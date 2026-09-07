import { base64, base64urlnopad, hex } from "@scure/base";
import { parseDictionary, type BareItem, type Dictionary } from "structured-headers";
import { z } from "zod";

export const PROJECT = "kosmo-native" as const;
export const PROTOCOL_VERSION = "1" as const;
export const SFV_VERSION = "0" as const;
export const DEFAULT_MANIFEST_CACHE_CONTROL = "private, no-store";
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MANIFEST_CONTENT_TYPES = new Set(["application/expo+json", "application/json"]);
const SIGNING_ALGORITHM = "rsa-v1_5-sha256" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNTIME = /^[^/\\\u0000-\u001f\u007f]+$/;
const MIME_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const platformSchema = z.enum(["ios", "android"]);
const channelSchema = z.enum(["staging", "production"]);
const runtimeSchema = z
  .string()
  .min(1)
  .regex(RUNTIME)
  .refine((value) => value !== "." && value !== "..");

export const manifestParamsSchema = z.object({
  platform: platformSchema,
  channel: channelSchema,
  runtime: runtimeSchema,
});

export const assetParamsSchema = manifestParamsSchema.extend({
  hash: z.string().regex(SHA256_HEX),
});

export const manifestHeadersSchema = z.object({
  "expo-protocol-version": z.string().optional(),
  "expo-platform": z.string().optional(),
  "expo-runtime-version": z.string().optional(),
  accept: z.string().optional(),
  "expo-expect-signature": z.string().optional(),
});

export type ManifestHeaders = z.infer<typeof manifestHeadersSchema>;
export type ManifestRoute = z.infer<typeof manifestParamsSchema>;
export type AssetRoute = z.infer<typeof assetParamsSchema>;

export interface ParsedSignature {
  sig: Uint8Array;
  keyid: string;
  alg: typeof SIGNING_ALGORITHM;
}

export interface SignatureExpectation {
  keyid?: string;
  alg?: typeof SIGNING_ALGORITHM;
}

const channelPointerSchema = z.object({
  complete: z.literal(true),
  manifestKey: z.string(),
  signature: z.string(),
  contentType: z.string(),
});
export type ChannelPointer = z.infer<typeof channelPointerSchema>;

export function isContentType(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && MIME_TYPE.test(value);
}

const manifestAssetSchema = z.object({
  hash: z.string().regex(SHA256_BASE64URL),
  key: z.string().min(1),
  contentType: z.string().refine(isContentType),
  fileExtension: z.string().optional(),
  url: z.string().min(1),
});

export const manifestSchema = z.object({
  id: z.string().regex(UUID),
  createdAt: z.string().refine((value) => value.length > 0 && Number.isFinite(Date.parse(value))),
  runtimeVersion: z.string(),
  launchAsset: manifestAssetSchema,
  assets: z.array(manifestAssetSchema),
  metadata: z.record(z.string(), z.string()),
  extra: z.record(z.string(), z.unknown()),
});
export type ExpoManifest = z.infer<typeof manifestSchema>;

export function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  try {
    const decoded = base64.decode(value);
    return base64.encode(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function hasDuplicateDictionaryKeys(input: string): boolean {
  const keys = new Set<string>();
  let segmentStart = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index <= input.length; index += 1) {
    const character = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== "," && index !== input.length) continue;
    const key = /^\s*([a-z][a-z0-9_*.-]*)/.exec(input.slice(segmentStart, index))?.[1];
    if (!key || keys.has(key)) return true;
    keys.add(key);
    segmentStart = index + 1;
  }
  return inString;
}

function parseSfvDictionary(input: string): Dictionary | undefined {
  if (hasDuplicateDictionaryKeys(input)) return undefined;
  try {
    return parseDictionary(input);
  } catch {
    return undefined;
  }
}

function getSfvItem(dictionary: Dictionary, key: string): { value: BareItem; parameters: Map<string, BareItem> } | undefined {
  const item = dictionary.get(key);
  if (!item || !Array.isArray(item) || item.length !== 2 || Array.isArray(item[0]) || !(item[1] instanceof Map)) {
    return undefined;
  }
  return { value: item[0] as BareItem, parameters: item[1] as Map<string, BareItem> };
}

