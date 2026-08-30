// Database setup, schema, migrations, and queue-level helpers.
//
// The DB lives at {BACKLOG_DIR}/backlog.db. BACKLOG_DIR defaults to
// ~/.backlog but can be overridden by calling initBacklog(dir) before any
// other module reads from `db`. Tests use this to sandbox into os.tmpdir().
//
// All exports use ESM `export let` so the live binding mechanic lets every
// other module see the singleton `db` once initBacklog has been called.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export let BACKLOG_DIR = null;
export let db = null;

const FRICTION_COLUMNS = [
  "source",
  "friction_category",
  "friction_tool",
  "friction_key",
  "occurrence_count",
  "first_seen_at",
  "last_seen_at",
];

function parseMetadataJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function initBacklog(dirOverride) {
  if (db) return db;
  BACKLOG_DIR = dirOverride || join(homedir(), ".backlog");
  if (!existsSync(BACKLOG_DIR)) {
    mkdirSync(BACKLOG_DIR, { recursive: true });
  }
  db = new DatabaseSync(join(BACKLOG_DIR, "backlog.db"));

  // WAL allows concurrent readers/writers across processes — required because
  // each Copilot session spawns its own extension process, and all share this DB.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      position INTEGER NOT NULL,
      priority INTEGER DEFAULT 0,
      queue_id TEXT NOT NULL,
      por_json TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (queue_id) REFERENCES queues(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  migrateRemoveFrictionStorage();
  addColumnIfMissing("items", "priority", "INTEGER DEFAULT 0");
  addColumnIfMissing("items", "queue_id", "TEXT");
  addColumnIfMissing("items", "por_json", "TEXT");
  ensureEventSchema();
  ensureQueueSchema();
  migrateRemoveSessionStorage();
  migrateRemoveLoopStorage();
  // Note: a legacy `pinned` column may exist on older installs. We never read
  // or write it — pinning was removed; the viewer is dismissed by closing the
  // window, and re-opens automatically when new items are added or
  // /backlog show is invoked.

  return db;
}

function addColumnIfMissing(tableName, columnName, definition) {
  if (db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}

export function itemContextCascadeEnabled() {
  if (!tableExists("item_contexts")) return false;
  const rows = db.prepare("PRAGMA foreign_key_list(item_contexts)").all();
  return rows.some((row) =>
    row.table === "items" &&
    row.from === "item_id" &&
    row.to === "id" &&
    String(row.on_delete || "").toUpperCase() === "CASCADE"
  );
}

export function tableExists(name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?"
  ).get(name);
}

export function itemColumns() {
  return db.prepare("PRAGMA table_info(items)").all().map((row) => row.name);
}

export function frictionStoragePresent() {
  const columns = new Set(itemColumns());
  return FRICTION_COLUMNS.some((column) => columns.has(column)) || tableExists("item_contexts");
}

export const legacyStoragePresent = frictionStoragePresent;

function readFrictionArchiveRows() {
  const columns = new Set(itemColumns());
  const hasSource = columns.has("source");
  const frictionRows = hasSource
    ? db.prepare("SELECT * FROM items WHERE source = ?").all("friction")
    : [];
  const contextRows = tableExists("item_contexts")
    ? db.prepare("SELECT * FROM item_contexts ORDER BY id").all()
    : [];
  return { frictionRows, contextRows };
}

export function exportFrictionArchive(label = "migration") {
  const archiveDir = join(BACKLOG_DIR, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const { frictionRows, contextRows } = readFrictionArchiveRows();
  const createdAt = new Date().toISOString();
  const lines = [
    JSON.stringify({ type: "meta", label, created_at: createdAt }),
    ...frictionRows.map((row) => JSON.stringify({ type: "item", row })),
    ...contextRows.map((row) => JSON.stringify({ type: "item_context", row })),
  ];
  const payload = `${lines.join("\n")}\n`;
  const checksum = createHash("sha256").update(payload).digest("hex");
  const stamp = createdAt.replace(/[:.]/g, "-");
  const jsonlPath = join(archiveDir, `friction-removal-${stamp}.jsonl`);
  const manifestPath = join(archiveDir, `friction-removal-${stamp}.manifest.json`);
  writeFileSync(jsonlPath, payload, "utf8");
  writeFileSync(manifestPath, JSON.stringify({
    label,
    created_at: createdAt,
    jsonl_path: jsonlPath,
    sha256: checksum,
    friction_item_count: frictionRows.length,
    item_context_count: contextRows.length,
  }, null, 2), "utf8");
  return { jsonlPath, manifestPath, checksum, frictionRows: frictionRows.length, contextRows: contextRows.length };
}

function migrateRemoveFrictionStorage() {
  if (!frictionStoragePresent()) return null;
  const archive = exportFrictionArchive("friction-removal");
  db.exec("DROP INDEX IF EXISTS idx_friction_dedupe;");
  db.exec("DROP INDEX IF EXISTS idx_item_contexts_item;");
  db.exec("DROP TABLE IF EXISTS item_contexts;");
  for (const column of FRICTION_COLUMNS) {
    if (itemColumns().includes(column)) {
      db.exec(`ALTER TABLE items DROP COLUMN ${column};`);
    }
  }
  db.prepare("DELETE FROM settings WHERE key = ?").run("friction_capture_enabled");
  db.exec("PRAGMA user_version = 1;");
  return archive;
}

function bumpUserVersionAtLeast(version) {
  const current = db.prepare("PRAGMA user_version").get().user_version || 0;
  if (current < version) db.exec(`PRAGMA user_version = ${version};`);
}

function indexExists(name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?"
  ).get(name);
}

function migrateRemoveSessionStorage() {
  const columns = itemColumns();
  const hasSessionId = columns.includes("session_id");
  const hasSessions = tableExists("sessions");
  if (!hasSessionId && !hasSessions) {
    bumpUserVersionAtLeast(4);
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("PRAGMA legacy_alter_table = ON;");
  try {
    if (hasSessionId) {
      if (db.prepare("SELECT 1 FROM items WHERE queue_id IS NULL LIMIT 1").get()) {
        ensureQueue("legacy", { name: "Legacy", description: "Migrated items that predate queue bindings" });
      }
      db.exec("DROP INDEX IF EXISTS idx_session;");
      db.exec("DROP INDEX IF EXISTS idx_position;");
      db.exec("ALTER TABLE items RENAME TO items_session_legacy;");
      db.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          position INTEGER NOT NULL,
          priority INTEGER DEFAULT 0,
          queue_id TEXT NOT NULL,
          por_json TEXT,
          status TEXT DEFAULT 'pending',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (queue_id) REFERENCES queues(id) ON DELETE CASCADE
        );
      `);
      db.exec(`
        INSERT INTO items (id, description, position, priority, queue_id, por_json, status, created_at, updated_at)
        SELECT id,
               description,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(queue_id, 'legacy'), status
                 ORDER BY position, created_at, id
               ),
               priority,
               COALESCE(queue_id, 'legacy'),
               por_json,
               status,
               created_at,
               updated_at
        FROM items_session_legacy;
      `);
      db.exec("DROP TABLE items_session_legacy;");
    }
    db.exec("DROP TABLE IF EXISTS sessions;");
    db.exec("CREATE INDEX IF NOT EXISTS idx_items_queue_status_position ON items(queue_id, status, position);");
    bumpUserVersionAtLeast(4);
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF;");
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

function migrateRemoveLoopStorage() {
  db.exec("DROP TABLE IF EXISTS queue_loop_state;");
  bumpUserVersionAtLeast(5);
}

function ensureEventSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      correlation_id TEXT,
      origin_host TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_gates (
      item_id TEXT NOT NULL,
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('start', 'review')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'waived', 'rejected')),
      binding_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (item_id, gate_kind),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS item_waivers (
      item_id TEXT NOT NULL,
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('start', 'review', 'both')),
      mode TEXT NOT NULL CHECK (mode IN ('sticky', 'time', 'count')),
      expires_at TEXT,
      remaining_uses INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (item_id, gate_kind),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope_kind, scope_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_item_gates_open ON item_gates(item_id, gate_kind) WHERE state IN ('pending', 'approved', 'waived');
    CREATE VIEW IF NOT EXISTS gates AS
      SELECT 'item' AS target_kind, item_id AS target_id, gate_kind, state, binding_json, updated_at FROM item_gates;
    CREATE VIEW IF NOT EXISTS waivers AS
      SELECT 'item' AS scope_kind, item_id AS scope_id, gate_kind, mode, expires_at, remaining_uses, updated_at FROM item_waivers;
  `);
}

function insertEventRow(event) {
  const payload = event.payload === undefined ? {} : event.payload;
  const result = db.prepare(`
    INSERT INTO events (actor, scope_kind, scope_id, kind, payload, correlation_id, origin_host)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.actor || "backlog",
    event.scopeKind,
    event.scopeId,
    event.kind,
    JSON.stringify(payload),
    event.correlationId || null,
    event.originHost || hostname(),
  );
  return result.lastInsertRowid;
}

export function appendEvent(event) {
  return insertEventRow(event);
}

export function writeWithEvent(mutator, event) {
  return tx(() => {
    const result = mutator(db);
    const eventId = insertEventRow(event);
    return { result, eventId };
  });
}

export function setItemGate({ itemId, gateKind, state, binding = {}, actor = "backlog", correlationId = null }) {
  return writeWithEvent((database) => {
    database.prepare(`
      INSERT INTO item_gates (item_id, gate_kind, state, binding_json, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_id, gate_kind) DO UPDATE SET
        state = excluded.state,
        binding_json = excluded.binding_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(itemId, gateKind, state, JSON.stringify(binding));
  }, {
    actor,
    scopeKind: "item",
    scopeId: itemId,
    kind: "item_gate_set",
    payload: { gateKind, state, binding },
    correlationId,
  });
}

