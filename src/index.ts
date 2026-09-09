import { getAsset, getManifest } from "./release";
import { parseRoute } from "./validation";

function notFound(): Response {
  return Response.json({ error: "not found" }, { status: 404 });
}

const worker = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

    const route = parseRoute(new URL(request.url).pathname);
    if (!route) return notFound();
    if (route.kind === "manifest") return getManifest(request, env, route);
    return getAsset(route, env);
  },
} satisfies ExportedHandler<Env>;

export default worker;
