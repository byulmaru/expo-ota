import { base64 } from "@scure/base";
import { parseDictionary, type BareItem, type Dictionary } from "structured-headers";

export const PROJECT = "kosmo-native" as const;
export const PROTOCOL_VERSION = "1" as const;
export const SFV_VERSION = "0" as const;
export const DEFAULT_MANIFEST_CACHE_CONTROL = "private, no-store";
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

const MANIFEST_CONTENT_TYPES = new Set(["application/expo+json", "application/json"]);
const SIGNING_ALGORITHM = "rsa-v1_5-sha256" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const RUNTIME = /^[^/\\\u0000-\u001f\u007f]+$/;
const MIME_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

type Platform = "ios" | "android";
type Channel = "staging" | "production";

export type ManifestRoute = {
  kind: "manifest";
  platform: Platform;
  channel: Channel;
  runtime: string;
};

export type AssetRoute = {
  kind: "asset";
  platform: Platform;
  channel: Channel;
  runtime: string;
  hash: string;
};

export type Route = ManifestRoute | AssetRoute;

export interface ParsedSignature {
  keyid: string;
  alg: typeof SIGNING_ALGORITHM;
}

export interface SignatureExpectation {
  keyid?: string;
  alg?: typeof SIGNING_ALGORITHM;
}

function decodeSegment(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function isPlatform(value: string | undefined): value is Platform {
  return value === "ios" || value === "android";
}

function isChannel(value: string | undefined): value is Channel {
  return value === "staging" || value === "production";
}

function decodeRuntime(segment: string | undefined): string | undefined {
  const runtime = decodeSegment(segment);
  if (!runtime || runtime === "." || runtime === ".." || !RUNTIME.test(runtime)) return undefined;
  return runtime;
}

export function parseRoute(pathname: string): Route | undefined {
  const parts = pathname.split("/");
  const [
    ,
    version,
    projects,
    project,
    platforms,
    platformSegment,
    channels,
    channelSegment,
    runtimes,
    runtimeSegment,
    resource,
    hashSegment,
  ] = parts;
  const platform = isPlatform(platformSegment) ? platformSegment : undefined;
  const channel = isChannel(channelSegment) ? channelSegment : undefined;
  const runtime = decodeRuntime(runtimeSegment);

  if (
    version !== "v1" ||
    projects !== "projects" ||
    project !== PROJECT ||
    platforms !== "platforms" ||
    !platform ||
    channels !== "channels" ||
    !channel ||
    runtimes !== "runtimes" ||
    !runtime
  ) {
    return undefined;
  }

  if (resource === "manifest" && parts.length === 11 && hashSegment === undefined) {
    return { kind: "manifest", platform, channel, runtime };
  }

  const hash = decodeSegment(hashSegment);
  if (resource === "assets" && parts.length === 12 && hash && SHA256_HEX.test(hash)) {
    return { kind: "asset", platform, channel, runtime, hash };
  }
  return undefined;
}

export function manifestKey(route: Pick<ManifestRoute, "platform" | "channel" | "runtime">): string {
  return `releases/${PROJECT}/${route.platform}/${route.channel}/${route.runtime}/manifest.json`;
}

export function assetKey(route: Pick<AssetRoute, "platform" | "channel" | "runtime" | "hash">): string {
  return `releases/${PROJECT}/${route.platform}/${route.channel}/${route.runtime}/assets/${route.hash}`;
}

export function isContentType(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  const mediaType = value.split(";", 1)[0]?.trim() ?? "";
  return MIME_TYPE.test(mediaType);
}

export function isUncompressed(value: unknown): boolean {
  return value === undefined || value === "" || (typeof value === "string" && value.toLowerCase() === "identity");
}

export function isManifestContentType(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MANIFEST_CONTENT_TYPES.has(mediaType);
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

export function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  try {
    const decoded = base64.decode(value);
    return base64.encode(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
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
    alg.value !== SIGNING_ALGORITHM ||
    !decodeCanonicalBase64(signature.value)?.length
  ) {
    return undefined;
  }
  return { keyid: keyid.value, alg: SIGNING_ALGORITHM };
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

export function accepts(contentType: string, accept: string | undefined): boolean {
  if (!accept) return true;

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!mediaType || !mediaType.includes("/")) return false;

  let bestSpecificity = -1;
  let bestQuality = 0;
  for (const entry of accept.split(",")) {
    const [rawCandidate, ...parameters] = entry.trim().toLowerCase().split(";");
    const candidate = rawCandidate?.trim() ?? "";
    if (!candidate) continue;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    let qualityValue = 1;
    if (quality) {
      qualityValue = Number(quality.trim().slice(2));
      if (!Number.isFinite(qualityValue) || qualityValue < 0) continue;
    }

    const specificity =
      candidate === mediaType ? 2 : candidate === `${mediaType.split("/", 1)[0]}/*` ? 1 : candidate === "*/*" ? 0 : -1;
    if (specificity < 0) continue;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQuality = qualityValue;
    } else if (specificity === bestSpecificity) {
      bestQuality = Math.max(bestQuality, qualityValue);
    }
  }
  return bestSpecificity >= 0 && bestQuality > 0;
}
