// Slash command parser and dispatcher.

import { createQueue, getQueue, listQueues, listQueueSummaries, updateQueue } from "./db.mjs";
import {
  addItem,
  markDone,
  removeItem,
  editItem,
  moveItem,
  listItems,
  listQueueItemCounts,
  listQueueItems,
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
  if (!text) return { cmd: "list", args: [], isTop: false, status: "pending", statusError: null };
  const firstBreak = text.search(/\s/);
  const cmd = (firstBreak === -1 ? text : text.slice(0, firstBreak)).toLowerCase();
  let rest = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  const args = [];
  let isTop = false;
  let status = "pending";
  let statusError = null;

  if (cmd === "add") {
    // Keep the description body intact, including newlines. Token-splitting
    // the whole line turned evidence bundles into one flattened sentence and
    // made list/sqlite dumps look title-only when the caller had passed more.
    const topMatch = rest.match(/^--top(?:\s+|$)/);
    if (topMatch) {
      isTop = true;
      rest = rest.slice(topMatch[0].length);
    }
    if (rest) args.push(rest);
    return { cmd, args, isTop, status, statusError };
  }

  const parts = rest.split(/\s+/).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "--top") {
      isTop = true;
      continue;
    }
    if (part === "--status" && cmd === "list") {
      const nextPart = parts[index + 1];
      if (nextPart && !nextPart.startsWith("--")) {
        status = nextPart.toLowerCase();
        index += 1;
        continue;
      }
      statusError = "Missing value for --status";
      continue;
    }
    args.push(part);
  }

  return { cmd, args, isTop, status, statusError };
}

function queueIdFromScope(scope) {
  const leaf = String(scope || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return (leaf || "backlog").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "backlog";
}

function formatItems(rows, queueId, status = "pending") {
  if (rows.length === 0) return `Queue '${queueId}' is empty`;
  const resolvedStatus = String(status || "pending").trim().toLowerCase() || "pending";
  return [`Queue '${queueId}' ${resolvedStatus} items:`, ...rows.map((item) => `#${item.position} [${item.id}] ${item.description}`)].join("\n");
}

function summarizeQueues(queues) {
  const countsByQueue = new Map();
  const queueId = queues.length === 1 ? queues[0].id : null;
  for (const row of listQueueItemCounts(queueId)) {
    const itemCounts = countsByQueue.get(row.queue_id) || {};
    itemCounts[row.status] = row.count;
    countsByQueue.set(row.queue_id, itemCounts);
  }
  return queues.map((queue) => {
    const itemCounts = countsByQueue.get(queue.id) || {};
    return {
      ...queue,
      itemCount: Object.values(itemCounts).reduce((total, count) => total + count, 0),
      itemCounts,
    };
  });
}

function formatQueues(queues) {
  if (queues.length === 0) return "No queues";
  return queues.map((queue) => {
    const counts = Object.entries(queue.itemCounts)
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ");
    const suffix = counts ? ` (${counts})` : " (empty)";
    return `  ${queue.id} - ${queue.name}${queue.description ? ` - ${queue.description}` : ""}${suffix}`;
  }).join("\n");
}

function formatQueueDetails(queue, items) {
  if (items.length === 0) return `Queue '${queue.id}' is empty`;
  return [
    `Queue '${queue.name}' [id: ${queue.id}] items:`,
    ...items.map((item) => `#${item.position} [${item.status}] [${item.id}] ${item.description}`),
  ].join("\n");
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
  const { cmd, args, isTop, status, statusError } = parseBacklogCommand(rawText);
  const resolveQueueForItemOps = () => resolveItemCommandContext({ cwd });
  const resolveQueueForList = () => {
    const queueId = args[0]?.trim();
    if (!queueId) return resolveQueueForItemOps();
    const queue = getQueue(queueId);
    return queue ? { queueId: queue.id } : { error: `Error: Queue '${queueId}' not found` };
  };
  const normalizedStatus = String(status || "pending").trim().toLowerCase() || "pending";

  if (cmd === "list" && statusError) return domainError(statusError);

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
      if (normalizedStatus !== "pending" && normalizedStatus !== "done") {
        return domainError(`Unsupported list status: ${status}`);
      }
      const queueContext = resolveQueueForList();
      if (queueContext.error) return domainError(queueContext.error);
      const items = listItems(queueContext.queueId, normalizedStatus);
      return {
        output: formatItems(items, queueContext.queueId, normalizedStatus),
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
        if (args[1]) {
          const queue = getQueue(args[1]);
          if (!queue) return domainError(`Queue '${args[1]}' not found`);
          const items = listQueueItems(queue.id);
          return {
            output: formatQueueDetails(queue, items),
            queue: summarizeQueues([queue])[0],
            items,
          };
        }
        const queues = listQueueSummaries();
        return {
          output: formatQueues(queues),
          queues,
        };
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
      if (args.length <= 2 && (!args[1] || args[1].toLowerCase() === "list")) {
        const queue = getQueue(args[0]);
        if (!queue) return domainError(`Queue '${args[0]}' not found`);
        const items = listQueueItems(queue.id);
        return {
          output: formatQueueDetails(queue, items),
          queue: summarizeQueues([queue])[0],
          items,
        };
      }
      return domainError("Usage: /backlog queue [list [queue-id]|<queue-id> [list]|add|create|edit|rename]");
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
