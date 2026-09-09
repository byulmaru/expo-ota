import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { parseActionInputs, type ActionInputs } from "./input";
import { hashObject, prepareRelease, type PreparedObject } from "./prepare";

const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable" as const;
const MANIFEST_CACHE_CONTROL = "private, no-store" as const;
const R2_BUCKET = "expo-ota" as const;

export interface PublishResult {
  updateId: string;
  manifestUrl: string;
}

interface ObjectResponse {
  ContentLength?: number;
  ContentType?: string;
  ContentEncoding?: string;
  CacheControl?: string;
  Body?: unknown;
}

export interface S3Transport {
  send(command: PutObjectCommand | GetObjectCommand): Promise<ObjectResponse>;
}

async function verifyObject(
  client: S3Transport,
  object: Pick<PreparedObject, "key" | "body" | "contentType" | "sha256Hex">,
  cacheControl: string,
): Promise<void> {
  const response = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: object.key }));
  if (response.ContentLength !== object.body.byteLength || response.ContentType !== object.contentType) {
    throw new Error(`R2 object verification failed for ${object.key}`);
  }
  if (response.ContentEncoding && response.ContentEncoding.toLowerCase() !== "identity") {
    throw new Error(`R2 object verification found compressed content for ${object.key}`);
  }
  if (response.CacheControl !== cacheControl) {
    throw new Error(`R2 object verification found unexpected cache control for ${object.key}`);
  }
  if (!response.Body || typeof response.Body !== "object") throw new Error("R2 read-back response had no body");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array | string>) {
    const bytes = Buffer.from(chunk);
    hash.update(bytes);
    size += bytes.byteLength;
  }
  if (size !== object.body.byteLength || hash.digest("hex") !== object.sha256Hex) {
    throw new Error(`R2 object body verification failed for ${object.key}`);
  }
}

export async function publishRelease(input: ActionInputs, client?: S3Transport): Promise<PublishResult> {
  const validatedInput = parseActionInputs(input);
  const transport = client ?? new S3Client({
    endpoint: "https://676a2d8e52515abd22c0edda7364cf73.r2.cloudflarestorage.com",
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
      Bucket: R2_BUCKET,
      Key: asset.key,
      Body: asset.body,
      ContentType: asset.contentType,
      ContentMD5: asset.md5Base64,
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
      if (!isPreconditionFailure) throw new Error(`R2 asset upload failed for ${asset.key}`);
    }
    await verifyObject(transport, asset, ASSET_CACHE_CONTROL);
  }

  const manifestHashes = hashObject(release.manifestUploadBody);
  const manifest: PreparedObject = {
    key: release.manifestKey,
    body: release.manifestUploadBody,
    contentType: release.manifestContentType,
    ...manifestHashes,
  };
  await transport.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: release.manifestKey,
      Body: release.manifestUploadBody,
      ContentType: release.manifestContentType,
      ContentMD5: manifest.md5Base64,
      CacheControl: MANIFEST_CACHE_CONTROL,
    }),
  );
  await verifyObject(transport, manifest, MANIFEST_CACHE_CONTROL);
  return { updateId: release.updateId, manifestUrl: release.manifestUrl };
}
