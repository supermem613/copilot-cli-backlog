import "./harness.mjs";
import { assert, assertEqual, done, sandboxDir } from "./harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createQueue } from "../db.mjs";
import { addItem, markDone } from "../items.mjs";
import { bindQueueScope } from "../queue-resolver.mjs";
import { handleBacklogCommand, parseBacklogCommand } from "../commands.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "cli-list-status-"));
process.on("exit", () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const queue = createQueue({ id: "queue-list-status", name: "List Status Queue" });
bindQueueScope(queue, tempDir, { preferred: true });

const closedItem = addItem("closed item that must stay auditable", false, queue.id);
markDone(closedItem.id, queue.id);
const openItem = addItem("open item", false, queue.id);

const cliPath = fileURLToPath(new URL("../../../../bin/backlog.mjs", import.meta.url));

const doneListing = await handleBacklogCommand(`list ${queue.id} --status done`, { cwd: tempDir });
const doneIds = (doneListing.items || []).map((item) => item.id);
assert(
  doneIds.includes(closedItem.id),
  `list --status done should reach the done item without a backup export, got ${JSON.stringify(doneIds)}`,
);
assert(
  !doneIds.includes(openItem.id),
  `list --status done should exclude pending items, got ${JSON.stringify(doneIds)}`,
);

const pendingListing = await handleBacklogCommand(`list ${queue.id}`, { cwd: tempDir });
const pendingIds = (pendingListing.items || []).map((item) => item.id);
assert(
  pendingIds.includes(openItem.id) && !pendingIds.includes(closedItem.id),
  `default list should stay pending-only, got ${JSON.stringify(pendingIds)}`,
);

const unknownFlag = spawnSync(
  process.execPath,
  [cliPath, "list", queue.id, "--nonsense", "value", "--cwd", tempDir, "--db-dir", sandboxDir],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert(unknownFlag.status !== 0, "list should exit non-zero for an unrecognized flag");
let unknownEnvelope = null;
try {
  unknownEnvelope = JSON.parse(unknownFlag.stdout);
} catch (error) {
  assert(false, `unrecognized-flag stdout should be parseable JSON: ${error.message}`);
}
if (unknownEnvelope) {
  assertEqual(unknownEnvelope.ok, false, "unrecognized list flag should report ok=false");
  assert(
    String(unknownEnvelope.data?.error || "").includes("--nonsense"),
    `unrecognized list flag error should name the flag, got ${JSON.stringify(unknownEnvelope.data)}`,
  );
}

for (const trailing of [[]]) {
  const label = trailing.length === 0 ? "at end of line" : "followed by another flag";
  const missingValue = spawnSync(
    process.execPath,
    [cliPath, "list", queue.id, "--status", ...trailing, "--cwd", tempDir, "--db-dir", sandboxDir],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert(missingValue.status !== 0, `list --status ${label} should exit non-zero`);
  let missingValueEnvelope = null;
  try {
    missingValueEnvelope = JSON.parse(missingValue.stdout);
  } catch (error) {
    assert(false, `list --status ${label} stdout should be parseable JSON: ${error.message}`);
  }
  if (missingValueEnvelope) {
    assertEqual(missingValueEnvelope.ok, false, `list --status ${label} should report ok=false`);
    assert(
      String(missingValueEnvelope.data?.error || "").includes("--status"),
      `list --status ${label} error should name the flag, got ${JSON.stringify(missingValueEnvelope.data)}`,
    );
  }
}

const statusFollowedByFlag = await handleBacklogCommand(`list ${queue.id} --status --top`, { cwd: tempDir });
assertEqual(statusFollowedByFlag.ok, false, "list --status followed by another flag should report ok=false");
assert(
  String(statusFollowedByFlag.error || "").includes("--status"),
  `list --status followed by another flag should name the flag, got ${JSON.stringify(statusFollowedByFlag.error)}`,
);

// `--status` belongs to `list` alone. Other commands must keep the literal tokens in
// their own arguments so nothing a user typed is dropped on the way to the handler.
const addParse = parseBacklogCommand("add --status done buy milk");
assertEqual(addParse.cmd, "add", "add should parse as the add command");
assertEqual(
  addParse.args.join(" "),
  "--status done buy milk",
  `add should keep --status tokens in its own arguments, got ${JSON.stringify(addParse.args)}`,
);
assertEqual(addParse.status, "pending", "add should not adopt a list status");

const doneParse = parseBacklogCommand("done --status x t1a2b3");
assertEqual(
  doneParse.args.join(" "),
  "--status x t1a2b3",
  `done should keep --status tokens in its own arguments, got ${JSON.stringify(doneParse.args)}`,
);

const listParse = parseBacklogCommand(`list ${queue.id} --status done`);
assertEqual(listParse.status, "done", "list should still consume its own --status value");
assertEqual(
  listParse.args.join(" "),
  queue.id,
  `list should not leave --status tokens in its arguments, got ${JSON.stringify(listParse.args)}`,
);

const addWithStatus = await handleBacklogCommand("add --status done buy milk", { cwd: tempDir });
assert(
  String(addWithStatus.output || "").includes("--status done buy milk"),
  `add should store the full typed description, got ${JSON.stringify(addWithStatus.output)}`,
);

done("test-cli-list-status");
