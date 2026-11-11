import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The first test to touch a codec compiles its WebAssembly; under a loaded machine that can
    // take longer than vitest's 5 s default.
    testTimeout: 30_000,
  },
});