export function setItemWaiver({ itemId, gateKind, mode, expiresAt = null, remainingUses = null, actor = "backlog", correlationId = null }) {
  return writeWithEvent((database) => {
    database.prepare(`
      INSERT INTO item_waivers (item_id, gate_kind, mode, expires_at, remaining_uses, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_id, gate_kind) DO UPDATE SET
        mode = excluded.mode,
        expires_at = excluded.expires_at,
        remaining_uses = excluded.remaining_uses,
        updated_at = CURRENT_TIMESTAMP
    `).run(itemId, gateKind, mode, expiresAt, remainingUses);
  }, {
    actor,
    scopeKind: "item",
    scopeId: itemId,
    kind: "item_waiver_set",
    payload: { gateKind, mode, expiresAt, remainingUses },
    correlationId,
  });
}

function replayEvent(event) {
  const payload = JSON.parse(event.payload || "{}");
  if (event.kind === "item_gate_set") {
    db.prepare(`
      INSERT INTO item_gates (item_id, gate_kind, state, binding_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_id, gate_kind) DO UPDATE SET
        state = excluded.state,
        binding_json = excluded.binding_json,
        updated_at = excluded.updated_at
    `).run(event.scope_id, payload.gateKind, payload.state, JSON.stringify(payload.binding || {}), event.ts);
  } else if (event.kind === "item_lease_set") {
    db.prepare(`
      INSERT INTO item_leases (item_id, lease_id, owner_session, repo_root, worktree_path, heartbeat_at, expires_at, status, needs_recovery, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        lease_id = excluded.lease_id,
        owner_session = excluded.owner_session,
        repo_root = excluded.repo_root,
        worktree_path = excluded.worktree_path,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at,
        status = excluded.status,
        needs_recovery = excluded.needs_recovery,
        updated_at = excluded.updated_at
    `).run(event.scope_id, payload.leaseId, payload.ownerSession, payload.repoRoot, payload.worktreePath || null, payload.heartbeatAt, payload.expiresAt, payload.status || "active", payload.needsRecovery ? 1 : 0, event.ts);
  } else if (event.kind === "item_waiver_set") {
    db.prepare(`
      INSERT INTO item_waivers (item_id, gate_kind, mode, expires_at, remaining_uses, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, gate_kind) DO UPDATE SET
        mode = excluded.mode,
        expires_at = excluded.expires_at,
        remaining_uses = excluded.remaining_uses,
        updated_at = excluded.updated_at
    `).run(event.scope_id, payload.gateKind, payload.mode, payload.expiresAt || null, payload.remainingUses ?? null, event.ts);
  }
}

