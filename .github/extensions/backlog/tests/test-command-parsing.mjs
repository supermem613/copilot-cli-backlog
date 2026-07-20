import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { db, listQueueScopes } from "../db.mjs";
import { parseBacklogCommand, handleBacklogCommand } from "../commands.mjs";
import { sandboxDir } from "./harness.mjs";

// Parser
const p1 = parseBacklogCommand("add buy milk");
assertEqual(p1.cmd, "add", "cmd parsed");
assertEqual(p1.args.join(" "), "buy milk", "args joined back to original");
assert(!p1.isTop, "isTop false when --top absent");

const p2 = parseBacklogCommand("add --top urgent thing");
assert(p2.isTop, "--top recognized");
assertEqual(p2.args.join(" "), "urgent thing", "--top stripped from args");

const p3 = parseBacklogCommand("");
assertEqual(p3.cmd, "list", "empty input defaults to list");

const p4 = parseBacklogCommand("doctor");
assertEqual(p4.cmd, "doctor", "doctor command parsed");
const p5 = parseBacklogCommand("init");
assertEqual(p5.cmd, "init", "init command parsed");

const unboundAddOut = await handleBacklogCommand("add no dumping ground");
assert(/Unbound queue resolution/.test(unboundAddOut.output), `add without cwd refuses implicit queue, got: ${unboundAddOut.output}`);
const queueTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queues'").get();
assert(queueTable, "queue table exists for queue-backed backlog items");
const initScope = join(sandboxDir, "soda");
mkdirSync(join(initScope, ".git"), { recursive: true });
const initOut = await handleBacklogCommand("init", { cwd: initScope });
assertEqual(initOut.queueId, "soda", "init derives the queue id from the workspace directory");
assertEqual(initOut.createdQueue, true, "init creates the queue on first run");
assertEqual(initOut.createdBinding, true, "init creates the workspace binding on first run");
assertEqual(initOut.status.state, "resolved", "init returns a resolved status descriptor");
assertEqual(initOut.status.matchedBy, "exact", "init binds the current workspace exactly");
assertEqual(listQueueScopes("soda").length, 1, "init persists one binding for the workspace");
const initAgainOut = await handleBacklogCommand("init", { cwd: initScope });
assertEqual(initAgainOut.createdQueue, false, "init reuses an existing queue");
assertEqual(initAgainOut.createdBinding, false, "init reuses an existing binding");
assertEqual(listQueueScopes("soda").length, 1, "init is idempotent for the same workspace");

const addOut = await handleBacklogCommand("add hello world", { cwd: initScope });
assert(addOut.output.startsWith("Added: 'hello world'"), `add command returns confirmation, got: ${addOut.output}`);

const listOut = await handleBacklogCommand("list", { cwd: initScope });
assert(/hello world/.test(listOut.output), `list shows added item, got: ${listOut.output}`);
assert(listOut.output.startsWith("Queue 'soda' pending items:"), `list names the resolved queue, got: ${listOut.output}`);
const listByQueueOut = await handleBacklogCommand("list soda");
assert(/Queue 'soda' pending items:[\s\S]*hello world/.test(listByQueueOut.output), `list accepts an explicit queue id, got: ${listByQueueOut.output}`);
const firstId = addOut.item.id;
const editOut = await handleBacklogCommand(`edit ${firstId} hello edited`, { cwd: initScope });
assert(/Updated 'hello edited'/.test(editOut.output), `edit command updates item, got: ${editOut.output}`);
await handleBacklogCommand("add second item", { cwd: initScope });
const moveOut = await handleBacklogCommand("move 2 1", { cwd: initScope });
assert(/Moved 'second item' to position 1/.test(moveOut), `move command repositions item, got: ${moveOut}`);
const movedListOut = await handleBacklogCommand("list", { cwd: initScope });
assert(/#1 \[[^\]]+\] second item/.test(movedListOut.output), `list reflects moved item order, got: ${movedListOut.output}`);
const missingQueueOut = await handleBacklogCommand("list missing-queue");
assert(/Queue 'missing-queue' not found/.test(missingQueueOut.output), `list reports unknown explicit queue ids, got: ${missingQueueOut.output}`);

const gatedId = firstId;
db.prepare("UPDATE items SET status = ? WHERE id = ?").run("proposed", gatedId);
const approveOut = await handleBacklogCommand(`approve ${gatedId}`);
assert(/Approved start/.test(approveOut), `approve command opens start gate, got: ${approveOut}`);
db.prepare("UPDATE items SET status = ? WHERE id = ?").run("needs_review", gatedId);
const reviewListOut = await handleBacklogCommand("review");
assert(/Human backlog decision required/.test(reviewListOut), "review command lists pending decisions");
const reviewOut = await handleBacklogCommand(`review ${gatedId} approve`);
assert(/Approved review/.test(reviewOut), `review command approves output, got: ${reviewOut}`);
const backupPath = join(sandboxDir, "command-backup.json");
const backupOut = await handleBacklogCommand(`backup ${backupPath}`);
assert(/Backlog backup written/.test(backupOut), `backup command writes backup, got: ${backupOut}`);
const restoreOut = await handleBacklogCommand(`restore ${backupPath}`);
assert(/Backlog backup restored/.test(restoreOut), `restore command restores backup, got: ${restoreOut}`);

const unknownOut = await handleBacklogCommand("frobnicate");
assert(/Unknown command/.test(unknownOut), "unknown command returns error message");
assert(/status/.test(unknownOut), "unknown command output lists status in the known commands");
assert(/item delete smoke: ok/.test(await handleBacklogCommand("doctor")), "doctor command runs smoke check");

done("test-command-parsing");
