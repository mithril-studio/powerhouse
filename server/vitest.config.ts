import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-pg.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // DBOS is a per-process singleton; keep files in separate forks (default)
    // and tests within a file sequential.
    pool: "forks",
    fileParallelism: false,
  },
});
