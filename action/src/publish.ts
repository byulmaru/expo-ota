import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const SIGNING_ALGORITHM = "rsa-v1_5-sha256" as const;
const MANIFEST_CONTENT_TYPE = "application/expo+json" as const;

const platformSchema = z.enum(["ios", "android"], {
  error: 'Input "platform" must be ios or android',
});
const channelSchema = z.enum(["staging", "production"], {
  error: 'Input "channel" must be staging or production',
});
const pathSegmentSchema = (name: string) =>
  z.string().min(1).refine(
    (value) => value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/u.test(value),
    `Input "${name}" must be one non-empty path segment`,
  );
const projectSchema = pathSegmentSchema("project");
const runtimeVersionSchema = pathSegmentSchema("runtime-version");
const publicBaseUrlSchema = z
  .url({ protocol: /^https?$/u, error: 'Input "public-base-url" must be an absolute HTTP(S) URL' })
  .refine((value) => {
    const url = new URL(value);
    return !(url.username || url.password || url.search || url.hash);
  }, 'Input "public-base-url" must not contain credentials, query, or fragment')
  .transform((value) => value.replace(/\/+$/u, ""));
const r2AccountIdSchema = z.string().min(1).regex(/^[A-Za-z0-9-]+$/u, {
  error: 'Input "r2-account-id" contains invalid characters',
});
const keyidSchema = z.string().min(1).regex(/^[A-Za-z0-9*._-]+$/u, {
  error: 'Input "keyid" must be an SFV token',
});
const actionInputsSchema = z.object({
  exportDir: z.string().min(1),
  project: projectSchema,
  platform: platformSchema,
  channel: channelSchema,
  runtimeVersion: runtimeVersionSchema,
  publicBaseUrl: publicBaseUrlSchema,
  r2Bucket: z.string().min(1),
  r2AccountId: r2AccountIdSchema,
  r2AccessKeyId: z.string().min(1),
  r2SecretAccessKey: z.string().min(1),
  signingPrivateKey: z.string().min(1),
  keyid: keyidSchema,
});

const exportAssetSchema = z.object({ path: z.string(), ext: z.string() });
const platformMetadataSchema = z.object({
  bundle: z.string().min(1),
  assets: z.array(exportAssetSchema),
});
const exportMetadataSchema = z.object({
  version: z.literal(0),
  bundler: z.literal("metro"),
  fileMetadata: z.record(z.string(), z.unknown()),
});

export type Platform = z.infer<typeof platformSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type ActionInputs = z.infer<typeof actionInputsSchema>;
type ExportAsset = z.infer<typeof exportAssetSchema>;

export interface PreparedObject {
  key: string;
  body: Buffer;
  contentType: string;
  sha256Hex: string;
  sha256Base64Url: string;
  md5Base64: string;
  md5Hex: string;
}

export interface PreparedRelease {
  updateId: string;
  manifestUrl: string;
  manifestKey: string;
  manifestBody: Buffer;
  signature: string;
  assets: PreparedObject[];
}

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

const MIME_TYPES: Record<string, string> = {
  aac: "audio/aac",
  avif: "image/avif",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  db: "application/octet-stream",
  gif: "image/gif",
  hbc: "application/javascript",
  heic: "image/heic",
  heif: "image/heif",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "application/javascript",
  json: "application/json",
  map: "application/json",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain",
  wasm: "application/wasm",
  wav: "audio/wav",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
  zip: "application/zip",
};

function fail(message: string): never {
  throw new Error(message);
}

function input(name: string, fallback?: string): string {
  const value = process.env[`INPUT_${name.toUpperCase()}`];
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  if (fallback !== undefined) return fallback;
  fail(`Missing required input "${name}"`);
}

function parseActionInputs(value: unknown): ActionInputs {
  const parsed = actionInputsSchema.safeParse(value);
  if (!parsed.success) fail(parsed.error.issues[0]?.message ?? "Invalid Action inputs");
  return parsed.data;
}

export function readActionInputs(): ActionInputs {
  return parseActionInputs({
    exportDir: input("export-dir"),
    project: input("project"),
    platform: input("platform"),
    channel: input("channel"),
    runtimeVersion: input("runtime-version"),
    publicBaseUrl: input("public-base-url"),
    r2Bucket: input("r2-bucket"),
    r2AccountId: input("r2-account-id"),
    r2AccessKeyId: input("r2-access-key-id"),
    r2SecretAccessKey: input("r2-secret-access-key"),
    signingPrivateKey: input("signing-private-key"),
    keyid: input("keyid", "main"),
  });
}

