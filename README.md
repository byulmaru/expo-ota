# Expo OTA Worker

This private repository contains the organization-shared, read-only Cloudflare Worker that serves prebuilt Expo Updates v1 manifests and immutable assets from the `RELEASES` R2 bucket.

The Worker does not publish releases, sign manifests, mutate pointers, or hold a signing private key. Release CI writes a complete pointer and signed manifest to R2. The Worker receives only the corresponding SPKI public key through the `EXPO_OTA_PUBLIC_KEY_PEM` deployment variable and verifies the exact manifest bytes with `RSASSA-PKCS1-v1_5` / `SHA-256` before serving them.

## Routes

- `GET /v1/projects/kosmo-native/platforms/{ios|android}/channels/{staging|production}/runtimes/{runtime}/manifest`
- `GET /v1/projects/kosmo-native/platforms/{ios|android}/channels/{staging|production}/runtimes/{runtime}/assets/{lowercase-sha256-hex}`

Manifest requests require `expo-protocol-version: 1`, matching `expo-platform` and `expo-runtime-version` headers, and an `Accept` value compatible with the stored manifest content type. If `expo-expect-signature` is present, it must be an Expo Structured Field Value dictionary with a bare `sig` member and optional matching `keyid` and `alg` members.

The stored pointer has this minimal shape:

```json
{
  "complete": true,
  "manifestKey": "releases/kosmo-native/ios/staging/runtime/manifests/release.json",
  "signature": "sig=\"<canonical-base64>\", keyid=\"main\", alg=\"rsa-v1_5-sha256\"",
  "contentType": "application/expo+json"
}
```

The signed manifest must contain a valid Expo Updates v1 manifest. Each `launchAsset` and `assets` entry must use a base64url SHA-256 hash whose decoded bytes match the lowercase hexadecimal asset URL on the same project, platform, channel, runtime, and Worker origin. Asset responses require R2 HTTP `contentType` metadata and a matching R2 SHA-256 checksum before they are streamed with long-lived immutable caching. Assets remain addressable after a channel pointer is promoted because their URLs are content-addressed.

`wrangler.jsonc` deliberately contains only local/test resource names and an empty public-key placeholder. Replace that variable and bind approved Cloudflare resources in a deployment environment; do not commit private keys, certificates, account identifiers, or release credentials.

## Development

```sh
CI=true pnpm install --frozen-lockfile
pnpm types
pnpm check:types
pnpm test
pnpm check:wrangler
```

`pnpm check:wrangler` runs a dry-run bundle validation. No command in this repository publishes a release or deploys a Worker automatically.
