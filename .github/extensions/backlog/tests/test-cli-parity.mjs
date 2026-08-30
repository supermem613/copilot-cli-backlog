import "./harness.mjs";
import { assert, assertEqual, done, sandboxDir } from "./harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createQueue, db } from "../db.mjs";
import { addItem, markDone } from "../items.mjs";
import { bindQueueScope, describeBacklogStatus } from "../queue-resolver.mjs";
import { parseBacklogCommand, handleBacklogCommand } from "../commands.mjs";
import { getCommandDefinition, getSlashCommandNames } from "../command-registry.mjs";
import { runCli } from "../cli.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "cli-parity-"));
const initDir = mkdtempSync(join(tmpdir(), "cli-init-"));
const topInitDir = mkdtempSync(join(tmpdir(), "cli-top-init-"));
const topSandboxDir = mkdtempSync(join(tmpdir(), "cli-top-sandbox-"));
process.on("exit", () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  try { rmSync(initDir, { recursive: true, force: true }); } catch {}
  try { rmSync(topInitDir, { recursive: true, force: true }); } catch {}
  try { rmSync(topSandboxDir, { recursive: true, force: true }); } catch {}
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
    assert(
      helpEnvelope.data.commands.some((command) => command.name === "queues"),
      "default help data should expose runnable commands as structured entries",
    );
  }

  for (const helpArgs of [["help", "queue"], ["queue", "--help"]]) {
    const targetedHelpResult = spawnSync(process.execPath, [cliPath, ...helpArgs, "--db-dir", sandboxDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assertEqual(targetedHelpResult.status, 0, `${helpArgs.join(" ")} should exit 0`);
    const targetedHelpEnvelope = JSON.parse(targetedHelpResult.stdout);
    assertEqual(targetedHelpEnvelope.data.command.scope, "cli", `${helpArgs.join(" ")} should expose CLI metadata`);
    assert(
      targetedHelpEnvelope.data.command.usage.startsWith("backlog queue"),
      `${helpArgs.join(" ")} should expose CLI usage`,
    );
    assert(
      targetedHelpEnvelope.data.help.includes("Usage: backlog queue"),
      `${helpArgs.join(" ")} should render CLI help text`,
    );
  }

  const commandsResult = spawnSync(process.execPath, [cliPath, "commands", "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(commandsResult.status, 0, "commands command should exit 0");
  const commandsEnvelope = JSON.parse(commandsResult.stdout);
  assertEqual(commandsEnvelope.ok, true, "commands envelope should report ok=true");
  assert(
    commandsEnvelope.data.commands.some((command) => command.name === "queues"),
    "commands data should expose the direct queue-list command",
  );
  assert(
    commandsEnvelope.data.commands.some((command) => command.name === "queue"),
    "commands data should expose queue inspection",
  );
  const queueCommand = commandsEnvelope.data.commands.find((command) => command.name === "queue");
  assertEqual(queueCommand?.scope, "cli", "structured command entries should identify the CLI surface");
  assert(
    queueCommand?.usage.startsWith("backlog queue"),
    "structured command entries should show CLI usage instead of slash usage",
  );

  createQueue({ id: "add", name: "Reserved ID Queue" });
  const reservedQueueResult = await handleBacklogCommand("queue list add");
  assertEqual(reservedQueueResult.queue.id, "add", "queue list <id> should inspect queue ids that match mutation verbs");

  createQueue({ id: "legacy-status", name: "Legacy Status Queue" });
  db.prepare(`
    INSERT INTO items (id, description, position, queue_id, status)
    VALUES (?, ?, ?, ?, ?)
  `).run("legacy-null-status", "legacy null status item", 1, "legacy-status", null);
  const legacyQueueList = await handleBacklogCommand("queue list");
  const legacyQueueSummary = legacyQueueList.queues.find((entry) => entry.id === "legacy-status");
  assertEqual(legacyQueueSummary.itemCount, 1, "queue summaries should count legacy items with null status");
  assertEqual(legacyQueueSummary.itemCounts.unknown, 1, "queue summaries should expose null status as unknown");
  const legacyQueueDetail = await handleBacklogCommand("queue legacy-status");
  assertEqual(legacyQueueDetail.items[0].status, "unknown", "queue details should expose null status as unknown");

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

  const unsupportedAddFlagsResult = spawnSync(process.execPath, [cliPath, "add", "unsupported add flag item", "--unsupported-flag", "--cwd", initDir, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(unsupportedAddFlagsResult.status, 1, `unsupported add flags should exit non-zero expected 1 got ${unsupportedAddFlagsResult.status}`);
  let unsupportedAddFlagsEnvelope;
  try {
    unsupportedAddFlagsEnvelope = JSON.parse(unsupportedAddFlagsResult.stdout);
  } catch (error) {
    assert(false, `unsupported add flags stdout should be parseable JSON: ${error.message}`);
  }
  assertEqual(unsupportedAddFlagsEnvelope?.ok, false, `unsupported add flags should report ok=false expected false got ${unsupportedAddFlagsEnvelope?.ok}`);
  const usageText = unsupportedAddFlagsEnvelope?.data?.help || unsupportedAddFlagsEnvelope?.data?.usage || unsupportedAddFlagsEnvelope?.data?.message;
  assertEqual(usageText, "Usage: backlog add [--top] <description>", "unsupported add flags usage guidance should advertise the supported --top form");
  const topQueueInitResult = spawnSync(process.execPath, [cliPath, "init", "top-cli-queue", "Top CLI Queue", "--cwd", topInitDir, "--db-dir", topSandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(topQueueInitResult.status, 0, "isolated top add coverage should init queue exit 0");
  const topAddResult = spawnSync(process.execPath, [cliPath, "add", "--top", "top cli item", "--cwd", topInitDir, "--db-dir", topSandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(topAddResult.status, 0, `top add should exit 0 expected 0 got ${topAddResult.status}`);
  let topAddEnvelope;
  try {
    topAddEnvelope = JSON.parse(topAddResult.stdout);
  } catch (error) {
    assert(false, `top add stdout should be parseable JSON: ${error.message}`);
  }
  assertEqual(topAddEnvelope?.ok, true, `top add should report ok=true expected true got ${topAddEnvelope?.ok}`);
  assertEqual(topAddEnvelope?.data?.item?.description, "top cli item", "top add envelope should expose the created item");
  const unsupportedAddListResult = spawnSync(process.execPath, [cliPath, "list", "--cwd", initDir, "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(unsupportedAddListResult.status, 0, "unsupported add flags should keep list command exit 0");
  let unsupportedAddListEnvelope;
  try {
    unsupportedAddListEnvelope = JSON.parse(unsupportedAddListResult.stdout);
  } catch (error) {
    assert(false, `unsupported add flags list stdout should be parseable JSON: ${error.message}`);
  }
  const pendingQueueLength = unsupportedAddListEnvelope?.data?.items?.length ?? 0;
  assertEqual(pendingQueueLength, 1, `pending queue expected 1 got ${pendingQueueLength}`);

  const queuesResult = spawnSync(process.execPath, [cliPath, "queues", "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(queuesResult.status, 0, "queues command should exit 0");
  const queuesEnvelope = JSON.parse(queuesResult.stdout);
  const cliQueueSummary = queuesEnvelope.data.queues.find((entry) => entry.id === "cli-init-queue");
  assertEqual(cliQueueSummary?.itemCount, 1, "queues data should expose the total item count");
  assertEqual(cliQueueSummary?.itemCounts?.pending, 1, "queues data should expose counts by status");

  const queueDetailResult = spawnSync(process.execPath, [cliPath, "queue", "cli-init-queue", "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(queueDetailResult.status, 0, "queue detail command should exit 0");
  const queueDetailEnvelope = JSON.parse(queueDetailResult.stdout);
  assertEqual(queueDetailEnvelope.data.queue.id, "cli-init-queue", "queue detail should expose queue metadata");
  assertEqual(queueDetailEnvelope.data.items[0].status, "pending", "queue detail should expose item status");
  assertEqual(queueDetailEnvelope.data.items[0].priority, 0, "queue detail should expose item priority");
  assert(queueDetailEnvelope.data.items[0].created_at, "queue detail should expose item creation time");
  assert(queueDetailEnvelope.data.items[0].updated_at, "queue detail should expose item update time");

  const queueDetailListResult = spawnSync(process.execPath, [cliPath, "queue", "cli-init-queue", "list", "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(queueDetailListResult.status, 0, "queue detail list form should exit 0");
  const queueDetailListEnvelope = JSON.parse(queueDetailListResult.stdout);
  assertEqual(queueDetailListEnvelope.data.items[0].id, editableId, "queue detail list form should expose the same items");

  const queueListDetailResult = spawnSync(process.execPath, [cliPath, "queue", "list", "queue-cli-parity", "--db-dir", sandboxDir], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assertEqual(queueListDetailResult.status, 0, "queue list detail form should exit 0");
  const queueListDetailEnvelope = JSON.parse(queueListDetailResult.stdout);
  assertEqual(queueListDetailEnvelope.data.items[0].status, "done", "queue details should include completed items");

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
    assert(
      unknownEnvelope.data.knownCommands.includes("help") && unknownEnvelope.data.knownCommands.includes("queues"),
      "unknown CLI command output lists shared commands and CLI helpers",
    );
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
