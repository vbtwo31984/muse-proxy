// Wire format and the exact strings each side signs. Every signed string starts
// with a distinct "muse-proxy/v1/<purpose>|" prefix so a signature made for one
// purpose can never be replayed as another.

import { canonicalize } from "./canonical.ts";
import { hmacSha256b64, sha256hex, signString, verifyString, type Identity } from "./crypto.ts";
import type { KeyObject } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_CLOCK_SKEW_MS = 60_000;
export const NONCE_TTL_MS = 5 * 60_000;

export const HEADER_KEY = "x-mp-key";
export const HEADER_TIMESTAMP = "x-mp-timestamp";
export const HEADER_NONCE = "x-mp-nonce";
export const HEADER_SIGNATURE = "x-mp-signature";
export const HEADER_SERVER_SIGNATURE = "x-mp-server-signature";

export type Trust = "untrusted" | "owner";

export interface EventBody {
  seq: number;
  id: string;
  kind: string;
  created_at: string;
  source: string;
  trust: Trust;
  payload: unknown;
}

export interface SignedEvent extends EventBody {
  sig: string;
}

// --- WebSocket frames -------------------------------------------------------

export interface HelloFrame {
  t: "hello";
  v: number;
  server_nonce: string;
  server_time: number;
}
export interface AuthFrame {
  t: "auth";
  key_id: string;
  client_nonce: string;
  ts: number;
  resume_after: number;
  sig: string;
}
export interface AuthOkFrame {
  t: "auth_ok";
  session_id: string;
  sig: string;
}
export interface EventFrame extends SignedEvent {
  t: "event";
}
export interface AckFrame {
  t: "ack";
  seq: number;
}
export interface PingFrame {
  t: "ping";
}
export interface PongFrame {
  t: "pong";
}
export interface ReqFrame {
  t: "req";
  id: string;
  method: string;
  params: unknown;
}
export interface ResFrame {
  t: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  sig: string;
}
export interface ErrorFrame {
  t: "error";
  code: string;
}

export type ServerFrame = HelloFrame | AuthOkFrame | EventFrame | PongFrame | ResFrame | ErrorFrame;
export type ClientFrame = AuthFrame | AckFrame | PingFrame | ReqFrame;

// --- Signing strings --------------------------------------------------------

export function clientAuthString(domain: string, serverNonce: string, clientNonce: string, ts: number): string {
  return `muse-proxy/v1/client-auth|${domain}|${serverNonce}|${clientNonce}|${ts}`;
}

export function serverAuthString(domain: string, clientNonce: string, serverNonce: string, sessionId: string): string {
  return `muse-proxy/v1/server-auth|${domain}|${clientNonce}|${serverNonce}|${sessionId}`;
}

export function requestString(
  method: string,
  domain: string,
  pathAndQuery: string,
  ts: number,
  nonce: string,
  body: Uint8Array | string,
): string {
  return `muse-proxy/v1/req|${method.toUpperCase()}|${domain}|${pathAndQuery}|${ts}|${nonce}|${sha256hex(body)}`;
}

export function responseString(status: number, body: Uint8Array | string, requestNonce: string): string {
  return `muse-proxy/v1/res|${status}|${sha256hex(body)}|${requestNonce}`;
}

export function rpcResultString(reqId: string, ok: boolean, resultOrError: unknown): string {
  return `muse-proxy/v1/rpc-res|${reqId}|${ok ? 1 : 0}|${sha256hex(canonicalize(resultOrError ?? null))}`;
}

/** The proof is keyed on sha256(code) so the server only ever stores the hash. */
export function pairProofFromHash(codeHash: string, clientPublicKey: string, name: string): string {
  return hmacSha256b64(codeHash, `muse-proxy/v1/pair|${clientPublicKey}|${name}`);
}

export function pairProof(pairingCode: string, clientPublicKey: string, name: string): string {
  return pairProofFromHash(sha256hex(pairingCode), clientPublicKey, name);
}

export function pairOkString(domain: string, clientPublicKey: string, name: string): string {
  return `muse-proxy/v1/pair-ok|${domain}|${clientPublicKey}|${name}`;
}

export function helperBundleString(sha256: string, version: string): string {
  return `muse-proxy/v1/helper-bundle|${version}|${sha256}`;
}

// --- Events -----------------------------------------------------------------

function eventSigningString(body: EventBody): string {
  const { seq, id, kind, created_at, source, trust, payload } = body;
  return "muse-proxy/v1/event|" + canonicalize({ seq, id, kind, created_at, source, trust, payload });
}

export function signEvent(identity: Identity, body: EventBody): SignedEvent {
  return { ...body, sig: signString(identity, eventSigningString(body)) };
}

export function verifyEvent(serverPublicKey: KeyObject | string, event: SignedEvent): boolean {
  return verifyString(serverPublicKey, eventSigningString(event), event.sig);
}

// --- Client-side request signing -------------------------------------------

export function signedRequestHeaders(
  identity: Identity,
  method: string,
  domain: string,
  pathAndQuery: string,
  body: string,
  nonce: string,
  now = Date.now(),
): Record<string, string> {
  return {
    [HEADER_KEY]: identity.fingerprint,
    [HEADER_TIMESTAMP]: String(now),
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: signString(identity, requestString(method, domain, pathAndQuery, now, nonce, body)),
  };
}
