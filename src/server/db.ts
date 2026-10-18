import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  key_id      TEXT PRIMARY KEY,          -- fingerprint
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('client', 'publisher')),
  public_key  TEXT NOT NULL,             -- raw Ed25519, base64url
  scopes      TEXT NOT NULL,             -- JSON array
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS keys_role_name ON keys(role, name) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash   TEXT PRIMARY KEY,          -- sha256 hex of the code; also the HMAC key for the pairing proof
  name        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  source      TEXT NOT NULL,
  trust       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  sig         TEXT NOT NULL,
  dedupe_key  TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS cursors (
  key_id      TEXT PRIMARY KEY,
  acked_seq   INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  key_id      TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (key_id, nonce)
);

CREATE TABLE IF NOT EXISTS aliases (
  local_part  TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS alias_counts (
  local_part  TEXT NOT NULL,
  day         TEXT NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (local_part, day)
);

CREATE TABLE IF NOT EXISTS connector_cache (
  cache_key   TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_files (
  event_id    TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_passkeys (
  id            TEXT PRIMARY KEY,        -- WebAuthn credential ID, base64url
  name          TEXT NOT NULL,
  public_key    BLOB NOT NULL,           -- COSE public key
  counter       INTEGER NOT NULL,
  transports    TEXT NOT NULL,           -- JSON array
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

CREATE TABLE IF NOT EXISTS admin_enroll_codes (
  code_hash   TEXT PRIMARY KEY,          -- sha256 hex of the code in the enrollment link
  expires_at  INTEGER NOT NULL,
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS admin_challenges (
  challenge   TEXT PRIMARY KEY,          -- base64url, single use
  purpose     TEXT NOT NULL CHECK (purpose IN ('enroll', 'login')),
  code_hash   TEXT,                      -- enrollment code it was issued for
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  TEXT PRIMARY KEY,          -- sha256 hex of the cookie value
  passkey_id  TEXT NOT NULL,
  csrf        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}
