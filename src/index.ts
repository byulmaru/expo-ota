import { Hono } from "hono";
import { releaseApp } from "./release";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  if (c.req.method !== "GET") return c.text("Method Not Allowed", 405);
  return next();
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.route("/v1/projects/:project/platforms/:platform/channels/:channel/runtimes/:runtime", releaseApp);

export default app;
