import {
  ASSET_CACHE_CONTROL,
  DEFAULT_MANIFEST_CACHE_CONTROL,
  PROTOCOL_VERSION,
  SFV_VERSION,
  accepts,
  assetKey,
  isContentType,
  isManifestContentType,
  isUncompressed,
  manifestKey,
  parseSignature,
  parseSignatureExpectation,
  type AssetRoute,
  type ManifestRoute,
} from "./validation";

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function getManifest(request: Request, env: Env, route: ManifestRoute): Promise<Response> {
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

  const object = await env.RELEASES.get(manifestKey(route));
  const contentType = object?.httpMetadata?.contentType;
  const contentEncoding = object?.httpMetadata?.contentEncoding;
  const signatureText = object?.customMetadata?.signature;
  const signature = parseSignature(signatureText);
  if (
    !object ||
    !isManifestContentType(contentType) ||
    !isUncompressed(contentEncoding) ||
    typeof signatureText !== "string" ||
    !signature
  ) {
    return jsonError(404, "release not found");
  }
  if (
    (expected?.keyid !== undefined && expected.keyid !== signature.keyid) ||
    (expected?.alg !== undefined && expected.alg !== signature.alg)
  ) {
    return jsonError(404, "invalid release");
  }
  if (!accepts(contentType, request.headers.get("accept") ?? undefined)) {
    return jsonError(406, "manifest content type is not acceptable");
  }

  const responseHeaders = new Headers({
    "content-type": contentType,
    "expo-protocol-version": PROTOCOL_VERSION,
    "expo-sfv-version": SFV_VERSION,
    "expo-signature": signatureText,
    "expo-manifest-filters": "",
    "expo-server-defined-headers": "",
    "cache-control": DEFAULT_MANIFEST_CACHE_CONTROL,
  });
  return new Response(object.body, { headers: responseHeaders });
}

export async function getAsset(route: AssetRoute, env: Env): Promise<Response> {
  const object = await env.RELEASES.get(assetKey(route));
  const contentType = object?.httpMetadata?.contentType;
  const contentEncoding = object?.httpMetadata?.contentEncoding;
  if (!object || !isContentType(contentType) || !isUncompressed(contentEncoding)) {
    return jsonError(404, "asset not found");
  }

  const headers = new Headers({
    "cache-control": ASSET_CACHE_CONTROL,
    "content-type": contentType,
    "content-length": String(object.size),
  });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