function normalizeExportPath(exportRoot: string, metadataPath: string): string {
  if (
    !metadataPath ||
    metadataPath.includes("\u0000") ||
    /^[\\/]/u.test(metadataPath) ||
    /^[A-Za-z]:[\\/]/u.test(metadataPath)
  ) {
    fail("metadata.json contains an invalid absolute asset path");
  }
  const normalized = metadataPath.replaceAll("\\", "/");
  const candidate = resolve(exportRoot, normalized);
  const lexicalRelative = relative(exportRoot, candidate);
  if (!lexicalRelative || lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
    fail("metadata.json contains an asset path outside export-dir");
  }
  return candidate;
}

async function resolveExportFile(exportRoot: string, metadataPath: string): Promise<string> {
  const candidate = normalizeExportPath(exportRoot, metadataPath);
  let resolvedRoot: string;
  let resolvedCandidate: string;
  try {
    [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(exportRoot), realpath(candidate)]);
  } catch {
    fail(`Export file not found: ${metadataPath}`);
  }
  const actualRelative = relative(resolvedRoot, resolvedCandidate);
  if (!actualRelative || actualRelative.startsWith("..") || isAbsolute(actualRelative)) {
    fail("metadata.json contains an asset symlink outside export-dir");
  }
  const fileStat = await stat(resolvedCandidate);
  if (!fileStat.isFile()) fail(`Export path is not a file: ${metadataPath}`);
  return resolvedCandidate;
}

async function readMetadata(exportRoot: string): Promise<Record<string, unknown>> {
  const metadataPath = await resolveExportFile(exportRoot, "metadata.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    fail("metadata.json is not valid JSON");
  }
  const validated = exportMetadataSchema.safeParse(parsed);
  if (!validated.success) {
    fail("Only Expo Metro metadata.json version 0 exports are supported");
  }
  return validated.data.fileMetadata;
}

function extensionForMetadata(ext: string): string | undefined {
  if (!ext) return undefined;
  const value = ext.startsWith(".") ? ext.slice(1) : ext;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) fail("metadata.json contains an invalid asset extension");
  return `.${value}`;
}

function contentTypeForExtension(ext: string): string {
  const normalized = ext.replace(/^\./u, "").toLowerCase();
  return Object.hasOwn(MIME_TYPES, normalized) ? MIME_TYPES[normalized]! : "application/octet-stream";
}

function hashObject(
  body: Buffer,
): Pick<PreparedObject, "sha256Hex" | "sha256Base64Url" | "md5Base64" | "md5Hex"> {
  const sha256 = createHash("sha256").update(body).digest();
  const md5 = createHash("md5").update(body).digest();
  return {
    sha256Hex: sha256.toString("hex"),
    sha256Base64Url: sha256.toString("base64url"),
    md5Base64: md5.toString("base64"),
    md5Hex: md5.toString("hex"),
  };
}

async function prepareFile(
  exportRoot: string,
  metadataAsset: ExportAsset,
  assetBaseUrl: string,
  prefix: string,
  contentType: string,
): Promise<PreparedObject & { fileExtension?: string; url: string }> {
  const filePath = await resolveExportFile(exportRoot, metadataAsset.path);
  const body = await readFile(filePath);
  const hashes = hashObject(body);
  const fileExtension = extensionForMetadata(metadataAsset.ext);
  return {
    key: `${prefix}/assets/${hashes.sha256Hex}`,
    body,
    contentType,
    ...hashes,
    fileExtension,
    url: `${assetBaseUrl}/${hashes.sha256Hex}`,
  };
}

export async function prepareRelease(input: ActionInputs): Promise<PreparedRelease> {
  input = parseActionInputs(input);
  const baseUrl = input.publicBaseUrl;
  const publicTupleUrl = `${baseUrl}/v1/projects/${encodeURIComponent(input.project)}/platforms/${input.platform}/channels/${input.channel}/runtimes/${encodeURIComponent(input.runtimeVersion)}`;
  const assetBaseUrl = `${publicTupleUrl}/assets`;
  const prefix = `releases/${input.project}/${input.platform}/${input.channel}/${input.runtimeVersion}`;
  const exportRoot = resolve(input.exportDir);
  const metadata = await readMetadata(exportRoot);
  const platformMetadata = platformMetadataSchema.safeParse(metadata[input.platform]);
  if (!platformMetadata.success) fail("metadata.json has no valid export for the selected platform");

  const launch = await prepareFile(
    exportRoot,
    { path: platformMetadata.data.bundle, ext: "" },
    assetBaseUrl,
    prefix,
    "application/javascript",
  );
  const assets = [
    launch,
    ...(await Promise.all(
      platformMetadata.data.assets.map((asset) =>
        prepareFile(
          exportRoot,
          asset,
          assetBaseUrl,
          prefix,
          contentTypeForExtension(asset.ext),
        ),
      ),
    )),
  ];
  const uniqueAssets = new Map<string, PreparedObject>();
  for (const asset of assets) {
    const existing = uniqueAssets.get(asset.key);
    if (existing && existing.contentType !== asset.contentType) {
      fail(`One asset hash maps to multiple content types: ${asset.sha256Hex}`);
    }
    uniqueAssets.set(asset.key, asset);
  }

  const updateId = randomUUID();
  const createdAt = new Date().toISOString();
  const manifest = {
    id: updateId,
    createdAt,
    runtimeVersion: input.runtimeVersion,
    launchAsset: {
      hash: launch.sha256Base64Url,
      key: launch.md5Hex,
      contentType: launch.contentType,
      url: launch.url,
    },
    assets: assets.slice(1).map((asset) => ({
      hash: asset.sha256Base64Url,
      key: asset.md5Hex,
      contentType: asset.contentType,
      ...(asset.fileExtension ? { fileExtension: asset.fileExtension } : {}),
      url: asset.url,
    })),
    metadata: {},
    extra: {},
  };
  const manifestBody = Buffer.from(JSON.stringify(manifest), "utf8");
  let privateKey;
  try {
    privateKey = createPrivateKey(input.signingPrivateKey);
  } catch {
    fail("Input \"signing-private-key\" is not a valid private key");
  }
  if (privateKey.asymmetricKeyType !== "rsa") fail("Input \"signing-private-key\" must be an RSA private key");
  const signature = `sig="${sign("RSA-SHA256", manifestBody, privateKey).toString("base64")}", keyid="${input.keyid}", alg="${SIGNING_ALGORITHM}"`;
  return {
    updateId,
    manifestUrl: `${publicTupleUrl}/manifest`,
    manifestKey: `${prefix}/manifest.json`,
    manifestBody,
    signature,
    assets: [...uniqueAssets.values()],
  };
}

