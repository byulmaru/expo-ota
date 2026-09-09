# Static Expo OTA publish workflow

This repository contains the reusable GitHub workflow and its bundled Node 24 publisher that validate, sign, and publish an approved Expo export as a static `multipart/mixed` manifest and immutable assets in one R2 bucket. The publisher does not build the app, serve HTTP requests, or select a native runtime.

The workflow checks out `byulmaru/expo-ota` at `refs/heads/main` into a separate `.publisher` directory before running the tracked bundle. That checkout requires this repository to be public; it is currently private, and the visibility change is a separate audited operation. Public visibility makes the workflow callable by anyone but does not grant publishing credentials: the job skips callers whose `github.repository_owner_id` is not `29172280`, and Vault trust remains the hard credential boundary.

The legacy Expo OTA Worker deployment was deleted on 2026-09-09; its custom domain is detached and no `/v1/...` path is active. Recovery would require an explicit redeploy from Git history and is not automatic. This README records the static endpoint's configured routing/header state, not full static-host validation or device-application proof.

As of 2026-09-09, the R2 custom domain `expo-ota.byulmaru.co` is configured/enabled and DNS is R2-proxied. UI configuration shows manifest cache bypass active. An independent edge check verified TLS, static routing, and manifest-only `expo-protocol-version: 1` / `expo-sfv-version: 0` headers; the empty R2 bucket (0 B) correctly returned an HTML 404 with `cf-cache-status: DYNAMIC`, which does not prove positive manifest cache behavior. No real release has returned HTTP 200 or produced signature, asset, or device-application proof.

The workflow must receive an already-built, approved export from the calling repository. The calling workflow owns the approved commit and any environment approval; within each caller repository, the reusable publisher workflow serializes publishes for the `(project, platform, channel, runtimeVersion)` tuple. Separate caller repositories are not coordinated by this concurrency group and should use distinct `project` namespaces for independent publication streams. The publisher source is trusted from this repository's reviewed `main` ref, not from the caller's commit.

## Static object paths and response contract

- `GET /releases/{project}/{platform}/{channel}/{runtime}/manifest.json`
- `GET /releases/{project}/{platform}/{channel}/{runtime}/assets/{lowercase-sha256-hex}`

The publisher writes these prospective static objects directly to R2. Serving them requires the configured public host. The route tuple maps directly to these keys:

```text
releases/{project}/{platform}/{channel}/{runtime}/manifest.json
releases/{project}/{platform}/{channel}/{runtime}/assets/{lowercase-sha256-hex}
```

`project`, `platform`, `channel`, and `runtime` are fixed in each URL. The publisher validates `project` and `runtime` as single path segments, and URL path segments are percent-encoded while R2 keys retain their exact input values.

The manifest object has a `multipart/mixed; boundary=...` content type. Its first part is the JSON manifest:

```text
Content-Disposition: form-data; name="manifest"
Content-Type: application/json
expo-signature: sig="<base64>", keyid="main", alg="rsa-v1_5-sha256"
```

The `expo-signature` value signs exactly the JSON bytes in that part. The signature is not duplicated in custom object metadata. Asset objects use their content-addressed keys and are served with `public, max-age=31536000, immutable`; the manifest uses `private, no-store`.

Publisher storage is uncompressed: manifest and asset objects must be written without `content-encoding` (an explicit `identity` value is accepted). The publisher verifies the stored body, content type, cache policy, and bytes after each write.

Before a device can consume a static manifest URL, the public host/CDN must route the exact encoded host/path to the matching R2 object and return these top-level response headers:

```text
expo-protocol-version: 1
expo-sfv-version: 0
```

It must preserve the manifest `Content-Type` and multipart bytes, avoid content encoding transformations, and bypass or revalidate caching for the fixed manifest path. Asset paths may use immutable CDN caching. The publisher writes the R2 object headers needed for storage, but configuring the public host, response headers, TLS, and cache behavior is an external deployment prerequisite.

