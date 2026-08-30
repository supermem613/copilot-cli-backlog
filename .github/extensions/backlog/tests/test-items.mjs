import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import {
  db,
  setItemGate,
  setItemWaiver,
  createQueue,
  attachItemPorContext,
  getItemPorContext,
  removeItemPorContext,
} from "../db.mjs";
import {
  addItem,
  markDone,
  removeItem,
  editItem,
  clearQueueItems,
  getTopItem,
  getPendingCount,
  resolveItemRef,
} from "../items.mjs";

const queueId = "test-items-queue";
createQueue({ id: queueId, name: "Test Items" });

const a = addItem("first task", false, queueId);
assertEqual(a.position, 1, "first add lands at position 1");
const b = addItem("second task", false, queueId);
assertEqual(b.position, 2, "second add lands at position 2");
addItem("third task", false, queueId);

assertEqual(getPendingCount(queueId), 3, "pending count = 3 after three adds");

const top = addItem("urgent task", true, queueId);
assertEqual(top.position, 1, "--top add lands at position 1");
assertEqual(getTopItem(queueId).description, "urgent task", "top item is the urgent one");
assertEqual(getPendingCount(queueId), 4, "pending count = 4 after --top add");

const d = markDone("1", queueId);
assertEqual(d.description, "urgent task", "done by position 1 marks urgent task done");
assertEqual(d.status, "done", "done envelope reports status done, not the pre-update pending row");
assertEqual(getPendingCount(queueId), 3, "pending count drops to 3 after done");
assertEqual(getTopItem(queueId).description, "first task", "first task back at top after done");

const r = removeItem("second-task", queueId);
assertEqual(r.description, "second task", "remove by id finds second task");
assertEqual(getPendingCount(queueId), 2, "pending count drops to 2 after remove");

const numericLeading = addItem("#2 parsePostHeaderAuthor regex is a task", false, queueId);
const numericLeadingRemoved = removeItem(numericLeading.id, queueId);
assertEqual(numericLeadingRemoved.description, "#2 parsePostHeaderAuthor regex is a task", "remove by numeric-leading id finds the id");
assertEqual(resolveItemRef("2", queueId).description, "third task", "all-digit refs still resolve by position");

const e = editItem("1", "first task (edited)", queueId);
assertEqual(e.description, "first task (edited)", "edit updates description");

const eEmpty = editItem("1", "   ", queueId);
assert(eEmpty === null, "edit with whitespace-only description returns null");

const missing = resolveItemRef("does-not-exist", queueId);
assert(!missing, "resolveItemRef returns falsy for missing id");

const clearQueueId = "test-clear-queue";
createQueue({ id: clearQueueId, name: "Test Clear" });
const clearOne = addItem("clear one", false, clearQueueId);
const clearTwo = addItem("clear two", false, clearQueueId);
setItemGate({ itemId: clearOne.id, gateKind: "start", state: "approved", actor: "test" });
setItemWaiver({ itemId: clearTwo.id, gateKind: "review", mode: "sticky", actor: "test" });
const cleared = clearQueueItems(clearQueueId);
assertEqual(cleared.changes, 2, "clear removes all queue items");
assertEqual(getPendingCount(clearQueueId), 0, "clear leaves no pending items");

const gated = addItem("gated remove", false, queueId);
setItemGate({ itemId: gated.id, gateKind: "start", state: "approved", actor: "test" });
setItemWaiver({ itemId: gated.id, gateKind: "review", mode: "sticky", actor: "test" });
assertEqual(removeItem(gated.id, queueId).description, "gated remove", "remove deletes gated item");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM item_gates WHERE item_id = ?").get(gated.id).count, 0, "remove deletes item gates");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM item_waivers WHERE item_id = ?").get(gated.id).count, 0, "remove deletes item waivers");

const queue = createQueue({ id: "custom-queue", name: "Custom" });
assertEqual(queue.name, "Custom", "createQueue creates a named queue");
const queuedItem = addItem("queue-backed task", false, "custom-queue");
assertEqual(queuedItem.queue_id, "custom-queue", "queue-backed items inherit the requested queue");
assertEqual(getPendingCount("custom-queue"), 1, "queue-aware pending counts are scoped by queue");
const por = attachItemPorContext({ itemId: queuedItem.id, porId: "por-1", metadata: { source: "test" } });
assertEqual(por.por_id, "por-1", "attachItemPorContext stores an item POR record");
const roundTrip = getItemPorContext(queuedItem.id);
assertEqual(roundTrip.metadata.source, "test", "POR context metadata round-trips through storage");
const removedPor = removeItemPorContext(queuedItem.id);
assertEqual(removedPor.por_id, "por-1", "removeItemPorContext returns the removed POR context");
assertEqual(getItemPorContext(queuedItem.id), null, "removeItemPorContext clears the stored POR context");

const queuedItemRow = db.prepare("SELECT queue_id FROM items WHERE id = ?").get(queuedItem.id);
assertEqual(queuedItemRow.queue_id, "custom-queue", "queue-backed items get their queue_id persisted");

const porPayload = { kind: "por", id: "por-1" };
db.prepare("UPDATE items SET por_json = ? WHERE id = ?").run(JSON.stringify(porPayload), queuedItem.id);
const storedPor = db.prepare("SELECT por_json FROM items WHERE id = ?").get(queuedItem.id).por_json;
assertEqual(JSON.parse(storedPor).id, porPayload.id, "POR attachment round-trips through item storage");

done("test-items");
