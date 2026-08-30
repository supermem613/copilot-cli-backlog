// Item CRUD: add, list, mark done, remove, move, edit. Position management
// is queue-scoped, and every ordering mutation keeps pending positions dense.

import {
  db,
  tx,
  deleteItemDependentsByIds,
  ensureQueue,
  getQueue,
  attachItemPorContext as attachPorContext,
  getItemPorContext as getPorContext,
  removeItemPorContext as removePorContext,
} from "./db.mjs";
import {
  sidecarBroadcast,
  clearViewerSuppression,
} from "./sidecar.mjs";

function normalizeQueueId(queueId) {
  const resolved = String(queueId || "").trim();
  if (!resolved) throw new Error("queue id is required");
  ensureQueue(resolved);
  return resolved;
}

export function generateId(description) {
  // Clamp stays at 50 because ids are CLI argv tokens and sidecar labels.
  // Trim trailing hyphens after the cut. A mid-token slice was producing
  // `...staleambiguous-` and collision suffixes became `--2`, so done-by-id
  // looked truncated and two HALT follow-ups were hard to tell apart.
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const clampBase = (value, max) => {
    const sliced = String(value || "").slice(0, max).replace(/-+$/g, "");
    return sliced || "item";
  };
  const base = clampBase(slug, 50);
  let id = base;
  let counter = 2;
  while (db.prepare("SELECT 1 FROM items WHERE id = ?").get(id)) {
    const suffix = `-${counter++}`;
    id = `${clampBase(slug, 50 - suffix.length)}${suffix}`;
  }
  return id;
}

export function getNextPosition(queueId) {
  const queue = normalizeQueueId(queueId);
  const row = db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as next FROM items WHERE queue_id = ? AND status = ?"
  ).get(queue, "pending");
  return row.next;
}

export function resolveItemRef(ref, queueId) {
  const queue = normalizeQueueId(queueId);
  // A nullish or blank ref must resolve to "no such item" rather than reaching
  // the driver, which rejects a non-bindable parameter with a raw TypeError.
  // Callers treat a throw as an execution failure and lose the real cause.
  if (ref === undefined || ref === null || String(ref).trim() === "") return undefined;
  if (/^\d+$/.test(String(ref))) {
    const pos = parseInt(ref, 10);
    return db.prepare(
      "SELECT * FROM items WHERE queue_id = ? AND status = ? AND position = ?"
    ).get(queue, "pending", pos);
  }
  return db.prepare(
    "SELECT * FROM items WHERE id = ? AND queue_id = ?"
  ).get(String(ref), queue);
}

export function reorderPositions(queueId) {
  const queue = normalizeQueueId(queueId);
  const items = db.prepare(
    "SELECT id FROM items WHERE queue_id = ? AND status = ? ORDER BY position, created_at, id"
  ).all(queue, "pending");
  const update = db.prepare("UPDATE items SET position = ? WHERE id = ?");
  items.forEach((item, idx) => update.run(idx + 1, item.id));
}

export function getPendingCount(queueId) {
  const queue = normalizeQueueId(queueId);
  return db.prepare(
    "SELECT COUNT(*) as count FROM items WHERE queue_id = ? AND status = ?"
  ).get(queue, "pending").count;
}

export function getTopItem(queueId) {
  const queue = normalizeQueueId(queueId);
  return db.prepare(
    "SELECT id, description FROM items WHERE queue_id = ? AND status = ? ORDER BY position LIMIT 1"
  ).get(queue, "pending");
}

export function listItems(queueId, status = "pending") {
  const queue = normalizeQueueId(queueId);
  const resolvedStatus = String(status || "pending").trim().toLowerCase() || "pending";
  return db.prepare(
    "SELECT id, description, position FROM items WHERE queue_id = ? AND status = ? ORDER BY position"
  ).all(queue, resolvedStatus);
}

export function listPendingItems(queueId) {
  return listItems(queueId, "pending");
}

export function listQueueItemCounts(queueId = null) {
  const queue = queueId ? String(queueId).trim() : null;
  const statement = queue ? db.prepare(`
    SELECT queue_id, COALESCE(status, 'unknown') AS status, COUNT(*) AS count
    FROM items
    WHERE queue_id = ?
    GROUP BY queue_id, COALESCE(status, 'unknown')
    ORDER BY queue_id, COALESCE(status, 'unknown')
  `) : db.prepare(`
    SELECT queue_id, COALESCE(status, 'unknown') AS status, COUNT(*) AS count
    FROM items
    WHERE queue_id IS NOT NULL
    GROUP BY queue_id, COALESCE(status, 'unknown')
    ORDER BY queue_id, COALESCE(status, 'unknown')
  `);
  return queue ? statement.all(queue) : statement.all();
}