export function rebuildProjectionsFromEvents() {
  return tx(() => {
    db.exec(`
      DELETE FROM item_gates;
      DELETE FROM item_waivers;
      DELETE FROM item_leases;
    `);
    const events = db.prepare("SELECT * FROM events ORDER BY id").all();
    for (const event of events) replayEvent(event);
    return events.length;
  });
}

// Run a function inside an immediate transaction so multi-statement
// read-modify-write sequences are atomic across processes (WAL alone
// doesn't serialize logically related statements). Retries once on
// SQLITE_BUSY since busy_timeout already covers most contention.
export function tx(fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    } catch (e) {
      if (attempt === 0 && /busy|locked/i.test(e.message)) continue;
      throw e;
    }
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  ).run(key, String(value));
}

export function deleteItemDependentsByIds(itemIds) {
  if (!itemIds.length) return;
  const placeholders = itemIds.map(() => "?").join(", ");
  db.prepare(`DELETE FROM item_gates WHERE item_id IN (${placeholders})`).run(...itemIds);
  db.prepare(`DELETE FROM item_waivers WHERE item_id IN (${placeholders})`).run(...itemIds);
  db.prepare(`DELETE FROM item_pors WHERE item_id IN (${placeholders})`).run(...itemIds);
  db.prepare(`DELETE FROM item_attachments WHERE item_id IN (${placeholders})`).run(...itemIds);
  db.prepare(`DELETE FROM item_isolation_units WHERE item_id IN (${placeholders})`).run(...itemIds);
  db.prepare(`DELETE FROM item_leases WHERE item_id IN (${placeholders})`).run(...itemIds);
}

