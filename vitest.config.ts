import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Building a ts-morph project per fixture takes a few seconds.
    testTimeout: 60_000,
  },
});
