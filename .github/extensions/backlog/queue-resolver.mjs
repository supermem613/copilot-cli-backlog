import { relative, resolve } from "node:path";
import { bindQueueScope as bindQueueScopeDb, db, listQueues, listQueueScopes as listQueueScopesDb } from "./db.mjs";
import { resolveWorktreeOrigin } from "./vcs-provider.mjs";

function normalizePath(value) {
  return resolve(String(value || "."));
}

function isAncestorPath(ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  const normalizedAncestor = normalizePath(ancestor);
  const normalizedDescendant = normalizePath(descendant);
  if (normalizedAncestor === normalizedDescendant) return false;
  const relativePath = relative(normalizedAncestor, normalizedDescendant);
  return !!relativePath && !relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.startsWith("\\") && !relativePath.includes("..\\") && !relativePath.includes("../");
}

function getQueueBindings(queue) {
  if (!queue) return [];
  if (Array.isArray(queue.bindings)) return queue.bindings;
  const queueId = queue.id;
  return queueId ? listQueueScopesDb(queueId) : [];
}

function normalizeStatusValue(value) {
  return String(value || "").trim();
}

function buildCandidate(queue, binding, matchedBy) {
  return {
    queueId: queue.id,
    queue,
    binding,
    matchedBy,
    scope: binding?.scope || null,
  };
}

export function bindQueueScope(queue, scope, { preferred = false } = {}) {
  if (!queue) throw new Error("queue is required");
  if (!scope) throw new Error("scope is required");
  const binding = bindQueueScopeDb(queue, scope, { preferred });
  const queueId = queue.id;
  if (queueId) {
    queue.bindings = listQueueScopesDb(queueId);
  }
  return binding;
}

export function resolveQueue({ cwd, worktreeEvidence = {} } = {}) {
  const queues = Array.isArray(worktreeEvidence.queues) ? worktreeEvidence.queues : [];
  const normalizedCwd = normalizePath(cwd);
  const worktreeOrigin = resolveWorktreeOrigin(normalizedCwd, worktreeEvidence);
  const normalizedOrigin = worktreeOrigin ? normalizePath(worktreeOrigin) : null;

  const exactMatches = [];
  const worktreeOriginMatches = [];
  const ancestorMatches = [];

  for (const queue of queues) {
    const bindings = getQueueBindings(queue);
    for (const binding of bindings) {
      const bindingScope = normalizePath(binding.scope);
      if (bindingScope === normalizedCwd) {
        exactMatches.push(buildCandidate(queue, binding, "exact"));
      } else if (normalizedOrigin && bindingScope === normalizedOrigin) {
        worktreeOriginMatches.push(buildCandidate(queue, binding, "worktree-origin"));
      } else if (isAncestorPath(bindingScope, normalizedCwd)) {
        ancestorMatches.push(buildCandidate(queue, binding, "ancestor"));
      }
    }
  }

  const groups = [
    { kind: "exact", matches: exactMatches },
    { kind: "worktree-origin", matches: worktreeOriginMatches },
    { kind: "ancestor", matches: ancestorMatches },
  ];

  for (const group of groups) {
    if (!group.matches.length) continue;
    const preferredMatches = group.matches.filter((candidate) => candidate.binding.preferred);
    const candidates = preferredMatches.length ? preferredMatches : group.matches;
    const uniqueQueueIds = [...new Set(candidates.map((candidate) => candidate.queueId))];
    if (candidates.length === 1 || uniqueQueueIds.length === 1) {
      const selected = candidates[0];
      return {
        state: "resolved",
        matchedBy: group.kind,
        queueId: selected.queueId,
        queue: selected.queue,
        binding: selected.binding,
        candidates: uniqueQueueIds,
      };
    }
    return {
      state: "ambiguous",
      matchedBy: group.kind,
      queueId: undefined,
      queue: undefined,
      binding: undefined,
      candidates: uniqueQueueIds,
    };
  }

  return {
    state: "unbound",
    matchedBy: undefined,
    queueId: undefined,
    queue: undefined,
    binding: undefined,
    candidates: [],
  };
}

export function resolveQueueForCwd(cwd, { queues = [], origin = null } = {}) {
  return resolveQueue({
    cwd,
    worktreeEvidence: {
      queues,
      origin,
      worktreeOrigin: origin,
    },
  });
}

