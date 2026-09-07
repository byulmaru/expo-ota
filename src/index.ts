import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getAsset, getManifest } from "./release";
import {
  assetParamsSchema,
  manifestHeadersSchema,
  manifestParamsSchema,
  PROJECT,
} from "./validation";

const app = new Hono<{ Bindings: Env }>();
const basePath = `/v1/projects/${PROJECT}/platforms/:platform/channels/:channel/runtimes/:runtime`;
const manifestPath = `${basePath}/manifest`;
const assetPath = `${basePath}/assets/:hash`;

app.use("*", async (c, next) => {
  if (c.req.method !== "GET") return c.text("Method Not Allowed", 405);
  return next();
});

app.get(
  manifestPath,
  zValidator("param", manifestParamsSchema, (result, c) => {
    if (!result.success) return c.json({ error: "not found" }, 404);
  }),
  zValidator("header", manifestHeadersSchema, (result, c) => {
    if (!result.success) return c.json({ error: "invalid request" }, 400);
  }),
  async (c) => {
    return getManifest(c.req.raw, c.env, c.req.valid("param"), c.req.valid("header"));
  },
);

app.get(
  assetPath,
  zValidator("param", assetParamsSchema, (result, c) => {
    if (!result.success) return c.json({ error: "not found" }, 404);
  }),
  async (c) => {
    return getAsset(c.req.valid("param"), c.env);
  },
);

app.notFound((c) => c.json({ error: "not found" }, 404));

export default app;
