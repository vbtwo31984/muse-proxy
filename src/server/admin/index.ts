// Web admin at /admin. A passkey is the only way in; passkeys are enrolled through single-use
// links from `muse-proxy admin-enroll`, so only someone with VM access can add one.
// Sessions live in SQLite; every form POST carries a per-session CSRF token.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import { randomNonce, safeEqual, sha256hex, type Identity } from "../../protocol/crypto.ts";
import type { Config } from "../config.ts";
import { nowIso, type Db } from "../db.ts";
import type { EventStore } from "../events.ts";
import type { StreamHub } from "../stream.ts";
import { RateLimiter } from "../ratelimit.ts";
import { clearAllEvents } from "../email.ts";
import { addAlias, createPairingCode, listAliases, listKeys, revokeAlias, revokeKey } from "../store.ts";
import {
  addPasskey,
  checkEnrollCode,
  getPasskey,
  listPasskeys,
  removePasskey,
  saveChallenge,
  takeChallenge,
  touchPasskey,
  useEnrollCode,
} from "./passkeys.ts";
import multipart from "@fastify/multipart";
import { inviteFormPage, inviteDetailPage } from "./invites.ts";
import { inviteUrl } from "../invites/index.ts";
import { isPast } from "../invites/calendar.ts";
import {
  createInvite,
  deleteInvite,
  getInvite,
  imageType,
  inviteSummary,
  listInvites,
  listRsvps,
  MAX_IMAGE_BYTES,
  readInviteInput,
  setInviteClosed,
  timeZones,
  updateInvite,
  validateInvite,
  type InviteInput,
} from "../invites/store.ts";
import { dashboardPage, enrollPage, eventPage, loginPage, pairPage, type CursorView, type EventSummary, type Flash, type SessionView } from "./views.ts";

const SESSION_COOKIE = "__Host-mp_admin";

const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' blob:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const browserLib = join(createRequire(import.meta.url).resolve("@simplewebauthn/browser"), "../../dist/bundle/index.umd.min.js");
const JS = "text/javascript; charset=utf-8";
const STATIC: Record<string, { type: string; body: string }> = {
  "admin.css": { type: "text/css; charset=utf-8", body: readFileSync(new URL("./admin.css", import.meta.url), "utf8") },
  "admin.js": { type: JS, body: readFileSync(new URL("./admin.js", import.meta.url), "utf8") },
  "webauthn.js": { type: JS, body: readFileSync(browserLib, "utf8") },
};

export interface AdminDeps {
  config: Config;
  db: Db;
  identity: Identity;
  events: EventStore;
  hub: StreamHub;
  version: string;
}

interface SessionRow {
  token_hash: string;
  passkey_id: string;
  csrf: string;
  expires_at: number;
}

declare module "fastify" {
  interface FastifyRequest {
    adminSession?: SessionRow;
  }
}

const credentialJson = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,1400}$/),
  rawId: z.string(),
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: z.string() }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
});
const enrollOptionsBody = z.object({ code: z.string().max(100) });
const enrollVerifyBody = z.object({ code: z.string().max(100), name: z.string().trim().min(1).max(40), response: credentialJson });
const loginVerifyBody = z.object({ response: credentialJson });

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

const FLASHES: Record<string, Flash> = {
  revoked_alias: { kind: "ok", text: "Address revoked." },
  revoked_key: { kind: "ok", text: "Key revoked." },
  removed_passkey: { kind: "ok", text: "Passkey removed." },
  cleared: { kind: "ok", text: "All events deleted." },
  enrolled: { kind: "ok", text: "Passkey added. Use it to sign in from now on." },
  last_passkey: { kind: "err", text: "That's the only passkey. Enroll another one first (mp admin-enroll)." },
  bad_label: { kind: "err", text: "Labels are lowercase letters, digits and dashes (max 31 chars)." },
  bad_name: { kind: "err", text: "Names are lowercase letters, digits and dashes (max 41 chars)." },
  not_found: { kind: "err", text: "Nothing matched; it may already be revoked." },
  invite_created: { kind: "ok", text: "Invitation created. Copy the link below and send it to your guests." },
  invite_saved: { kind: "ok", text: "Changes saved." },
  invite_closed: { kind: "ok", text: "RSVPs closed." },
  invite_reopened: { kind: "ok", text: "RSVPs reopened." },
  invite_deleted: { kind: "ok", text: "Invitation deleted." },
};

