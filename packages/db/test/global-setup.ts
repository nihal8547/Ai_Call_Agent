import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Applies pending migrations to the integration-test database (owner connection).
 * Non-destructive: tests create their own uniquely named tenants and never depend on an empty database.
 * Skipped when TEST_DATABASE_URL is not set; the suites then skip themselves.
 */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn("TEST_DATABASE_URL not set: database integration tests are skipped");
    return;
  }
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url, DATABASE_MIGRATION_URL: url },
    stdio: "pipe",
  });
}
