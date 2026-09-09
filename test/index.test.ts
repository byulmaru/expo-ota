import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const PROJECT = "kosmo-native";
const PLATFORM = "ios";
const CHANNEL = "staging";
const ALGORITHM = "rsa-v1_5-sha256";
const SIGNATURE = `sig="c2lnbmF0dXJl", keyid="main", alg="${ALGORITHM}"`;
const ASSET_BODY = "javascript bundle";

let runtimeSequence = 0;

function nextRuntime(): string {
  runtimeSequence += 1;
  return `test-runtime-${runtimeSequence}`;
}

function encodeBase64Url(bytes: ArrayBufferLike | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  let value = "";
  for (const byte of view) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<{ base64Url: string; hex: string }> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return {
    base64Url: encodeBase64Url(digest),
    hex: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

function releasePrefix(runtime: string, platform = PLATFORM, channel = CHANNEL, project = PROJECT): string {
  return `releases/${project}/${platform}/${channel}/${runtime}`;
}

function manifestKey(runtime: string, platform = PLATFORM, channel = CHANNEL, project = PROJECT): string {
  return `${releasePrefix(runtime, platform, channel, project)}/manifest.json`;
}

function manifestPath(runtime: string, platform = PLATFORM, channel = CHANNEL, project = PROJECT): string {
  return `/v1/projects/${encodeURIComponent(project)}/platforms/${platform}/channels/${channel}/runtimes/${encodeURIComponent(runtime)}/manifest`;
}

function assetPath(runtime: string, hash: string, platform = PLATFORM, channel = CHANNEL, project = PROJECT): string {
  return `/v1/projects/${encodeURIComponent(project)}/platforms/${platform}/channels/${channel}/runtimes/${encodeURIComponent(runtime)}/assets/${hash}`;
}

function manifestHeaders(runtime: string, expectation?: string): HeadersInit {
  return {
    accept: "application/expo+json",
    "expo-platform": PLATFORM,
    "expo-protocol-version": "1",
    "expo-runtime-version": runtime,
    ...(expectation === undefined ? {} : { "expo-expect-signature": expectation }),
  };
}

function testEnv(): Env {
  return { RELEASES: env.RELEASES };
}

async function fetchWorker(path: string, init?: RequestInit, workerEnv = testEnv()): Promise<Response> {
  const request = new Request(`https://ota.example${path}`, init);
  const context = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

interface SeedManifestOptions {
  project?: string;
  runtime?: string;
  body?: string;
  signature?: string;
  contentType?: string;
  contentEncoding?: string;
}

async function seedManifest(options: SeedManifestOptions = {}) {
  const project = options.project ?? PROJECT;
  const runtime = options.runtime ?? nextRuntime();
  const body = options.body ?? `manifest bytes for ${runtime}\n`;
  const signature = options.signature ?? SIGNATURE;
  const contentType = options.contentType ?? "application/expo+json";
  await env.RELEASES.put(manifestKey(runtime, PLATFORM, CHANNEL, project), body, {
    httpMetadata: {
      contentType,
      ...(options.contentEncoding === undefined ? {} : { contentEncoding: options.contentEncoding }),
    },
    ...(signature === undefined ? {} : { customMetadata: { signature } }),
  });
  return { project, runtime, body, signature, contentType, prefix: releasePrefix(runtime, PLATFORM, CHANNEL, project) };
}

describe("Expo OTA Worker", () => {
  it("maps a tuple to one fixed manifest key and streams exact bytes with the stored signature", async () => {
    const release = await seedManifest({ body: "not JSON and intentionally unchanged\n\u0000" });
    await env.RELEASES.put(`${release.prefix}/pointer.json`, "pointer is not part of delivery");

    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime, `sig, keyid="main", alg="${ALGORITHM}"`),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    expect(response.headers.get("expo-signature")).toBe(release.signature);
    expect(response.headers.get("expo-manifest-filters")).toBe("");
    expect(response.headers.get("expo-server-defined-headers")).toBe("");
    expect(response.headers.get("content-type")).toBe(release.contentType);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.arrayBuffer()).toEqual(new TextEncoder().encode(release.body).buffer);
  });

  it("promotes body and signature metadata from the same fixed R2 object", async () => {
    const runtime = nextRuntime();
    const nextSignature = `sig="bmV3", keyid="main", alg="${ALGORITHM}"`;
    await seedManifest({ runtime, body: "old manifest", signature: SIGNATURE });
    await env.RELEASES.put(manifestKey(runtime), "new manifest", {
      httpMetadata: { contentType: "application/expo+json" },
      customMetadata: { signature: nextSignature },
    });

    const response = await fetchWorker(manifestPath(runtime), { headers: manifestHeaders(runtime) });

    expect(response.status).toBe(200);
    expect(response.headers.get("expo-signature")).toBe(nextSignature);
    expect(await response.text()).toBe("new manifest");
  });

  it("requires the protocol and tuple headers", async () => {
    const release = await seedManifest();
    const missingProtocol = await fetchWorker(manifestPath(release.runtime), {
      headers: { ...manifestHeaders(release.runtime), "expo-protocol-version": "2" },
    });
    expect(missingProtocol.status).toBe(400);

    const mismatchedTuple = await fetchWorker(manifestPath(release.runtime), {
      headers: { ...manifestHeaders(release.runtime), "expo-runtime-version": "other-runtime" },
    });
    expect(mismatchedTuple.status).toBe(400);
  });

  it("uses the most specific Accept range, including an explicit q=0", async () => {
    const release = await seedManifest();
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: {
        ...manifestHeaders(release.runtime),
        accept: "application/expo+json;q=0, */*;q=1",
      },
    });
    expect(response.status).toBe(406);
  });

  it.each([
    ["wrong expected keyid", `sig, keyid="other", alg="${ALGORITHM}"`, 404],
    ["wrong expected algorithm", `sig, keyid="main", alg="other"`, 400],
    ["malformed expectation", `sig, keyid="main", alg="${ALGORITHM}" trailing`, 400],
  ])("handles %s signature expectation", async (_label, expectation, status) => {
    const release = await seedManifest();
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime, expectation),
    });
    expect(response.status).toBe(status);
  });

  it.each([
    ["missing signature", undefined],
    ["malformed signature", "sig=:YWJj:, keyid=\"main\", alg=\"rsa-v1_5-sha256\""],
  ])("fails closed for %s manifest metadata", async (_label, signature) => {
    const runtime = nextRuntime();
    const contentType = "application/expo+json";
    await env.RELEASES.put(manifestKey(runtime), "manifest", {
      httpMetadata: { contentType },
      ...(signature === undefined ? {} : { customMetadata: { signature } }),
    });

    const response = await fetchWorker(manifestPath(runtime), { headers: manifestHeaders(runtime) });
    expect(response.status).toBe(404);
  });

  it("uses structured-fields last-member semantics for duplicate keys", async () => {
    const release = await seedManifest({
      signature: `sig="c2lnbmF0dXJl", keyid="ignored", keyid="main", alg="${ALGORITHM}"`,
    });
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime, `sig, keyid="main", alg="${ALGORITHM}"`),
    });
    expect(response.status).toBe(200);
  });

  it("passes through a nonempty signature value without decoding it", async () => {
    const signature = `sig="not-base64", keyid="main", alg="${ALGORITHM}"`;
    const release = await seedManifest({ signature });
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-signature")).toBe(signature);
  });

  it("fails closed for a missing or unsupported manifest content type", async () => {
    const missingRuntime = nextRuntime();
    await env.RELEASES.put(manifestKey(missingRuntime), "manifest", {
      customMetadata: { signature: SIGNATURE },
    });
    expect((await fetchWorker(manifestPath(missingRuntime), { headers: manifestHeaders(missingRuntime) })).status).toBe(404);

    const unsupported = await seedManifest({ contentType: "text/plain" });
    expect((await fetchWorker(manifestPath(unsupported.runtime), { headers: manifestHeaders(unsupported.runtime) })).status).toBe(404);
  });

  it("keeps platform and channel namespaces isolated", async () => {
    const release = await seedManifest();
    const response = await fetchWorker(manifestPath(release.runtime, "android", "production"), {
      headers: { ...manifestHeaders(release.runtime), "expo-platform": "android" },
    });
    expect(response.status).toBe(404);
  });

  it("keeps project namespaces isolated for manifests and assets", async () => {
    const runtime = nextRuntime();
    const first = await seedManifest({ project: "kosmo-native", runtime, body: "first project manifest" });
    const second = await seedManifest({ project: "another project", runtime, body: "second project manifest" });

    const firstManifest = await fetchWorker(manifestPath(runtime, PLATFORM, CHANNEL, first.project), {
      headers: manifestHeaders(runtime),
    });
    const secondManifest = await fetchWorker(manifestPath(runtime, PLATFORM, CHANNEL, second.project), {
      headers: manifestHeaders(runtime),
    });

    expect(await firstManifest.text()).toBe(first.body);
    expect(await secondManifest.text()).toBe(second.body);

    const firstAssetBody = "first project asset";
    const secondAssetBody = "second project asset";
    const firstAsset = await sha256(firstAssetBody);
    const secondAsset = await sha256(secondAssetBody);
    await env.RELEASES.put(`${first.prefix}/assets/${firstAsset.hex}`, firstAssetBody, {
      httpMetadata: { contentType: "application/javascript" },
    });
    await env.RELEASES.put(`${second.prefix}/assets/${secondAsset.hex}`, secondAssetBody, {
      httpMetadata: { contentType: "application/javascript" },
    });

    const firstAssetResponse = await fetchWorker(
      assetPath(runtime, firstAsset.hex, PLATFORM, CHANNEL, first.project),
    );
    const secondAssetResponse = await fetchWorker(
      assetPath(runtime, secondAsset.hex, PLATFORM, CHANNEL, second.project),
    );
    const crossProjectAssetResponse = await fetchWorker(
      assetPath(runtime, firstAsset.hex, PLATFORM, CHANNEL, second.project),
    );

    expect(await firstAssetResponse.text()).toBe(firstAssetBody);
    expect(await secondAssetResponse.text()).toBe(secondAssetBody);
    expect(crossProjectAssetResponse.status).toBe(404);
  });

  it.each(["..", "../other", "project/name"])("rejects unsafe project path segment %s", async (project) => {
    const runtime = nextRuntime();
    const response = await fetchWorker(manifestPath(runtime, PLATFORM, CHANNEL, project), {
      headers: manifestHeaders(runtime),
    });
    expect(response.status).toBe(404);
  });

  it("decodes one runtime path segment before mapping the fixed key", async () => {
    const runtime = "runtime with spaces";
    const release = await seedManifest({ runtime });
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(release.body);

    const traversal = await fetchWorker(manifestPath("../other"), {
      headers: manifestHeaders("../other"),
    });
    expect(traversal.status).toBe(404);

    const dotSegment = await fetchWorker(manifestPath(".."), {
      headers: manifestHeaders(".."),
    });
    expect(dotSegment.status).toBe(404);
  });

  it("rejects compressed manifest and asset objects", async () => {
    const compressedManifest = await seedManifest({ contentEncoding: "gzip" });
    const manifestResponse = await fetchWorker(manifestPath(compressedManifest.runtime), {
      headers: manifestHeaders(compressedManifest.runtime),
    });
    expect(manifestResponse.status).toBe(404);

    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    await env.RELEASES.put(`${releasePrefix(runtime)}/assets/${assetHash.hex}`, ASSET_BODY, {
      httpMetadata: { contentType: "application/javascript", contentEncoding: "br" },
    });
    const assetResponse = await fetchWorker(assetPath(runtime, assetHash.hex));
    expect(assetResponse.status).toBe(404);

    const identityManifest = await seedManifest({ contentEncoding: "identity" });
    const identityResponse = await fetchWorker(manifestPath(identityManifest.runtime), {
      headers: manifestHeaders(identityManifest.runtime),
    });
    expect(identityResponse.status).toBe(200);
  });

  it("serves an old content-addressed asset without consulting a manifest or checksum metadata", async () => {
    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    await env.RELEASES.put(`${releasePrefix(runtime)}/assets/${assetHash.hex}`, ASSET_BODY, {
      httpMetadata: { contentType: "application/javascript" },
    });

    const response = await fetchWorker(assetPath(runtime, assetHash.hex));
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toBe("application/javascript");
    expect(await response.text()).toBe(ASSET_BODY);
  });

  it("requires asset content type metadata", async () => {
    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    await env.RELEASES.put(`${releasePrefix(runtime)}/assets/${assetHash.hex}`, ASSET_BODY);

    const response = await fetchWorker(assetPath(runtime, assetHash.hex));
    expect(response.status).toBe(404);
  });

  it("rejects invalid asset hash routes", async () => {
    const runtime = nextRuntime();
    const response = await fetchWorker(assetPath(runtime, "f".repeat(63)));
    expect(response.status).toBe(404);

    const uppercase = await fetchWorker(assetPath(runtime, "A" + "f".repeat(63)));
    expect(uppercase.status).toBe(404);
  });

  it("returns not found for an absent fixed manifest", async () => {
    const runtime = nextRuntime();
    const response = await fetchWorker(manifestPath(runtime), { headers: manifestHeaders(runtime) });
    expect(response.status).toBe(404);
  });

  it("rejects non-GET requests", async () => {
    const response = await fetchWorker(manifestPath(nextRuntime()), { method: "POST" });
    expect(response.status).toBe(405);
  });
});
