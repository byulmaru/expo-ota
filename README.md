# Expo OTA Worker and publish Action

This private repository contains the organization-shared, read-only Cloudflare Worker that serves Expo Updates v1 manifests and immutable assets from the `RELEASES` R2 bucket, plus the reusable GitHub Action that validates, signs, and publishes approved Expo exports to that bucket.

The Worker is deliberately a delivery layer. A publisher validates the manifest and every asset reference, signs the exact manifest bytes, and publishes the manifest body and its `signature` custom metadata together to one fixed R2 object. The Worker does not publish releases, hold a private key, verify the signature, parse manifest JSON, traverse asset references, or hash asset bodies. Expo clients remain responsible for cryptographic signature verification.

The Action is the publisher. It must receive an already-built, approved export from the calling repository; it does not build the app or select a native runtime. The calling workflow owns the approved commit, environment approval, and concurrency guard for the `(project, platform, channel, runtimeVersion)` tuple. Keep the Action reference pinned to an immutable commit until a reviewed release of this private repository exists; the examples below intentionally use `<ACTION_COMMIT_SHA>` because no `v1` reference exists yet.

## Routes and R2 keys

- `GET /v1/projects/kosmo-native/platforms/{ios|android}/channels/{staging|production}/runtimes/{runtime}/manifest`
- `GET /v1/projects/kosmo-native/platforms/{ios|android}/channels/{staging|production}/runtimes/{runtime}/assets/{lowercase-sha256-hex}`

The route tuple maps directly to these keys:

```text
releases/kosmo-native/{platform}/{channel}/{runtime}/manifest.json
releases/kosmo-native/{platform}/{channel}/{runtime}/assets/{lowercase-sha256-hex}
```

The manifest object must have an Expo manifest content type (`application/expo+json` or `application/json`) and a `signature` custom metadata value in Expo Structured Field Value form:

```text
sig="<canonical-base64>", keyid="main", alg="rsa-v1_5-sha256"
```

The publisher should upload the body and metadata in one R2 `put` operation. R2 then exposes the body and metadata from the same object version, so a promoted tuple never requires a pointer read. Asset objects need their content type metadata and are served with long-lived immutable caching. Their content-addressed keys remain available after a later manifest promotion.

Publisher storage is uncompressed: manifest and asset objects must be written without `content-encoding` (an explicit `identity` value is accepted). The Worker does not negotiate or decode compressed objects and returns `404` for any other content encoding.

Manifest requests require `expo-protocol-version: 1`, matching `expo-platform` and `expo-runtime-version` headers, and, when present, an `Accept` value compatible with the stored manifest content type. `expo-expect-signature` is checked against the stored signature's `keyid` and `alg`; the signature itself is verified by the Expo client. Responses reset `expo-manifest-filters` and `expo-server-defined-headers` with empty SFV dictionaries.

## Publishing and rollback contract

Publisher CI owns the release proof: it must validate the manifest JSON, runtime version, asset hashes and URLs, sign the exact bytes that it uploads, and verify the R2 write before considering a release ready. It should upload assets first and overwrite the fixed manifest object only after those checks pass.

The channel is part of the asset URL in this contract. Promoting a manifest between `staging` and `production` therefore requires the publisher to produce URLs and a signature that match the destination tuple; it must not claim that the same signed bytes can be copied across channel-scoped URLs without revalidation.

Rollback should republish known-good assets in a new manifest with a new UUID and a strictly later `createdAt`, sign those exact bytes, and overwrite the fixed tuple object with the new body and matching signature metadata. It does not delete old assets. Copying older bytes only changes what the server selects; an older `createdAt` does not force clients that already applied a newer update to downgrade.

This repository has no production deployment, live R2, or device-application proof. The checks below cover the Worker bundle, publisher Action, and local R2 test harness only.

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

The required inputs are `export-dir`, `project`, `platform`, `channel`, `runtime-version`, `public-base-url`, `r2-bucket`, `r2-account-id`, `r2-access-key-id`, `r2-secret-access-key`, and `signing-private-key`. The R2 account ID, access-key ID, and secret access key are publishing credentials, and the signing key is a PEM-encoded RSA private key; provide all of them as protected GitHub secrets or environment secrets and never commit them to the calling repository. `keyid` is optional.

The Action returns `update-id` (the UUID in the published manifest) and `manifest-url` (the public URL for the fixed tuple manifest). A successful run means the export was validated, its manifest was signed, assets were uploaded, the fixed manifest object was written with the matching signature metadata, and the published object was read back successfully. It does not mean that a native binary was built or that a device has applied the update.

The generated manifest deliberately uses `metadata: {}` and `extra: {}`. It does not populate `extra.expoClient`, so on a remote update `Constants.expoConfig` is `null` in SDK 56. Callers that depend on Expo config through `Constants.expoConfig` are outside this Action's current compatibility contract; they must keep that configuration in the bundle or wait for an explicitly approved public-config artifact extension.

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
CI=true pnpm types
CI=true pnpm check:types
CI=true pnpm check:action
CI=true pnpm test
CI=true pnpm test:action
CI=true pnpm check:wrangler
CI=true pnpm build:action
```

`pnpm test` covers the Worker tests; `pnpm test:action` covers the publisher tests, and `pnpm check:action` type-checks its Node 24 source. `pnpm check:wrangler` runs a dry-run Worker bundle validation. `pnpm build:action` creates the packaged Node 24 Action entrypoint at `action/dist/index.cjs`; the generated bundle is required by `action.yml` and must be included in the Action release. Publishing still requires the caller's explicit workflow invocation, protected secrets, and release approval; local development commands do not deploy a Worker or publish a release.
