import { appendFileSync } from "node:fs";
import { readActionInputs } from "./input";
import { publishRelease } from "./publish";

function setActionOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value}\n`, { encoding: "utf8", mode: 0o600 });
}

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
