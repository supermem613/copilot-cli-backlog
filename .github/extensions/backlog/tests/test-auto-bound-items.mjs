import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { join } from "node:path";
import { db, createQueue } from "../db.mjs";
import { handleBacklogCommand } from "../commands.mjs";
import { bindQueueScope } from "../queue-resolver.mjs";
import { createBacklogJoinConfig } from "../join-config.mjs";
import { markDone } from "../items.mjs";
import { sandboxDir } from "./harness.mjs";

function assertResolutionBlock(result, label, expectedQueueId) {
  assert(result && typeof result === "object", `${label} returns an object`);
  assert(result?.resolution, `${label} returns a resolution block`);
  assertEqual(result?.resolution?.queueId, expectedQueueId, `${label} uses the resolver-selected queue`);
}

const scopeA = join(sandboxDir, "scope-a");
const scopeB = join(sandboxDir, "scope-b");

const queueA = createQueue({ id: "queue-a", name: "Queue A" });
const queueB = createQueue({ id: "queue-b", name: "Queue B" });
bindQueueScope(queueA, scopeA);
bindQueueScope(queueB, scopeB);

const addOut = await handleBacklogCommand("add first bound item", { cwd: scopeA });
assert(/Added:/.test(addOut.output), `add command confirms item creation, got: ${addOut.output}`);

const insertedRow = db.prepare("SELECT queue_id, description FROM items ORDER BY position").get();
assertEqual(insertedRow.queue_id, queueA.id, "add uses the resolver-selected queue for a bound cwd");
assertEqual(insertedRow.description, "first bound item", "add stores the expected description");

const listAOut = await handleBacklogCommand("list", { cwd: scopeA });
assert(listAOut.output.includes("first bound item"), `list for queue A shows the bound item, got: ${listAOut.output}`);

const listBOut = await handleBacklogCommand("list", { cwd: scopeB });
assert(!listBOut.output.includes("first bound item"), `list for queue B should not include queue A items, got: ${listBOut.output}`);

assertEqual(listBOut.output, `Queue '${queueB.id}' is empty`, `list should not see queue A items from queue B scope, got: ${listBOut.output}`);

const pendingBOut = await handleBacklogCommand("pending", { cwd: scopeB });
assertEqual(pendingBOut, "0", `pending should ignore queue A items when resolving queue B scope, got: ${pendingBOut}`);

const doneBOut = await handleBacklogCommand("done 1", { cwd: scopeB });
assert(/Error: Item '1' not found/.test(doneBOut.output), `done should not mutate queue A items from queue B scope, got: ${doneBOut.output}`);

const removeBOut = await handleBacklogCommand("remove 1", { cwd: scopeB });
assert(/Error: Item '1' not found/.test(removeBOut), `remove should not mutate queue A items from queue B scope, got: ${removeBOut}`);

const clearBOut = await handleBacklogCommand("clear", { cwd: scopeB });
assert(/Cleared 0 item\(s\) from queue/.test(clearBOut), `clear should not clear queue A items from queue B scope, got: ${clearBOut}`);
const remainingRows = db.prepare("SELECT COUNT(*) as count FROM items").get().count;
assertEqual(remainingRows, 1, "clear leaves queue A items intact when resolving queue B scope");

const unboundScope = join(sandboxDir, "unbound-scope");
const unboundListOut = await handleBacklogCommand("list", { cwd: unboundScope });
assert(/Unbound queue resolution/.test(unboundListOut.output), `unbound list reports missing binding, got: ${unboundListOut.output}`);
const unboundAddOut = await handleBacklogCommand("add should not bind implicitly", { cwd: unboundScope });
assert(/Unbound queue resolution/.test(unboundAddOut.output), `unbound add refuses implicit binding, got: ${unboundAddOut.output}`);

const joinConfig = createBacklogJoinConfig({
  getActiveSessionId: () => "auto-bound-items-session",
  log: () => {},
  syncSidecarVisibility: () => {},
  markDone,
  handleBacklogCommand,
});

assertEqual(
  joinConfig.tools.map((tool) => tool.name).join(","),
  "backlog_list,backlog_done,backlog_status",
  "agent tools omit automatic add/edit/remove and next-work surfaces",
);

const listTool = joinConfig.tools.find((tool) => tool.name === "backlog_list");
const listToolOut = await listTool.handler({}, { sessionId: "auto-bound-items-session", cwd: scopeB });
assertResolutionBlock(listToolOut, "backlog_list", queueB.id);

const doneTool = joinConfig.tools.find((tool) => tool.name === "backlog_done");
const doneToolOut = await doneTool.handler({ ref: "1" }, { sessionId: "auto-bound-items-session", cwd: scopeA });
assertResolutionBlock(doneToolOut, "backlog_done", queueA.id);

done("test-auto-bound-items");
