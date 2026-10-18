import { publicKeyFromB64, verifyString } from "../protocol/crypto.ts";
import {
  HEADER_KEY,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  MAX_CLOCK_SKEW_MS,
  NONCE_TTL_MS,
  requestString,
} from "../protocol/messages.ts";
import type { Db } from "./db.ts";
import { getActiveKey, hasScope, useNonce, type KeyRecord } from "./store.ts";

export type AuthResult = { ok: true; key: KeyRecord; nonce: string } | { ok: false; status: 401 | 403; code: string };

export interface SignedRequest {
  method: string;
  pathAndQuery: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Uint8Array | string;
}

function header(headers: SignedRequest["headers"], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Verifies an X-MP-* signed request. Failures deliberately return one generic
 * code so callers learn nothing about which check failed.
 */
export function verifySignedRequest(db: Db, domain: string, req: SignedRequest, requiredScope: string, now = Date.now()): AuthResult {
  const fail: AuthResult = { ok: false, status: 401, code: "auth_failed" };
  const keyId = header(req.headers, HEADER_KEY);
  const tsRaw = header(req.headers, HEADER_TIMESTAMP);
  const nonce = header(req.headers, HEADER_NONCE);
  const sig = header(req.headers, HEADER_SIGNATURE);
  if (!keyId || !tsRaw || !nonce || !sig) return fail;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return fail;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return fail;
  const key = getActiveKey(db, keyId);
  if (!key) return fail;
  const message = requestString(req.method, domain, req.pathAndQuery, ts, nonce, req.rawBody);
  if (!verifyString(publicKeyFromB64(key.public_key), message, sig)) return fail;
  // Only record the nonce after the signature checks out, so garbage can't fill the table.
  if (!useNonce(db, key.key_id, nonce, NONCE_TTL_MS + MAX_CLOCK_SKEW_MS, now)) return fail;
  if (!hasScope(key, requiredScope)) return { ok: false, status: 403, code: "forbidden" };
  return { ok: true, key, nonce };
}