export function parseSignature(value: unknown): ParsedSignature | undefined {
  if (typeof value !== "string") return undefined;
  const dictionary = parseSfvDictionary(value);
  const signature = dictionary && getSfvItem(dictionary, "sig");
  const keyid = dictionary && getSfvItem(dictionary, "keyid");
  const alg = dictionary && getSfvItem(dictionary, "alg");
  if (
    !dictionary ||
    dictionary.size !== 3 ||
    !signature ||
    signature.parameters.size !== 0 ||
    typeof signature.value !== "string" ||
    !keyid ||
    keyid.parameters.size !== 0 ||
    typeof keyid.value !== "string" ||
    keyid.value.length === 0 ||
    !alg ||
    alg.parameters.size !== 0 ||
    typeof alg.value !== "string" ||
    alg.value !== SIGNING_ALGORITHM
  ) {
    return undefined;
  }
  const sig = decodeCanonicalBase64(signature.value);
  if (!sig || sig.length === 0) return undefined;
  return { sig, keyid: keyid.value, alg: alg.value };
}

export function parseSignatureExpectation(value: string): SignatureExpectation | undefined {
  const dictionary = parseSfvDictionary(value);
  const sig = dictionary && getSfvItem(dictionary, "sig");
  const keyid = dictionary && getSfvItem(dictionary, "keyid");
  const alg = dictionary && getSfvItem(dictionary, "alg");
  if (
    !dictionary ||
    dictionary.size > 3 ||
    !sig ||
    sig.parameters.size !== 0 ||
    sig.value !== true ||
    (keyid !== undefined && (keyid.parameters.size !== 0 || typeof keyid.value !== "string")) ||
    (alg !== undefined && (alg.parameters.size !== 0 || alg.value !== SIGNING_ALGORITHM)) ||
    (keyid === undefined && dictionary.has("keyid")) ||
    (alg === undefined && dictionary.has("alg")) ||
    [...dictionary.keys()].some((key) => !["sig", "keyid", "alg"].includes(key))
  ) {
    return undefined;
  }
  return {
    ...(keyid === undefined ? {} : { keyid: keyid.value as string }),
    ...(alg === undefined ? {} : { alg: SIGNING_ALGORITHM }),
  };
}

export function parsePointer(value: unknown, route: ManifestRoute): ChannelPointer | undefined {
  const result = channelPointerSchema.safeParse(value);
  if (!result.success) return undefined;
  const prefix = `releases/${PROJECT}/${route.platform}/${route.channel}/${route.runtime}/`;
  const manifestPrefix = `${prefix}manifests/`;
  const { manifestKey } = result.data;
  if (
    !MANIFEST_CONTENT_TYPES.has(result.data.contentType.split(";", 1)[0]!.trim().toLowerCase()) ||
    (manifestKey !== `${prefix}manifest.json` &&
      (!manifestKey.startsWith(manifestPrefix) ||
        manifestKey.slice(manifestPrefix.length).length === 0 ||
        manifestKey.slice(manifestPrefix.length).includes("/")))
  ) {
    return undefined;
  }
  return result.data;
}

function parseAssetPath(url: URL): AssetRoute | undefined {
  const parts = url.pathname.split("/");
  if (
    parts.length !== 12 ||
    parts[1] !== "v1" ||
    parts[2] !== "projects" ||
    parts[3] !== PROJECT ||
    parts[4] !== "platforms" ||
    parts[6] !== "channels" ||
    parts[8] !== "runtimes" ||
    parts[10] !== "assets"
  ) {
    return undefined;
  }
  let runtime: string;
  let hash: string;
  try {
    runtime = decodeURIComponent(parts[9]!);
    hash = decodeURIComponent(parts[11]!);
  } catch {
    return undefined;
  }
  const result = assetParamsSchema.safeParse({ platform: parts[5], channel: parts[7], runtime, hash });
  return result.success ? result.data : undefined;
}

export function validateAssetReferences(manifest: ExpoManifest, route: ManifestRoute, requestUrl: URL): boolean {
  if (manifest.runtimeVersion !== route.runtime) return false;
  for (const asset of [manifest.launchAsset, ...manifest.assets]) {
    if (!SHA256_BASE64URL.test(asset.hash)) return false;
    let routeHash: Uint8Array;
    try {
      routeHash = base64urlnopad.decode(asset.hash);
      if (base64urlnopad.encode(routeHash) !== asset.hash) return false;
    } catch {
      return false;
    }
    if (routeHash.byteLength !== 32) return false;
    const hash = hex.encode(routeHash);

    let assetUrl: URL;
    try {
      assetUrl = new URL(asset.url, requestUrl);
    } catch {
      return false;
    }
    const assetRoute = parseAssetPath(assetUrl);
    if (
      !assetRoute ||
      assetUrl.origin !== requestUrl.origin ||
      assetUrl.search ||
      assetUrl.hash ||
      assetRoute.platform !== route.platform ||
      assetRoute.channel !== route.channel ||
      assetRoute.runtime !== route.runtime ||
      assetRoute.hash !== hash
    ) {
      return false;
    }
  }
  return true;
}
