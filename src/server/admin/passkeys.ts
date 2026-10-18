// Web admin state in SQLite: passkeys, single-use enrollment codes, WebAuthn challenges
// and sessions. Shared by the admin plugin and the server CLI.

import { randomNonce, sha256hex } from "../../protocol/crypto.ts";
import { nowIso, type Db } from "../db.ts";

export const CHALLENGE_TTL_MS = 5 * 60_000;

export interface Passkey {
  id: string;
  name: string;
  public_key: Uint8Array;
  counter: number;
  transports: string[];
  created_at: string;
  last_used_at: string | null;
}

type PasskeyRow = Omit<Passkey, "transports"> & { transports: string };

const toPasskey = (r: PasskeyRow): Passkey => ({ ...r, public_key: new Uint8Array(r.public_key), transports: JSON.parse(r.transports) as string[] });

/** A single-use code for the enrollment link. Only its hash is stored. */
export function createEnrollCode(db: Db, minutes: number, now = Date.now()): { code: string; expiresAt: number } {
  const code = randomNonce(24);
  const expiresAt = now + minutes * 60_000;
  db.prepare("INSERT INTO admin_enroll_codes (code_hash, expires_at) VALUES (?, ?)").run(sha256hex(code), expiresAt);
  return { code, expiresAt };
}

/** The code's hash if it is unused and unexpired. */
export function checkEnrollCode(db: Db, code: string, now = Date.now()): string | undefined {
  if (!code) return undefined;
  const hash = sha256hex(code);
  const row = db.prepare("SELECT 1 FROM admin_enroll_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(hash, now);
  return row ? hash : undefined;
}

/** Burns the code; false if it was already used or has expired. */
export function useEnrollCode(db: Db, codeHash: string, now = Date.now()): boolean {
  return (
    db.prepare("UPDATE admin_enroll_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").run(nowIso(now), codeHash, now).changes === 1
  );
}

export function saveChallenge(db: Db, challenge: string, purpose: "enroll" | "login", codeHash: string | null = null, now = Date.now()): void {
  db.prepare("INSERT INTO admin_challenges (challenge, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?)").run(challenge, purpose, codeHash, now + CHALLENGE_TTL_MS);
}

/** Deletes the challenge and reports whether it was live and issued for this purpose (and code). */
export function takeChallenge(db: Db, challenge: string, purpose: "enroll" | "login", codeHash: string | null = null, now = Date.now()): boolean {
  const row = db.prepare("DELETE FROM admin_challenges WHERE challenge = ? RETURNING purpose, code_hash, expires_at").get(challenge) as
    | { purpose: string; code_hash: string | null; expires_at: number }
    | undefined;
  return !!row && row.purpose === purpose && row.code_hash === codeHash && row.expires_at > now;
}

export function listPasskeys(db: Db): Passkey[] {
  return (db.prepare("SELECT * FROM admin_passkeys ORDER BY created_at").all() as unknown as PasskeyRow[]).map(toPasskey);
}

export function getPasskey(db: Db, id: string): Passkey | undefined {
  const row = db.prepare("SELECT * FROM admin_passkeys WHERE id = ?").get(id) as PasskeyRow | undefined;
  return row && toPasskey(row);
}

export function addPasskey(db: Db, p: { id: string; name: string; publicKey: Uint8Array; counter: number; transports: string[] }): void {
  db.prepare("INSERT INTO admin_passkeys (id, name, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    p.id,
    p.name,
    p.publicKey,
    p.counter,
    JSON.stringify(p.transports),
    nowIso(),
  );
}

export function touchPasskey(db: Db, id: string, counter: number): void {
  db.prepare("UPDATE admin_passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, nowIso(), id);
}

/** Removes a passkey by ID, or by name when exactly one has it, and ends its sessions. */
export function removePasskey(db: Db, idOrName: string): number {
  let ids = (db.prepare("SELECT id FROM admin_passkeys WHERE id = ?").all(idOrName) as { id: string }[]).map((r) => r.id);
  if (!ids.length) {
    ids = (db.prepare("SELECT id FROM admin_passkeys WHERE name = ?").all(idOrName) as { id: string }[]).map((r) => r.id);
    if (ids.length > 1) throw new Error(`${ids.length} passkeys are named ${idOrName}; use the ID`);
  }
  for (const id of ids) {
    db.prepare("DELETE FROM admin_sessions WHERE passkey_id = ?").run(id);
    db.prepare("DELETE FROM admin_passkeys WHERE id = ?").run(id);
  }
  return ids.length;
}

export function purgeAdmin(db: Db, now = Date.now()): void {
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM admin_challenges WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM admin_enroll_codes WHERE expires_at <= ?").run(now - 86_400_000);
}
