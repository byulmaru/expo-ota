import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parseActionInputs, type ActionInputs } from "./input";
import { hashObject, prepareRelease } from "./prepare";

const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable" as const;
const MANIFEST_CACHE_CONTROL = "private, no-store" as const;

export interface PublishResult {
  updateId: string;
  manifestUrl: string;
}

export interface S3Transport {
  send(command: PutObjectCommand): Promise<unknown>;
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
  return { updateId: release.updateId, manifestUrl: release.manifestUrl };
}
