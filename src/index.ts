import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getAsset, getManifest } from "./release";
import {
  assetParamsSchema,
  manifestParamsSchema,
  manifestRequestHeadersSchema,
} from "./validation";

const RELEASE_PATH = "/v1/projects/:project/platforms/:platform/channels/:channel/runtimes/:runtime";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  if (c.req.method !== "GET") return c.text("Method Not Allowed", 405);
  await next();
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.get(
  `${RELEASE_PATH}/manifest`,
  zValidator("param", manifestParamsSchema, (result, c) => {
    if (!result.success) return c.notFound();
  }),
  zValidator("header", manifestRequestHeadersSchema, (result, c) => {
    if (!result.success) return c.json({ error: "unsupported expo protocol version" }, 400);
  }),
  (c) => getManifest(c.req.raw, c.env, c.req.valid("param"), c.req.valid("header")),
);

app.get(
  `${RELEASE_PATH}/assets/:hash`,
  zValidator("param", assetParamsSchema, (result, c) => {
    if (!result.success) return c.notFound();
  }),
  (c) => getAsset(c.req.valid("param"), c.env),
);

export default app;
