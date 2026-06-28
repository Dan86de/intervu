import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.integration.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
