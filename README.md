# Expo OTA Worker

This private repository contains the organization-shared, read-only Cloudflare Worker that serves Expo Updates v1 manifests and immutable assets from the `RELEASES` R2 bucket.

The Worker is deliberately a delivery layer. A publisher validates the manifest and every asset reference, signs the exact manifest bytes, and publishes the manifest body and its `signature` custom metadata together to one fixed R2 object. The Worker does not publish releases, hold a private key, verify the signature, parse manifest JSON, traverse asset references, or hash asset bodies. Expo clients remain responsible for cryptographic signature verification.

## Routes and R2 keys

- `GET /v1/projects/{project}/platforms/{ios|android}/channels/{staging|production}/runtimes/{runtime}/manifest`
- `GET /v1/projects/{project}/platforms/{ios|android}/channels/{staging|production}/runtimes/{runtime}/assets/{lowercase-sha256-hex}`

The route tuple maps directly to these keys:

```text
releases/{project}/{platform}/{channel}/{runtime}/manifest.json
releases/{project}/{platform}/{channel}/{runtime}/assets/{lowercase-sha256-hex}
```

`project` is a caller-selected, nonempty path segment. The Worker accepts any project value that does not contain `/`, `\`, or control characters and is not `.` or `..`; it does not maintain a project registry or allowlist.

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

This repository has no production deployment, live R2, or device-application proof. The checks below cover the Worker bundle and local R2 test harness only.

## Development

```sh
CI=true pnpm install --frozen-lockfile
CI=true pnpm types
CI=true pnpm check:types
CI=true pnpm test
CI=true pnpm check:wrangler
```

`pnpm check:wrangler` runs a dry-run Worker bundle validation. No command in this repository publishes a release or deploys a Worker automatically.