The static endpoint is fixed to one project, platform, channel, and runtime tuple and must be consumed by a host that supports the Expo `multipart/mixed` response structure. It does not perform dynamic request-header negotiation or per-request signing-key selection.

## Publishing and rollback contract

Publisher CI owns the release proof: it validates the export, hashes every asset, signs the exact JSON bytes embedded in the multipart body, and verifies the R2 write before considering a release ready. It uploads assets first and overwrites the fixed manifest object only after those checks pass.

The channel is part of the asset URL in this contract. Promoting a manifest between `staging` and `production` therefore requires the publisher to produce URLs and a signature that match the destination tuple; it must not claim that the same signed bytes can be copied across channel-scoped URLs without revalidation.

Rollback should republish known-good assets in a new multipart manifest with a new UUID and a strictly later `createdAt`, sign the exact JSON part bytes, and overwrite the fixed tuple object. It does not delete old assets. Copying older bytes only changes what the static host serves; an older `createdAt` does not force clients that already applied a newer update to downgrade.

## Reusable Vault publisher workflow

Application repositories should call the reusable workflow after exporting and uploading the approved export artifact. The caller passes only the artifact name, release tuple, and its app-owned signing key. The workflow downloads the caller artifact, joins the existing private Tailnet, authenticates to Vault with GitHub OIDC, reads the R2 access key object from `secret/data/expo-ota/r2`, maps the canonical service variables into the publisher's required inputs, and runs the checked-out Node 24 bundle. It does not inherit all caller secrets; `signing_private_key` remains an explicit app-owned workflow secret.

The caller must have the non-secret Tailscale variables `TAILSCALE_AUDIENCE` and `TAILSCALE_OAUTH_CLIENT_ID`, plus `EXPO_OTA_PUBLIC_BASE_URL`, `EXPO_OTA_R2_BUCKET`, and `CLOUDFLARE_ACCOUNT_ID`, available from its repository or organization configuration. The reusable workflow uses the existing `VAULT_ADDR` variable for both the Vault endpoint and GitHub OIDC audience; callers do not configure a separate audience variable. The workflow does not rely on variables from this repository's private configuration.

Vault provisioning is pending with the infrastructure owner. The `expo-ota-publish` role at the `github-actions` JWT mount must be bound to `repository_owner_id=29172280` and the exact `job_workflow_ref` `byulmaru/expo-ota/.github/workflows/publish.yml@refs/heads/main`, allowing approved callers across the `byulmaru` organization while keeping the publisher workflow pinned to this repository and ref. Its policy must grant read access only to the dedicated KV v2 API path `secret/data/expo-ota/r2`; the workflow selects only the `access_key_id` and `secret_access_key` fields from that object. Public repository visibility and workflow callability do not bypass this Vault trust.

```yaml
jobs:
  publish-ota:
    needs: export
    permissions:
      actions: read
      contents: read
      id-token: write
    uses: byulmaru/expo-ota/.github/workflows/publish.yml@refs/heads/main
    with:
      artifact_name: expo-ota-export
      project: kosmo-native
      platform: ios
      channel: production
      runtime_version: '1.0.0'
    secrets:
      signing_private_key: ${{ secrets.EXPO_OTA_SIGNING_PRIVATE_KEY }}
```

The artifact named by `artifact_name` must contain the export directory contents with `metadata.json` at its root. The caller remains responsible for producing that artifact from the approved source and for passing the app-specific signing key; it does not need to configure the shared R2 secrets, which the reusable workflow reads from Vault on its runner at publish time.

## Publisher workflow inputs and outputs

The reusable workflow is the supported publishing entrypoint. The caller should export the app at the approved commit, retain the complete export directory as the workflow artifact, apply any required GitHub environment approval, and serialize publishes for the same `(project, platform, channel, runtimeVersion)` tuple before calling the workflow. The workflow owner guard accepts only repositories with `repository_owner_id=29172280`; Vault remains the source of R2 credentials.

`platform` accepts `ios` or `android`; `channel` accepts `staging` or `production`; `project` is a required non-empty path segment such as `kosmo-native`. `keyid` is optional and defaults to `main`. The caller's concurrency key must include `project` along with `platform`, `channel`, and `runtime-version`.

