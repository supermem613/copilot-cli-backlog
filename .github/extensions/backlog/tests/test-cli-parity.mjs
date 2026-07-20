import "./harness.mjs";
import { assert, assertEqual, done, sandboxDir } from "./harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createQueue } from "../db.mjs";
import { addItem, markDone } from "../items.mjs";
import { bindQueueScope, describeBacklogStatus } from "../queue-resolver.mjs";
import { parseBacklogCommand, handleBacklogCommand } from "../commands.mjs";
import { getCommandDefinition, getSlashCommandNames } from "../command-registry.mjs";
import { runCli } from "../cli.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "cli-parity-"));
const initDir = mkdtempSync(join(tmpdir(), "cli-init-"));
process.on("exit", () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  try { rmSync(initDir, { recursive: true, force: true }); } catch {}
});

const queue = createQueue({ id: "queue-cli-parity", name: "CLI Parity Queue" });
bindQueueScope(queue, tempDir, { preferred: true });
const pendingItem = addItem("pending parity item", false, queue.id);
markDone(pendingItem.id, queue.id);

const expectedStatus = describeBacklogStatus({
  cwd: tempDir,
  queues: [queue],
});

const cliPath = fileURLToPath(new URL("../../../../bin/backlog.mjs", import.meta.url));
const statusResult = spawnSync(process.execPath, [cliPath, "status", "--cwd", tempDir, "--db-dir", sandboxDir], {
  cwd: process.cwd(),
  encoding: "utf8",
});

