import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["action/test/**/*.test.ts"],
  },
});