### Inputs and outputs

The workflow inputs are `artifact_name`, `project`, `platform`, `channel`, `runtime_version`, and `keyid`; `runtime_version` is required and `keyid` is optional. The app-owned `signing_private_key` secret is also required. The workflow maps `EXPO_OTA_PUBLIC_BASE_URL`, `EXPO_OTA_R2_BUCKET`, and `CLOUDFLARE_ACCOUNT_ID` into the publisher's required service inputs, while Vault supplies the R2 access key ID and secret access key. The publisher validates every mapped value; the removed root Action metadata is not a separate supported entrypoint. The R2 access key ID, secret access key, and signing key are publishing credentials; callers must never commit them. `keyid` is fixed when the manifest is published.

The publisher internally writes `update-id` (the UUID in the published manifest) and `manifest-url` (the public URL for the fixed tuple manifest) for its run step; the reusable workflow does not expose caller-visible workflow outputs. A successful run means the export was validated, its JSON manifest part was signed, assets were uploaded, the fixed multipart manifest object was written, and the published object was read back successfully. It does not mean that a native binary was built, the static host is live, or a device has applied the update.

The generated manifest deliberately uses `metadata: {}` and `extra: {}`. It does not populate `extra.expoClient`, so on a remote update `Constants.expoConfig` is `null` in SDK 56. Callers that depend on Expo config through `Constants.expoConfig` are outside this publisher's current compatibility contract; they must keep that configuration in the bundle or wait for an explicitly approved public-config artifact extension.

The manifest URL uses the supplied `public-base-url` followed by the exact encoded `releases/{project}/{platform}/{channel}/{runtime}/manifest.json` key. Every launch and asset URL uses the same supplied origin followed by the exact encoded `releases/{project}/{platform}/{channel}/{runtime}/assets/{sha256}` key. The publisher writes to the supplied `r2-bucket` and writes immutable assets with `public, max-age=31536000, immutable` plus the static multipart manifest with `private, no-store`.

### Export artifact contract

The artifact named by `artifact_name` must contain the root of an approved Expo CLI export, not a source checkout and not a fresh build request. The workflow downloads it to `.artifacts/expo-export`; that directory must contain the Expo export `metadata.json` in the v0 Metro shape and every file referenced by that metadata:

```text
.artifacts/expo-export/
├── metadata.json
├── <bundle path from metadata.json>
└── assets/
    └── <asset files referenced by metadata.json>
```

The metadata inventory has `version: 0`, `bundler: "metro"`, and a platform entry under `fileMetadata` containing one `bundle` path and `assets` entries with `path` and `ext`. Paths must stay inside `.artifacts/expo-export`, resolve to regular files, and be present exactly as referenced. The Expo export's inventory names are not the publication identity: the publisher hashes the actual bundle and asset bytes with SHA-256, uses lowercase hexadecimal content-addressed R2 asset keys, and emits the protocol's base64url hashes in the signed manifest. Do not pre-compress files; this publisher stores manifest and assets without `content-encoding`.

Build and approval remain caller-owned. For example, the calling workflow can run `expo export --platform ios --output-dir .artifacts/expo-export` and upload that directory as an artifact in an earlier job, then the reusable workflow downloads it in the protected publish job before running the trusted bundle. The export must come from the same approved source and release metadata that the workflow records; the publisher does not rebuild or silently replace it.

## Development

```sh
CI=true pnpm install --frozen-lockfile
CI=true pnpm check:action
CI=true pnpm test:action
CI=true pnpm build:action
```

`pnpm test:action` covers the publisher tests, and `pnpm check:action` type-checks its Node 24 source. `pnpm build:action` creates the packaged Node 24 publisher entrypoint at `action/dist/index.cjs`; the reusable workflow checks out and runs this tracked bundle. Publishing still requires the caller's explicit workflow invocation, protected secrets, static-host configuration, and release approval; local development commands do not deploy a Worker or publish a release.