assert(!statusResult.error, `expected CLI entry at ${cliPath}, got ${statusResult.error?.message || "unknown launch error"}`);
if (statusResult.error) {
  done("test-cli-parity");
} else {
  assertEqual(statusResult.status, 0, "status command should exit 0");
  assert(statusResult.stdout, "stdout should contain a JSON envelope");
  let statusEnvelope;
  try {
    statusEnvelope = JSON.parse(statusResult.stdout);
  } catch (error) {
    assert(false, `stdout should be parseable JSON: ${error.message}`);
  }
  if (statusEnvelope) {
    assertEqual(typeof statusEnvelope, "object", "status envelope should be an object");
    assertEqual(statusEnvelope.ok, true, "status envelope should report ok=true");
    assertEqual(statusEnvelope.command, "status", "status envelope should identify the command");
    assertEqual(typeof statusEnvelope.schemaVersion, "string", "status envelope should include schemaVersion");
    assertEqual(typeof statusEnvelope.data, "object", "status envelope should include a data object");
    assertEqual(typeof statusEnvelope.timingMs, "number", "status envelope should include timingMs");
    assertEqual(statusEnvelope.data.state, expectedStatus.state, "status data should mirror the shared status descriptor");
    assertEqual(statusEnvelope.data.queueId, expectedStatus.queueId, "status data queueId should mirror the shared status descriptor");
    assertEqual(statusEnvelope.data.matchedBy, expectedStatus.matchedBy, "status data matchedBy should mirror the shared status descriptor");
    assertEqual(statusEnvelope.data.canonicalScope, expectedStatus.canonicalScope, "status data canonicalScope should mirror the shared status descriptor");
    assertEqual(JSON.stringify(statusEnvelope.data.candidates || []), JSON.stringify(expectedStatus.candidates || []), "status data candidates should mirror the shared status descriptor");
    assertEqual(JSON.stringify(statusEnvelope.data.itemCounts || {}), JSON.stringify(expectedStatus.itemCounts || {}), "status data itemCounts should mirror the shared status descriptor");
    assertEqual(statusEnvelope.data.createdItem, expectedStatus.createdItem, "status data createdItem should mirror the shared status descriptor");
    if (statusResult.stderr) {
      assert(/hint|progress/i.test(statusResult.stderr), `stderr should contain hints/progress when present, got: ${statusResult.stderr}`);
    }
  }

  const sharedCommandNames = ["add", "list", "move", "done", "remove"];
  for (const sharedCommand of sharedCommandNames) {
    const parsed = parseBacklogCommand(sharedCommand);
    assertEqual(parsed.cmd, sharedCommand, `shared slash parser should recognize ${sharedCommand}`);
  }
  const queueParsed = parseBacklogCommand("queue list");
  assertEqual(queueParsed.cmd, "queue", "queue subcommands should share the queue handler");
  const initParsed = parseBacklogCommand("init");
  assertEqual(initParsed.cmd, "init", "init should share the queue binding handler");
  const doctorParsed = parseBacklogCommand("doctor");
  assertEqual(doctorParsed.cmd, "doctor", "doctor should share the shared slash handler");
  assert(getCommandDefinition("backlog"), "extension root /backlog command metadata stays registered");
  assertEqual(
    getSlashCommandNames().join(","),
    "add,list,move,done,remove,edit,pending,status,init,clear,queue,show,approve,review,backup,restore,doctor",
    "CLI-visible shared commands match the runnable slash subcommand surface",
  );

  const sharedHandlerCheck = await handleBacklogCommand("doctor");
  assert(typeof sharedHandlerCheck === "string", "shared slash handler should return a string response for doctor");

  const helpResult = spawnSync(process.execPath, [cliPath, "help", "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(helpResult.status, 0, "help command should exit 0");
  let helpEnvelope;
  try {
    helpEnvelope = JSON.parse(helpResult.stdout);
  } catch (error) {
    assert(false, `help stdout should be parseable JSON by default: ${error.message}`);
  }
  if (helpEnvelope) {
    assertEqual(helpEnvelope.ok, true, "help envelope should report ok=true");
    assertEqual(helpEnvelope.command, "help", "help envelope should identify the command");
    assert(/Usage: backlog <command>/.test(helpEnvelope.data.help), "help envelope should contain help text in data.help");
  }

  const initResult = spawnSync(process.execPath, [cliPath, "init", "cli-init-queue", "CLI Init Queue", "--cwd", initDir, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(initResult.status, 0, "init command should exit 0");
  let initEnvelope;
  try {
    initEnvelope = JSON.parse(initResult.stdout);
  } catch (error) {
    assert(false, `init stdout should be parseable JSON: ${error.message}`);
  }
  if (initEnvelope) {
    assertEqual(initEnvelope.ok, true, "init envelope should report ok=true");
    assertEqual(initEnvelope.command, "init", "init envelope should identify the command");
    assertEqual(initEnvelope.data.queueId, "cli-init-queue", "init envelope should include the created queue id");
    assertEqual(initEnvelope.data.status.state, "resolved", "init envelope should include resolved status");
  }

  const cliAddResult = spawnSync(process.execPath, [cliPath, "add", "editable cli item", "--cwd", initDir, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(cliAddResult.status, 0, "add command should exit 0 for edit parity setup");
  let cliAddEnvelope;
  try {
    cliAddEnvelope = JSON.parse(cliAddResult.stdout);
  } catch (error) {
    assert(false, `add stdout should be parseable JSON: ${error.message}`);
  }
  assertEqual(cliAddEnvelope?.data?.item?.description, "editable cli item", "add envelope should expose the created item");
  assertEqual(cliAddEnvelope?.data?.item?.position, 1, "add envelope should expose the created item position");
  const editableId = cliAddEnvelope?.data?.item?.id;
  assert(editableId, "add envelope should expose the created item id");

  const cliListResult = spawnSync(process.execPath, [cliPath, "list", "--cwd", initDir, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(cliListResult.status, 0, "list command should exit 0");
  let cliListEnvelope;
  try {
    cliListEnvelope = JSON.parse(cliListResult.stdout);
  } catch (error) {
    assert(false, `list stdout should be parseable JSON: ${error.message}`);
  }
  assertEqual(cliListEnvelope?.data?.queueId, "cli-init-queue", "list envelope should expose the resolved queue id");
  assertEqual(cliListEnvelope?.data?.items?.[0]?.description, "editable cli item", "list envelope should expose pending items as objects");

  const cliEditResult = spawnSync(process.execPath, [cliPath, "edit", editableId || "missing", "edited cli item", "--cwd", initDir, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(cliEditResult.status, 0, "edit command should exit 0");
  let cliEditEnvelope;
  try {
    cliEditEnvelope = JSON.parse(cliEditResult.stdout);
  } catch (error) {
    assert(false, `edit stdout should be parseable JSON: ${error.message}`);
  }
  if (cliEditEnvelope) {
    assertEqual(cliEditEnvelope.ok, true, "edit envelope should report ok=true");
    assertEqual(cliEditEnvelope.command, "edit", "edit envelope should identify the command");
    assertEqual(cliEditEnvelope.data.item?.description, "edited cli item", "edit envelope should expose the updated item");
  }

  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write;
  let unknownStdout = "";
  process.exitCode = undefined;
  process.stdout.write = (chunk) => {
    unknownStdout += String(chunk);
    return true;
  };
  try {
    await runCli(["frobnicate", "--cwd", tempDir, "--db-dir", sandboxDir]);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assertEqual(process.exitCode, 1, "unknown CLI commands should set a non-zero exit code");
  process.exitCode = originalExitCode;
  let unknownEnvelope;
  try {
    unknownEnvelope = JSON.parse(unknownStdout);
  } catch (error) {
    assert(false, `unknown command stdout should be parseable JSON: ${error.message}`);
  }
  if (unknownEnvelope) {
    assertEqual(unknownEnvelope.ok, false, "unknown CLI commands should report ok=false");
    assertEqual(unknownEnvelope.command, "frobnicate", "unknown CLI commands should identify the attempted command");
    assertEqual(unknownEnvelope.data.knownCommands.join(","), getSlashCommandNames().join(","), "unknown CLI command output lists the runnable slash subcommands");
  }

  const missingDoneResult = spawnSync(process.execPath, [cliPath, "done", "missing-item", "--cwd", initDir, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(missingDoneResult.status, 1, "domain errors should exit non-zero");
  const missingDoneEnvelope = JSON.parse(missingDoneResult.stdout);
  assertEqual(missingDoneEnvelope.ok, false, "domain errors should report ok=false");
  assertEqual(missingDoneEnvelope.data.error, "Item 'missing-item' not found", "domain errors should expose a structured error");

  const removedJsonFlag = `--${"json"}`;
  const removedFlagResult = spawnSync(process.execPath, [cliPath, removedJsonFlag, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(removedFlagResult.status, 1, "removed JSON flag should exit non-zero");
  const removedFlagEnvelope = JSON.parse(removedFlagResult.stdout);
  assertEqual(removedFlagEnvelope.ok, false, "removed JSON flag should report ok=false");
  assertEqual(removedFlagEnvelope.command, removedJsonFlag, "removed JSON flag should be treated as an unknown command");
}

done("test-cli-parity");
