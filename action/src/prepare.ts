import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { parseActionInputs, type ActionInputs } from "./input";

const SIGNING_ALGORITHM = "rsa-v1_5-sha256" as const;

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
  manifestUploadBody: Buffer;
  manifestContentType: string;
  assets: PreparedObject[];
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

async function resolveExportFile(exportRoot: string, metadataPath: string): Promise<string> {
  if (
    !metadataPath ||
    metadataPath.includes("\u0000") ||
    /^[\\/]/u.test(metadataPath) ||
    /^[A-Za-z]:[\\/]/u.test(metadataPath)
  ) {
    throw new Error("metadata.json contains an invalid absolute asset path");
  }
  const normalized = metadataPath.replaceAll("\\", "/");
  const candidate = resolve(exportRoot, normalized);
  const lexicalRelative = relative(exportRoot, candidate);
  if (!lexicalRelative || lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
    throw new Error("metadata.json contains an asset path outside export-dir");
  }
  let resolvedRoot: string;
  let resolvedCandidate: string;
  try {
    [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(exportRoot), realpath(candidate)]);
  } catch {
    throw new Error(`Export file not found: ${metadataPath}`);
  }
  const actualRelative = relative(resolvedRoot, resolvedCandidate);
  if (!actualRelative || actualRelative.startsWith("..") || isAbsolute(actualRelative)) {
    throw new Error("metadata.json contains an asset symlink outside export-dir");
  }
  const fileStat = await stat(resolvedCandidate);
  if (!fileStat.isFile()) throw new Error(`Export path is not a file: ${metadataPath}`);
  return resolvedCandidate;
}

export function hashObject(
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
  metadataPath: string,
  metadataExtension: string,
  assetUrlPrefix: string,
  prefix: string,
  contentType: string,
): Promise<PreparedObject & { fileExtension?: string; url: string }> {
  const filePath = await resolveExportFile(exportRoot, metadataPath);
  const body = await readFile(filePath);
  const hashes = hashObject(body);
  let fileExtension: string | undefined;
  if (metadataExtension) {
    const normalizedExtension = metadataExtension.startsWith(".") ? metadataExtension.slice(1) : metadataExtension;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(normalizedExtension)) {
      throw new Error("metadata.json contains an invalid asset extension");
    }
    fileExtension = `.${normalizedExtension}`;
  }
  return {
    key: `${prefix}/assets/${hashes.sha256Hex}`,
    body,
    contentType,
    ...hashes,
    fileExtension,
    url: `${assetUrlPrefix}/${hashes.sha256Hex}`,
  };
}

export async function prepareRelease(input: ActionInputs): Promise<PreparedRelease> {
  const validatedInput = parseActionInputs(input);
  const publicObjectPath = [
    "releases",
    encodeURIComponent(validatedInput.project),
    encodeURIComponent(validatedInput.platform),
    encodeURIComponent(validatedInput.channel),
    encodeURIComponent(validatedInput.runtimeVersion),
  ].join("/");
  const publicObjectUrl = `${validatedInput.publicBaseUrl}/${publicObjectPath}`;
  const prefix = `releases/${validatedInput.project}/${validatedInput.platform}/${validatedInput.channel}/${validatedInput.runtimeVersion}`;
  const exportRoot = resolve(validatedInput.exportDir);
  const metadataPath = await resolveExportFile(exportRoot, "metadata.json");
  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    throw new Error("metadata.json is not valid JSON");
  }
  const validatedMetadata = z
    .object({
      version: z.literal(0),
      bundler: z.literal("metro"),
      fileMetadata: z.record(z.string(), z.unknown()),
    })
    .safeParse(parsedMetadata);
  if (!validatedMetadata.success) throw new Error("Only Expo Metro metadata.json version 0 exports are supported");
  const metadata = validatedMetadata.data.fileMetadata;
  const platformMetadata = z
    .object({
      bundle: z.string().min(1),
      assets: z.array(z.object({ path: z.string(), ext: z.string() })),
    })
    .safeParse(metadata[validatedInput.platform]);
  if (!platformMetadata.success) throw new Error("metadata.json has no valid export for the selected platform");

  const launch = await prepareFile(
    exportRoot,
    platformMetadata.data.bundle,
    "",
    `${publicObjectUrl}/assets`,
    prefix,
    "application/javascript",
  );
  const assets = [
    launch,
    ...(await Promise.all(
      platformMetadata.data.assets.map((asset) => {
        const extension = asset.ext.replace(/^\./u, "").toLowerCase();
        const contentType = Object.hasOwn(MIME_TYPES, extension) ? MIME_TYPES[extension]! : "application/octet-stream";
        return prepareFile(exportRoot, asset.path, asset.ext, `${publicObjectUrl}/assets`, prefix, contentType);
      }),
    )),
  ];
  const uniqueAssets = new Map<string, PreparedObject>();
  for (const asset of assets) {
    const existing = uniqueAssets.get(asset.key);
    if (existing && existing.contentType !== asset.contentType) {
      throw new Error(`One asset hash maps to multiple content types: ${asset.sha256Hex}`);
    }
    uniqueAssets.set(asset.key, asset);
  }

  const updateId = randomUUID();
  const createdAt = new Date().toISOString();
  const manifest = {
    id: updateId,
    createdAt,
    runtimeVersion: validatedInput.runtimeVersion,
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
    privateKey = createPrivateKey(validatedInput.signingPrivateKey);
  } catch {
    throw new Error('Input "signing-private-key" is not a valid private key');
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error('Input "signing-private-key" must be an RSA private key');
  }
  const signature = `sig="${sign("RSA-SHA256", manifestBody, privateKey).toString("base64")}", keyid="${validatedInput.keyid}", alg="${SIGNING_ALGORITHM}"`;
  const boundary = `expo-manifest-${randomUUID()}`;
  const manifestContentType = `multipart/mixed; boundary=${boundary}`;
  const manifestUploadBody = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\nexpo-signature: ${signature}\r\n\r\n`,
      "utf8",
    ),
    manifestBody,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  return {
    updateId,
    manifestUrl: `${publicObjectUrl}/manifest.json`,
    manifestKey: `${prefix}/manifest.json`,
    manifestUploadBody,
    manifestContentType,
    assets: [...uniqueAssets.values()],
  };
}
