import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma does not read .env when a config file is used; load the monorepo root .env if present.
// Variables already set in the environment (CI, production) always win.
try {
  process.loadEnvFile(path.resolve(__dirname, "../../.env"));
} catch {
  // no .env file — rely on the real environment
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
});
