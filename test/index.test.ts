import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const manifestPath = (runtime = "ios-runtime") =>
  `/v1/projects/kosmo-native/platforms/ios/channels/staging/runtimes/${runtime}/manifest`;

const assetPath = (sha256 = "a".repeat(64)) =>
  `/v1/projects/kosmo-native/platforms/ios/channels/staging/runtimes/ios-runtime/assets/${sha256}`;

const manifestHeaders = (runtime: string, accept = "application/expo+json"): HeadersInit => ({
  accept,
  "expo-platform": "ios",
  "expo-protocol-version": "1",
  "expo-runtime-version": runtime,
});

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`https://ota.example${path}`, init);
  const context = createExecutionContext();
  const response = await worker.fetch(request, env, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("Expo OTA worker", () => {
  it("serves a completed manifest with protocol and signature headers", async () => {
    await env.RELEASES.put(
      "releases/kosmo-native/ios/staging/ios-runtime/pointer.json",
      JSON.stringify({
        complete: true,
        manifestKey: "releases/kosmo-native/ios/staging/ios-runtime/manifests/ios-runtime.json",
        signature: "sig-v1",
        contentType: "application/expo+json",
      }),
    );
    await env.RELEASES.put(
      "releases/kosmo-native/ios/staging/ios-runtime/manifests/ios-runtime.json",
      '{"id":"release-1"}',
      {
      httpMetadata: { contentType: "application/expo+json" },
      },
    );

    const response = await fetchWorker(manifestPath(), { headers: manifestHeaders("ios-runtime") });

    expect(response.status).toBe(200);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    expect(response.headers.get("expo-signature")).toBe("sig-v1");
    expect(response.headers.get("content-type")).toBe("application/expo+json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe('{"id":"release-1"}');
  });

  it("keeps release tuples isolated", async () => {
    await env.RELEASES.put(
      "releases/kosmo-native/android/production/android-runtime/pointer.json",
      JSON.stringify({
        complete: true,
        manifestKey: "releases/kosmo-native/android/production/android-runtime/manifests/android-runtime.json",
        signature: "android-sig",
        contentType: "application/expo+json",
      }),
    );
    await env.RELEASES.put(
      "releases/kosmo-native/android/production/android-runtime/manifests/android-runtime.json",
      '{"platform":"android"}',
    );

    const response = await fetchWorker(
      "/v1/projects/kosmo-native/platforms/ios/channels/production/runtimes/android-runtime/manifest",
      { headers: manifestHeaders("android-runtime") },
    );
    expect(response.status).toBe(404);
  });

  it("rejects a pointer that escapes its release tuple", async () => {
    await env.RELEASES.put(
      "releases/kosmo-native/ios/staging/cross-runtime/pointer.json",
      JSON.stringify({
        complete: true,
        manifestKey: "releases/kosmo-native/android/production/android-runtime/manifests/android-runtime.json",
        signature: "cross-tuple",
        contentType: "application/expo+json",
      }),
    );

    const response = await fetchWorker(manifestPath("cross-runtime"), {
      headers: manifestHeaders("cross-runtime"),
    });
    expect(response.status).toBe(404);
  });

  it.each([
    ["missing pointer", undefined],
    ["incomplete pointer", { complete: false, manifestKey: "m", signature: "s", contentType: "x" }],
    ["missing signature", { complete: true, manifestKey: "m", contentType: "x" }],
  ])("fails closed for %s", async (_label, pointer) => {
    if (pointer) {
      await env.RELEASES.put(
        "releases/kosmo-native/ios/staging/bad-runtime/pointer.json",
        JSON.stringify(pointer),
      );
    }
    const response = await fetchWorker(manifestPath("bad-runtime"), {
      headers: manifestHeaders("bad-runtime"),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a manifest when the requested representation is unsupported", async () => {
    await env.RELEASES.put(
      "releases/kosmo-native/ios/staging/negotiated-runtime/pointer.json",
      JSON.stringify({
        complete: true,
        manifestKey: "releases/kosmo-native/ios/staging/negotiated-runtime/manifest.json",
        signature: "signature",
        contentType: "application/expo+json",
      }),
    );
    await env.RELEASES.put("releases/kosmo-native/ios/staging/negotiated-runtime/manifest.json", "{}");

    const response = await fetchWorker(manifestPath("negotiated-runtime"), {
      headers: manifestHeaders("negotiated-runtime", "application/json"),
    });
    expect(response.status).toBe(406);
  });

  it("fails closed for a syntactically valid but unsupported manifest type", async () => {
    await env.RELEASES.put(
      "releases/kosmo-native/ios/staging/unsupported-runtime/pointer.json",
      JSON.stringify({
        complete: true,
        manifestKey: "releases/kosmo-native/ios/staging/unsupported-runtime/manifest.json",
        signature: "signature",
        contentType: "text/html",
      }),
    );
    await env.RELEASES.put("releases/kosmo-native/ios/staging/unsupported-runtime/manifest.json", "{}");

    const response = await fetchWorker(manifestPath("unsupported-runtime"), {
      headers: manifestHeaders("unsupported-runtime", "text/html"),
    });
    expect(response.status).toBe(404);
  });

  it.each([
    ["platform", { ...manifestHeaders("ios-runtime"), "expo-platform": "android" }],
    ["runtime", { ...manifestHeaders("ios-runtime"), "expo-runtime-version": "other-runtime" }],
  ])("rejects a %s header that disagrees with the URL tuple", async (_label, headers) => {
    const response = await fetchWorker(manifestPath(), { headers });
    expect(response.status).toBe(400);
  });

  it("streams assets and marks them immutable", async () => {
    const sha256 = "b".repeat(64);
    await env.RELEASES.put(
      `releases/kosmo-native/ios/staging/ios-runtime/assets/${sha256}`,
      "asset-body",
      { httpMetadata: { contentType: "image/png" } },
    );

    const response = await fetchWorker(assetPath(sha256));
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("asset-body");
  });
});
