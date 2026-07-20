// Slash command parser and dispatcher.

import { createQueue, getQueue, listQueues, updateQueue } from "./db.mjs";
import {
  addItem,
  markDone,
  removeItem,
  editItem,
  moveItem,
  listPendingItems,
  getPendingCount,
  clearQueueItems,
} from "./items.mjs";
import {
  tryStartSidecar,
  showViewer,
  sidecarState,
} from "./sidecar.mjs";
import { formatDoctorReport } from "./doctor.mjs";
import { getSlashCommandNames } from "./command-registry.mjs";
import { bindQueueScope, describeBacklogStatus, resolveItemCommandContext } from "./queue-resolver.mjs";
import {
  approveItemStart,
  approveItemReview,
  rejectItemReview,
  listHumanDecisions,
  formatHumanDecisionNotice,
} from "./review-channel.mjs";
import { exportBacklogBackup, restoreBacklogBackup } from "./backup.mjs";

export function parseBacklogCommand(input) {
  const text = String(input || "").trim();
  if (!text) return { cmd: "list", args: [], isTop: false };
  const parts = text.split(/\s+/);
  const cmd = parts.shift().toLowerCase();
  const isTop = parts.includes("--top");
  const args = parts.filter((part) => part !== "--top");
  return { cmd, args, isTop };
}

