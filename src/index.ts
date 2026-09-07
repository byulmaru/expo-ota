interface ChannelPointer {
  complete: true;
  manifestKey: string;
  signature: string;
  contentType: string;
}

const PROJECT = "kosmo-native";
const PROTOCOL_VERSION = "1";
const SFV_VERSION = "0";
const MANIFEST_CONTENT_TYPES = new Set(["application/expo+json", "application/json"]);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const RUNTIME = /^[^/]+$/;

type Route =
  | {
      kind: "manifest";
      platform: "ios" | "android";
      channel: "staging" | "production";
      runtime: string;
    }
  | {
      kind: "asset";
      platform: "ios" | "android";
      channel: "staging" | "production";
      runtime: string;
      sha256: string;
    };

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function isChannelPointer(value: unknown): value is ChannelPointer {
  if (typeof value !== "object" || value === null) return false;
  const pointer = value as Record<string, unknown>;

  return (
    pointer.complete === true &&
    typeof pointer.manifestKey === "string" &&
    typeof pointer.signature === "string" &&
    pointer.signature.length > 0 &&
    typeof pointer.contentType === "string" &&
    pointer.contentType.length > 0 &&
    MANIFEST_CONTENT_TYPES.has(pointer.contentType.toLowerCase())
  );
}

function decodeRuntime(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    const runtime = decodeURIComponent(segment);
    return RUNTIME.test(runtime) ? runtime : undefined;
  } catch {
    return undefined;
  }
}

function parseRoute(url: URL): Route | undefined {
  const parts = url.pathname.split("/");
  if (parts.length < 10 || parts[0] !== "") return undefined;

  const [, version, projects, project, platforms, platform, channels, channel, runtimes, runtimeSegment, resource, key] = parts;
  const runtime = decodeRuntime(runtimeSegment);
  if (
    version !== "v1" ||
    projects !== "projects" ||
    project !== PROJECT ||
    platforms !== "platforms" ||
    (platform !== "ios" && platform !== "android") ||
    channels !== "channels" ||
    (channel !== "staging" && channel !== "production") ||
    runtimes !== "runtimes" ||
    !runtime
  ) {
    return undefined;
  }

  if (resource === "manifest" && key === undefined && parts.length === 11) {
    return { kind: "manifest", platform, channel, runtime };
  }

  if (resource === "assets" && key !== undefined && parts.length === 12 && SHA256_HEX.test(key)) {
    return { kind: "asset", platform, channel, runtime, sha256: key };
  }

  return undefined;
}

function pointerKey(route: Extract<Route, { kind: "manifest" }>): string {
  return `${releasePrefix(route)}pointer.json`;
}

function releasePrefix(route: Pick<Extract<Route, { kind: "manifest" }>, "platform" | "channel" | "runtime">): string {
  return `releases/${PROJECT}/${route.platform}/${route.channel}/${route.runtime}/`;
}

function isManifestKey(route: Extract<Route, { kind: "manifest" }>, key: string): boolean {
  const prefix = releasePrefix(route);
  if (key === `${prefix}manifest.json`) return true;

  const manifestPrefix = `${prefix}manifests/`;
  const suffix = key.startsWith(manifestPrefix) ? key.slice(manifestPrefix.length) : "";
  return suffix.length > 0 && !suffix.includes("/");
}

function accepts(contentType: string, request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return true;

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || !mediaType.includes("/")) return false;

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

  const pointerObject = await env.RELEASES.get(pointerKey(route));
  if (!pointerObject) return jsonError(404, "release not found");

  let pointer: unknown;
  try {
    pointer = await pointerObject.json<unknown>();
  } catch {
    return jsonError(404, "invalid release pointer");
  }

  if (
    !isChannelPointer(pointer) ||
    !isManifestKey(route, pointer.manifestKey)
  ) {
    return jsonError(404, "invalid release pointer");
  }
  if (!accepts(pointer.contentType, request)) {
    return jsonError(406, "manifest content type is not acceptable");
  }

  const manifestObject = await env.RELEASES.get(pointer.manifestKey);
  if (!manifestObject) return jsonError(404, "manifest not found");

  const headers = new Headers({
    "content-type": pointer.contentType,
    "expo-protocol-version": PROTOCOL_VERSION,
    "expo-sfv-version": SFV_VERSION,
    "expo-signature": pointer.signature,
    "cache-control": "private, no-store",
  });
  return new Response(manifestObject.body, { headers });
}

async function getAsset(env: Env, route: Extract<Route, { kind: "asset" }>): Promise<Response> {
  const object = await env.RELEASES.get(
    `releases/${PROJECT}/${route.platform}/${route.channel}/${route.runtime}/assets/${route.sha256}`,
  );
  if (!object) return jsonError(404, "asset not found");

  const headers = new Headers({
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
  });
  return new Response(object.body, { headers });
}

const handler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

    const route = parseRoute(new URL(request.url));
    if (!route) return jsonError(404, "not found");

    if (route.kind === "manifest") return getManifest(request, env, route);
    return getAsset(env, route);
  },
} satisfies ExportedHandler<Env>;

export default handler;
