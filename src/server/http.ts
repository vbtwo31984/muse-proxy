import { existsSync, readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { safeEqual, sha256hex, signString, type Identity } from "../protocol/crypto.ts";
import { helperBundleString, pairOkString, pairProofFromHash, responseString, HEADER_SERVER_SIGNATURE } from "../protocol/messages.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { EventStore } from "./events.ts";
import type { ConnectorRegistry } from "./connectors/index.ts";
import { verifySignedRequest } from "./auth.ts";
import { RateLimiter } from "./ratelimit.ts";
import { StreamHub } from "./stream.ts";
import { registerAdmin } from "./admin/index.ts";
import { activePairingCodes, addKey, burnPairingCode, type KeyRecord } from "./store.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    mpKey?: KeyRecord;
    mpNonce?: string;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  identity: Identity;
  events: EventStore;
  connectors: ConnectorRegistry;
  version: string;
}

const publishBody = z.object({
  kind: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  payload: z.unknown(),
  dedupe_key: z.string().min(1).max(128).optional(),
});

const pairBody = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  client_pubkey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

interface HelperBundle {
  bytes: Buffer;
  meta: { version: string; sha256: string; sig: string };
}

function loadHelperBundle(path: string, identity: Identity, version: string): HelperBundle | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  const sha256 = sha256hex(bytes);
  const v = `${version}+${sha256.slice(0, 12)}`;
  return { bytes, meta: { version: v, sha256, sig: signString(identity, helperBundleString(sha256, v)) } };
}

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; hub: StreamHub }> {
  const { config, db, identity, events, connectors } = deps;
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 256 * 1024 });
  const authFailures = new RateLimiter(20, 15 * 60_000);
  const pairAttempts = new RateLimiter(5, 3_600_000);
  const hub = new StreamHub({ db, domain: config.domain, identity, events, connectors, authFailures });
  const helper = loadHelperBundle(config.helperBundlePath, identity, deps.version);

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      const err = new Error("invalid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Sign every response to a signed request, so clients can tell it came from this server.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.mpNonce) {
      const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : "";
      reply.header(HEADER_SERVER_SIGNATURE, signString(identity, responseString(reply.statusCode, body, req.mpNonce)));
    }
    reply.header("cache-control", "no-store");
    return payload;
  });

  function requireAuth(scope: (req: FastifyRequest) => string) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (authFailures.blocked(req.ip)) return reply.code(429).send({ error: "rate_limited" });
      const result = verifySignedRequest(
        db,
        config.domain,
        { method: req.method, pathAndQuery: req.url, headers: req.headers, rawBody: req.rawBody ?? Buffer.alloc(0) },
        scope(req),
      );
      if (!result.ok) {
        authFailures.hit(req.ip);
        return reply.code(result.status).send({ error: result.code });
      }
      req.mpKey = result.key;
      req.mpNonce = result.nonce;
    };
  }

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get("/healthz", async () => ({ ok: true, clients_connected: hub.connectedCount, last_seq: events.lastSeq() }));

  app.get("/v1/server-key", async () => ({ domain: config.domain, public_key: identity.publicKeyB64, fingerprint: identity.fingerprint }));

  app.get("/v1/stream", { websocket: true }, (socket, req) => hub.handle(socket, req.ip));

  app.post("/v1/pair", async (req, reply) => {
    if (!pairAttempts.hit(req.ip)) return reply.code(429).send({ error: "rate_limited" });
    const codes = activePairingCodes(db);
    if (codes.length === 0) return reply.code(404).send({ error: "pairing_closed" });
    const parsed = pairBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { name, client_pubkey, proof } = parsed.data;
    const match = codes.find((c) => c.name === name && safeEqual(pairProofFromHash(c.code_hash, client_pubkey, name), proof));
    if (!match) return reply.code(401).send({ error: "auth_failed" });
    burnPairingCode(db, match.code_hash);
    let key: KeyRecord;
    try {
      key = addKey(db, name, "client", client_pubkey);
    } catch (err) {
      return reply.code(409).send({ error: "conflict", message: (err as Error).message });
    }
    return {
      domain: config.domain,
      key_id: key.key_id,
      scopes: key.scopes,
      server_public_key: identity.publicKeyB64,
      sig: signString(identity, pairOkString(config.domain, client_pubkey, name)),
    };
  });

  app.post("/v1/publish", { preHandler: requireAuth(() => "publish") }, async (req, reply) => {
    const parsed = publishBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const name = req.mpKey!.name;
    const { event, duplicate } = events.append({
      kind: `publish.${name}.${parsed.data.kind}`,
      source: `publisher:${name}`,
      trust: "owner",
      payload: parsed.data.payload ?? null,
      dedupeKey: parsed.data.dedupe_key ? `pub:${name}:${parsed.data.dedupe_key}` : undefined,
    });
    return { id: event.id, seq: event.seq, duplicate };
  });

  app.post<{ Params: { method: string } }>(
    "/v1/rpc/:method",
    { preHandler: requireAuth((req) => `rpc:${(req.params as { method: string }).method}`) },
    async (req) => {
      const body = req.body as { params?: unknown } | undefined;
      const outcome = await connectors.call(req.params.method, body?.params ?? {});
      return outcome.ok ? { ok: true, result: outcome.result, cached: outcome.cached } : { ok: false, error: outcome.error };
    },
  );

  app.get("/v1/rpc", { preHandler: requireAuth(() => "rpc:*") }, async () => ({ methods: connectors.list() }));

  app.get<{ Querystring: { after?: string; wait?: string; limit?: string } }>(
    "/v1/events/poll",
    { preHandler: requireAuth(() => "poll") },
    async (req) => {
      const after = Math.max(0, Number.parseInt(req.query.after ?? "0", 10) || 0);
      const wait = Math.min(50, Math.max(0, Number.parseInt(req.query.wait ?? "0", 10) || 0));
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? "100", 10) || 100));
      let list = events.listAfter(after, limit);
      if (list.length === 0 && wait > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            events.off("appended", done);
            resolve();
          };
          const timer = setTimeout(done, wait * 1000);
          events.on("appended", done);
          req.raw.on("close", done);
        });
        list = events.listAfter(after, limit);
      }
      return { events: list, last_seq: events.lastSeq() };
    },
  );

  app.post("/v1/ack", { preHandler: requireAuth(() => "ack") }, async (req, reply) => {
    const seq = (req.body as { seq?: unknown } | undefined)?.seq;
    if (typeof seq !== "number") return reply.code(400).send({ error: "invalid_request" });
    return { acked_seq: events.ack(req.mpKey!.key_id, seq) };
  });

  app.get("/v1/helper/latest.json", async (_req, reply) => (helper ? helper.meta : reply.code(404).send({ error: "not_built" })));
  app.get("/v1/helper/latest", async (_req, reply) => {
    if (!helper) return reply.code(404).send({ error: "not_built" });
    return reply.type("text/javascript; charset=utf-8").send(helper.bytes);
  });

  await registerAdmin(app, { config, db, identity, events, hub, version: deps.version });

  return { app, hub };
}
