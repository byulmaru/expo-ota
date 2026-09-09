# Static Expo OTA publish Action

This private repository contains the reusable GitHub Action that validates, signs, and publishes an approved Expo export as a static `multipart/mixed` manifest and immutable assets in one R2 bucket. The Action does not build the app, serve HTTP requests, or select a native runtime.

The legacy Expo OTA Worker deployment was deleted on 2026-09-09; its custom domain is detached and no `/v1/...` path is active. Recovery would require an explicit redeploy from Git history and is not automatic. This README records the static endpoint's configured routing/header state, not full static-host validation or device-application proof.

As of 2026-09-09, the R2 custom domain `expo-ota.byulmaru.co` is configured/enabled and DNS is R2-proxied. UI configuration shows manifest cache bypass active. An independent edge check verified TLS, static routing, and manifest-only `expo-protocol-version: 1` / `expo-sfv-version: 0` headers; the empty R2 bucket (0 B) correctly returned an HTML 404 with `cf-cache-status: DYNAMIC`, which does not prove positive manifest cache behavior. No real release has returned HTTP 200 or produced signature, asset, or device-application proof.

The Action must receive an already-built, approved export from the calling repository. The calling workflow owns the approved commit, environment approval, and concurrency guard for the `(project, platform, channel, runtimeVersion)` tuple. Keep the Action reference pinned to an immutable commit until a reviewed release of this private repository exists; the examples below intentionally use `<ACTION_COMMIT_SHA>` because no `v1` reference exists yet.

## Static object paths and response contract

- `GET /releases/{project}/{platform}/{channel}/{runtime}/manifest.json`
- `GET /releases/{project}/{platform}/{channel}/{runtime}/assets/{lowercase-sha256-hex}`

The Action writes these prospective static objects directly to R2. Serving them requires the configured public host. The route tuple maps directly to these keys:

```text
releases/{project}/{platform}/{channel}/{runtime}/manifest.json
releases/{project}/{platform}/{channel}/{runtime}/assets/{lowercase-sha256-hex}
```

`project`, `platform`, `channel`, and `runtime` are fixed in each URL. The Action validates `project` and `runtime` as single path segments, and URL path segments are percent-encoded while R2 keys retain their exact input values.

The manifest object has a `multipart/mixed; boundary=...` content type. Its first part is the JSON manifest:

```text
Content-Disposition: form-data; name="manifest"
Content-Type: application/json
expo-signature: sig="<base64>", keyid="main", alg="rsa-v1_5-sha256"
```

The `expo-signature` value signs exactly the JSON bytes in that part. The signature is not duplicated in custom object metadata. Asset objects use their content-addressed keys and are served with `public, max-age=31536000, immutable`; the manifest uses `private, no-store`.

Publisher storage is uncompressed: manifest and asset objects must be written without `content-encoding` (an explicit `identity` value is accepted). The Action verifies the stored body, content type, cache policy, and bytes after each write.

Before a device can consume a static manifest URL, the public host/CDN must route the exact encoded host/path to the matching R2 object and return these top-level response headers:

```text
expo-protocol-version: 1
expo-sfv-version: 0
```

It must preserve the manifest `Content-Type` and multipart bytes, avoid content encoding transformations, and bypass or revalidate caching for the fixed manifest path. Asset paths may use immutable CDN caching. The Action writes the R2 object headers needed for storage, but configuring the public host, response headers, TLS, and cache behavior is an external deployment prerequisite.

The static endpoint is fixed to one project, platform, channel, and runtime tuple and must be consumed by a host that supports the Expo `multipart/mixed` response structure. It does not perform dynamic request-header negotiation or per-request signing-key selection.

## Publishing and rollback contract

Publisher CI owns the release proof: it validates the export, hashes every asset, signs the exact JSON bytes embedded in the multipart body, and verifies the R2 write before considering a release ready. It uploads assets first and overwrites the fixed manifest object only after those checks pass.

The channel is part of the asset URL in this contract. Promoting a manifest between `staging` and `production` therefore requires the publisher to produce URLs and a signature that match the destination tuple; it must not claim that the same signed bytes can be copied across channel-scoped URLs without revalidation.

Rollback should republish known-good assets in a new multipart manifest with a new UUID and a strictly later `createdAt`, sign the exact JSON part bytes, and overwrite the fixed tuple object. It does not delete old assets. Copying older bytes only changes what the static host serves; an older `createdAt` does not force clients that already applied a newer update to downgrade.

## GitHub Action publisher

Call the private Action from a workflow in the application repository. The caller should export the app at the approved commit, retain the complete export directory as the workflow artifact, apply any required GitHub environment approval, and serialize publishes for the same `(project, platform, channel, runtimeVersion)` tuple before invoking this Action.

