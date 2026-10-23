import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [
  "verify-planner-package-safety.mjs",
  "verify-android-preview-errors.mjs",
  "verify-sync-entrypoints.mjs",
  "verify-planner-sync.mjs",
  "verify-planner-compaction.mjs",
  "verify-planner-remote-merge.mjs",
  "verify-cloudflare-http.mjs",
  "verify-cloudflare-db.mjs",
  "verify-cloudflare-assets.mjs",
  "verify-cloudflare-transport.mjs",
];

let failed = false;
for (const check of checks) {
  process.stdout.write(`\n==> ${check}\n`);
  const result = spawnSync(process.execPath, [path.join(root, "scripts", check)], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`${check}: ${result.error.message}\n`);
    failed = true;
  } else if (result.status !== 0) {
    process.stderr.write(`${check}: exited with status ${result.status ?? "unknown"}\n`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
