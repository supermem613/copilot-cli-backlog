import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { createQueue, db, listQueueScopes, listQueues } from "../db.mjs";
import { addItem, markDone } from "../items.mjs";
import { handleBacklogCommand } from "../commands.mjs";
import { bindQueueScope } from "../queue-resolver.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

const tempDirs = [];
function trackTempDir(dir) {
  tempDirs.push(dir);
  return dir;
}

function makeTrackedTempDir(prefix) {
  return trackTempDir(makeTempDir(prefix));
}

process.on("exit", () => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function countItems(queueId) {
  return db.prepare("SELECT COUNT(*) as count FROM items WHERE queue_id = ?").get(queueId).count;
}

const resolvedScope = makeTrackedTempDir("backlog-status-resolved");
const resolvedQueue = createQueue({ id: "queue-status-resolved", name: "Resolved Status" });
bindQueueScope(resolvedQueue, resolvedScope, { preferred: true });
const pendingItem = addItem("Pending item", false, resolvedQueue.id);
markDone(pendingItem.id, resolvedQueue.id);
const beforeResolvedItemCount = countItems(resolvedQueue.id);
const beforeResolvedQueueCount = listQueues().length;
const beforeResolvedBindingCount = listQueueScopes(resolvedQueue.id).length;
const resolvedResult = await handleBacklogCommand("status", { cwd: resolvedScope });
assertEqual(typeof resolvedResult, "object", "status returns a resolution block");
assertEqual(resolvedResult.queueId, resolvedQueue.id, "status resolution chooses the bound queue id");
assertEqual(resolvedResult.matchedBy, "exact", "status resolution reports the exact match reason");
assertEqual(resolvedResult.canonicalScope, resolvedScope, "status resolution reports the canonical scope");
assertEqual(resolvedResult.itemCounts.pendingItems, 0, "status resolution reports pending item count");
assertEqual(resolvedResult.itemCounts.done, 1, "status resolution reports done item count");
assertEqual(resolvedResult.createdItem, false, "status resolution does not create an item");
assertEqual(countItems(resolvedQueue.id), beforeResolvedItemCount, "status resolution does not create items");
assertEqual(listQueues().length, beforeResolvedQueueCount, "status resolution does not create queues");
assertEqual(listQueueScopes(resolvedQueue.id).length, beforeResolvedBindingCount, "status resolution does not create queue bindings");

const ambiguousScope = makeTrackedTempDir("backlog-status-ambiguous");
const ambiguousQueueA = createQueue({ id: "queue-status-ambiguous-a", name: "Ambiguous A" });
const ambiguousQueueB = createQueue({ id: "queue-status-ambiguous-b", name: "Ambiguous B" });
bindQueueScope(ambiguousQueueA, ambiguousScope, { preferred: true });
bindQueueScope(ambiguousQueueB, ambiguousScope, { preferred: true });
const beforeAmbiguousItemCount = countItems(ambiguousQueueA.id) + countItems(ambiguousQueueB.id);
const beforeAmbiguousQueueCount = listQueues().length;
const beforeAmbiguousBindingCount = listQueueScopes(ambiguousQueueA.id).length + listQueueScopes(ambiguousQueueB.id).length;
const ambiguousResult = await handleBacklogCommand("status", { cwd: ambiguousScope });
assertEqual(typeof ambiguousResult, "object", "ambiguous status returns a resolution block");
assertEqual(ambiguousResult.state, "ambiguous", "ambiguous status reports ambiguity");
assertEqual(ambiguousResult.queueId, undefined, "ambiguous status does not select a queue");
assert(Array.isArray(ambiguousResult.candidates), "ambiguous status returns candidates");
assertEqual(ambiguousResult.candidates.length, 2, "ambiguous status reports both candidate queues");
assertEqual(ambiguousResult.canonicalScope, ambiguousScope, "ambiguous status reports the canonical scope");
assertEqual(ambiguousResult.createdItem, false, "ambiguous status does not create an item");
assertEqual(countItems(ambiguousQueueA.id) + countItems(ambiguousQueueB.id), beforeAmbiguousItemCount, "ambiguous status does not create items");
assertEqual(listQueues().length, beforeAmbiguousQueueCount, "ambiguous status does not create queues");
assertEqual(listQueueScopes(ambiguousQueueA.id).length + listQueueScopes(ambiguousQueueB.id).length, beforeAmbiguousBindingCount, "ambiguous status does not create queue bindings");

done("test-backlog-status");
