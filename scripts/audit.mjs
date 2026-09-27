#!/usr/bin/env node
// Fails on high or critical advisories in production dependencies, except those listed here with
// a reason and an expiry date (after which they fail again, so exceptions get re-reviewed).
import { execSync } from "node:child_process";

const ALLOWED = {
  // postcss 8.4.31 is pinned inside next@15 and runs only at build time on our own CSS; the
  // advisories need attacker-controlled CSS or source maps. Fixed by moving to next 16.
  "GHSA-qx2v-qp2m-jg93": { until: "2027-01-31", why: "build-time postcss inside next 15" },
  "GHSA-6g55-p6wh-862q": { until: "2027-01-31", why: "build-time postcss inside next 15" },
  "GHSA-fxqj-rqcc-2cmp": { until: "2027-01-31", why: "build-time postcss inside next 15" },
  "GHSA-r28c-9q8g-f849": { until: "2027-01-31", why: "build-time postcss inside next 15" },
};

let raw;
try {
  raw = execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (err) {
  raw = err.stdout; // npm audit exits non-zero when it finds anything
}
const report = JSON.parse(raw);
const today = new Date().toISOString().slice(0, 10);
const problems = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via === "string" || !["high", "critical"].includes(via.severity)) continue;
    const id = String(via.url ?? "").split("/").pop();
    const allowed = ALLOWED[id];
    if (allowed && allowed.until >= today) continue;
    problems.push(`${via.severity.toUpperCase()} ${name}: ${via.title} (${via.url})${allowed ? " — allowance expired" : ""}`);
  }
}
if (problems.length) {
  console.error(`Production dependency advisories:\n${[...new Set(problems)].join("\n")}`);
  process.exit(1);
}
console.log("No unaccepted high or critical advisories in production dependencies.");
