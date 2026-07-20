import { resolveItemCommandContext } from "./queue-resolver.mjs";
import { getCommandDefinition, getToolDefinitions } from "./command-registry.mjs";
import { listPendingItems } from "./items.mjs";

const ELEVATING_HANDLER_KEYS = [
  "onPermissionRequest",
  "onUserInput",
  "onUserInputRequest",
  "onElicitation",
  "onElicitationRequest",
  "onExitPlanMode",
  "onExitPlanModeRequest",
  "onAutoModeSwitch",
  "onAutoModeSwitchRequest",
];

function getInvocationCwd(args, invocation) {
  return args?.cwd || invocation?.cwd || invocation?.context?.cwd || null;
}

export function describeJoinPrivilege(config) {
  const elevatedHandlers = ELEVATING_HANDLER_KEYS.filter((key) => config[key] !== undefined);
  const hasHooks = config.hooks !== undefined;
  const skippedPermissionTools = (config.tools || [])
    .filter((tool) => tool?.skipPermission !== undefined)
    .map((tool) => tool.name || "(unnamed)");
  return {
    elevated: elevatedHandlers.length > 0 || hasHooks || skippedPermissionTools.length > 0,
    elevatedHandlers,
    hasHooks,
    skippedPermissionTools,
  };
}

export function assertDeprivilegedJoinConfig(config) {
  const privilege = describeJoinPrivilege(config);
  if (!privilege.elevated) return;
  const parts = [];
  if (privilege.elevatedHandlers.length > 0) {
    parts.push(`handlers: ${privilege.elevatedHandlers.join(", ")}`);
  }
  if (privilege.hasHooks) parts.push("hooks");
  if (privilege.skippedPermissionTools.length > 0) {
    parts.push(`skipPermission tools: ${privilege.skippedPermissionTools.join(", ")}`);
  }
  throw new Error(`backlog join config must stay de-privileged; remove ${parts.join("; ")}`);
}

export function createBacklogJoinConfig({
  getActiveSessionId,
  log,
  syncSidecarVisibility,
  markDone,
  handleBacklogCommand,
}) {
  const backlogCommand = getCommandDefinition("backlog");
  const toolMetadata = Object.fromEntries(getToolDefinitions().map((tool) => [tool.name, tool]));

  return {
    commands: [
      {
        name: "backlog",
        description: backlogCommand?.description || "Manage backlog queues and items",
        handler: async (context) => {
          const sid = getActiveSessionId() || "default";
          const rawText = context.args || "list";
          const result = await handleBacklogCommand(rawText, { cwd: context.cwd || context.options?.cwd });
          const message = typeof result === "string" || result == null
            ? result
            : (result.output ?? result.message ?? result);
          log(message);
        },
      },
    ],

    tools: [
      {
        ...toolMetadata["backlog_list"],
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const cwd = getInvocationCwd(args, invocation);
          const queueContext = resolveItemCommandContext({ cwd });
          if (queueContext.error) {
            syncSidecarVisibility(sid);
            return { message: queueContext.error, resolution: queueContext.resolution, queueId: queueContext.queueId, ok: false, items: [] };
          }
          syncSidecarVisibility(sid);
          const items = listPendingItems(queueContext.queueId);
          if (items.length === 0) {
            return { message: "Backlog is empty", resolution: queueContext.resolution, queueId: queueContext.queueId, items: [] };
          }
          return { message: items.map((i) => `#${i.position} [${i.id}] ${i.description}`).join("\n"), resolution: queueContext.resolution, queueId: queueContext.queueId, items };
        },
      },
      {
        ...toolMetadata["backlog_done"],
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const cwd = getInvocationCwd(args, invocation);
          const queueContext = resolveItemCommandContext({ cwd });
          if (queueContext.error) {
            return { message: queueContext.error, resolution: queueContext.resolution, queueId: queueContext.queueId, ok: false };
          }
          const item = markDone(args.ref, queueContext.queueId);
          if (!item) {
            return { message: `Error: Item '${args.ref}' not found`, resolution: queueContext.resolution, queueId: queueContext.queueId, ok: false };
          }
          return { message: `Marked '${item.description}' as done`, resolution: queueContext.resolution, queueId: queueContext.queueId, item };
        },
      },
      {
        ...toolMetadata["backlog_status"],
        handler: async (args, invocation) => {
          return handleBacklogCommand("status", { cwd: args?.cwd || invocation?.cwd || invocation?.context?.cwd });
        },
      },
    ],
  };
}
