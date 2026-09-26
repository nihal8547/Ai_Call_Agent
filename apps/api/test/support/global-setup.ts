import { execFileSync } from "node:child_process";
import path from "node:path";

/** Apply migrations to the integration-test database (non-destructive, advisory-locked by Prisma) */
export default function setup(): void {
  try {
    process.loadEnvFile(path.resolve(__dirname, "../../../../.env"));
  } catch {
    // CI provides variables directly
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !process.env.TEST_APP_DATABASE_URL) {
    console.warn("TEST_DATABASE_URL / TEST_APP_DATABASE_URL not set: API integration tests are skipped");
    return;
  }
  execFileSync("pnpm", ["--filter", "@platform/db", "exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url, DATABASE_MIGRATION_URL: url },
    stdio: "pipe",
  });
}
