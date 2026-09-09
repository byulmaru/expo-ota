import {
  ASSET_CACHE_CONTROL,
  contentEncodingSchema,
  contentTypeSchema,
  DEFAULT_MANIFEST_CACHE_CONTROL,
  type ManifestRequestHeaders,
  manifestContentTypeSchema,
  PROTOCOL_VERSION,
  SFV_VERSION,
  accepts,
  assetKey,
  manifestKey,
  parseSignature,
  parseSignatureExpectation,
  type AssetRoute,
  type ManifestRoute,
} from "./validation";
import { z } from "zod";

const manifestMetadataSchema = z.object({
  contentType: manifestContentTypeSchema,
  contentEncoding: contentEncodingSchema,
});
const assetMetadataSchema = z.object({
  contentType: contentTypeSchema,
  contentEncoding: contentEncodingSchema,
});

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function getManifest(
  request: Request,
  env: Env,
  route: ManifestRoute,
  requestHeaders: ManifestRequestHeaders,
): Promise<Response> {
  if (
    requestHeaders["expo-platform"] !== route.platform ||
    requestHeaders["expo-runtime-version"] !== route.runtime
  ) {
    return jsonError(400, "request headers do not match release tuple");
  }

  const expectationHeader = requestHeaders["expo-expect-signature"];
  const expected = expectationHeader === undefined ? undefined : parseSignatureExpectation(expectationHeader);
  if (expectationHeader !== undefined && !expected) {
    return jsonError(400, "invalid signature expectation");
  }

  const object = await env.RELEASES.get(manifestKey(route));
  const metadata = manifestMetadataSchema.safeParse({
    contentType: object?.httpMetadata?.contentType,
    contentEncoding: object?.httpMetadata?.contentEncoding,
  });
  const signatureText = object?.customMetadata?.signature ?? "";
  const signature = parseSignature(signatureText);
  if (!object || !metadata.success || !signature) {
    return jsonError(404, "release not found");
  }
  if (
    (expected?.keyid !== undefined && expected.keyid !== signature.keyid) ||
    (expected?.alg !== undefined && expected.alg !== signature.alg)
  ) {
    return jsonError(404, "invalid release");
  }
  if (!accepts(metadata.data.contentType, request.headers.get("accept") ?? undefined)) {
    return jsonError(406, "manifest content type is not acceptable");
  }

  const responseHeaders = new Headers({
    "content-type": metadata.data.contentType,
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
  const metadata = assetMetadataSchema.safeParse({
    contentType: object?.httpMetadata?.contentType,
    contentEncoding: object?.httpMetadata?.contentEncoding,
  });
  if (!object || !metadata.success) {
    return jsonError(404, "asset not found");
  }

  const headers = new Headers({
    "cache-control": ASSET_CACHE_CONTROL,
    "content-type": metadata.data.contentType,
    "content-length": String(object.size),
  });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