function queueBindingRowToObject(row) {
  return {
    id: row.id,
    queueId: row.queue_id,
    scope: row.scope,
    preferred: !!row.preferred,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function bindQueueScope(queueOrId, scope, { preferred = false } = {}) {
  if (!queueOrId) throw new Error("queue is required");
  if (!scope) throw new Error("scope is required");
  const queueId = typeof queueOrId === "string" ? queueOrId : queueOrId?.id;
  if (!queueId) throw new Error("queue is required");
  const normalizedScope = resolve(String(scope));
  const existing = db.prepare("SELECT * FROM queue_bindings WHERE queue_id = ? AND scope = ?").get(queueId, normalizedScope);
  if (existing) {
    db.prepare(`
      UPDATE queue_bindings
      SET preferred = ?, updated_at = CURRENT_TIMESTAMP
      WHERE queue_id = ? AND scope = ?
    `).run(preferred ? 1 : 0, queueId, normalizedScope);
    return queueBindingRowToObject(db.prepare("SELECT * FROM queue_bindings WHERE queue_id = ? AND scope = ?").get(queueId, normalizedScope));
  }
  const result = db.prepare(`
    INSERT INTO queue_bindings (queue_id, scope, preferred, created_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(queueId, normalizedScope, preferred ? 1 : 0);
  return queueBindingRowToObject(db.prepare("SELECT * FROM queue_bindings WHERE id = ?").get(result.lastInsertRowid));
}

export function listQueueScopes(queueOrId) {
  if (!queueOrId) return [];
  const queueId = typeof queueOrId === "string" ? queueOrId : queueOrId?.id;
  if (!queueId) return [];
  return db.prepare("SELECT * FROM queue_bindings WHERE queue_id = ? ORDER BY preferred DESC, scope ASC").all(queueId).map(queueBindingRowToObject);
}

export function removeQueueScope(queueOrId, scope) {
  if (!queueOrId) throw new Error("queue is required");
  if (!scope) throw new Error("scope is required");
  const queueId = typeof queueOrId === "string" ? queueOrId : queueOrId?.id;
  if (!queueId) throw new Error("queue is required");
  const normalizedScope = resolve(String(scope));
  const existing = db.prepare("SELECT * FROM queue_bindings WHERE queue_id = ? AND scope = ?").get(queueId, normalizedScope);
  if (!existing) return null;
  db.prepare("DELETE FROM queue_bindings WHERE queue_id = ? AND scope = ?").run(queueId, normalizedScope);
  return queueBindingRowToObject(existing);
}

function queueRowToObject(row) {
  return {
    ...row,
    metadata: row.metadata_json ? parseMetadataJson(row.metadata_json) : {},
    bindings: listQueueScopes(row.id),
  };
}

export function createQueue({ id, name, description = null, metadata = {} } = {}) {
  const queueId = id || `queue-${Date.now()}`;
  const existing = getQueue(queueId);
  if (existing) return existing;
  db.prepare(`
    INSERT INTO queues (id, name, description, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(queueId, name || queueId, description, JSON.stringify(metadata || {}));
  return getQueue(queueId);
}

export function ensureQueue(queueId, { name = null, description = null, metadata = undefined } = {}) {
  if (!queueId) throw new Error("queue id is required");
  const existing = getQueue(queueId);
  if (existing) {
    if (name !== null || description !== null || metadata !== undefined) {
      updateQueue(queueId, { name, description, metadata });
    }
    return existing;
  }
  return createQueue({ id: queueId, name: name || queueId, description, metadata: metadata ?? {} });
}

export function getQueue(queueId) {
  if (!queueId) return null;
  const row = db.prepare("SELECT * FROM queues WHERE id = ?").get(queueId);
  return row ? queueRowToObject(row) : null;
}

export function listQueues() {
  return db.prepare("SELECT * FROM queues ORDER BY name, created_at").all().map(queueRowToObject);
}

export function listQueueSummaries() {
  return db.prepare(`
    SELECT
      q.*,
      COALESCE(counts.item_count, 0) AS item_count,
      COALESCE(counts.item_counts_json, '{}') AS item_counts_json
    FROM queues q
    LEFT JOIN (
      SELECT
        queue_id,
        SUM(status_count) AS item_count,
        json_group_object(status, status_count) AS item_counts_json
      FROM (
        SELECT queue_id, COALESCE(status, 'unknown') AS status, COUNT(*) AS status_count
        FROM items
        WHERE queue_id IS NOT NULL
        GROUP BY queue_id, COALESCE(status, 'unknown')
      )
      GROUP BY queue_id
    ) counts ON counts.queue_id = q.id
    ORDER BY q.name, q.created_at
  `).all().map((row) => {
    const { item_count, item_counts_json, ...queueRow } = row;
    return {
      ...queueRowToObject(queueRow),
      itemCount: item_count,
      itemCounts: JSON.parse(item_counts_json),
    };
  });
}

export function updateQueue(queueId, { name = undefined, description = undefined, metadata = undefined } = {}) {
  const updates = [];
  const params = [];
  if (name !== undefined) {
    updates.push("name = ?");
    params.push(name);
  }
  if (description !== undefined) {
    updates.push("description = ?");
    params.push(description);
  }
  if (metadata !== undefined) {
    updates.push("metadata_json = ?");
    params.push(JSON.stringify(metadata || {}));
  }
  if (!updates.length) return getQueue(queueId);
  updates.push("updated_at = CURRENT_TIMESTAMP");
  params.push(queueId);
  db.prepare(`UPDATE queues SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  return getQueue(queueId);
}

function ensureQueueSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS item_pors (
      item_id TEXT PRIMARY KEY,
      por_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'por',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS item_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('path', 'note')),
      ref TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS item_isolation_units (
      item_id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      path TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('soda', 'git')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS item_leases (
      item_id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL,
      owner_session TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      worktree_path TEXT,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      needs_recovery INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS queue_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      preferred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (queue_id) REFERENCES queues(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_bindings_unique_queue_scope ON queue_bindings(queue_id, scope);
    CREATE INDEX IF NOT EXISTS idx_items_queue_status_position ON items(queue_id, status, position);
    CREATE INDEX IF NOT EXISTS idx_queue_bindings_queue_scope ON queue_bindings(queue_id, scope);
    CREATE INDEX IF NOT EXISTS idx_queue_bindings_scope ON queue_bindings(scope, preferred);
    CREATE INDEX IF NOT EXISTS idx_item_pors_item ON item_pors(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_attachments_item ON item_attachments(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_isolation_units_item ON item_isolation_units(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_leases_item ON item_leases(item_id);
  `);
  addColumnIfMissing("queues", "description", "TEXT");
  addColumnIfMissing("queues", "metadata_json", "TEXT DEFAULT '{}'" );
  addColumnIfMissing("items", "queue_id", "TEXT");
  addColumnIfMissing("items", "por_json", "TEXT");
  bumpUserVersionAtLeast(3);
}

export function attachItemPorContext(input, maybeMetadata = {}) {
  let itemId;
  let porId = null;
  let kind = "por";
  let metadata = {};
  if (typeof input === "object" && input !== null) {
    itemId = input.itemId ?? input.item_id ?? input.id;
    porId = input.porId ?? input.por_id ?? input.ref ?? null;
    kind = input.kind ?? "por";
    metadata = input.metadata ?? {};
  } else {
    itemId = input;
    if (typeof maybeMetadata === "string") {
      porId = maybeMetadata;
    } else {
      porId = maybeMetadata.porId ?? maybeMetadata.por_id ?? maybeMetadata.ref ?? null;
      kind = maybeMetadata.kind ?? "por";
      metadata = maybeMetadata.metadata ?? maybeMetadata ?? {};
    }
  }
  if (!itemId) return null;
  const resolvedPorId = porId || `por-${itemId}`;
  db.prepare(`
    INSERT INTO item_pors (item_id, por_id, kind, meta_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(item_id) DO UPDATE SET
      por_id = excluded.por_id,
      kind = excluded.kind,
      meta_json = excluded.meta_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(itemId, resolvedPorId, kind, JSON.stringify(metadata || {}));
  return getItemPorContext(itemId);
}

export function getItemPorContext(itemId) {
  if (!itemId) return null;
  const row = db.prepare("SELECT * FROM item_pors WHERE item_id = ?").get(itemId);
  if (!row) return null;
  return {
    ...row,
    metadata: row.meta_json ? parseMetadataJson(row.meta_json) : {},
  };
}

export function removeItemPorContext(itemId) {
  if (!itemId) return null;
  const context = getItemPorContext(itemId);
  db.prepare("DELETE FROM item_pors WHERE item_id = ?").run(itemId);
  return context;
}

export function setItemLease({ itemId, leaseId, ownerSession, repoRoot, worktreePath = null, heartbeatAt, expiresAt, status = "active", needsRecovery = false, actor = "backlog", correlationId = null }) {
  return writeWithEvent((database) => {
    database.prepare(`
      INSERT INTO item_leases (item_id, lease_id, owner_session, repo_root, worktree_path, heartbeat_at, expires_at, status, needs_recovery, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_id) DO UPDATE SET
        lease_id = excluded.lease_id,
        owner_session = excluded.owner_session,
        repo_root = excluded.repo_root,
        worktree_path = excluded.worktree_path,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at,
        status = excluded.status,
        needs_recovery = excluded.needs_recovery,
        updated_at = CURRENT_TIMESTAMP
    `).run(itemId, leaseId, ownerSession, repoRoot, worktreePath, heartbeatAt, expiresAt, status, needsRecovery ? 1 : 0);
  }, {
    actor,
    scopeKind: "item",
    scopeId: itemId,
    kind: "item_lease_set",
    payload: { leaseId, ownerSession, repoRoot, worktreePath, heartbeatAt, expiresAt, status, needsRecovery: !!needsRecovery },
    correlationId,
  });
}

export function getItemLease(itemId) {
  const row = db.prepare("SELECT * FROM item_leases WHERE item_id = ?").get(itemId);
  return row || null;
}
