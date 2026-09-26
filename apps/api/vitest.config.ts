import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC (instead of esbuild) so NestJS decorator metadata is emitted in tests
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
