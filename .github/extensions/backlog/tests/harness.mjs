// Test sandbox helper. Initializes the backlog DB into a fresh tmp dir
// per test process. Each test file imports this BEFORE importing items/
// commands/sidecar so the live `db` binding points at the sandbox.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { initBacklog } from "../db.mjs";

// Canonicalize the sandbox path. On macOS tmpdir() returns a /var/folders
// symlink whose realpath is /private/var/folders, and process.cwd() always
// reports the canonical form. Queue bindings compare against process.cwd(),
// so a non-canonical fixture path would never match after a chdir. Production
// binds and resolves from the same canonical process.cwd(), so realpath here
// keeps the fixtures faithful to that invariant.
export const sandboxDir = realpathSync(mkdtempSync(join(tmpdir(), "backlog-test-")));
initBacklog(sandboxDir);

// Best-effort cleanup. Not every Node version supports the recursive option
// without a callback, hence the try/catch.
process.on("exit", () => {
  try { rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
});

let passed = 0;
let failed = 0;
const failures = [];

export function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  failures.push(msg || "assertion failed");
  console.error(`  ✗ ${msg}`);
}

export function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, `${msg || "values"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function done(suiteName) {
  const total = passed + failed;
  if (failed === 0) {
    console.log(`✓ ${suiteName}: ${passed}/${total} assertions passed`);
    process.exit(0);
  } else {
    console.error(`\n✗ ${suiteName}: ${failed}/${total} assertions failed`);
    for (const f of failures) console.error(`    - ${f}`);
    process.exit(1);
  }
}
