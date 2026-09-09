import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  ASSET_CACHE_CONTROL,
  assetParamsSchema,
  contentEncodingSchema,
  contentTypeSchema,
  DEFAULT_MANIFEST_CACHE_CONTROL,
  manifestParamsSchema,
  manifestRequestHeadersSchema,
  manifestContentTypeSchema,
  PROTOCOL_VERSION,
  SFV_VERSION,
  accepts,
  parseSignature,
  parseSignatureExpectation,
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

export const releaseApp = new Hono<{ Bindings: Env }>();

releaseApp.get(
  "/manifest",
  zValidator("param", manifestParamsSchema, (result, c) => {
    if (!result.success) return c.notFound();
  }),
  zValidator("header", manifestRequestHeadersSchema, (result, c) => {
    if (!result.success) return c.json({ error: "unsupported expo protocol version" }, 400);
  }),
  async (c) => {
    const route = c.req.valid("param");
    const requestHeaders = c.req.valid("header");
    if (
      requestHeaders["expo-platform"] !== route.platform ||
      requestHeaders["expo-runtime-version"] !== route.runtime
    ) {
      return c.json({ error: "request headers do not match release tuple" }, 400);
    }

    const expectationHeader = requestHeaders["expo-expect-signature"];
    const expected = expectationHeader === undefined ? undefined : parseSignatureExpectation(expectationHeader);
    if (expectationHeader !== undefined && !expected) {
      return c.json({ error: "invalid signature expectation" }, 400);
    }

    const object = await c.env.RELEASES.get(
      `releases/${route.project}/${route.platform}/${route.channel}/${route.runtime}/manifest.json`,
    );
    const metadata = manifestMetadataSchema.safeParse({
      contentType: object?.httpMetadata?.contentType,
      contentEncoding: object?.httpMetadata?.contentEncoding,
    });
    const signatureText = object?.customMetadata?.signature ?? "";
    const signature = parseSignature(signatureText);
    if (!object || !metadata.success || !signature) {
      return c.json({ error: "release not found" }, 404);
    }
    if (
      (expected?.keyid !== undefined && expected.keyid !== signature.keyid) ||
      (expected?.alg !== undefined && expected.alg !== signature.alg)
    ) {
      return c.json({ error: "invalid release" }, 404);
    }
    if (!accepts(metadata.data.contentType, c.req.header("accept"))) {
      return c.json({ error: "manifest content type is not acceptable" }, 406);
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
  },
);

releaseApp.get(
  "/assets/:hash",
  zValidator("param", assetParamsSchema, (result, c) => {
    if (!result.success) return c.notFound();
  }),
  async (c) => {
    const route = c.req.valid("param");
    const object = await c.env.RELEASES.get(
      `releases/${route.project}/${route.platform}/${route.channel}/${route.runtime}/assets/${route.hash}`,
    );
    const metadata = assetMetadataSchema.safeParse({
      contentType: object?.httpMetadata?.contentType,
      contentEncoding: object?.httpMetadata?.contentEncoding,
    });
    if (!object || !metadata.success) {
      return c.json({ error: "asset not found" }, 404);
    }

    const headers = new Headers({
      "cache-control": ASSET_CACHE_CONTROL,
      "content-type": metadata.data.contentType,
      "content-length": String(object.size),
    });
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  },
);