export function listQueueItems(queueId) {
  const queue = String(queueId || "").trim();
  if (!queue || !getQueue(queue)) throw new Error(`Queue '${queue}' not found`);
  return db.prepare(`
    SELECT
      i.id,
      i.description,
      i.position,
      i.priority,
      i.queue_id,
      COALESCE(i.status, 'unknown') AS status,
      i.created_at,
      i.updated_at,
      p.por_id,
      p.kind AS por_kind,
      p.meta_json AS por_meta_json,
      l.lease_id,
      l.owner_session,
      l.repo_root,
      l.worktree_path,
      l.heartbeat_at,
      l.expires_at,
      l.status AS lease_status,
      l.needs_recovery
    FROM items i
    LEFT JOIN item_pors p ON p.item_id = i.id
    LEFT JOIN item_leases l ON l.item_id = i.id
    WHERE i.queue_id = ?
    ORDER BY
      CASE WHEN i.status = 'pending' THEN 0 ELSE 1 END,
      i.status,
      i.position,
      i.created_at,
      i.id
  `).all(queue).map((row) => {
    const {
      por_id,
      por_kind,
      por_meta_json,
      lease_id,
      owner_session,
      repo_root,
      worktree_path,
      heartbeat_at,
      expires_at,
      lease_status,
      needs_recovery,
      ...item
    } = row;
    return {
      ...item,
      por: por_id ? {
        id: por_id,
        kind: por_kind,
        metadata: por_meta_json ? JSON.parse(por_meta_json) : {},
      } : null,
      lease: lease_id ? {
        id: lease_id,
        owner_session,
        repo_root,
        worktree_path,
        heartbeat_at,
        expires_at,
        status: lease_status,
        needs_recovery: !!needs_recovery,
      } : null,
    };
  });
}

export function addItem(description, isTop = false, queueId) {
  const queue = normalizeQueueId(queueId);
  const out = tx(() => {
    const id = generateId(description);
    let position;
    if (isTop) {
      db.prepare(
        "UPDATE items SET position = position + 1 WHERE queue_id = ? AND status = ?"
      ).run(queue, "pending");
      position = 1;
    } else {
      position = getNextPosition(queue);
    }
    db.prepare(
      "INSERT INTO items (id, description, position, queue_id) VALUES (?, ?, ?, ?)"
    ).run(id, description, position, queue);
    return { id, position, queue_id: queue };
  });
  clearViewerSuppression();
  sidecarBroadcast();
  return out;
}

export function markDone(ref, queueId) {
  const queue = normalizeQueueId(queueId);
  const item = tx(() => {
    const it = resolveItemRef(ref, queue);
    if (!it) return null;
    db.prepare(
      "UPDATE items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run("done", it.id);
    reorderPositions(queue);
    return { ...it, status: "done" };
  });
  if (item) sidecarBroadcast();
  return item;
}

export function removeItem(ref, queueId) {
  const queue = normalizeQueueId(queueId);
  const item = tx(() => {
    const it = resolveItemRef(ref, queue);
    if (!it) return null;
    deleteItemDependentsByIds([it.id]);
    db.prepare("DELETE FROM items WHERE id = ?").run(it.id);
    reorderPositions(queue);
    return it;
  });
  if (item) sidecarBroadcast();
  return item;
}

export function clearQueueItems(queueId) {
  const queue = normalizeQueueId(queueId);
  const result = tx(() => {
    const itemIds = db.prepare("SELECT id FROM items WHERE queue_id = ?").all(queue).map((row) => row.id);
    deleteItemDependentsByIds(itemIds);
    return db.prepare("DELETE FROM items WHERE queue_id = ?").run(queue);
  });
  sidecarBroadcast();
  return result;
}

function resolveMoveTarget(target, pendingCount) {
  const value = String(target || "").trim().toLowerCase();
  if (value === "top") return 1;
  if (value === "bottom" || value === "end" || value === "last") return pendingCount;
  if (!/^\d+$/.test(value)) {
    throw new Error("Move target must be a position number, 'top', or 'bottom'");
  }
  const position = parseInt(value, 10);
  if (position < 1 || position > pendingCount) {
    throw new Error(`Move target must be between 1 and ${pendingCount}`);
  }
  return position;
}

export function moveItem(ref, target, queueId) {
  const queue = normalizeQueueId(queueId);
  const item = tx(() => {
    const it = resolveItemRef(ref, queue);
    if (!it || it.status !== "pending") return null;
    const nextPosition = resolveMoveTarget(target, getPendingCount(queue));
    if (it.position === nextPosition) return { ...it, position: nextPosition };
    if (nextPosition < it.position) {
      db.prepare(
        "UPDATE items SET position = position + 1 WHERE queue_id = ? AND status = ? AND position >= ? AND position < ?"
      ).run(queue, "pending", nextPosition, it.position);
    } else {
      db.prepare(
        "UPDATE items SET position = position - 1 WHERE queue_id = ? AND status = ? AND position > ? AND position <= ?"
      ).run(queue, "pending", it.position, nextPosition);
    }
    db.prepare("UPDATE items SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(nextPosition, it.id);
    reorderPositions(queue);
    return { ...it, position: nextPosition };
  });
  if (item) sidecarBroadcast();
  return item;
}

export function editItem(ref, newDescription, queueId) {
  const queue = normalizeQueueId(queueId);
  const desc = (newDescription || "").trim();
  if (!desc) return null;
  const item = tx(() => {
    const it = resolveItemRef(ref, queue);
    if (!it) return null;
    db.prepare(
      "UPDATE items SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(desc, it.id);
    return { ...it, description: desc };
  });
  if (item) sidecarBroadcast();
  return item;
}

export function createQueue(queueSpec) {
  return ensureQueue(queueSpec.id, queueSpec);
}

export function listQueues() {
  return getQueue ? db.prepare("SELECT * FROM queues ORDER BY name, created_at").all().map((row) => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
  })) : [];
}

export function updateQueue(queueId, updates) {
  return db.prepare("UPDATE queues SET name = ?, description = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(updates.name, updates.description ?? null, JSON.stringify(updates.metadata ?? {}), queueId);
}

export function attachItemPorContext(...args) {
  return attachPorContext(...args);
}

export function getItemPorContext(itemId) {
  return getPorContext(itemId);
}

export function removeItemPorContext(itemId) {
  return removePorContext(itemId);
}
