import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { type ActionInputs } from "../src/input";
import { prepareRelease } from "../src/prepare";
import { publishRelease, type S3Transport } from "../src/publish";

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

function parseManifestPart(body: Buffer, contentType: string): { headers: Record<string, string>; body: Buffer } {
  const boundary = /^multipart\/mixed; boundary=([^;]+)$/u.exec(contentType)?.[1];
  if (!boundary) throw new Error(`unexpected manifest content type: ${contentType}`);
  const opening = Buffer.from(`--${boundary}\r\n`, "utf8");
  if (!body.subarray(0, opening.length).equals(opening)) throw new Error("manifest multipart opening boundary is invalid");
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n", "utf8"), opening.length);
  const bodyEnd = body.indexOf(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"), headerEnd + 4);
  if (headerEnd < 0 || bodyEnd < 0) throw new Error("manifest multipart delimiters are invalid");
  const headers = Object.fromEntries(
    body
      .subarray(opening.length, headerEnd)
      .toString("utf8")
      .split("\r\n")
      .map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      }),
  );
  return { headers, body: body.subarray(headerEnd + 4, bodyEnd) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Expo OTA publish action", () => {
  it("builds tuple-scoped manifest bytes and signs those exact bytes", async () => {
    const fixtureData = await fixture();
    const release = await prepareRelease(inputs(fixtureData.directory, fixtureData.privateKey));
    const manifestPart = parseManifestPart(release.manifestUploadBody, release.manifestContentType);
    const manifest = JSON.parse(manifestPart.body.toString("utf8")) as Record<string, unknown>;
    expect(manifest.runtimeVersion).toBe("fingerprint test");
    expect(manifest.id).toBe(release.updateId);
    expect(manifest.launchAsset).toMatchObject({ contentType: "application/javascript" });
    const launchHash = createHash("sha256").update("bundle bytes").digest("hex");
    expect((manifest.launchAsset as { url: string }).url).toBe(
      `https://ota.example.test/releases/kosmo-native/ios/staging/fingerprint%20test/assets/${launchHash}`,
    );
    expect((manifest.launchAsset as { url: string }).url).not.toContain("/v1/projects/");
    expect(release.assets).toHaveLength(2);
    expect(release.manifestUrl).toBe(
      "https://ota.example.test/releases/kosmo-native/ios/staging/fingerprint%20test/manifest.json",
    );
    expect(manifestPart.headers["content-disposition"]).toBe('form-data; name="manifest"');
    expect(manifestPart.headers["content-type"]).toBe("application/json");
    const signature = manifestPart.headers["expo-signature"];
    expect(signature).toMatch(/^sig="[^"]+", keyid="main", alg="rsa-v1_5-sha256"$/u);
    const encodedSignature = /^sig="([^"]+)"/u.exec(signature)?.[1];
    expect(encodedSignature).toBeTruthy();
    expect(verify("RSA-SHA256", manifestPart.body, fixtureData.publicKey, Buffer.from(encodedSignature!, "base64"))).toBe(true);
    expect(
      verify("RSA-SHA256", Buffer.concat([manifestPart.body, Buffer.from("tampered")]), fixtureData.publicKey, Buffer.from(encodedSignature!, "base64")),
    ).toBe(false);
    expect((manifest.launchAsset as { hash: string }).hash).toBe(
      createHash("sha256").update("bundle bytes").digest("base64url"),
    );
    expect((manifest.assets as Array<{ hash: string }>)[0]?.hash).toBe(
      createHash("sha256").update("asset bytes").digest("base64url"),
    );
  });

  it.each([
    ["traversal", "../bundle.hbc", "outside export-dir"],
    ["symlink", "outside-link.hbc", "asset symlink outside export-dir"],
  ] as const)("rejects %s paths that escape the export directory before any R2 write", async (_name, metadataPath, message) => {
    const fixtureData = await fixture();
    if (metadataPath === "outside-link.hbc") {
      const outsideDirectory = await mkdtemp(join(tmpdir(), "expo-ota-action-outside-"));
      temporaryDirectories.push(outsideDirectory);
      const outsideFile = join(outsideDirectory, "outside.hbc");
      await writeFile(outsideFile, "outside bytes");
      await symlink(outsideFile, join(fixtureData.directory, metadataPath));
    }
    await writeFile(
      join(fixtureData.directory, "metadata.json"),
      JSON.stringify({
        version: 0,
        bundler: "metro",
        fileMetadata: { ios: { bundle: metadataPath, assets: [] } },
      }),
    );
    let writes = 0;
    const client: S3Transport = {
      async send(command) {
        if (command.input.Body !== undefined) writes += 1;
        return {};
      },
    };
    await expect(publishRelease(inputs(fixtureData.directory, fixtureData.privateKey), client)).rejects.toThrow(
      message,
    );
    expect(writes).toBe(0);
  });

  it("uses the requested project namespace for URLs and R2 keys", async () => {
    const fixtureData = await fixture();
    const release = await prepareRelease({
      ...inputs(fixtureData.directory, fixtureData.privateKey),
      project: "another native",
    });
    expect(release.manifestUrl).toBe(
      "https://ota.example.test/releases/another%20native/ios/staging/fingerprint%20test/manifest.json",
    );
    expect(release.manifestKey).toBe(
      "releases/another native/ios/staging/fingerprint test/manifest.json",
    );
    expect(release.assets.every((asset) => asset.key.startsWith("releases/another native/"))).toBe(true);
    const manifestPart = parseManifestPart(release.manifestUploadBody, release.manifestContentType);
    const manifest = JSON.parse(manifestPart.body.toString("utf8")) as {
      launchAsset: { url: string };
      assets: Array<{ url: string }>;
    };
    const launchKey = release.assets[0]?.key;
    expect(launchKey).toBe("releases/another native/ios/staging/fingerprint test/assets/" + release.assets[0]?.sha256Hex);
    expect(manifest.launchAsset.url).toBe(
      `https://ota.example.test/${launchKey!.split("/").map(encodeURIComponent).join("/")}`,
    );
    const assetKey = release.assets[1]?.key;
    expect(manifest.assets[0]?.url).toBe(
      `https://ota.example.test/${assetKey!.split("/").map(encodeURIComponent).join("/")}`,
    );
    expect(manifest.assets[0]?.url).not.toContain("/v1/projects/");
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

  it("does not treat inherited MIME names as known asset extensions", async () => {
    const fixtureData = await fixture();
    await writeFile(
      join(fixtureData.directory, "metadata.json"),
      JSON.stringify({
        version: 0,
        bundler: "metro",
        fileMetadata: { ios: { bundle: "bundle.hbc", assets: [{ path: "logo.png", ext: "constructor" }] } },
      }),
    );
    const release = await prepareRelease(inputs(fixtureData.directory, fixtureData.privateKey));
    const manifestPart = parseManifestPart(release.manifestUploadBody, release.manifestContentType);
    const manifest = JSON.parse(manifestPart.body.toString("utf8")) as {
      assets: Array<{ contentType: string }>;
    };
    expect(manifest.assets[0]?.contentType).toBe("application/octet-stream");
  });

  it("uploads immutable assets before replacing and verifying the fixed manifest", async () => {
    const fixtureData = await fixture();
    const storage = new Map<string, {
      body: Buffer;
      contentType: string;
      cacheControl?: string;
    }>();
    const events: string[] = [];
    const manifestObjectKey = "releases/kosmo-native/ios/staging/fingerprint test/manifest.json";
    const assetObjectPrefix = "releases/kosmo-native/ios/staging/fingerprint test/assets/";
    let corruptAssetReads = false;
    const fakeClient: S3Transport = {
      async send(command) {
        const input = command.input;
        const bucket = String(input.Bucket);
        const key = String(input.Key);
        const storageKey = `${bucket}:${key}`;
        if (input.Body !== undefined) {
          if (input.IfNoneMatch === "*" && storage.has(storageKey)) {
            throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
          }
          const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(String(input.Body));
          storage.set(storageKey, {
            body,
            contentType: String(input.ContentType),
            cacheControl: input.CacheControl as string | undefined,
          });
          events.push(`put:${bucket}:${key}`);
          return {};
        }
        const object = storage.get(storageKey);
        if (!object) throw new Error(`missing ${bucket}:${key}`);
        const body = corruptAssetReads && key.includes("/assets/") ? Buffer.alloc(object.body.length, 0x78) : object.body;
        events.push(`get:${bucket}:${key}`);
        return {
          ContentLength: body.length,
          ContentType: object.contentType,
          CacheControl: object.cacheControl,
          Body: Readable.from([body]),
        };
      },
    };
    const actionInputs = inputs(fixtureData.directory, fixtureData.privateKey);
    const first = await publishRelease(actionInputs, fakeClient);
    const firstManifest = storage.get(`releases:${manifestObjectKey}`);
    expect(firstManifest?.cacheControl).toBe("private, no-store");
    expect(firstManifest?.contentType).toMatch(/^multipart\/mixed; boundary=/u);
    const storedManifestPart = firstManifest
      ? parseManifestPart(firstManifest.body, firstManifest.contentType)
      : undefined;
    expect(storedManifestPart?.headers["expo-signature"]).toMatch(
      /^sig="[^"]+", keyid="main", alg="rsa-v1_5-sha256"$/u,
    );
    const firstAssetPuts = events.filter((event) => event.startsWith(`put:releases:${assetObjectPrefix}`));
    expect(firstAssetPuts).toHaveLength(2);
    const assetObjects = [...storage.entries()].filter(([key]) => key.startsWith(`releases:${assetObjectPrefix}`));
    expect(assetObjects).toHaveLength(2);
    expect(assetObjects.every(([, object]) => object.cacheControl === "public, max-age=31536000, immutable")).toBe(true);
    expect(new Set([...storage.keys()].map((key) => key.split(":", 1)[0]))).toEqual(new Set(["releases"]));
    const firstManifestPut = events.findIndex((event) => event === `put:releases:${manifestObjectKey}`);
    const lastAssetRead = Math.max(
      ...events
        .map((event, index) => (event.startsWith(`get:releases:${assetObjectPrefix}`) ? index : -1))
        .filter((index) => index >= 0),
    );
    expect(firstManifestPut).toBeGreaterThan(lastAssetRead);

    events.length = 0;
    const second = await publishRelease(actionInputs, fakeClient);
    expect(second.updateId).not.toBe(first.updateId);
    expect(events.filter((event) => event.startsWith(`put:releases:${assetObjectPrefix}`))).toHaveLength(0);
    const secondManifest = storage.get(`releases:${manifestObjectKey}`);
    expect(secondManifest).toBeDefined();
    expect(parseManifestPart(secondManifest!.body, secondManifest!.contentType).headers["expo-signature"]).toMatch(
      /^sig="[^"]+", keyid="main", alg="rsa-v1_5-sha256"$/u,
    );

    events.length = 0;
    corruptAssetReads = true;
    await expect(publishRelease(actionInputs, fakeClient)).rejects.toThrow("R2 object body verification failed");
    expect(events.some((event) => event === `put:releases:${manifestObjectKey}`)).toBe(false);
  });
});
