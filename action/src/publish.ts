import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { parseActionInputs, type ActionInputs } from "./input";
import { hashObject, prepareRelease, type PreparedObject } from "./prepare";

const MANIFEST_CONTENT_TYPE = "application/expo+json" as const;

export interface PublishResult {
  updateId: string;
  manifestUrl: string;
}

interface ObjectResponse {
  ContentLength?: number;
  ContentType?: string;
  ContentEncoding?: string;
  Metadata?: Record<string, string>;
  Body?: unknown;
}

export interface S3Transport {
  send(command: PutObjectCommand | GetObjectCommand): Promise<ObjectResponse>;
}

async function verifyObject(
  client: S3Transport,
  bucket: string,
  object: Pick<PreparedObject, "key" | "body" | "contentType" | "sha256Hex">,
  signature?: string,
): Promise<void> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
  if (response.ContentLength !== object.body.byteLength || response.ContentType !== object.contentType) {
    throw new Error(`R2 object verification failed for ${object.key}`);
  }
  if (response.ContentEncoding && response.ContentEncoding.toLowerCase() !== "identity") {
    throw new Error(`R2 object verification found compressed content for ${object.key}`);
  }
  const storedSignature = Object.entries(response.Metadata ?? {}).find(([key]) => key.toLowerCase() === "signature")?.[1];
  if (signature !== undefined && storedSignature !== signature) {
    throw new Error(`R2 manifest signature metadata verification failed for ${object.key}`);
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
      ContentMD5: asset.md5Base64,
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
    await verifyObject(transport, validatedInput.r2Bucket, asset);
  }

  const manifestHashes = hashObject(release.manifestBody);
  const manifest: PreparedObject = {
    key: release.manifestKey,
    body: release.manifestBody,
    contentType: MANIFEST_CONTENT_TYPE,
    ...manifestHashes,
  };
  await transport.send(
    new PutObjectCommand({
      Bucket: validatedInput.r2Bucket,
      Key: release.manifestKey,
      Body: release.manifestBody,
      ContentType: MANIFEST_CONTENT_TYPE,
      ContentMD5: manifest.md5Base64,
      Metadata: { signature: release.signature },
    }),
  );
  await verifyObject(transport, validatedInput.r2Bucket, manifest, release.signature);
  return { updateId: release.updateId, manifestUrl: release.manifestUrl };
}
