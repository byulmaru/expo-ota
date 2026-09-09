import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRelease, publishRelease, type ActionInputs, type S3Transport } from "../src/publish";

const temporaryDirectories: string[] = [];

function inputs(exportDir: string, privateKey: string): ActionInputs {
  return {
    exportDir,
    project: "kosmo-native",
    platform: "ios",
    channel: "staging",
    runtimeVersion: "fingerprint test",
    publicBaseUrl: "https://ota.example.test/",
    r2Bucket: "releases",
    r2AccountId: "account",
    r2AccessKeyId: "access",
    r2SecretAccessKey: "secret",
    signingPrivateKey: privateKey,
    keyid: "main",
  };
}

async function fixture(): Promise<{ directory: string; privateKey: string; publicKey: string }> {
  const directory = await mkdtemp(join(tmpdir(), "expo-ota-action-"));
  temporaryDirectories.push(directory);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  await writeFile(join(directory, "bundle.hbc"), "bundle bytes");
  await writeFile(join(directory, "logo.png"), "asset bytes");
  await writeFile(
    join(directory, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: {
        ios: { bundle: "bundle.hbc", assets: [{ path: "logo.png", ext: "png" }] },
      },
    }),
  );
  return { directory, privateKey: privatePem, publicKey: publicPem };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Expo OTA publish action", () => {
  it("builds tuple-scoped manifest bytes and signs those exact bytes", async () => {
    const fixtureData = await fixture();
    const release = await prepareRelease(inputs(fixtureData.directory, fixtureData.privateKey));
    const manifest = JSON.parse(release.manifestBody.toString("utf8")) as Record<string, unknown>;
    expect(manifest.runtimeVersion).toBe("fingerprint test");
    expect(manifest.id).toBe(release.updateId);
    expect(manifest.launchAsset).toMatchObject({ contentType: "application/javascript" });
    expect((manifest.launchAsset as { url: string }).url).toContain("runtimes/fingerprint%20test/assets/");
    expect(release.assets).toHaveLength(2);
    expect(release.manifestUrl).toBe(
      "https://ota.example.test/v1/projects/kosmo-native/platforms/ios/channels/staging/runtimes/fingerprint%20test/manifest",
    );
    expect(release.signature).toMatch(/^sig="[^"]+", keyid="main", alg="rsa-v1_5-sha256"$/u);
    const encodedSignature = /^sig="([^"]+)"/u.exec(release.signature)?.[1];
    expect(encodedSignature).toBeTruthy();
    expect(verify("RSA-SHA256", release.manifestBody, fixtureData.publicKey, Buffer.from(encodedSignature!, "base64"))).toBe(true);
    expect(
      verify("RSA-SHA256", Buffer.concat([release.manifestBody, Buffer.from("tampered")]), fixtureData.publicKey, Buffer.from(encodedSignature!, "base64")),
    ).toBe(false);
    expect((manifest.launchAsset as { hash: string }).hash).toBe(
      createHash("sha256").update("bundle bytes").digest("base64url"),
    );
    expect((manifest.assets as Array<{ hash: string }>)[0]?.hash).toBe(
      createHash("sha256").update("asset bytes").digest("base64url"),
    );
  });

  it("rejects metadata paths that escape the export directory", async () => {
    const fixtureData = await fixture();
    await writeFile(
      join(fixtureData.directory, "metadata.json"),
      JSON.stringify({
        version: 0,
        bundler: "metro",
        fileMetadata: { ios: { bundle: "../bundle.hbc", assets: [] } },
      }),
    );
    await expect(prepareRelease(inputs(fixtureData.directory, fixtureData.privateKey))).rejects.toThrow(
      "outside export-dir",
    );
  });

  it("uses the requested project namespace for URLs and R2 keys", async () => {
    const fixtureData = await fixture();
    const release = await prepareRelease({
      ...inputs(fixtureData.directory, fixtureData.privateKey),
      project: "another native",
    });
    expect(release.manifestUrl).toBe(
      "https://ota.example.test/v1/projects/another%20native/platforms/ios/channels/staging/runtimes/fingerprint%20test/manifest",
    );
    expect(release.manifestKey).toBe(
      "releases/another native/ios/staging/fingerprint test/manifest.json",
    );
    expect(release.assets.every((asset) => asset.key.startsWith("releases/another native/"))).toBe(true);
    const manifest = JSON.parse(release.manifestBody.toString("utf8")) as {
      launchAsset: { url: string };
      assets: Array<{ url: string }>;
    };
    expect(manifest.launchAsset.url).toContain("/projects/another%20native/");
    expect(manifest.assets[0]?.url).toContain("/projects/another%20native/");
  });

  it("rejects an unsafe project before writing to R2", async () => {
    const fixtureData = await fixture();
    let writes = 0;
    const client: S3Transport = {
      async send(command) {
        if (command.input.Body !== undefined) writes += 1;
        return {};
      },
    };
    await expect(
      publishRelease(
        { ...inputs(fixtureData.directory, fixtureData.privateKey), project: "../other" },
        client,
      ),
    ).rejects.toThrow('Input "project" must be one non-empty path segment');
    expect(writes).toBe(0);
  });

  it("uploads immutable assets before replacing and verifying the fixed manifest", async () => {
    const fixtureData = await fixture();
    const storage = new Map<string, { body: Buffer; contentType: string; metadata?: Record<string, string> }>();
    const events: string[] = [];
    let corruptAssetReads = false;
    const fakeClient: S3Transport = {
      async send(command) {
        const input = command.input;
        const key = String(input.Key);
        if (input.Body !== undefined) {
          if (input.IfNoneMatch === "*" && storage.has(key)) {
            throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
          }
          const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(String(input.Body));
          storage.set(key, {
            body,
            contentType: String(input.ContentType),
            metadata: input.Metadata as Record<string, string> | undefined,
          });
          events.push(`put:${key}`);
          return {};
        }
        const object = storage.get(key);
        if (!object) throw new Error(`missing ${key}`);
        const body = corruptAssetReads && key.includes("/assets/") ? Buffer.alloc(object.body.length, 0x78) : object.body;
        events.push(`get:${key}`);
        return {
          ContentLength: body.length,
          ContentType: object.contentType,
          Metadata: object.metadata,
          Body: Readable.from([body]),
        };
      },
    };
    const actionInputs = inputs(fixtureData.directory, fixtureData.privateKey);
    const first = await publishRelease(actionInputs, fakeClient);
    const firstManifest = storage.get("releases/kosmo-native/ios/staging/fingerprint test/manifest.json");
    expect(firstManifest?.metadata?.signature).toBeTruthy();
    const firstAssetPuts = events.filter((event) => event.startsWith("put:releases/kosmo-native/ios/staging/fingerprint test/assets/"));
    expect(firstAssetPuts).toHaveLength(2);
    const firstManifestPut = events.findIndex((event) => event.startsWith("put:releases/kosmo-native/ios/staging/fingerprint test/manifest"));
    const lastAssetRead = Math.max(
      ...events
        .map((event, index) => (event.startsWith("get:releases/kosmo-native/ios/staging/fingerprint test/assets/") ? index : -1))
        .filter((index) => index >= 0),
    );
    expect(firstManifestPut).toBeGreaterThan(lastAssetRead);

    events.length = 0;
    const second = await publishRelease(actionInputs, fakeClient);
    expect(second.updateId).not.toBe(first.updateId);
    expect(events.filter((event) => event.startsWith("put:releases/kosmo-native/ios/staging/fingerprint test/assets/"))).toHaveLength(0);
    expect(storage.get("releases/kosmo-native/ios/staging/fingerprint test/manifest.json")?.metadata?.signature).toBeTruthy();

    events.length = 0;
    corruptAssetReads = true;
    await expect(publishRelease(actionInputs, fakeClient)).rejects.toThrow("R2 object body verification failed");
    expect(events.some((event) => event.startsWith("put:releases/kosmo-native/ios/staging/fingerprint test/manifest"))).toBe(false);
  });
});
