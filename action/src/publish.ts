import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const PROJECT = "kosmo-native" as const;
const SIGNING_ALGORITHM = "rsa-v1_5-sha256" as const;
const MANIFEST_CONTENT_TYPE = "application/expo+json" as const;

export type Platform = "ios" | "android";
export type Channel = "staging" | "production";

export interface ActionInputs {
  exportDir: string;
  platform: Platform;
  channel: Channel;
  runtimeVersion: string;
  publicBaseUrl: string;
  r2Bucket: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  signingPrivateKey: string;
  keyid: string;
}

interface ExportAsset {
  path: string;
  ext: string;
}

interface PlatformMetadata {
  bundle: string;
  assets: ExportAsset[];
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredInput(name: string): string {
  const key = name.toUpperCase();
  const value = process.env[`INPUT_${key}`] ?? process.env[`INPUT_${key.replaceAll("-", "_")}`];
  if (!value?.trim()) fail(`Missing required input "${name}"`);
  return value.trim();
}

function optionalInput(name: string, fallback: string): string {
  const key = name.toUpperCase();
  const value = process.env[`INPUT_${key}`] ?? process.env[`INPUT_${key.replaceAll("-", "_")}`];
  return value?.trim() || fallback;
}

export function readActionInputs(): ActionInputs {
  const platform = requiredInput("platform");
  const channel = requiredInput("channel");
  if (platform !== "ios" && platform !== "android") fail("Input \"platform\" must be ios or android");
  if (channel !== "staging" && channel !== "production") {
    fail("Input \"channel\" must be staging or production");
  }

  return {
    exportDir: requiredInput("export-dir"),
    platform,
    channel,
    runtimeVersion: requiredInput("runtime-version"),
    publicBaseUrl: requiredInput("public-base-url"),
    r2Bucket: requiredInput("r2-bucket"),
    r2AccountId: requiredInput("r2-account-id"),
    r2AccessKeyId: requiredInput("r2-access-key-id"),
    r2SecretAccessKey: requiredInput("r2-secret-access-key"),
    signingPrivateKey: requiredInput("signing-private-key"),
    keyid: optionalInput("keyid", "main"),
  };
}

function validateRuntime(runtimeVersion: string): void {
  if (
    !runtimeVersion ||
    runtimeVersion === "." ||
    runtimeVersion === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(runtimeVersion)
  ) {
    fail("Input \"runtime-version\" must be one non-empty path segment");
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("Input \"public-base-url\" must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("Input \"public-base-url\" must be an absolute HTTP(S) URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    fail("Input \"public-base-url\" must not contain credentials, query, or fragment");
  }
  return value.replace(/\/+$/u, "");
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
  if (!isRecord(parsed) || parsed.version !== 0 || parsed.bundler !== "metro" || !isRecord(parsed.fileMetadata)) {
    fail("Only Expo Metro metadata.json version 0 exports are supported");
  }
  return parsed.fileMetadata;
}

function validatePlatformMetadata(value: unknown): PlatformMetadata {
  if (!isRecord(value) || typeof value.bundle !== "string" || !value.bundle || !Array.isArray(value.assets)) {
    fail("metadata.json has no valid export for the selected platform");
  }
  const assets = value.assets.map((asset) => {
    if (!isRecord(asset) || typeof asset.path !== "string" || typeof asset.ext !== "string") {
      fail("metadata.json contains an invalid asset entry");
    }
    return { path: asset.path, ext: asset.ext };
  });
  return { bundle: value.bundle, assets };
}

function extensionForMetadata(ext: string): string | undefined {
  if (!ext) return undefined;
  const value = ext.startsWith(".") ? ext.slice(1) : ext;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) fail("metadata.json contains an invalid asset extension");
  return `.${value}`;
}

