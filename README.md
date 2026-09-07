# Kosmo Expo OTA Worker

This worker serves prebuilt Expo OTA manifests and immutable update assets from the `RELEASES` R2 bucket. Manifest responses preserve the release pointer's Expo signature metadata; a public signing key is not currently part of the Worker `Env`, so cryptographic signature verification remains an integration prerequisite.

## Routes

- `GET /v1/projects/kosmo-native/platforms/{ios|android}/channels/{staging|production}/runtimes/{runtime}/manifest`
- `GET /v1/projects/kosmo-native/platforms/{ios|android}/channels/{staging|production}/runtimes/{runtime}/assets/{sha256}`

Manifest requests require `expo-protocol-version: 1`. The channel pointer and prebuilt manifest are read from R2. Asset requests accept only lowercase SHA-256 hexadecimal keys.

The worker is intentionally read-only: unsupported methods and unknown routes return an error, and there are no publish, administration, signing, or conditional request endpoints.
