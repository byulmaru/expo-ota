import { hex } from "@scure/base";
import {
  ASSET_CACHE_CONTROL,
  DEFAULT_MANIFEST_CACHE_CONTROL,
  MAX_MANIFEST_BYTES,
  PROJECT,
  PROTOCOL_VERSION,
  SFV_VERSION,
  decodeCanonicalBase64,
  isContentType,
  manifestSchema,
  parsePointer,
  parseSignature,
  parseSignatureExpectation,
  validateAssetReferences,
  type ChannelPointer,
  type ManifestHeaders,
  type ManifestRoute,
  type AssetRoute,
  type ParsedSignature,
} from "./validation";

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function verifyManifestSignature(
  bytes: ArrayBuffer,
  signature: ParsedSignature,
  env: Env,
): Promise<boolean> {
  const pem = env.EXPO_OTA_PUBLIC_KEY_PEM;
  if (typeof pem !== "string" || !pem.trim()) return false;
  const match = /^-----BEGIN PUBLIC KEY-----([\s\S]+)-----END PUBLIC KEY-----$/.exec(pem.trim());
  if (!match) return false;
  const der = decodeCanonicalBase64(match[1]!.replace(/\s/g, ""));
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

export async function getManifest(
  request: Request,
  env: Env,
  route: ManifestRoute,
  headers: ManifestHeaders,
): Promise<Response> {
  if (headers["expo-protocol-version"] !== PROTOCOL_VERSION) {
    return jsonError(400, "unsupported expo protocol version");
  }
  if (headers["expo-platform"] !== route.platform || headers["expo-runtime-version"] !== route.runtime) {
    return jsonError(400, "request headers do not match release tuple");
  }

  const expectationHeader = headers["expo-expect-signature"];
  const expected = expectationHeader === undefined ? undefined : parseSignatureExpectation(expectationHeader);
  if (expectationHeader !== undefined && !expected) return jsonError(400, "invalid signature expectation");

  const prefix = `releases/${PROJECT}/${route.platform}/${route.channel}/${route.runtime}/`;
  const pointerObject = await env.RELEASES.get(`${prefix}pointer.json`);
  if (!pointerObject) return jsonError(404, "release not found");

  let pointer: ChannelPointer | undefined;
  try {
    pointer = parsePointer(await pointerObject.json<unknown>(), route);
  } catch {
    pointer = undefined;
  }
  if (!pointer) return jsonError(404, "release not found");

  const signature = parseSignature(pointer.signature);
  if (
    !signature ||
    (expected?.keyid !== undefined && expected.keyid !== signature.keyid) ||
    (expected?.alg !== undefined && expected.alg !== signature.alg)
  ) {
    return jsonError(404, "invalid release");
  }
  const manifestMediaType = pointer.contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (
    headers.accept &&
    !headers.accept.split(",").some((entry) => {
      const [rawCandidate, ...parameters] = entry.trim().toLowerCase().split(";");
      const candidate = rawCandidate?.trim() ?? "";
      if (!candidate) return false;
      const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
      if (quality) {
        const value = Number(quality.trim().slice(2));
        if (!Number.isFinite(value) || value <= 0) return false;
      }
      return (
        candidate === "*/*" ||
        candidate === manifestMediaType ||
        candidate === `${manifestMediaType.split("/", 1)[0]}/*`
      );
    })
  ) {
    return jsonError(406, "manifest content type is not acceptable");
  }

  const manifestObject = await env.RELEASES.get(pointer.manifestKey);
  const manifestContentType = manifestObject?.httpMetadata?.contentType;
  if (!manifestObject || manifestObject.size > MAX_MANIFEST_BYTES || !manifestContentType) {
    return jsonError(404, "invalid release");
  }
  if (manifestContentType.split(";", 1)[0]!.trim().toLowerCase() !== manifestMediaType) {
    return jsonError(404, "invalid release");
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await manifestObject.arrayBuffer();
    if (bytes.byteLength > MAX_MANIFEST_BYTES) return jsonError(404, "invalid release");
  } catch {
    return jsonError(404, "invalid release");
  }
  if (!(await verifyManifestSignature(bytes, signature, env))) return jsonError(404, "invalid release");

  let manifest;
  try {
    manifest = manifestSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)),
    );
  } catch {
    return jsonError(404, "invalid release");
  }
  if (!manifest.success || !validateAssetReferences(manifest.data, route, new URL(request.url))) {
    return jsonError(404, "invalid release");
  }

  const responseHeaders = new Headers({
    "content-type": pointer.contentType,
    "expo-protocol-version": PROTOCOL_VERSION,
    "expo-sfv-version": SFV_VERSION,
    "expo-signature": pointer.signature,
    "cache-control": DEFAULT_MANIFEST_CACHE_CONTROL,
  });
  return new Response(bytes, { headers: responseHeaders });
}

export async function getAsset(route: AssetRoute, env: Env): Promise<Response> {
  const object = await env.RELEASES.get(
    `releases/${PROJECT}/${route.platform}/${route.channel}/${route.runtime}/assets/${route.hash}`,
  );
  if (!object || !object.checksums?.sha256 || !object.httpMetadata?.contentType) {
    return jsonError(404, "asset not found");
  }
  const checksum = hex.encode(new Uint8Array(object.checksums.sha256));
  if (checksum !== route.hash || !isContentType(object.httpMetadata.contentType)) {
    return jsonError(404, "asset not found");
  }

  const headers = new Headers({
    "cache-control": ASSET_CACHE_CONTROL,
    "content-type": object.httpMetadata.contentType,
    "content-length": String(object.size),
  });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