function s3Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function isPreconditionFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

async function bodyDigest(body: unknown): Promise<{ sha256Hex: string; size: number }> {
  if (!body || typeof body !== "object") fail("R2 read-back response had no body");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    hash.update(bytes);
    size += bytes.byteLength;
  }
  return { sha256Hex: hash.digest("hex"), size };
}

async function verifyObject(
  client: S3Transport,
  bucket: string,
  object: Pick<PreparedObject, "key" | "body" | "contentType" | "sha256Hex">,
  signature?: string,
): Promise<void> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
  if (response.ContentLength !== object.body.byteLength || response.ContentType !== object.contentType) {
    fail(`R2 object verification failed for ${object.key}`);
  }
  if (response.ContentEncoding && response.ContentEncoding.toLowerCase() !== "identity") {
    fail(`R2 object verification found compressed content for ${object.key}`);
  }
  const storedSignature = Object.entries(response.Metadata ?? {}).find(([key]) => key.toLowerCase() === "signature")?.[1];
  if (signature !== undefined && storedSignature !== signature) {
    fail(`R2 manifest signature metadata verification failed for ${object.key}`);
  }
  const digest = await bodyDigest(response.Body);
  if (digest.size !== object.body.byteLength || digest.sha256Hex !== object.sha256Hex) {
    fail(`R2 object body verification failed for ${object.key}`);
  }
}

function createClient(input: ActionInputs): S3Transport {
  const client = new S3Client({
    endpoint: s3Endpoint(input.r2AccountId),
    forcePathStyle: true,
    region: "auto",
    credentials: {
      accessKeyId: input.r2AccessKeyId,
      secretAccessKey: input.r2SecretAccessKey,
    },
  });
  return {
    send: (command) => client.send(command) as Promise<ObjectResponse>,
  };
}

export async function publishRelease(input: ActionInputs, client: S3Transport = createClient(input)): Promise<PublishResult> {
  const release = await prepareRelease(input);
  for (const asset of release.assets) {
    const command = new PutObjectCommand({
      Bucket: input.r2Bucket,
      Key: asset.key,
      Body: asset.body,
      ContentType: asset.contentType,
      ContentMD5: asset.md5Base64,
      IfNoneMatch: "*",
    });
    try {
      await client.send(command);
    } catch (error) {
      if (!isPreconditionFailure(error)) throw new Error(`R2 asset upload failed for ${asset.key}`);
    }
    await verifyObject(client, input.r2Bucket, asset);
  }

  const manifestHashes = hashObject(release.manifestBody);
  const manifest: PreparedObject = {
    key: release.manifestKey,
    body: release.manifestBody,
    contentType: MANIFEST_CONTENT_TYPE,
    ...manifestHashes,
  };
  await client.send(
    new PutObjectCommand({
      Bucket: input.r2Bucket,
      Key: release.manifestKey,
      Body: release.manifestBody,
      ContentType: MANIFEST_CONTENT_TYPE,
      ContentMD5: manifest.md5Base64,
      Metadata: { signature: release.signature },
    }),
  );
  await verifyObject(client, input.r2Bucket, manifest, release.signature);
  return { updateId: release.updateId, manifestUrl: release.manifestUrl };
}

export function setActionOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value}\n`, { encoding: "utf8", mode: 0o600 });
}