function queueIdFromScope(scope) {
  const leaf = String(scope || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return (leaf || "backlog").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "backlog";
}

function formatItems(rows, queueId) {
  if (rows.length === 0) return `Queue '${queueId}' is empty`;
  return [`Queue '${queueId}' pending items:`, ...rows.map((item) => `#${item.position} [${item.id}] ${item.description}`)].join("\n");
}

// Item commands return structured envelopes so the CLI can expose machine data
// while the extension slash surface still renders the human `output` string.
// `error` is normalized without an "Error:" prefix so callers get a clean
// message; `output` keeps the prefixed human form for display.
function domainError(message) {
  const normalized = String(message || "").replace(/^Error:\s*/, "");
  return { ok: false, error: normalized, output: `Error: ${normalized}` };
}

export async function handleBacklogCommand(rawText, { cwd = null } = {}) {
  const { cmd, args, isTop } = parseBacklogCommand(rawText);
  const resolveQueueForItemOps = () => resolveItemCommandContext({ cwd });
  const resolveQueueForList = () => {
    const queueId = args[0]?.trim();
    if (!queueId) return resolveQueueForItemOps();
    const queue = getQueue(queueId);
    return queue ? { queueId: queue.id } : { error: `Error: Queue '${queueId}' not found` };
  };

  switch (cmd) {
    case "add": {
      const desc = args.join(" ").trim();
      if (!desc) return domainError("Description required. Usage: /backlog add <description>");
      const queueContext = resolveQueueForItemOps();
      if (queueContext.error) return domainError(queueContext.error);
      const { id, position } = addItem(desc, isTop, queueContext.queueId);
      return {
        output: `Added: '${desc}' [id: ${id}, position: ${position}]`,
        item: { id, position, description: desc },
      };
    }
    case "list": {
      const queueContext = resolveQueueForList();
      if (queueContext.error) return domainError(queueContext.error);
      const items = listPendingItems(queueContext.queueId);
      return {
        output: formatItems(items, queueContext.queueId),
        queueId: queueContext.queueId,
        items,
      };
    }
    case "done": {
      const queueContext = resolveQueueForItemOps();
      if (queueContext.error) return domainError(queueContext.error);
      const item = markDone(args[0], queueContext.queueId);
      if (!item) return domainError(`Item '${args[0]}' not found`);
      return { output: `Marked '${item.description}' as done`, item };
    }
    case "remove": {
      const queueContext = resolveQueueForItemOps();
      if (queueContext.error) return queueContext.error;
      const item = removeItem(args[0], queueContext.queueId);
      return item ? `Removed '${item.description}'` : `Error: Item '${args[0]}' not found`;
    }
    case "edit": {
      const queueContext = resolveQueueForItemOps();
      if (queueContext.error) return domainError(queueContext.error);
      const [ref, ...rest] = args;
      const desc = rest.join(" ").trim();
      const item = editItem(ref, desc, queueContext.queueId);
      if (!item) return domainError(`Item '${ref}' not found or empty description`);
      return { output: `Updated '${item.description}'`, item };
    }
    case "move": {
      if (!args[0] || !args[1]) return "Error: Usage: /backlog move <id-or-position> <position|top|bottom>";
      const queueContext = resolveQueueForItemOps();
      if (queueContext.error) return queueContext.error;
      try {
        const item = moveItem(args[0], args[1], queueContext.queueId);
        return item ? `Moved '${item.description}' to position ${item.position}` : `Error: Item '${args[0]}' not found`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "pending": {
      const queueContext = resolveQueueForItemOps();
      if (queueContext.error) return queueContext.error;
      return String(getPendingCount(queueContext.queueId));
    }
    case "status": {
      return describeBacklogStatus({ cwd, queues: listQueues() });
    }
    case "init": {
      if (!cwd) return "Error: Workspace directory required. Usage: /backlog init [queue-id] [name]";
      const workspace = cwd;
      const scope = workspace;
      const queueId = args[0] || queueIdFromScope(scope);
      const name = args.slice(1).join(" ").trim() || queueId;
      const beforeQueueExists = listQueues().some((queue) => queue.id === queueId);
      const queue = createQueue({ id: queueId, name });
      const beforeBindingExists = queue.bindings?.some((binding) => binding.scope === scope) || false;
      const binding = bindQueueScope(queue, scope, { preferred: true });
      const status = describeBacklogStatus({ cwd: workspace, queues: listQueues() });
      return {
        message: `Initialized backlog queue '${queue.name}' [id: ${queue.id}] for ${scope}`,
        queueId: queue.id,
        queueName: queue.name,
        workspace,
        scope,
        createdQueue: !beforeQueueExists,
        createdBinding: !beforeBindingExists,
        binding,
        status,
      };
    }
    case "clear": {
      const queueContext = resolveQueueForItemOps();
      if (queueContext.error) return queueContext.error;
      const result = clearQueueItems(queueContext.queueId);
      return `Cleared ${result.changes} item(s) from queue`;
    }
    case "queue": {
      const sub = (args[0] || "list").toLowerCase();
      if (sub === "list") {
        const queues = listQueues();
        if (queues.length === 0) return "No queues";
        return queues.map((queue) => `  ${queue.id} - ${queue.name}${queue.description ? ` - ${queue.description}` : ""}`).join("\n");
      }
      if (sub === "add" || sub === "create") {
        const queueId = args[1];
        const name = args.slice(2).join(" ").trim();
        if (!queueId) return "Error: Queue id required. Usage: /backlog queue add <queue-id> [name]";
        const queue = createQueue({ id: queueId, name: name || queueId });
        return `Created queue '${queue.name}' [id: ${queue.id}]`;
      }
      if (sub === "edit") {
        const queueId = args[1];
        const description = args.slice(2).join(" ").trim();
        if (!queueId || !description) return "Error: Usage: /backlog queue edit <queue-id> <description>";
        const queue = updateQueue(queueId, { description });
        if (!queue) return `Error: Queue '${queueId}' not found`;
        return `Updated queue '${queue.name}' [id: ${queue.id}]`;
      }
      if (sub === "rename") {
        const queueId = args[1];
        const name = args.slice(2).join(" ").trim();
        if (!queueId || !name) return "Error: Usage: /backlog queue rename <queue-id> <new-name>";
        const queue = updateQueue(queueId, { name });
        if (!queue) return `Error: Queue '${queueId}' not found`;
        return `Renamed queue '${queue.name}' [id: ${queue.id}]`;
      }
      return "Error: Usage: /backlog queue list|add|create|edit|rename";
    }
    case "show": {
      if (!sidecarState.role) tryStartSidecar();
      showViewer();
      return "Backlog viewer opened. Close the window to dismiss it.";
    }
    case "approve": {
      const id = args[0];
      if (!id) return "Error: Item id required. Usage: /backlog approve <id>";
      try {
        const item = approveItemStart({ itemId: id, actor: "human-command" });
        return `Approved start for '${item.description}' [id: ${item.id}]`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "review": {
      if (args.length === 0) return formatHumanDecisionNotice(listHumanDecisions());
      const id = args[0];
      const verdict = (args[1] || "").toLowerCase();
      if (verdict !== "approve" && verdict !== "reject") {
        return "Error: Review verdict required. Usage: /backlog review <id> approve|reject";
      }
      try {
        const item = verdict === "approve"
          ? approveItemReview({ itemId: id, actor: "human-command" })
          : rejectItemReview({ itemId: id, reason: args.slice(2).join(" "), actor: "human-command" });
        return verdict === "approve"
          ? `Approved review for '${item.description}' [id: ${item.id}]`
          : `Rejected review for '${item.description}' [id: ${item.id}]`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "backup": {
      try {
        const out = exportBacklogBackup({ outputPath: args[0] || undefined });
        return `Backlog backup written: ${out.path} (sha256 ${out.sha256})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "restore": {
      if (!args[0]) return "Error: Backup path required. Usage: /backlog restore <path>";
      try {
        const out = restoreBacklogBackup({ inputPath: args[0] });
        return `Backlog backup restored: ${args[0]} (sha256 ${out.sha256})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "doctor": {
      return formatDoctorReport();
    }
    default:
      return `Unknown command: ${cmd}\nCommands: ${getSlashCommandNames().join(", ")}`;
  }
}
