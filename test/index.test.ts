import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";

const PROJECT = "kosmo-native";
const PLATFORM = "ios";
const CHANNEL = "staging";
const ALGORITHM = "rsa-v1_5-sha256";
const ASSET_BODY = "javascript bundle";

let signingKey: CryptoKey;
let publicKeyPem: string;
let runtimeSequence = 0;
let releaseSequence = 0;

function encodeBase64(bytes: ArrayBufferLike | Uint8Array): string {
  let value = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  for (const byte of view) value += String.fromCharCode(byte);
  return btoa(value);
}

function encodePem(bytes: ArrayBufferLike | Uint8Array): string {
  const base64 = encodeBase64(bytes);
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function encodeBase64Url(bytes: ArrayBufferLike | Uint8Array): string {
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<{ base64Url: string; hex: string; bytes: ArrayBuffer }> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return {
    base64Url: encodeBase64Url(digest),
    hex: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    bytes: digest,
  };
}

function nextRuntime(): string {
  runtimeSequence += 1;
  return `test-runtime-${runtimeSequence}`;
}

function nextReleaseId(): string {
  releaseSequence += 1;
  return `00000000-0000-4000-8000-${releaseSequence.toString(16).padStart(12, "0")}`;
}

function releasePrefix(runtime: string, platform = PLATFORM, channel = CHANNEL): string {
  return `releases/${PROJECT}/${platform}/${channel}/${runtime}`;
}

function manifestPath(runtime: string, platform = PLATFORM, channel = CHANNEL): string {
  return `/v1/projects/${PROJECT}/platforms/${platform}/channels/${channel}/runtimes/${encodeURIComponent(runtime)}/manifest`;
}

function assetPath(runtime: string, hash: string, platform = PLATFORM, channel = CHANNEL): string {
  return `/v1/projects/${PROJECT}/platforms/${platform}/channels/${channel}/runtimes/${encodeURIComponent(runtime)}/assets/${hash}`;
}

function testEnv(key = publicKeyPem): Env {
  return { RELEASES: env.RELEASES, EXPO_OTA_PUBLIC_KEY_PEM: key };
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

async function fetchWorker(path: string, init?: RequestInit, workerEnv = testEnv()): Promise<Response> {
  const request = new Request(`https://ota.example${path}`, init);
  const context = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

interface SeedOptions {
  runtime?: string;
  manifestRuntime?: string;
  assetUrl?: string;
  manifestHash?: string;
  signature?: string;
}

async function seedRelease(options: SeedOptions = {}) {
  const runtime = options.runtime ?? nextRuntime();
  const assetHash = await sha256(ASSET_BODY);
  const body = JSON.stringify({
    id: nextReleaseId(),
    createdAt: "2026-09-07T00:00:00.000Z",
    runtimeVersion: options.manifestRuntime ?? runtime,
    launchAsset: {
      hash: options.manifestHash ?? assetHash.base64Url,
      key: "bundle",
      contentType: "application/javascript",
      url: options.assetUrl ?? `https://ota.example${assetPath(runtime, assetHash.hex)}`,
    },
    assets: [],
    metadata: {},
    extra: {},
  });
  const signatureBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(body),
  );
  const signature =
    options.signature ?? `sig="${encodeBase64(signatureBytes)}", keyid="main", alg="${ALGORITHM}"`;
  const prefix = releasePrefix(runtime);
  const manifestKey = `${prefix}/manifests/${runtime}.json`;
  await env.RELEASES.put(
    `${prefix}/pointer.json`,
    JSON.stringify({ complete: true, manifestKey, signature, contentType: "application/expo+json" }),
  );
  await env.RELEASES.put(manifestKey, body, { httpMetadata: { contentType: "application/expo+json" } });
  await env.RELEASES.put(`${prefix}/assets/${assetHash.hex}`, ASSET_BODY, {
    httpMetadata: { contentType: "application/javascript" },
    sha256: assetHash.bytes,
  });
  return { runtime, body, assetHash, manifestKey, signature, prefix };
}

beforeAll(async () => {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signingKey = keyPair.privateKey;
  publicKeyPem = encodePem((await crypto.subtle.exportKey("spki", keyPair.publicKey)) as ArrayBuffer);
});

describe("Expo OTA Worker", () => {
  it("verifies and serves a signed manifest with Expo response headers", async () => {
    const release = await seedRelease();
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime, `sig, keyid="main", alg="${ALGORITHM}"`),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    expect(response.headers.get("expo-signature")).toBe(release.signature);
    expect(response.headers.get("content-type")).toBe("application/expo+json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe(release.body);
  });

  it("rejects a tampered manifest body", async () => {
    const release = await seedRelease();
    await env.RELEASES.put(release.manifestKey, `${release.body} `, {
      httpMetadata: { contentType: "application/expo+json" },
    });

    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a tampered signature", async () => {
    const release = await seedRelease();
    const badSignature = `sig="${encodeBase64(new TextEncoder().encode("bad signature"))}", keyid="main", alg="${ALGORITHM}"`;
    await env.RELEASES.put(
      `${release.prefix}/pointer.json`,
      JSON.stringify({ complete: true, manifestKey: release.manifestKey, signature: badSignature, contentType: "application/expo+json" }),
    );

    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime),
    });
    expect(response.status).toBe(404);
  });

  it.each([
    ["wrong expected keyid", `sig, keyid="other", alg="${ALGORITHM}"`],
    ["wrong expected algorithm", `sig, keyid="main", alg="other"`],
    ["malformed expectation", `sig, keyid="main", alg="${ALGORITHM}" trailing`],
  ])("rejects %s", async (_label, expectation) => {
    const release = await seedRelease();
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime, expectation),
    });
    expect(response.status).toBe(_label === "wrong expected keyid" ? 404 : 400);
  });

  it.each([
    ["wrong key id", `sig="${encodeBase64(new TextEncoder().encode("bad"))}", keyid="other", alg="${ALGORITHM}"`],
    ["wrong algorithm", `sig="${encodeBase64(new TextEncoder().encode("bad"))}", keyid="main", alg="other"`],
    ["binary signature form", "sig=:YWJj:, keyid=\"main\", alg=\"rsa-v1_5-sha256\""],
    ["uppercase field", `SIG="bad", keyid="main", alg="${ALGORITHM}"`],
    ["non-ASCII string", `sig="bad", keyid="main\u0080", alg="${ALGORITHM}"`],
  ])("fails closed for %s response metadata", async (_label, signature) => {
    const release = await seedRelease({ signature });
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a manifest with a runtime that differs from the route", async () => {
    const release = await seedRelease({ manifestRuntime: "other-runtime" });
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a noncanonical base64url asset hash", async () => {
    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastCharacter = assetHash.base64Url.at(-1)!;
    const lastCharacterIndex = base64UrlAlphabet.indexOf(lastCharacter);
    const noncanonicalHash = `${assetHash.base64Url.slice(0, -1)}${base64UrlAlphabet[lastCharacterIndex + 1]}`;
    const release = await seedRelease({ runtime, manifestHash: noncanonicalHash });

    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime),
    });
    expect(response.status).toBe(404);
  });

  it.each([
    ["cross-channel URL", (runtime: string, hash: string) => assetPath(runtime, hash, PLATFORM, "production")],
    ["cross-runtime URL", (runtime: string, hash: string) => assetPath("other-runtime", hash)],
    ["wrong hash URL", (runtime: string) => assetPath(runtime, "f".repeat(64))],
  ])("rejects a manifest with a %s asset reference", async (_label, urlBuilder) => {
    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    const release = await seedRelease({ runtime, assetUrl: urlBuilder(runtime, assetHash.hex) });
    const response = await fetchWorker(manifestPath(release.runtime), {
      headers: manifestHeaders(release.runtime),
    });
    expect(response.status).toBe(404);
  });

  it("fails closed when the configured public key is missing", async () => {
    const release = await seedRelease();
    const response = await fetchWorker(
      manifestPath(release.runtime),
      { headers: manifestHeaders(release.runtime) },
      testEnv(""),
    );
    expect(response.status).toBe(404);
  });

  it("keeps platform and channel namespaces isolated", async () => {
    const release = await seedRelease();
    const response = await fetchWorker(
      manifestPath(release.runtime, "android", "production"),
      { headers: { ...manifestHeaders(release.runtime), "expo-platform": "android" } },
    );
    expect(response.status).toBe(404);
  });

  it("serves immutable assets without consulting the current pointer", async () => {
    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    await env.RELEASES.put(`${releasePrefix(runtime)}/assets/${assetHash.hex}`, ASSET_BODY, {
      httpMetadata: { contentType: "application/javascript" },
      sha256: assetHash.bytes,
    });

    const response = await fetchWorker(assetPath(runtime, assetHash.hex));
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toBe("application/javascript");
    expect(await response.text()).toBe(ASSET_BODY);
  });

  it("rejects an asset without R2 content type", async () => {
    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    await env.RELEASES.put(`${releasePrefix(runtime)}/assets/${assetHash.hex}`, ASSET_BODY);

    const response = await fetchWorker(assetPath(runtime, assetHash.hex));
    expect(response.status).toBe(404);
  });

  it("rejects an asset without an R2 SHA-256 checksum", async () => {
    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    await env.RELEASES.put(`${releasePrefix(runtime)}/assets/${assetHash.hex}`, ASSET_BODY, {
      httpMetadata: { contentType: "application/javascript" },
    });

    const response = await fetchWorker(assetPath(runtime, assetHash.hex));
    expect(response.status).toBe(404);
  });

  it("rejects an asset whose R2 SHA-256 checksum does not match its URL", async () => {
    const runtime = nextRuntime();
    const assetHash = await sha256(ASSET_BODY);
    const otherHash = await sha256("different asset");
    await env.RELEASES.put(`${releasePrefix(runtime)}/assets/${otherHash.hex}`, ASSET_BODY, {
      httpMetadata: { contentType: "application/javascript" },
      sha256: assetHash.bytes,
    });

    const response = await fetchWorker(assetPath(runtime, otherHash.hex));
    expect(response.status).toBe(404);
  });

  it("returns no update for a missing or incomplete pointer", async () => {
    const missingRuntime = nextRuntime();
    const missing = await fetchWorker(manifestPath(missingRuntime), {
      headers: manifestHeaders(missingRuntime),
    });
    expect(missing.status).toBe(404);

    const runtime = nextRuntime();
    await env.RELEASES.put(`${releasePrefix(runtime)}/pointer.json`, JSON.stringify({ complete: false }));
    const incomplete = await fetchWorker(manifestPath(runtime), { headers: manifestHeaders(runtime) });
    expect(incomplete.status).toBe(404);
  });

  it("rejects non-GET requests", async () => {
    const response = await fetchWorker(manifestPath(nextRuntime()), { method: "POST" });
    expect(response.status).toBe(405);
  });
});