export async function registerAdmin(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { config, db, identity, events, hub } = deps;
  if (!config.admin.enabled) return;
  const rpID = config.domain;
  const origin = `https://${config.domain}`;
  // Stable per admin, so re-enrolling on the same device replaces its old passkey there.
  const userID = new Uint8Array(Buffer.from(sha256hex(`muse-proxy admin ${config.admin.email}`), "hex").subarray(0, 16));
  const starts = new RateLimiter(60, 15 * 60_000);
  const failures = new RateLimiter(20, 15 * 60_000);

  await app.register(async (admin) => {
    admin.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    // Invitation forms upload a picture. Fields (including _csrf) land on req.body; the file as a Buffer.
    await admin.register(multipart, {
      attachFieldsToBody: "keyValues",
      limits: { files: 1, fileSize: MAX_IMAGE_BYTES, fields: 20, fieldSize: 16 * 1024, parts: 25 },
    });

    admin.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
      if (err.code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).type("text/plain").send("That picture is too big (max 15 MB). Go back and choose a smaller one.");
      }
      if ((err.statusCode ?? 500) >= 500) console.error(`[admin] ${req.method} ${req.url}`, err);
      return reply.send(err);
    });

    admin.addHook("onSend", async (_req, reply, payload) => {
      reply.header("content-security-policy", CSP);
      reply.header("x-frame-options", "DENY");
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
      reply.header("cache-control", "no-store");
      return payload;
    });

    function currentSession(req: FastifyRequest): SessionRow | undefined {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return undefined;
      return db.prepare("SELECT * FROM admin_sessions WHERE token_hash = ? AND expires_at > ?").get(sha256hex(token), Date.now()) as
        | SessionRow
        | undefined;
    }

    async function requireSession(req: FastifyRequest, reply: FastifyReply) {
      const session = currentSession(req);
      if (!session) return req.method === "GET" ? reply.redirect("/admin/login", 303) : reply.code(403).type("text/plain").send("not signed in");
      if (req.method === "POST") {
        const token = (req.body as Record<string, string> | undefined)?._csrf ?? "";
        if (!safeEqual(token, session.csrf)) return reply.code(403).type("text/plain").send("bad csrf token");
      }
      req.adminSession = session;
    }

    /** Starts a session for a passkey and returns the Set-Cookie header. */
    function startSession(passkeyId: string): string {
      const token = randomNonce();
      const maxAge = config.admin.sessionHours * 3600;
      db.prepare("INSERT INTO admin_sessions (token_hash, passkey_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
        sha256hex(token),
        passkeyId,
        randomNonce(),
        nowIso(),
        Date.now() + maxAge * 1000,
      );
      return sessionCookie(token, maxAge);
    }

    function fail(req: FastifyRequest, reply: FastifyReply, status: number, error: string, detail: string) {
      failures.hit(req.ip);
      console.warn(`[admin] ${req.url} rejected from ${req.ip}: ${detail}`);
      return reply.code(status).send({ error });
    }

    const rateLimited = (reply: FastifyReply) => reply.code(429).send({ error: "Too many attempts. Try again later." });
    // Runs before the multipart body is read, so uploads from signed-out browsers aren't buffered.
    async function requireSignedIn(req: FastifyRequest, reply: FastifyReply) {
      if (!currentSession(req)) return reply.code(403).type("text/plain").send("not signed in");
    }

    const view = (req: FastifyRequest): SessionView => ({ email: config.admin.email, csrf: req.adminSession!.csrf, passkeyId: req.adminSession!.passkey_id });
    const page = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").send(body);
    const field = (req: FastifyRequest, name: string) => String((req.body as Record<string, unknown> | undefined)?.[name] ?? "").trim();

    admin.get<{ Params: { file: string } }>("/admin/static/:file", async (req, reply) => {
      const f = STATIC[req.params.file];
      if (!f) return reply.code(404).send();
      return reply.type(f.type).send(f.body);
    });

    // --- Enrollment ----------------------------------------------------------
    // GET only shows the page (link previews must not burn the code); the code is used up
    // when a passkey is registered with it.

    admin.get<{ Querystring: { code?: string } }>("/admin/enroll", async (req, reply) => {
      if (!starts.hit(req.ip)) return reply.code(429).type("text/plain").send("too many attempts");
      const code = req.query.code ?? "";
      if (!checkEnrollCode(db, code)) return page(reply.code(410), enrollPage({ error: "This enrollment link is invalid, used or expired. Run mp admin-enroll for a new one." }));
      return page(reply, enrollPage({ code }));
    });

    admin.post("/admin/enroll/options", async (req, reply) => {
      if (!starts.hit(req.ip) || failures.blocked(req.ip)) return rateLimited(reply);
      const body = enrollOptionsBody.safeParse(req.body);
      const codeHash = body.success ? checkEnrollCode(db, body.data.code) : undefined;
      if (!codeHash) return fail(req, reply, 410, "This enrollment link is invalid, used or expired.", "bad enrollment code");
      const options = await generateRegistrationOptions({
        rpName: "muse-proxy",
        rpID,
        userID,
        userName: config.admin.email,
        userDisplayName: `muse-proxy admin (${config.admin.email})`,
        attestationType: "none",
        excludeCredentials: listPasskeys(db).map((p) => ({ id: p.id, transports: p.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      saveChallenge(db, options.challenge, "enroll", codeHash);
      return options;
    });

    admin.post("/admin/enroll/verify", async (req, reply) => {
      if (failures.blocked(req.ip)) return rateLimited(reply);
      const body = enrollVerifyBody.safeParse(req.body);
      if (!body.success) return fail(req, reply, 400, "Malformed request.", "bad enroll body");
      const codeHash = sha256hex(body.data.code);
      let result;
      try {
        result = await verifyRegistrationResponse({
          response: body.data.response as unknown as RegistrationResponseJSON,
          expectedChallenge: (c) => takeChallenge(db, c, "enroll", codeHash),
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch (err) {
        return fail(req, reply, 400, "The passkey couldn't be verified. Reload and try again.", `registration: ${(err as Error).message}`);
      }
      if (!result.verified) return fail(req, reply, 400, "The passkey couldn't be verified.", "registration not verified");
      if (!useEnrollCode(db, codeHash)) return fail(req, reply, 410, "This enrollment link was already used or has expired.", "enrollment code reused");
      const { credential } = result.registrationInfo;
      if (getPasskey(db, credential.id)) return fail(req, reply, 409, "That passkey is already enrolled.", "duplicate credential");
      addPasskey(db, {
        id: credential.id,
        name: body.data.name,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
      });
      console.log(`[admin] passkey "${body.data.name}" enrolled from ${req.ip}`);
      return reply.header("set-cookie", startSession(credential.id)).send({ redirect: "/admin?ok=enrolled#passkeys" });
    });

    // --- Sign in -------------------------------------------------------------

    admin.get("/admin/login", async (req, reply) => {
      if (currentSession(req)) return reply.redirect("/admin", 303);
      return page(reply, loginPage(listPasskeys(db).length > 0));
    });

    admin.post("/admin/login/options", async (req, reply) => {
      if (!starts.hit(req.ip) || failures.blocked(req.ip)) return rateLimited(reply);
      // Discoverable credentials: no allow list, the authenticator offers what it has for this rpID.
      const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
      saveChallenge(db, options.challenge, "login");
      return options;
    });

    admin.post("/admin/login/verify", async (req, reply) => {
      if (failures.blocked(req.ip)) return rateLimited(reply);
      const body = loginVerifyBody.safeParse(req.body);
      if (!body.success) return fail(req, reply, 400, "Malformed request.", "bad login body");
      const passkey = getPasskey(db, body.data.response.id);
      if (!passkey) return fail(req, reply, 403, "This passkey isn't enrolled here (it may have been removed).", `unknown credential ${body.data.response.id}`);
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response: body.data.response as unknown as AuthenticationResponseJSON,
          expectedChallenge: (c) => takeChallenge(db, c, "login"),
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: { id: passkey.id, publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter, transports: passkey.transports as never },
          requireUserVerification: true,
        });
      } catch (err) {
        return fail(req, reply, 403, "Sign-in failed. Try again.", `authentication (${passkey.name}): ${(err as Error).message}`);
      }
      if (!result.verified) return fail(req, reply, 403, "Sign-in failed. Try again.", `authentication not verified (${passkey.name})`);
      touchPasskey(db, passkey.id, result.authenticationInfo.newCounter);
      console.log(`[admin] signed in with passkey "${passkey.name}" from ${req.ip}`);
      return reply.header("set-cookie", startSession(passkey.id)).send({ redirect: "/admin" });
    });

    admin.post("/admin/logout", { preHandler: requireSession }, async (req, reply) => {
      db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(req.adminSession!.token_hash);
      return reply.header("set-cookie", sessionCookie("", 0)).redirect("/admin/login", 303);
    });

    // --- Pages ---------------------------------------------------------------

    admin.get<{ Querystring: { ok?: string; created?: string } }>("/admin", { preHandler: requireSession }, async (req, reply) => {
      const aliases = listAliases(db);
      let flash = FLASHES[req.query.ok ?? ""];
      const created = req.query.created && aliases.find((a) => a.local_part === req.query.created && !a.revoked_at);
      if (created) flash = { kind: "ok", text: `Created ${created.local_part}@${config.domain}` };
      const recent = db
        .prepare(
          `SELECT seq, kind, created_at, source, trust, length(payload) AS bytes,
             CASE WHEN kind = 'email.received' THEN json_extract(payload, '$.from[0]') END AS "from",
             CASE WHEN kind = 'email.received' THEN json_extract(payload, '$.subject') END AS subject
           FROM events ORDER BY seq DESC LIMIT 50`,
        )
        .all() as unknown as EventSummary[];
      const cursors = db
        .prepare("SELECT c.key_id, k.name, c.acked_seq, c.updated_at FROM cursors c LEFT JOIN keys k ON k.key_id = c.key_id ORDER BY c.updated_at DESC")
        .all() as unknown as CursorView[];
      const eventCount = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      return page(
        reply,
        dashboardPage(
          {
            domain: config.domain,
            fingerprint: identity.fingerprint,
            version: deps.version,
            connected: hub.connectedCount,
            disconnectedMs: hub.disconnectedForMs(),
            lastSeq: events.lastSeq(),
            cursors,
            aliases,
            keys: listKeys(db),
            events: recent,
            eventCount,
            passkeys: listPasskeys(db),
            invites: listInvites(db).map((i) => ({ ...i, past: isPast(i) })),
          },
          view(req),
          flash,
        ),
      );
    });

    admin.get<{ Params: { seq: string } }>("/admin/events/:seq", { preHandler: requireSession }, async (req, reply) => {
      const row = db.prepare("SELECT seq, id, kind, created_at, source, trust, payload FROM events WHERE seq = ?").get(Number(req.params.seq)) as
        | { seq: number; id: string; kind: string; created_at: string; source: string; trust: string; payload: string }
        | undefined;
      if (!row) return reply.code(404).type("text/plain").send("no such event (it may have been purged)");
      return page(reply, eventPage({ ...row, payload: JSON.parse(row.payload) }, view(req)));
    });

    // --- Actions -------------------------------------------------------------

    admin.post("/admin/aliases", { preHandler: requireSession }, async (req, reply) => {
      try {
        const a = addAlias(db, field(req, "label"));
        console.log(`[admin] created alias ${a.local_part}`);
        return reply.redirect(`/admin?created=${encodeURIComponent(a.local_part)}#aliases`, 303);
      } catch {
        return reply.redirect("/admin?ok=bad_label#aliases", 303);
      }
    });

    admin.post("/admin/aliases/revoke", { preHandler: requireSession }, async (req, reply) => {
      const alias = field(req, "alias");
      const n = alias ? revokeAlias(db, alias) : 0;
      if (n) console.log(`[admin] revoked alias ${alias}`);
      return reply.redirect(`/admin?ok=${n ? "revoked_alias" : "not_found"}#aliases`, 303);
    });

    admin.post("/admin/keys/revoke", { preHandler: requireSession }, async (req, reply) => {
      const keyId = field(req, "key_id");
      // By key_id only (revokeKey also matches names, which could hit several keys).
      const exists = keyId && db.prepare("SELECT 1 FROM keys WHERE key_id = ? AND revoked_at IS NULL").get(keyId);
      const n = exists ? revokeKey(db, keyId) : 0;
      if (n) {
        hub.disconnectKey(keyId);
        console.log(`[admin] revoked key ${keyId}`);
      }
      return reply.redirect(`/admin?ok=${n ? "revoked_key" : "not_found"}#keys`, 303);
    });

    admin.post("/admin/pair", { preHandler: requireSession }, async (req, reply) => {
      const name = field(req, "name");
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return reply.redirect("/admin?ok=bad_name#keys", 303);
      const { code, expiresAt } = createPairingCode(db, name);
      console.log(`[admin] created a pairing code for ${name}`);
      return page(reply, pairPage({ name, code, expiresAt, url: `https://${config.domain}`, serverKey: identity.publicKeyB64 }, view(req)));
    });

    admin.post("/admin/events/clear", { preHandler: requireSession }, async (_req, reply) => {
      const deleted = clearAllEvents(db);
      console.log(`[admin] deleted ${deleted.events} event(s) and ${deleted.emails} email(s)`);
      return reply.redirect("/admin?ok=cleared#events", 303);
    });

    admin.post("/admin/passkeys/remove", { preHandler: requireSession }, async (req, reply) => {
      const id = field(req, "id");
      const passkey = id ? getPasskey(db, id) : undefined;
      if (!passkey) return reply.redirect("/admin?ok=not_found#passkeys", 303);
      if (listPasskeys(db).length === 1) return reply.redirect("/admin?ok=last_passkey#passkeys", 303);
      removePasskey(db, passkey.id);
      console.log(`[admin] removed passkey "${passkey.name}"`);
      // Removing the passkey this session signed in with also ended the session.
      if (passkey.id === req.adminSession!.passkey_id) return reply.header("set-cookie", sessionCookie("", 0)).redirect("/admin/login", 303);
      return reply.redirect("/admin?ok=removed_passkey#passkeys", 303);
    });

    // --- Invitations -----------------------------------------------------------

    const emptyInvite = (): InviteInput => ({ title: "", description: "", location: "", date: "", start: "", end: "", timezone: config.timezone });
    const inviteValues = (i: NonNullable<ReturnType<typeof getInvite>>): InviteInput => ({
      title: i.title,
      description: i.description,
      location: i.location,
      date: i.starts_local.slice(0, 10),
      start: i.starts_local.slice(11, 16),
      end: i.ends_local?.slice(11, 16) ?? "",
      timezone: i.timezone,
    });
    /** Form values plus the uploaded picture (if any), with errors for both. */
    function readInviteForm(req: FastifyRequest) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const values = readInviteInput(body);
      const errors = validateInvite(values);
      const image = Buffer.isBuffer(body.image) && body.image.length > 0 ? body.image : undefined;
      if (image && !imageType(image)) errors.image = "That file isn't a JPEG, PNG, WebP or GIF picture.";
      return { values, errors, image, removeImage: body.remove_image === "1" };
    }
    const upload = { onRequest: requireSignedIn, preHandler: requireSession };

    admin.get("/admin/invites/new", { preHandler: requireSession }, async (req, reply) =>
      page(reply, inviteFormPage({ values: emptyInvite(), errors: {}, timezones: timeZones(), isNew: true }, view(req))),
    );

    admin.post("/admin/invites", upload, async (req, reply) => {
      const { values, errors, image } = readInviteForm(req);
      if (Object.keys(errors).length) return page(reply.code(400), inviteFormPage({ values, errors, timezones: timeZones(), isNew: true }, view(req)));
      const inv = createInvite(db, config.dataDir, values, image);
      console.log(`[admin] created invitation ${inv.id}`);
      return reply.redirect(`/admin/invites/${inv.id}?ok=invite_created`, 303);
    });

    admin.get<{ Params: { id: string }; Querystring: { ok?: string } }>("/admin/invites/:id", { preHandler: requireSession }, async (req, reply) => {
      const inv = inviteSummary(db, req.params.id);
      if (!inv) return reply.code(404).type("text/plain").send("no such invitation");
      return page(
        reply,
        inviteDetailPage({ inv: { ...inv, past: isPast(inv) }, rsvps: listRsvps(db, inv.id), url: inviteUrl(config.domain, inv.id) }, view(req), FLASHES[req.query.ok ?? ""]),
      );
    });

    admin.get<{ Params: { id: string } }>("/admin/invites/:id/edit", { preHandler: requireSession }, async (req, reply) => {
      const inv = getInvite(db, req.params.id);
      if (!inv) return reply.code(404).type("text/plain").send("no such invitation");
      return page(reply, inviteFormPage({ inv, values: inviteValues(inv), errors: {}, timezones: timeZones(), isNew: false }, view(req)));
    });

    admin.post<{ Params: { id: string } }>("/admin/invites/:id", upload, async (req, reply) => {
      const inv = getInvite(db, req.params.id);
      if (!inv) return reply.code(404).type("text/plain").send("no such invitation");
      const { values, errors, image, removeImage } = readInviteForm(req);
      if (Object.keys(errors).length) return page(reply.code(400), inviteFormPage({ inv, values, errors, timezones: timeZones(), isNew: false }, view(req)));
      updateInvite(db, config.dataDir, inv.id, values, { image, removeImage });
      console.log(`[admin] updated invitation ${inv.id}`);
      return reply.redirect(`/admin/invites/${inv.id}?ok=invite_saved`, 303);
    });

    admin.post<{ Params: { id: string; action: string } }>("/admin/invites/:id/:action", { preHandler: requireSession }, async (req, reply) => {
      const { id, action } = req.params;
      if (!getInvite(db, id)) return reply.code(404).type("text/plain").send("no such invitation");
      if (action === "close" || action === "reopen") {
        setInviteClosed(db, id, action === "close");
        console.log(`[admin] ${action === "close" ? "closed" : "reopened"} RSVPs for invitation ${id}`);
        return reply.redirect(`/admin/invites/${id}?ok=invite_${action === "close" ? "closed" : "reopened"}`, 303);
      }
      if (action === "delete") {
        deleteInvite(db, config.dataDir, id);
        console.log(`[admin] deleted invitation ${id}`);
        return reply.redirect("/admin?ok=invite_deleted#invites", 303);
      }
      return reply.code(404).type("text/plain").send("unknown action");
    });
  });
}