```yaml
- name: Publish Expo OTA update
  uses: byulmaru/expo-ota@<ACTION_COMMIT_SHA>
  with:
    export-dir: .artifacts/expo-export
    project: kosmo-native
    platform: ios
    channel: staging
    runtime-version: '1.0.0'
    public-base-url: https://updates.example.com
    r2-bucket: expo-ota
    r2-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    r2-access-key-id: ${{ secrets.EXPO_OTA_R2_ACCESS_KEY_ID }}
    r2-secret-access-key: ${{ secrets.EXPO_OTA_R2_SECRET_ACCESS_KEY }}
    signing-private-key: ${{ secrets.EXPO_OTA_SIGNING_PRIVATE_KEY }}
    keyid: main
```

`platform` accepts `ios` or `android`; `channel` accepts `staging` or `production`; `project` is a required non-empty path segment such as `kosmo-native`. `keyid` is optional and defaults to `main`. The caller's concurrency key must include `project` along with `platform`, `channel`, and `runtime-version`.

### Inputs and outputs

The required inputs are `export-dir`, `project`, `platform`, `channel`, `runtime-version`, `public-base-url`, `r2-bucket`, `r2-account-id`, `r2-access-key-id`, `r2-secret-access-key`, and `signing-private-key`. `public-base-url` is the static CDN or R2 origin for both the multipart manifest and immutable assets. `r2-bucket` is the single bucket containing the fixed manifest and content-addressed assets. The R2 account ID, access-key ID, and secret access key are publishing credentials, and the signing key is a PEM-encoded RSA private key; provide all of them as protected GitHub secrets or environment secrets and never commit them to the calling repository. `keyid` is optional and fixed when the manifest is published.

The Action returns `update-id` (the UUID in the published manifest) and `manifest-url` (the public URL for the fixed tuple manifest). A successful run means the export was validated, its JSON manifest part was signed, assets were uploaded, the fixed multipart manifest object was written, and the published object was read back successfully. It does not mean that a native binary was built, the static host is live, or a device has applied the update.

The generated manifest deliberately uses `metadata: {}` and `extra: {}`. It does not populate `extra.expoClient`, so on a remote update `Constants.expoConfig` is `null` in SDK 56. Callers that depend on Expo config through `Constants.expoConfig` are outside this Action's current compatibility contract; they must keep that configuration in the bundle or wait for an explicitly approved public-config artifact extension.

The manifest URL uses `public-base-url` followed by the exact encoded `releases/{project}/{platform}/{channel}/{runtime}/manifest.json` key. Every launch and asset URL uses the same origin followed by the exact encoded `releases/{project}/{platform}/{channel}/{runtime}/assets/{sha256}` key. The Action writes immutable assets with `public, max-age=31536000, immutable` and writes the static multipart manifest with `private, no-store`.

### Export artifact contract

`export-dir` must be the root of an approved Expo CLI export, not a source checkout and not a fresh build request. It must contain the Expo export `metadata.json` in the v0 Metro shape and every file referenced by that metadata:

```text
.artifacts/expo-export/
├── metadata.json
├── <bundle path from metadata.json>
└── assets/
    └── <asset files referenced by metadata.json>
```

The metadata inventory has `version: 0`, `bundler: "metro"`, and a platform entry under `fileMetadata` containing one `bundle` path and `assets` entries with `path` and `ext`. Paths must stay inside `export-dir`, resolve to regular files, and be present exactly as referenced. The Expo export's inventory names are not the publication identity: the Action hashes the actual bundle and asset bytes with SHA-256, uses lowercase hexadecimal content-addressed R2 asset keys, and emits the protocol's base64url hashes in the signed manifest. Do not pre-compress files; this publisher stores manifest and assets without `content-encoding`.

Build and approval remain caller-owned. For example, the calling workflow can run `expo export --platform ios --output-dir .artifacts/expo-export` and upload that directory as an artifact in an earlier job, then download it in the protected publish job before invoking this Action. The export must come from the same approved source and release metadata that the workflow records; the Action does not rebuild or silently replace it.

## Development

```sh
CI=true pnpm install --frozen-lockfile
CI=true pnpm check:action
CI=true pnpm test:action
CI=true pnpm build:action
```

`pnpm test:action` covers the publisher tests, and `pnpm check:action` type-checks its Node 24 source. `pnpm build:action` creates the packaged Node 24 Action entrypoint at `action/dist/index.cjs`; the generated bundle is required by `action.yml` and must be included in the Action release. Publishing still requires the caller's explicit workflow invocation, protected secrets, static-host configuration, and release approval; local development commands do not deploy a Worker or publish a release.
