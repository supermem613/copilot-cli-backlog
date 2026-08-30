import "./harness.mjs";
import { assert, assertEqual, done, sandboxDir } from "./harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../../../bin/backlog.mjs", import.meta.url));

function runCli(args) {
  const commandLabel = args[0] || "cli";
  const result = spawnSync(process.execPath, [cliPath, ...args, "--cwd", workspaceDir, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert(!result.error, `${commandLabel} should launch without error, got ${result.error?.message || "unknown launch error"}`);
  assertEqual(result.status, 0, `${commandLabel} command should exit 0`);

  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    assert(false, `${commandLabel} stdout should be parseable JSON: ${error.message}`);
  }

  if (envelope) {
    assertEqual(envelope.ok, true, `${commandLabel} envelope should report ok=true`);
    assertEqual(envelope.command, commandLabel, `${commandLabel} envelope should identify the command`);
  }

  return envelope;
}

const workspaceDir = mkdtempSync(join(sandboxDir, "workspace-"));
mkdirSync(join(workspaceDir, ".git"), { recursive: true });

const initEnvelope = runCli(["init", "session-targeting-queue", "Session Target Queue"]);
assertEqual(initEnvelope?.data?.queueId, "session-targeting-queue", "init should create the expected queue id");

const distinctItem = "session-targeting-item";
const addEnvelope = runCli(["add", distinctItem]);
assert(addEnvelope?.data?.output?.includes(distinctItem), `add output should include the added item, got: ${addEnvelope?.data?.output}`);

const listEnvelope = runCli(["list"]);
assert(listEnvelope?.data?.output?.includes(distinctItem), `list output should include the added item, got: ${listEnvelope?.data?.output}`);

const statusEnvelope = runCli(["status"]);
assertEqual(statusEnvelope?.data?.queueId, initEnvelope?.data?.queueId, "status should resolve the same queue id as init");
assertEqual(statusEnvelope?.data?.itemCounts?.pendingItems, 1, "status should report one pending item");

done("test-cli-session-targeting");
