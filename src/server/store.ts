// Key registry, pairing codes, aliases and nonces. Thin wrappers over SQLite so
// the CLI, HTTP layer and SMTP layer share one set of rules.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprintOf, generateIdentity, identityFromPem, privateKeyPem, publicKeyFromB64, sha256hex, type Identity } from "../protocol/crypto.ts";
import { randomBase32 } from "../protocol/ids.ts";
import { nowIso, type Db } from "./db.ts";

export type Role = "client" | "publisher";

export interface KeyRecord {
  key_id: string;
  name: string;
  role: Role;
  public_key: string;
  scopes: string[];
  created_at: string;
  revoked_at: string | null;
}

export const DEFAULT_CLIENT_SCOPES = ["stream", "poll", "ack", "rpc:*"];
export const DEFAULT_PUBLISHER_SCOPES = ["publish"];
export const PAIRING_TTL_MS = 15 * 60_000;

// --- Server identity ---------------------------------------------------------

export function loadOrCreateServerIdentity(path: string): Identity {
  if (existsSync(path)) return identityFromPem(readFileSync(path, "utf8"));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const identity = generateIdentity();
  writeFileSync(path, privateKeyPem(identity), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return identity;
}

// --- Keys --------------------------------------------------------------------

interface KeyRow {
  key_id: string;
  name: string;
  role: Role;
  public_key: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}

function toRecord(row: KeyRow): KeyRecord {
  return { ...row, scopes: JSON.parse(row.scopes) as string[] };
}

export function addKey(db: Db, name: string, role: Role, publicKeyB64: string, scopes?: string[]): KeyRecord {
  publicKeyFromB64(publicKeyB64); // validates
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error("name must be lowercase letters, digits and dashes (max 41 chars)");
  const record: KeyRecord = {
    key_id: fingerprintOf(publicKeyB64),
    name,
    role,
    public_key: publicKeyB64,
    scopes: scopes ?? (role === "client" ? DEFAULT_CLIENT_SCOPES : DEFAULT_PUBLISHER_SCOPES),
    created_at: nowIso(),
    revoked_at: null,
  };
  db.prepare("INSERT INTO keys (key_id, name, role, public_key, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    record.key_id,
    record.name,
    record.role,
    record.public_key,
    JSON.stringify(record.scopes),
    record.created_at,
  );
  return record;
}

export function getActiveKey(db: Db, keyId: string): KeyRecord | undefined {
  const row = db.prepare("SELECT * FROM keys WHERE key_id = ? AND revoked_at IS NULL").get(keyId) as KeyRow | undefined;
  return row && toRecord(row);
}

export function listKeys(db: Db): KeyRecord[] {
  return (db.prepare("SELECT * FROM keys ORDER BY created_at").all() as unknown as KeyRow[]).map(toRecord);
}

export function revokeKey(db: Db, keyIdOrName: string): number {
  const res = db
    .prepare("UPDATE keys SET revoked_at = ? WHERE revoked_at IS NULL AND (key_id = ? OR name = ?)")
    .run(nowIso(), keyIdOrName, keyIdOrName);
  return Number(res.changes);
}

export function hasScope(key: KeyRecord, scope: string): boolean {
  if (key.scopes.includes(scope)) return true;
  const colon = scope.indexOf(":");
  return colon > 0 && key.scopes.includes(scope.slice(0, colon) + ":*");
}

// --- Pairing -----------------------------------------------------------------

export function createPairingCode(db: Db, name: string, now = Date.now()): { code: string; expiresAt: number } {
  const code = `${randomBase32(6)}-${randomBase32(6)}-${randomBase32(6)}-${randomBase32(6)}-${randomBase32(4)}`; // 140 bits
  const expiresAt = now + PAIRING_TTL_MS;
  db.prepare("INSERT INTO pairing_codes (code_hash, name, expires_at) VALUES (?, ?, ?)").run(sha256hex(code), name, expiresAt);
  return { code, expiresAt };
}

export function activePairingCodes(db: Db, now = Date.now()): { code_hash: string; name: string }[] {
  db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(now);
  return db.prepare("SELECT code_hash, name FROM pairing_codes").all() as { code_hash: string; name: string }[];
}

export function burnPairingCode(db: Db, codeHash: string): void {
  db.prepare("DELETE FROM pairing_codes WHERE code_hash = ?").run(codeHash);
}

// --- Nonces ------------------------------------------------------------------

/** Records a nonce; returns false if it was already seen (replay). */
export function useNonce(db: Db, keyId: string, nonce: string, ttlMs: number, now = Date.now()): boolean {
  const res = db.prepare("INSERT OR IGNORE INTO nonces (key_id, nonce, expires_at) VALUES (?, ?, ?)").run(keyId, nonce, now + ttlMs);
  return Number(res.changes) === 1;
}

export function purgeNonces(db: Db, now = Date.now()): void {
  db.prepare("DELETE FROM nonces WHERE expires_at <= ?").run(now);
}

// --- Aliases -----------------------------------------------------------------

export interface AliasRecord {
  local_part: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

export function addAlias(db: Db, label: string): AliasRecord {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) throw new Error("label must be lowercase letters, digits and dashes (max 31 chars)");
  const prefix = label.slice(0, 8).replace(/-+$/, "");
  const record: AliasRecord = {
    local_part: `${prefix}-${randomBase32(12)}`, // 60 random bits
    label,
    created_at: nowIso(),
    revoked_at: null,
  };
  db.prepare("INSERT INTO aliases (local_part, label, created_at) VALUES (?, ?, ?)").run(record.local_part, record.label, record.created_at);
  return record;
}

export function getActiveAlias(db: Db, localPart: string): AliasRecord | undefined {
  return db.prepare("SELECT * FROM aliases WHERE local_part = ? AND revoked_at IS NULL").get(localPart.toLowerCase()) as
    | AliasRecord
    | undefined;
}

export function listAliases(db: Db): AliasRecord[] {
  return db.prepare("SELECT * FROM aliases ORDER BY created_at").all() as unknown as AliasRecord[];
}

export function revokeAlias(db: Db, localPart: string): number {
  const lp = localPart.split("@")[0]!.toLowerCase();
  return Number(db.prepare("UPDATE aliases SET revoked_at = ? WHERE local_part = ? AND revoked_at IS NULL").run(nowIso(), lp).changes);
}

/** Increments today's count for an alias; returns false if the daily limit is already reached. */
export function takeAliasQuota(db: Db, localPart: string, limit: number, now = Date.now()): boolean {
  const day = nowIso(now).slice(0, 10);
  const row = db.prepare("SELECT count FROM alias_counts WHERE local_part = ? AND day = ?").get(localPart, day) as
    | { count: number }
    | undefined;
  if ((row?.count ?? 0) >= limit) return false;
  db.prepare(
    "INSERT INTO alias_counts (local_part, day, count) VALUES (?, ?, 1) ON CONFLICT(local_part, day) DO UPDATE SET count = count + 1",
  ).run(localPart, day);
  return true;
}
