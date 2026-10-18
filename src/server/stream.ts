// WebSocket session: mutual Ed25519 challenge-response, then at-least-once
// event delivery with cumulative acks, plus RPC over the same socket.

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { publicKeyFromB64, randomNonce, signString, verifyString, type Identity } from "../protocol/crypto.ts";
import {
  clientAuthString,
  MAX_CLOCK_SKEW_MS,
  NONCE_TTL_MS,
  PROTOCOL_VERSION,
  rpcResultString,
  serverAuthString,
  type ClientFrame,
  type ServerFrame,
  type SignedEvent,
} from "../protocol/messages.ts";
import type { Db } from "./db.ts";
import type { EventStore } from "./events.ts";
import type { ConnectorRegistry } from "./connectors/index.ts";
import { RateLimiter } from "./ratelimit.ts";
import { getActiveKey, hasScope, useNonce, type KeyRecord } from "./store.ts";

const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 25_000;
const DEAD_AFTER_MS = 65_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface StreamDeps {
  db: Db;
  domain: string;
  identity: Identity;
  events: EventStore;
  connectors: ConnectorRegistry;
  authFailures: RateLimiter;
}

export class StreamHub {
  private readonly deps: StreamDeps;
  private readonly sessions = new Set<Session>();
  /** Last time any authenticated client was connected (or now, if one is). */
  private lastSeen = Date.now();

  constructor(deps: StreamDeps) {
    this.deps = deps;
  }

  get connectedCount(): number {
    let n = 0;
    for (const s of this.sessions) if (s.key) n++;
    return n;
  }

  /** Milliseconds since the last authenticated client disconnected; 0 if one is connected. */
  disconnectedForMs(now = Date.now()): number {
    return this.connectedCount > 0 ? 0 : now - this.lastSeen;
  }

  handle(socket: WebSocket, ip: string): void {
    if (this.deps.authFailures.blocked(ip)) {
      socket.close(4429, "too many failures");
      return;
    }
    const session = new Session(socket, ip, this.deps, () => {
      this.sessions.delete(session);
      if (session.key) this.lastSeen = Date.now();
    });
    this.sessions.add(session);
  }

  /** Disconnects live sessions of a key (after it was revoked). */
  disconnectKey(keyId: string): void {
    for (const s of this.sessions) if (s.key?.key_id === keyId) s.close(4401, "key revoked");
  }

  closeAll(): void {
    for (const s of this.sessions) s.close(1001, "server shutting down");
  }
}

class Session {
  key: KeyRecord | undefined;
  private readonly socket: WebSocket;
  private readonly ip: string;
  private readonly deps: StreamDeps;
  private readonly serverNonce = randomNonce();
  private lastSent = 0;
  private pumping = false;
  private pumpAgain = false;
  private lastPong = Date.now();
  private readonly authTimer: NodeJS.Timeout;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly onAppended = () => this.pump();

  constructor(socket: WebSocket, ip: string, deps: StreamDeps, onClose: () => void) {
    this.socket = socket;
    this.ip = ip;
    this.deps = deps;
    this.authTimer = setTimeout(() => this.close(4401, "auth timeout"), AUTH_TIMEOUT_MS);
    socket.on("message", (data, isBinary) => {
      if (isBinary) return this.close(4400, "binary frames not supported");
      this.onMessage(data.toString());
    });
    socket.on("pong", () => (this.lastPong = Date.now()));
    socket.on("close", () => {
      clearTimeout(this.authTimer);
      clearInterval(this.heartbeat);
      this.deps.events.off("appended", this.onAppended);
      onClose();
    });
    socket.on("error", () => undefined);
    this.send({ t: "hello", v: PROTOCOL_VERSION, server_nonce: this.serverNonce, server_time: Date.now() });
  }

  close(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  private send(frame: ServerFrame): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private onMessage(text: string): void {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(text) as ClientFrame;
    } catch {
      return this.close(4400, "invalid JSON");
    }
    if (!this.key) {
      if (frame.t !== "auth") return this.close(4401, "auth required");
      return this.authenticate(frame);
    }
    switch (frame.t) {
      case "ack":
        if (typeof frame.seq === "number" && hasScope(this.key, "ack")) this.deps.events.ack(this.key.key_id, frame.seq);
        return;
      case "ping":
        return this.send({ t: "pong" });
      case "req":
        void this.handleRpc(frame.id, frame.method, frame.params);
        return;
      default:
        return this.close(4400, "unexpected frame");
    }
  }

  private authenticate(frame: Extract<ClientFrame, { t: "auth" }>): void {
    const fail = () => {
      this.deps.authFailures.hit(this.ip);
      this.send({ t: "error", code: "auth_failed" });
      this.close(4401, "auth failed");
    };
    const { key_id, client_nonce, ts, sig, resume_after } = frame;
    if (typeof key_id !== "string" || typeof client_nonce !== "string" || typeof sig !== "string" || typeof ts !== "number") return fail();
    if (!NONCE_RE.test(client_nonce) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) return fail();
    const key = getActiveKey(this.deps.db, key_id);
    if (!key || key.role !== "client" || !hasScope(key, "stream")) return fail();
    const message = clientAuthString(this.deps.domain, this.serverNonce, client_nonce, ts);
    if (!verifyString(publicKeyFromB64(key.public_key), message, sig)) return fail();
    if (!useNonce(this.deps.db, key.key_id, `ws:${client_nonce}`, NONCE_TTL_MS + MAX_CLOCK_SKEW_MS)) return fail();

    clearTimeout(this.authTimer);
    this.key = key;
    const sessionId = randomUUID();
    this.send({
      t: "auth_ok",
      session_id: sessionId,
      sig: signString(this.deps.identity, serverAuthString(this.deps.domain, client_nonce, this.serverNonce, sessionId)),
    });
    this.lastSent = Number.isSafeInteger(resume_after) && resume_after > 0 ? resume_after : 0;
    this.deps.events.on("appended", this.onAppended);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > DEAD_AFTER_MS) return this.socket.terminate();
      this.socket.ping();
    }, HEARTBEAT_MS);
    this.pump();
  }

  /** Sends every event after lastSent, in order. Re-entrant calls coalesce into one more pass. */
  private pump(): void {
    if (!this.key || this.socket.readyState !== this.socket.OPEN) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (;;) {
          if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            setTimeout(() => this.pump(), 250);
            return;
          }
          const batch: SignedEvent[] = this.deps.events.listAfter(this.lastSent, 100);
          if (batch.length === 0) break;
          for (const e of batch) {
            this.send({ t: "event", ...e });
            this.lastSent = e.seq;
          }
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async handleRpc(id: unknown, method: unknown, params: unknown): Promise<void> {
    if (typeof id !== "string" || id.length > 64 || typeof method !== "string") return this.close(4400, "invalid request");
    const outcome =
      this.key && hasScope(this.key, `rpc:${method}`)
        ? await this.deps.connectors.call(method, params)
        : ({ ok: false, error: { code: "forbidden", message: "missing scope" } } as const);
    const body = outcome.ok ? outcome.result : outcome.error;
    const sig = signString(this.deps.identity, rpcResultString(id, outcome.ok, body));
    this.send(outcome.ok ? { t: "res", id, ok: true, result: outcome.result, sig } : { t: "res", id, ok: false, error: outcome.error, sig });
  }
}
