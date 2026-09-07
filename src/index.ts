const PROJECT = "kosmo-native" as const;
const PROTOCOL_VERSION = "1" as const;
const SFV_VERSION = "0" as const;
const DEFAULT_MANIFEST_CACHE_CONTROL = "private, no-store";
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MANIFEST_CONTENT_TYPES = new Set(["application/expo+json", "application/json"]);
const SIGNING_ALGORITHM = "rsa-v1_5-sha256" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNTIME = /^[^/\\\u0000-\u001f\u007f]+$/;
const MIME_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

type Platform = "ios" | "android";
type Channel = "staging" | "production";

interface ChannelPointer {
  complete: true;
  manifestKey: string;
  signature: string;
  contentType: string;
}

interface ExpoAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension?: string;
  url: string;
}

interface ExpoManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: ExpoAsset;
  assets: ExpoAsset[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

type SfvValue = { kind: "boolean"; value: true } | { kind: "string"; value: string };

interface ParsedSignature {
  sig: Uint8Array;
  keyid: string;
  alg: typeof SIGNING_ALGORITHM;
}

interface SignatureExpectation {
  keyid?: string;
  alg?: typeof SIGNING_ALGORITHM;
}

type Route =
  | {
      kind: "manifest";
      platform: Platform;
      channel: Channel;
      runtime: string;
    }
  | {
      kind: "asset";
      platform: Platform;
      channel: Channel;
      runtime: string;
      hash: string;
    };

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function isPlatform(value: string | undefined): value is Platform {
  return value === "ios" || value === "android";
}

function isChannel(value: string | undefined): value is Channel {
  return value === "staging" || value === "production";
}

function decodeSegment(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function decodeRuntime(segment: string | undefined): string | undefined {
  const runtime = decodeSegment(segment);
  if (!runtime || runtime === "." || runtime === ".." || !RUNTIME.test(runtime)) return undefined;
  return runtime;
}

function parseRoute(url: URL): Route | undefined {
  const parts = url.pathname.split("/");
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

function releasePrefix(route: Pick<Route, "platform" | "channel" | "runtime">): string {
  return `releases/${PROJECT}/${route.platform}/${route.channel}/${route.runtime}/`;
}

function pointerKey(route: Pick<Route, "platform" | "channel" | "runtime">): string {
  return `${releasePrefix(route)}pointer.json`;
}

function assetKey(route: Pick<Route, "platform" | "channel" | "runtime">, hash: string): string {
  return `${releasePrefix(route)}assets/${hash}`;
}

function isManifestKey(route: Pick<Route, "platform" | "channel" | "runtime">, key: string): boolean {
  const prefix = releasePrefix(route);
  if (key === `${prefix}manifest.json`) return true;
  const manifestPrefix = `${prefix}manifests/`;
  const suffix = key.startsWith(manifestPrefix) ? key.slice(manifestPrefix.length) : "";
  return suffix.length > 0 && !suffix.includes("/");
}

function isContentType(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && MIME_TYPE.test(value);
}

function bytesToHex(value: ArrayBufferLike | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isManifestContentType(value: unknown): value is string {
  return typeof value === "string" && MANIFEST_CONTENT_TYPES.has(value.split(";", 1)[0]!.trim().toLowerCase());
}

function isManifestHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_BASE64URL.test(value);
}

function skipSpaces(input: string, index: number): number {
  while (input[index] === " " || input[index] === "\t") index += 1;
  return index;
}

function parseSfvString(input: string, index: number): { value: string; index: number } | undefined {
  if (input[index] !== '"') return undefined;
  let value = "";
  index += 1;
  while (index < input.length) {
    const character = input[index]!;
    if (character === '"') return { value, index: index + 1 };
    if (character === "\\") {
      const escaped = input[index + 1];
      if (escaped !== "\\" && escaped !== '"') return undefined;
      value += escaped;
      index += 2;
      continue;
    }
    const codePoint = character.charCodeAt(0);
    if (codePoint < 0x20 || codePoint > 0x7e) return undefined;
    value += character;
    index += 1;
  }
  return undefined;
}

function parseSfvDictionary(input: string): Record<string, SfvValue> | undefined {
  const result: Record<string, SfvValue> = {};
  let index = 0;
  while (true) {
    index = skipSpaces(input, index);
    const keyStart = index;
    while (index < input.length && /[a-z0-9_*.-]/.test(input[index]!)) index += 1;
    const key = input.slice(keyStart, index);
    if (!key || !/^[a-z][a-z0-9_*.-]*$/.test(key) || key in result) return undefined;

    index = skipSpaces(input, index);
    if (input[index] === "=") {
      const parsed = parseSfvString(input, skipSpaces(input, index + 1));
      if (!parsed) return undefined;
      result[key] = { kind: "string", value: parsed.value };
      index = parsed.index;
    } else {
      result[key] = { kind: "boolean", value: true };
    }

    index = skipSpaces(input, index);
    if (index === input.length) return result;
    if (input[index] !== ",") return undefined;
    index = skipSpaces(input, index + 1);
    if (index === input.length) return undefined;
  }
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0) return undefined;
  const decoded = decodeBase64(value);
  if (!decoded) return undefined;
  let bytes = "";
  for (const byte of decoded) bytes += String.fromCharCode(byte);
  return btoa(bytes) === value ? decoded : undefined;
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!SHA256_BASE64URL.test(value)) return undefined;
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = decodeBase64(`${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`);
  if (!decoded) return undefined;
  let bytes = "";
  for (const byte of decoded) bytes += String.fromCharCode(byte);
  const canonical = btoa(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return canonical === value ? decoded : undefined;
}

function parseSignature(value: unknown): ParsedSignature | undefined {
  if (typeof value !== "string") return undefined;
  const dictionary = parseSfvDictionary(value);
  const signature = dictionary?.sig;
  const keyid = dictionary?.keyid;
  const alg = dictionary?.alg;
  if (
    !signature ||
    signature.kind !== "string" ||
    !keyid ||
    keyid.kind !== "string" ||
    keyid.value.length === 0 ||
    !alg ||
    alg.kind !== "string" ||
    alg.value !== SIGNING_ALGORITHM ||
    Object.keys(dictionary ?? {}).some((key) => !["sig", "keyid", "alg"].includes(key))
  ) {
    return undefined;
  }
  const sig = decodeCanonicalBase64(signature.value);
  if (!sig || sig.length === 0) return undefined;
  return { sig, keyid: keyid.value, alg: alg.value };
}

function parseSignatureExpectation(value: string): SignatureExpectation | undefined {
  const dictionary = parseSfvDictionary(value);
  const sig = dictionary?.sig;
  const keyid = dictionary?.keyid;
  const alg = dictionary?.alg;
  if (
    !sig ||
    sig.kind !== "boolean" ||
    (keyid !== undefined && keyid.kind !== "string") ||
    (alg !== undefined && (alg.kind !== "string" || alg.value !== SIGNING_ALGORITHM)) ||
    Object.keys(dictionary ?? {}).some((key) => !["sig", "keyid", "alg"].includes(key))
  ) {
    return undefined;
  }
  return {
    ...(keyid === undefined ? {} : { keyid: keyid.value }),
    ...(alg === undefined ? {} : { alg: SIGNING_ALGORITHM }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function parsePointer(value: unknown, route: Route): ChannelPointer | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.complete !== true ||
    typeof value.manifestKey !== "string" ||
    !isManifestKey(route, value.manifestKey) ||
    typeof value.signature !== "string" ||
    !isManifestContentType(value.contentType)
  ) {
    return undefined;
  }
  return {
    complete: true,
    manifestKey: value.manifestKey,
    signature: value.signature,
    contentType: value.contentType,
  };
}

function parseExpoAsset(value: unknown): ExpoAsset | undefined {
  if (!isRecord(value) || !isManifestHash(value.hash) || typeof value.key !== "string" || !value.key) return undefined;
  if (!isContentType(value.contentType) || typeof value.url !== "string" || !value.url) return undefined;
  if (value.fileExtension !== undefined && typeof value.fileExtension !== "string") return undefined;
  return {
    hash: value.hash,
    key: value.key,
    contentType: value.contentType,
    url: value.url,
    ...(value.fileExtension === undefined ? {} : { fileExtension: value.fileExtension }),
  };
}

function parseManifest(value: unknown): ExpoManifest | undefined {
  if (!isRecord(value)) return undefined;
  const launchAsset = parseExpoAsset(value.launchAsset);
  const rawAssets = value.assets;
  if (!Array.isArray(rawAssets)) return undefined;
  const assets: ExpoAsset[] = [];
  for (const rawAsset of rawAssets) {
    const asset = parseExpoAsset(rawAsset);
    if (!asset) return undefined;
    assets.push(asset);
  }
  if (
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !isDateTime(value.createdAt) ||
    typeof value.runtimeVersion !== "string" ||
    !launchAsset ||
    !isRecord(value.metadata) ||
    !Object.values(value.metadata).every((entry) => typeof entry === "string") ||
    !isRecord(value.extra)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    runtimeVersion: value.runtimeVersion,
    launchAsset,
    assets,
    metadata: value.metadata as Record<string, string>,
    extra: value.extra,
  };
}

function hashToRouteHash(hash: string): string | undefined {
  const bytes = decodeBase64Url(hash);
  if (!bytes || bytes.byteLength !== 32) return undefined;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateAssetReferences(
  manifest: ExpoManifest,
  route: Extract<Route, { kind: "manifest" }>,
  requestUrl: URL,
): boolean {
  if (manifest.runtimeVersion !== route.runtime) return false;
  for (const asset of [manifest.launchAsset, ...manifest.assets]) {
    const routeHash = hashToRouteHash(asset.hash);
    if (!routeHash) return false;

    let assetUrl: URL;
    try {
      assetUrl = new URL(asset.url, requestUrl);
    } catch {
      return false;
    }
    const assetRoute = parseRoute(assetUrl);
    if (
      !assetRoute ||
      assetRoute.kind !== "asset" ||
      assetUrl.origin !== requestUrl.origin ||
      assetUrl.search ||
      assetUrl.hash ||
      assetRoute.platform !== route.platform ||
      assetRoute.channel !== route.channel ||
      assetRoute.runtime !== route.runtime ||
      assetRoute.hash !== routeHash
    ) {
      return false;
    }
  }
  return true;
}

function accepts(contentType: string, request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return true;
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return accept.split(",").some((entry) => {
    const [rawCandidate, ...parameters] = entry.trim().toLowerCase().split(";");
    const candidate = rawCandidate?.trim() ?? "";
    if (!candidate) return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    if (quality) {
      const value = Number(quality.trim().slice(2));
      if (!Number.isFinite(value) || value <= 0) return false;
    }
    return candidate === "*/*" || candidate === mediaType || candidate === `${mediaType.split("/", 1)[0]}/*`;
  });
}

function decodePem(value: string): Uint8Array | undefined {
  const match = /^-----BEGIN PUBLIC KEY-----([\s\S]+)-----END PUBLIC KEY-----$/.exec(value.trim());
  if (!match) return undefined;
  return decodeCanonicalBase64(match[1]!.replace(/\s/g, ""));
}

async function verifyManifestSignature(bytes: ArrayBuffer, signature: ParsedSignature, env: Env): Promise<boolean> {
  const pem = env.EXPO_OTA_PUBLIC_KEY_PEM;
  if (typeof pem !== "string" || !pem.trim()) return false;
  const der = decodePem(pem);
  if (!der) return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature.sig, bytes);
  } catch {
    return false;
  }
}

function signatureIsCompatible(signature: ParsedSignature, expected: SignatureExpectation | undefined): boolean {
  if (!expected) return true;
  return (
    (expected.keyid === undefined || expected.keyid === signature.keyid) &&
    (expected.alg === undefined || expected.alg === signature.alg)
  );
}

async function readPointer(env: Env, route: Route): Promise<ChannelPointer | undefined> {
  const object = await env.RELEASES.get(pointerKey(route));
  if (!object) return undefined;
  try {
    return parsePointer(await object.json<unknown>(), route);
  } catch {
    return undefined;
  }
}

async function getManifest(request: Request, env: Env, route: Extract<Route, { kind: "manifest" }>): Promise<Response> {
  if (request.headers.get("expo-protocol-version") !== PROTOCOL_VERSION) {
    return jsonError(400, "unsupported expo protocol version");
  }
  if (
    request.headers.get("expo-platform") !== route.platform ||
    request.headers.get("expo-runtime-version") !== route.runtime
  ) {
    return jsonError(400, "request headers do not match release tuple");
  }

  const expectationHeader = request.headers.get("expo-expect-signature");
  const expected = expectationHeader === null ? undefined : parseSignatureExpectation(expectationHeader);
  if (expectationHeader !== null && !expected) return jsonError(400, "invalid signature expectation");

  const pointer = await readPointer(env, route);
  if (!pointer) return jsonError(404, "release not found");
  const signature = parseSignature(pointer.signature);
  if (!signature || !signatureIsCompatible(signature, expected)) return jsonError(404, "invalid release");
  if (!accepts(pointer.contentType, request)) return jsonError(406, "manifest content type is not acceptable");

  const manifestObject = await env.RELEASES.get(pointer.manifestKey);
  if (!manifestObject || manifestObject.size > MAX_MANIFEST_BYTES || !manifestObject.httpMetadata?.contentType) {
    return jsonError(404, "invalid release");
  }
  if (
    manifestObject.httpMetadata?.contentType &&
    manifestObject.httpMetadata.contentType.split(";", 1)[0]!.trim().toLowerCase() !== pointer.contentType.split(";", 1)[0]!.trim().toLowerCase()
  ) {
    return jsonError(404, "invalid release");
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await new Response(manifestObject.body).arrayBuffer();
    if (bytes.byteLength > MAX_MANIFEST_BYTES) return jsonError(404, "invalid release");
  } catch {
    return jsonError(404, "invalid release");
  }
  if (!(await verifyManifestSignature(bytes, signature, env))) return jsonError(404, "invalid release");

  let manifest: ExpoManifest | undefined;
  try {
    manifest = parseManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
  } catch {
    return jsonError(404, "invalid release");
  }
  if (!manifest || !validateAssetReferences(manifest, route, new URL(request.url))) {
    return jsonError(404, "invalid release");
  }

  const headers = new Headers({
    "content-type": pointer.contentType,
    "expo-protocol-version": PROTOCOL_VERSION,
    "expo-sfv-version": SFV_VERSION,
    "expo-signature": pointer.signature,
    "cache-control": DEFAULT_MANIFEST_CACHE_CONTROL,
  });
  return new Response(bytes, { headers });
}

async function getAsset(route: Extract<Route, { kind: "asset" }>, env: Env): Promise<Response> {
  const object = await env.RELEASES.get(assetKey(route, route.hash));
  if (
    !object ||
    !object.checksums.sha256 ||
    bytesToHex(object.checksums.sha256) !== route.hash ||
    !object.httpMetadata?.contentType
  ) {
    return jsonError(404, "asset not found");
  }
  if (!isContentType(object.httpMetadata.contentType)) return jsonError(404, "asset not found");

  const headers = new Headers({
    "cache-control": ASSET_CACHE_CONTROL,
    "content-type": object.httpMetadata.contentType,
    "content-length": String(object.size),
  });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

const handler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const route = parseRoute(new URL(request.url));
    if (!route) return jsonError(404, "not found");
    if (route.kind === "manifest") return getManifest(request, env, route);
    return getAsset(route, env);
  },
} satisfies ExportedHandler<Env>;

export default handler;
