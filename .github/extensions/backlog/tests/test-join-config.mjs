import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import {
  assertDeprivilegedJoinConfig,
  createBacklogJoinConfig,
  describeJoinPrivilege,
} from "../join-config.mjs";

const statusResolution = {
  queueId: "status-queue",
  canonicalScope: "/tmp/status-scope",
  matchedBy: "exact",
  itemCounts: { pendingItems: 1, done: 2 },
  createdItem: false,
};

const dependencies = {
  getActiveSessionId: () => "test-session",
  log: () => {},
  syncSidecarVisibility: () => {},
  markDone: () => ({ description: "done item" }),
  handleBacklogCommand: async (rawText) => {
    if (rawText === "status") return statusResolution;
    return "ok";
  },
};

const config = createBacklogJoinConfig(dependencies);
assertEqual(
  JSON.stringify(describeJoinPrivilege(config)),
  JSON.stringify({
    elevated: false,
    elevatedHandlers: [],
    hasHooks: false,
    skippedPermissionTools: [],
  }),
  "join config matches de-privileged baseline",
);
assertEqual(config.commands[0].name, "backlog", "backlog command is registered");
assertEqual(config.tools.length, 3, "agent tool count matches baseline");
assertEqual(config.tools.map((tool) => tool.name).join(","),
  "backlog_list,backlog_done,backlog_status",
  "agent tool names match baseline");
assertDeprivilegedJoinConfig(config);

const statusTool = config.tools.find((tool) => tool.name === "backlog_status");
assert(statusTool, "backlog_status tool is registered");
assertEqual(typeof statusTool.handler, "function", "backlog_status tool exposes a handler");
const commandResult = await dependencies.handleBacklogCommand("status", { cwd: "/tmp/status-scope" });
const toolResult = await statusTool.handler({}, { sessionId: "test-session" });
assertEqual(typeof toolResult, "object", "backlog_status handler returns a resolution block");
assertEqual(JSON.stringify(Object.keys(toolResult).sort()), JSON.stringify(Object.keys(commandResult).sort()), "backlog_status handler returns the same resolution block shape as /backlog status");
assertEqual(toolResult.queueId, commandResult.queueId, "backlog_status handler preserves queueId");
assertEqual(toolResult.canonicalScope, commandResult.canonicalScope, "backlog_status handler preserves canonicalScope");
assertEqual(toolResult.matchedBy, commandResult.matchedBy, "backlog_status handler preserves matchedBy");
assertEqual(toolResult.itemCounts.pendingItems, commandResult.itemCounts.pendingItems, "backlog_status handler preserves pending item count");
assertEqual(toolResult.itemCounts.done, commandResult.itemCounts.done, "backlog_status handler preserves done item count");
assertEqual(toolResult.createdItem, commandResult.createdItem, "backlog_status handler preserves createdItem");

let threw = false;
try {
  assertDeprivilegedJoinConfig({
    ...config,
    onPermissionRequest: () => {},
  });
} catch (err) {
  threw = /de-privileged/.test(err.message) && /onPermissionRequest/.test(err.message);
}
assert(threw, "startup assertion rejects an elevated handler with a clear message");

threw = false;
try {
  assertDeprivilegedJoinConfig({
    ...config,
    tools: [{ name: "unsafe_tool", skipPermission: true }],
  });
} catch (err) {
  threw = /skipPermission tools: unsafe_tool/.test(err.message);
}
assert(threw, "startup assertion rejects per-tool skipPermission with a clear message");

done("test-join-config");
