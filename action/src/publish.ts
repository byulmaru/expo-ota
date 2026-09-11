import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { parseActionInputs, type ActionInputs } from "./input";
import { hashObject, prepareRelease } from "./prepare";

const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable" as const;
const MANIFEST_CACHE_CONTROL = "private, no-store" as const;

export interface PublishResult {
  updateId: string;
  manifestUrl: string;
}

interface ObjectResponse {
  Contents?: Array<{ Key?: string }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
  Errors?: Array<{ Key?: string; Code?: string; Message?: string }>;
}

export interface S3Transport {
  send(
    command: PutObjectCommand | ListObjectsV2Command | DeleteObjectsCommand,
  ): Promise<ObjectResponse>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown R2 error";
}

const RELEASE_FOLDER_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function cleanupOldReleaseAssets(
  client: S3Transport,
  bucket: string,
  assetPrefix: string,
  updateId: string,
): Promise<void> {
  const listPrefix = `${assetPrefix}/`;
  const retainedPrefix = `${listPrefix}${updateId}/`;
  let continuationToken: string | undefined;

  while (true) {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: listPrefix,
        MaxKeys: 1000,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    const staleKeys = (response.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => {
        if (!key || !key.startsWith(listPrefix) || key.startsWith(retainedPrefix)) return false;
        const relativeKey = key.slice(listPrefix.length);
        const separator = relativeKey.indexOf("/");
        return separator > 0 && RELEASE_FOLDER_NAME.test(relativeKey.slice(0, separator));
      });

    if (staleKeys.length > 0) {
      const objects = staleKeys.map((Key) => ({ Key }));
      const deleteResponse = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      const errors = deleteResponse.Errors ?? [];
      if (errors.length > 0) {
        const details = errors
          .map(({ Key, Code, Message }) => [Key, Code, Message].filter(Boolean).join(":"))
          .join(", ");
        throw new Error(`R2 asset cleanup delete returned object errors${details ? `: ${details}` : ""}`);
      }
    }

    if (!response.IsTruncated) return;
    if (!response.NextContinuationToken) {
      throw new Error("R2 asset cleanup listing was truncated without a continuation token");
    }
    continuationToken = response.NextContinuationToken;
  }
}

export async function publishRelease(input: ActionInputs, client?: S3Transport): Promise<PublishResult> {
  const validatedInput = parseActionInputs(input);
  const transport = client ?? new S3Client({
    endpoint: `https://${validatedInput.r2AccountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    region: "auto",
    credentials: {
      accessKeyId: validatedInput.r2AccessKeyId,
      secretAccessKey: validatedInput.r2SecretAccessKey,
    },
  });
  const release = await prepareRelease(validatedInput);

  for (const asset of release.assets) {
    const command = new PutObjectCommand({
      Bucket: validatedInput.r2Bucket,
      Key: asset.key,
      Body: asset.body,
      ContentType: asset.contentType,
      ChecksumSHA256: asset.sha256Base64,
      CacheControl: ASSET_CACHE_CONTROL,
      IfNoneMatch: "*",
    });
    try {
      await transport.send(command);
    } catch (error) {
      const isPreconditionFailure =
        typeof error === "object" &&
        error !== null &&
        ((error as { name?: unknown }).name === "PreconditionFailed" ||
          (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 412);
      if (!isPreconditionFailure) throw error;
    }
  }

  const manifestHashes = hashObject(release.manifestUploadBody);
  await transport.send(
    new PutObjectCommand({
      Bucket: validatedInput.r2Bucket,
      Key: release.manifestKey,
      Body: release.manifestUploadBody,
      ContentType: release.manifestContentType,
      ChecksumSHA256: manifestHashes.sha256Base64,
      CacheControl: MANIFEST_CACHE_CONTROL,
    }),
  );
  try {
    await cleanupOldReleaseAssets(transport, validatedInput.r2Bucket, `${release.manifestKey.slice(0, -"/manifest.json".length)}/assets`, release.updateId);
  } catch (error) {
    throw new Error(
      `R2 post-publish cleanup failed after manifest upload for update ${release.updateId}; manifest is already published: ${errorMessage(error)}`,
    );
  }
  return { updateId: release.updateId, manifestUrl: release.manifestUrl };
}
