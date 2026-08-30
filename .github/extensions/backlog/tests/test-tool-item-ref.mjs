import "./harness.mjs";
import { assert, assertEqual, done, sandboxDir } from "./harness.mjs";
import { join } from "node:path";
import { createQueue } from "../db.mjs";
import { handleBacklogCommand } from "../commands.mjs";
import { bindQueueScope } from "../queue-resolver.mjs";
import { createBacklogJoinConfig } from "../join-config.mjs";
import { getToolDefinitions } from "../command-registry.mjs";
import { markDone } from "../items.mjs";

// Every human-facing backlog surface names an item by "id" (README, the tool
// description, and `/backlog done <id-or-position>`), while the tool schema
// named the parameter `ref`. An agent that followed the prose passed `id`, the
// harness rejected the call on schema validation before the handler ran, and
// the caller only saw an opaque "Tool execution failed". Accepting both names
// and validating inside the handler keeps every rejection self-describing.

const scope = join(sandboxDir, "ref-alias-scope");
const queue = createQueue({ id: "queue-ref-alias", name: "Queue Ref Alias" });
bindQueueScope(queue, scope);

await handleBacklogCommand("add alias target one", { cwd: scope });
await handleBacklogCommand("add alias target two", { cwd: scope });

const doneToolSchema = getToolDefinitions().find((tool) => tool.name === "backlog_done");
assert(doneToolSchema.parameters.properties.ref, "backlog_done schema exposes ref");
assert(doneToolSchema.parameters.properties.id, "backlog_done schema exposes id as an accepted alias");
assertEqual(
  Array.isArray(doneToolSchema.parameters.required),
  false,
  "backlog_done leaves argument validation to the handler so rejections carry a domain message",
);

const joinConfig = createBacklogJoinConfig({
  getActiveSessionId: () => "ref-alias-session",
  log: () => {},
  syncSidecarVisibility: () => {},
  markDone,
  handleBacklogCommand,
});
const doneTool = joinConfig.tools.find((tool) => tool.name === "backlog_done");
const invocation = { sessionId: "ref-alias-session", cwd: scope };

const viaRef = await doneTool.handler({ ref: "1" }, invocation);
assertEqual(viaRef.item?.description, "alias target one", "backlog_done marks the item done when given ref");

const viaId = await doneTool.handler({ id: "1" }, invocation);
assertEqual(viaId.item?.description, "alias target two", "backlog_done marks the item done when given id");

const missing = await doneTool.handler({}, invocation);
assertEqual(missing.ok, false, "backlog_done reports failure when no item reference is supplied");
assert(
  /requires .*\bref\b/.test(missing.message) && /\bid\b/.test(missing.message),
  `backlog_done names both accepted argument names when none is supplied, got: ${missing.message}`,
);

const notFound = await doneTool.handler({ id: "no-such-item" }, invocation);
assertEqual(notFound.ok, false, "backlog_done reports failure for an unknown item reference");
assert(
  /Item 'no-such-item' not found/.test(notFound.message),
  `backlog_done distinguishes an unknown item from a malformed call, got: ${notFound.message}`,
);

const conflicting = await doneTool.handler({ ref: "1", id: "2" }, invocation);
assertEqual(conflicting.ok, false, "backlog_done reports failure when ref and id disagree");
assert(
  /both/i.test(conflicting.message),
  `backlog_done explains the conflicting ref and id, got: ${conflicting.message}`,
);

done("test-tool-item-ref");
