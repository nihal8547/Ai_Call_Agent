import path from "node:path";
import { defineConfig } from "vitest/config";

// Local runs pick up the monorepo root .env; CI sets the variables directly
try {
  process.loadEnvFile(path.resolve(__dirname, "../../.env"));
} catch {
  // no .env file
}
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Tests share one database
    fileParallelism: false,
  },
});