function contentTypeForExtension(ext: string): string {
  const normalized = ext.replace(/^\./u, "").toLowerCase();
  return MIME_TYPES[normalized] ?? "application/octet-stream";
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

function assetUrl(baseUrl: string, platform: Platform, channel: Channel, runtimeVersion: string, hash: string): string {
  return `${baseUrl}/v1/projects/${PROJECT}/platforms/${platform}/channels/${channel}/runtimes/${encodeURIComponent(runtimeVersion)}/assets/${hash}`;
}

function manifestUrl(baseUrl: string, platform: Platform, channel: Channel, runtimeVersion: string): string {
  return `${baseUrl}/v1/projects/${PROJECT}/platforms/${platform}/channels/${channel}/runtimes/${encodeURIComponent(runtimeVersion)}/manifest`;
}

function releasePrefix(platform: Platform, channel: Channel, runtimeVersion: string): string {
  return `releases/${PROJECT}/${platform}/${channel}/${runtimeVersion}`;
}

function escapeSfvString(value: string): string {
  if (!/^[A-Za-z0-9*._-]+$/u.test(value)) fail("Input \"keyid\" must be an SFV token");
  return value;
}

function signatureForManifest(manifestBody: Buffer, privateKeyPem: string, keyid: string): string {
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    fail("Input \"signing-private-key\" is not a valid private key");
  }
  if (privateKey.asymmetricKeyType !== "rsa") fail("Input \"signing-private-key\" must be an RSA private key");
  const signature = sign("RSA-SHA256", manifestBody, privateKey).toString("base64");
  return `sig="${signature}", keyid="${escapeSfvString(keyid)}", alg="${SIGNING_ALGORITHM}"`;
}

async function prepareAsset(
  exportRoot: string,
  metadataAsset: ExportAsset,
  baseUrl: string,
  platform: Platform,
  channel: Channel,
  runtimeVersion: string,
  prefix: string,
  contentType: string,
): Promise<PreparedObject & { fileExtension?: string; hashBase64Url: string; keyHex: string; url: string }> {
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
    hashBase64Url: hashes.sha256Base64Url,
    keyHex: hashes.md5Hex,
    url: assetUrl(baseUrl, platform, channel, runtimeVersion, hashes.sha256Hex),
  };
}

export async function prepareRelease(input: ActionInputs): Promise<PreparedRelease> {
  validateRuntime(input.runtimeVersion);
  const baseUrl = normalizeBaseUrl(input.publicBaseUrl);
  if (!input.r2Bucket || !input.r2AccountId || !input.r2AccessKeyId || !input.r2SecretAccessKey) {
    fail("R2 bucket and credentials must not be empty");
  }
  const exportRoot = resolve(input.exportDir);
  const metadata = await readMetadata(exportRoot);
  const platformMetadata = validatePlatformMetadata(metadata[input.platform]);
  const prefix = releasePrefix(input.platform, input.channel, input.runtimeVersion);

  const launchPath = await resolveExportFile(exportRoot, platformMetadata.bundle);
  const launchBody = await readFile(launchPath);
  const launchHashes = hashObject(launchBody);
  const launch = {
    key: `${prefix}/assets/${launchHashes.sha256Hex}`,
    body: launchBody,
    contentType: "application/javascript",
    ...launchHashes,
    fileExtension: undefined,
    hashBase64Url: launchHashes.sha256Base64Url,
    keyHex: launchHashes.md5Hex,
    url: assetUrl(baseUrl, input.platform, input.channel, input.runtimeVersion, launchHashes.sha256Hex),
  };

  const assets = [
    launch,
    ...(await Promise.all(
      platformMetadata.assets.map((asset) =>
        prepareAsset(
          exportRoot,
          asset,
          baseUrl,
          input.platform,
          input.channel,
          input.runtimeVersion,
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
      hash: launch.hashBase64Url,
      key: launch.keyHex,
      contentType: launch.contentType,
      url: launch.url,
    },
    assets: assets.slice(1).map((asset) => ({
      hash: asset.hashBase64Url,
      key: asset.keyHex,
      contentType: asset.contentType,
      ...(asset.fileExtension ? { fileExtension: asset.fileExtension } : {}),
      url: asset.url,
    })),
    metadata: {},
    extra: {},
  };
  const manifestBody = Buffer.from(JSON.stringify(manifest), "utf8");
  const signature = signatureForManifest(manifestBody, input.signingPrivateKey, input.keyid);
  return {
    updateId,
    manifestUrl: manifestUrl(baseUrl, input.platform, input.channel, input.runtimeVersion),
    manifestKey: `${prefix}/manifest.json`,
    manifestBody,
    signature,
    assets: [...uniqueAssets.values()],
  };
}

function s3Endpoint(accountId: string): string {
  if (!/^[A-Za-z0-9-]+$/u.test(accountId)) fail("Input \"r2-account-id\" contains invalid characters");
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function isPreconditionFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === "PreconditionFailed" || error.$metadata !== undefined && isRecord(error.$metadata) && error.$metadata.httpStatusCode === 412;
}

function metadataValue(metadata: Record<string, string> | undefined, name: string): string | undefined {
  if (!metadata) return undefined;
  const entry = Object.entries(metadata).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
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
  if (signature !== undefined && metadataValue(response.Metadata, "signature") !== signature) {
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
