import { EventEmitter } from "node:events";
import { signEvent, type SignedEvent, type Trust } from "../protocol/messages.ts";
import { ulid } from "../protocol/ids.ts";
import type { Identity } from "../protocol/crypto.ts";
import { nowIso, type Db } from "./db.ts";

interface EventRow {
  seq: number;
  id: string;
  kind: string;
  created_at: string;
  source: string;
  trust: Trust;
  payload: string;
  sig: string;
}

function toEvent(row: EventRow): SignedEvent {
  return {
    seq: row.seq,
    id: row.id,
    kind: row.kind,
    created_at: row.created_at,
    source: row.source,
    trust: row.trust,
    payload: JSON.parse(row.payload),
    sig: row.sig,
  };
}

export interface AppendInput {
  kind: string;
  source: string;
  trust: Trust;
  payload: unknown;
  dedupeKey?: string;
}

/** Durable, append-only event log. Emits "appended" after each successful append. */
export class EventStore extends EventEmitter<{ appended: [SignedEvent] }> {
  private readonly db: Db;
  private readonly identity: Identity;

  constructor(db: Db, identity: Identity) {
    super();
    this.db = db;
    this.identity = identity;
  }

  /** Appends and signs an event. Returns the existing event if `dedupeKey` was already used. */
  append(input: AppendInput): { event: SignedEvent; duplicate: boolean } {
    if (input.dedupeKey) {
      const existing = this.db.prepare("SELECT * FROM events WHERE dedupe_key = ?").get(input.dedupeKey) as EventRow | undefined;
      if (existing) return { event: toEvent(existing), duplicate: true };
    }
    // The seq is assigned by SQLite, but it's part of the signed body, so insert,
    // read back the seq, then sign and store the signature in one transaction.
    const id = "evt_" + ulid();
    const createdAt = nowIso();
    const payloadJson = JSON.stringify(input.payload ?? null);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const res = this.db
        .prepare("INSERT INTO events (id, kind, created_at, source, trust, payload, sig, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, '', ?)")
        .run(id, input.kind, createdAt, input.source, input.trust, payloadJson, input.dedupeKey ?? null);
      const seq = Number(res.lastInsertRowid);
      const event = signEvent(this.identity, {
        seq,
        id,
        kind: input.kind,
        created_at: createdAt,
        source: input.source,
        trust: input.trust,
        payload: JSON.parse(payloadJson),
      });
      this.db.prepare("UPDATE events SET sig = ? WHERE seq = ?").run(event.sig, seq);
      this.db.exec("COMMIT");
      this.emit("appended", event);
      return { event, duplicate: false };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listAfter(afterSeq: number, limit = 100): SignedEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE seq > ? AND sig != '' ORDER BY seq LIMIT ?").all(afterSeq, limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  get(id: string): SignedEvent | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
    return row && toEvent(row);
  }

  lastSeq(): number {
    // sqlite_sequence survives purges, unlike MAX(seq).
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  /** Cumulative ack. Never moves a cursor backwards, and never past the last real event. */
  ack(keyId: string, seq: number): number {
    const capped = Math.min(Math.max(0, Math.floor(seq)), this.lastSeq());
    this.db
      .prepare(
        "INSERT INTO cursors (key_id, acked_seq, updated_at) VALUES (?, ?, ?) ON CONFLICT(key_id) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq), updated_at = excluded.updated_at",
      )
      .run(keyId, capped, nowIso());
    return this.cursor(keyId);
  }

  cursor(keyId: string): number {
    const row = this.db.prepare("SELECT acked_seq FROM cursors WHERE key_id = ?").get(keyId) as { acked_seq: number } | undefined;
    return row?.acked_seq ?? 0;
  }

  /**
   * Deletes events that every active client has acked and that are older than
   * `retentionDays`, plus anything older than `unackedRetentionDays` regardless.
   */
  purge(retentionDays: number, unackedRetentionDays: number, now = Date.now()): number {
    const cutoff = nowIso(now - retentionDays * 86_400_000);
    const hardCutoff = nowIso(now - unackedRetentionDays * 86_400_000);
    const minAck = this.db
      .prepare(
        "SELECT MIN(COALESCE(c.acked_seq, 0)) AS m FROM keys k LEFT JOIN cursors c ON c.key_id = k.key_id WHERE k.role = 'client' AND k.revoked_at IS NULL",
      )
      .get() as { m: number | null };
    const acked = minAck.m ?? Number.MAX_SAFE_INTEGER;
    const a = this.db.prepare("DELETE FROM events WHERE created_at < ? AND seq <= ?").run(cutoff, acked);
    const b = this.db.prepare("DELETE FROM events WHERE created_at < ?").run(hardCutoff);
    return Number(a.changes) + Number(b.changes);
  }
}
