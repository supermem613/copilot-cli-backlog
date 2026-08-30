import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { generateId, addItem } from "../items.mjs";
import { createQueue } from "../db.mjs";

// ID generation must:
//  - lowercase + slugify
//  - drop punctuation
//  - clamp to 50 chars
//  - dedupe with a numeric suffix when the base collides

const a = generateId("Hello, World!");
assertEqual(a, "hello-world", "slugifies basic input");

const queueId = "id-generation-queue";
createQueue({ id: queueId, name: "ID Generation" });

addItem("Hello, World!", false, queueId); // claims "hello-world"

const b = generateId("Hello, World!");
assertEqual(b, "hello-world-2", "appends -2 on first collision");

addItem("Hello, World!", false, queueId); // claims "hello-world-2"

const c = generateId("Hello, World!");
assertEqual(c, "hello-world-3", "appends -3 on second collision");

const d = generateId("a".repeat(100));
assert(d.length <= 50, "clamps long ids to 50 chars");

const longTitle = "POR-GATED Grease triage 2026-08-26: Stale/ambiguous edit and apply_patch preimage recurrence";
const longId = generateId(longTitle);
assert(longId.length <= 50, "long title ids stay within the 50-char clamp");
assert(!longId.endsWith("-"), "long title ids do not end with a hyphen after the clamp");

const haltA = "POR-GATED Grease triage 2026-08-26 HALT follow-up: Skillify script-template.js redaction corrupts template JS";
const haltB = "POR-GATED Grease triage 2026-08-26 HALT follow-up: ADE tenant ranking KQL times out at 30-day window";
const haltAAdd = addItem(haltA, false, queueId);
const haltBId = generateId(haltB);
assert(!haltBId.includes("--"), "collision suffix does not stack onto a trailing hyphen");
assert(haltBId !== haltAAdd.id, "two long titles that share a prefix still get distinct ids");

done("test-id-generation");
