import { publishRelease, readActionInputs, setActionOutput } from "./publish";

async function main(): Promise<void> {
  const result = await publishRelease(readActionInputs());
  setActionOutput("update-id", result.updateId);
  setActionOutput("manifest-url", result.manifestUrl);
  console.log(`Published Expo OTA update ${result.updateId}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Expo OTA publish failed";
  console.error(`::error::${message.replace(/[\r\n]+/gu, " ")}`);
  process.exitCode = 1;
});