function formatAmbiguousResolutionError(resolution, cwd) {
  const candidates = Array.isArray(resolution?.candidates) && resolution.candidates.length > 0
    ? resolution.candidates.join(", ")
    : "(none)";
  const scope = cwd ? `'${cwd}'` : "the current workspace";
  return `Ambiguous queue resolution for ${scope}. Candidates: ${candidates}`;
}

function formatUnboundResolutionError(cwd) {
  const scope = cwd ? `'${cwd}'` : "the current workspace";
  return `Unbound queue resolution for ${scope}. Bind a queue scope before operating on backlog items.`;
}

export function resolveItemCommandContext({
  cwd = null,
  queues = null,
  origin = null,
  worktreeEvidence = {},
} = {}) {
  const queueList = Array.isArray(queues) ? queues : (Array.isArray(worktreeEvidence.queues) ? worktreeEvidence.queues : listQueues());
  const evidence = {
    ...worktreeEvidence,
    queues: queueList,
    origin,
    worktreeOrigin: origin ?? worktreeEvidence.worktreeOrigin ?? worktreeEvidence.origin ?? null,
  };
  const normalizedCwd = cwd ? normalizePath(cwd) : null;

  if (!normalizedCwd) {
    const resolution = {
      state: "unbound",
      matchedBy: undefined,
      queueId: undefined,
      queue: undefined,
      binding: undefined,
      candidates: [],
    };
    return {
      cwd: normalizedCwd,
      queueId: undefined,
      queue: undefined,
      resolution,
      error: formatUnboundResolutionError(normalizedCwd),
      candidates: [],
    };
  }

  const resolution = resolveQueue({ cwd: normalizedCwd, worktreeEvidence: evidence });
  if (resolution.state === "resolved") {
    return {
      cwd: normalizedCwd,
      queueId: resolution.queueId,
      queue: resolution.queue || undefined,
      resolution,
      error: null,
      candidates: resolution.candidates || [],
    };
  }

  if (resolution.state === "ambiguous") {
    return {
      cwd: normalizedCwd,
      queueId: undefined,
      queue: undefined,
      resolution,
      error: formatAmbiguousResolutionError(resolution, normalizedCwd),
      candidates: resolution.candidates || [],
    };
  }

  return {
    cwd: normalizedCwd,
    queueId: undefined,
    queue: undefined,
    resolution,
    error: formatUnboundResolutionError(normalizedCwd),
    candidates: [],
  };
}

function getItemCount(queueId, status) {
  const normalizedStatus = normalizeStatusValue(status);
  if (!queueId) return 0;
  if (!normalizedStatus) {
    return db.prepare(
      "SELECT COUNT(*) as count FROM items WHERE queue_id = ?"
    ).get(queueId).count;
  }
  return db.prepare(
    "SELECT COUNT(*) as count FROM items WHERE queue_id = ? AND status = ?"
  ).get(queueId, normalizedStatus).count;
}

export function describeBacklogStatus({ cwd, queues = null, origin = null, worktreeEvidence = {} } = {}) {
  const normalizedCwd = normalizePath(cwd);
  const queueList = Array.isArray(queues) ? queues : (Array.isArray(worktreeEvidence.queues) ? worktreeEvidence.queues : listQueues());
  const evidence = {
    ...worktreeEvidence,
    queues: queueList,
    origin,
    worktreeOrigin: origin ?? worktreeEvidence.worktreeOrigin ?? worktreeEvidence.origin ?? null,
  };
  const resolution = resolveQueue({ cwd: normalizedCwd, worktreeEvidence: evidence });
  const pendingItems = resolution.state === "resolved" && resolution.queueId ? getItemCount(resolution.queueId, "pending") : 0;
  const doneItems = resolution.state === "resolved" && resolution.queueId ? getItemCount(resolution.queueId, "done") : 0;
  const itemCounts = {
    done: doneItems,
    pendingItems,
  };
  const queueSummary = resolution.state === "resolved" && resolution.queue
    ? {
        id: resolution.queue.id,
        name: resolution.queue.name,
        description: resolution.queue.description || null,
      }
    : null;
  const normalizedOrigin = resolveWorktreeOrigin(normalizedCwd, evidence);
  return {
    state: resolution.state,
    queueId: resolution.queueId,
    queueSummary,
    matchedBy: resolution.matchedBy,
    canonicalScope: normalizedCwd,
    candidates: resolution.candidates || [],
    itemCounts,
    createdItem: false,
    worktreeEvidence: {
      cwd: normalizedCwd,
      origin: normalizedOrigin,
      queueCount: queueList.length,
    },
    resolution,
  };
}
