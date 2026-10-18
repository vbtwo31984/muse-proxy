// Receive-only SMTP. Accepts mail for active aliases @<domain> from any sender,
// rejects everything else at RCPT TO, verifies SPF/DKIM/DMARC, and turns each
// message into an `email.received` event. Never relays.

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync, watchFile } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { authenticate } from "mailauth";
import { z } from "zod";
import { convert as htmlToText } from "html-to-text";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { EventStore } from "./events.ts";
import { getActiveAlias, takeAliasQuota } from "./store.ts";
import { ConnectorError, type Connector } from "./connectors/types.ts";

const MAX_TEXT_CHARS = 100_000;
const MAX_ATTACHMENT_FETCH_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = [
  /^text\//,
  /^image\/(png|jpeg|gif|webp)$/,
  /^application\/pdf$/,
  /^application\/json$/,
  /^text\/calendar$/,
  /^application\/ics$/,
];

type Resolver = (name: string, rrtype: string) => Promise<unknown>;

export interface AuthSummary {
  spf: string;
  dkim: string;
  dmarc: string;
  arc: string;
  /** Set when DMARC failed but a trusted forwarder's ARC seal recorded a DMARC pass, e.g. "google.com". */
  arc_vouched_by?: string;
}

interface ArcResult {
  status?: { result?: string };
  signature?: { signingDomain?: string } | false;
  authenticationResults?: { dmarc?: { result?: string } };
}

/**
 * Forwarding (e.g. a Gmail filter) often breaks the original DKIM signature and SPF
 * alignment, so DMARC fails even for genuine mail. A forwarder that ARC-seals the
 * message records what it saw on receipt; if the chain validates, the newest seal is
 * from a trusted provider, and that provider recorded dmarc=pass, trust it.
 */
export function arcVouchingSealer(arc: unknown, trustedSealers: string[]): string | undefined {
  const a = arc as ArcResult | false | undefined;
  if (!a || a.status?.result !== "pass") return undefined;
  const sealer = (a.signature && a.signature.signingDomain ? a.signature.signingDomain : "").toLowerCase();
  if (!sealer || !trustedSealers.includes(sealer)) return undefined;
  return a.authenticationResults?.dmarc?.result === "pass" ? sealer : undefined;
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).flatMap((o) => o.value.map((v) => (v.name ? `${v.name} <${v.address}>` : v.address ?? ""))).filter(Boolean);
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}

const HIDDEN_ELEMENT = /<([a-z][a-z0-9]*)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?:\.0+)?\b)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/**
 * Plain text for Muse. Uses the text part if there is one, otherwise converts
 * the HTML, dropping images and elements styled to be invisible (a common way to
 * hide instructions from humans while showing them to an AI).
 */
export function bodyText(parsed: Pick<ParsedMail, "text" | "html">): string {
  let text = parsed.text?.trim() ?? "";
  if (!text && typeof parsed.html === "string") {
    text = htmlToText(parsed.html.replace(HIDDEN_ELEMENT, ""), {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      ],
    });
  }
  return text.replace(ZERO_WIDTH, "");
}

/** Builds the event payload from a parsed message. Attachment bytes are never included. */
export function buildEmailPayload(parsed: ParsedMail, opts: { aliases: { local_part: string; label: string }[]; envelopeFrom: string | null; remoteIp: string | null; auth: AuthSummary }) {
  const body = truncate(bodyText(parsed), MAX_TEXT_CHARS);
  return {
    alias: opts.aliases[0]?.local_part ?? null,
    alias_label: opts.aliases[0]?.label ?? null,
    aliases: opts.aliases.map((a) => ({ alias: a.local_part, label: a.label })),
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    reply_to: addresses(parsed.replyTo),
    envelope_from: opts.envelopeFrom,
    remote_ip: opts.remoteIp,
    subject: parsed.subject ?? null,
    date: parsed.date ? parsed.date.toISOString() : null,
    message_id: parsed.messageId ?? null,
    auth: opts.auth,
    text: body.text,
    text_truncated: body.truncated,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? null,
      content_type: a.contentType,
      size: a.size,
      sha256: createHash("sha256").update(a.content).digest("hex"),
    })),
  };
}

/** Domain of the From header, for logs only. */
function headerFromDomain(raw: Buffer): string {
  const head = raw.subarray(0, 64 * 1024).toString("utf8");
  const m = /^from:[^\r\n]*@([a-z0-9.-]+)/im.exec(head);
  return m?.[1]?.toLowerCase() ?? "unknown";
}

function resultOf(check: unknown): string | undefined {
  return check && typeof check === "object" ? (check as { status?: { result?: string } }).status?.result : undefined;
}

function summarizeAuth(res: Awaited<ReturnType<typeof authenticate>>): AuthSummary {
  const dkimResults = (res.dkim?.results ?? []) as unknown[];
  return {
    spf: resultOf(res.spf) ?? "none",
    dkim: dkimResults.some((r) => resultOf(r) === "pass") ? "pass" : (resultOf(dkimResults[0]) ?? "none"),
    dmarc: resultOf(res.dmarc) ?? "none",
    arc: resultOf(res.arc) ?? "none",
  };
}

class SmtpReject extends Error {
  readonly responseCode: number;
  constructor(code: number, message: string) {
    super(message);
    this.responseCode = code;
  }
}

export interface MailServerDeps {
  config: Config;
  db: Db;
  events: EventStore;
  resolver?: Resolver;
}

export function mailDir(config: Config): string {
  return join(config.dataDir, "mail");
}

export function createMailServer(deps: MailServerDeps): SMTPServer {
  const { config, db, events } = deps;
  const domain = config.domain.toLowerCase();
  mkdirSync(mailDir(config), { recursive: true, mode: 0o700 });

  const options: SMTPServerOptions = {
    name: domain,
    banner: "muse-proxy ESMTP (receive only)",
    authOptional: true,
    disabledCommands: ["AUTH"],
    size: config.maxMessageBytes,
    maxClients: 20,
    socketTimeout: 60_000,
    closeTimeout: 10_000,
    logger: false,
    onConnect(_session, callback) {
      callback();
    },
    onRcptTo(address, session, callback) {
      const rcpt = address.address.toLowerCase();
      const at = rcpt.lastIndexOf("@");
      const local = rcpt.slice(0, at);
      const host = rcpt.slice(at + 1);
      if (at < 1 || host !== domain) return callback(new SmtpReject(550, "5.7.1 Relaying denied"));
      if (session.envelope.rcptTo.length >= 20) return callback(new SmtpReject(452, "4.5.3 Too many recipients"));
      if (!getActiveAlias(db, local)) return callback(new SmtpReject(550, "5.1.1 No such user"));
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("error", (err) => callback(err));
      stream.on("end", () => {
        if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) {
          return callback(new SmtpReject(552, "5.3.4 Message too big"));
        }
        handleMessage(Buffer.concat(chunks), session)
          .then(() => callback())
          .catch((err: unknown) => {
            if (err instanceof SmtpReject) return callback(err);
            console.error("[smtp] failed to process message", err);
            callback(new SmtpReject(451, "4.3.0 Temporary failure, try again later"));
          });
      });
    },
  };

  if (config.tlsCertPath && config.tlsKeyPath && existsSync(config.tlsCertPath) && existsSync(config.tlsKeyPath)) {
    options.key = readFileSync(config.tlsKeyPath);
    options.cert = readFileSync(config.tlsCertPath);
  }
  // Without a cert, smtp-server falls back to its built-in self-signed one; senders still get encryption.

  async function handleMessage(raw: Buffer, session: Parameters<NonNullable<SMTPServerOptions["onData"]>>[1]): Promise<void> {
    const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address || null : null;
    const auth = await authenticate(raw, {
      ip: session.remoteAddress,
      helo: session.clientHostname || session.hostNameAppearsAs,
      sender: envelopeFrom ?? undefined,
      mta: domain,
      resolver: deps.resolver as never,
      disableBimi: true,
    });
    const authSummary = summarizeAuth(auth);
    const dmarc = auth.dmarc as { status?: { result?: string }; policy?: string } | false;
    if (dmarc && dmarc.status?.result === "fail" && dmarc.policy === "reject") {
      const vouchedBy = arcVouchingSealer(auth.arc, config.arcTrustedSealers);
      if (!vouchedBy) {
        console.log(`[smtp] rejected (DMARC p=reject) from=${headerFromDomain(raw)} ip=${session.remoteAddress} auth=${JSON.stringify(authSummary)}`);
        throw new SmtpReject(550, "5.7.1 Rejected by sender's DMARC policy");
      }
      authSummary.arc_vouched_by = vouchedBy;
    }

    const aliases = session.envelope.rcptTo
      .map((r) => getActiveAlias(db, r.address.toLowerCase().split("@")[0]!))
      .filter((a): a is NonNullable<typeof a> => !!a);
    if (aliases.length === 0) throw new SmtpReject(550, "5.1.1 No such user");
    for (const alias of aliases) {
      if (!takeAliasQuota(db, alias.local_part, config.aliasDailyLimit)) throw new SmtpReject(452, "4.2.2 Mailbox over daily limit");
    }

    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const payload = buildEmailPayload(parsed, {
      aliases,
      envelopeFrom,
      remoteIp: session.remoteAddress,
      auth: authSummary,
    });
    const dedupeKey = parsed.messageId ? `email:${parsed.messageId}:${aliases.map((a) => a.local_part).sort().join(",")}` : undefined;
    const { event, duplicate } = events.append({ kind: "email.received", source: "smtp", trust: "untrusted", payload, dedupeKey });
    if (!duplicate) {
      const path = join(mailDir(config), `${event.id}.eml`);
      writeFileSync(path, raw, { mode: 0o600 });
      db.prepare("INSERT OR REPLACE INTO mail_files (event_id, path, created_at) VALUES (?, ?, ?)").run(event.id, path, Date.now());
    }
  }

  const server = new SMTPServer(options);
  server.on("error", (err) => console.error("[smtp] server error", err.message));

  // Caddy renews the cert every ~60 days; pick up the new files without a restart.
  if (config.tlsCertPath && config.tlsKeyPath) {
    const certPath = config.tlsCertPath;
    const keyPath = config.tlsKeyPath;
    watchFile(certPath, { interval: 3_600_000 }, (curr) => {
      if (curr.mtimeMs === 0) return; // file doesn't exist (yet)
      try {
        server.updateSecureContext({ key: readFileSync(keyPath), cert: readFileSync(certPath) });
        console.log("[smtp] reloaded TLS certificate");
      } catch (err) {
        console.error("[smtp] TLS reload failed", (err as Error).message);
      }
    });
  }
  return server;
}

export function purgeMail(db: Db, retentionDays: number, now = Date.now()): number {
  const rows = db.prepare("SELECT event_id, path FROM mail_files WHERE created_at < ?").all(now - retentionDays * 86_400_000) as {
    event_id: string;
    path: string;
  }[];
  for (const row of rows) {
    try {
      unlinkSync(row.path);
    } catch {
      // already gone
    }
    db.prepare("DELETE FROM mail_files WHERE event_id = ?").run(row.event_id);
  }
  return rows.length;
}

/** Deletes every event and stored email (admin "events clear"). Returns what was deleted. */
export function clearAllEvents(db: Db): { events: number; emails: number } {
  const events = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  const files = db.prepare("SELECT path FROM mail_files").all() as { path: string }[];
  for (const f of files) rmSync(f.path, { force: true });
  db.exec("BEGIN");
  db.prepare("DELETE FROM mail_files").run();
  db.prepare("DELETE FROM events").run();
  db.exec("COMMIT");
  return { events, emails: files.length };
}

/** email.attachment: fetch one attachment of a received email by its sha256. */
export const emailAttachment: Connector<{ event_id: string; sha256: string }> = {
  name: "email.attachment",
  description: "Fetch an email attachment (base64). Params: { event_id, sha256 }",
  params: z.object({
    event_id: z.string().regex(/^evt_[0-9A-Z]{26}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  perHour: 120,
  cacheTtlSec: 0,
  allowedHosts: [],
  async run({ event_id, sha256 }, ctx) {
    const row = ctx.db.prepare("SELECT path FROM mail_files WHERE event_id = ?").get(event_id) as { path: string } | undefined;
    if (!row || !existsSync(row.path)) throw new ConnectorError("not_found", "email not found or past retention");
    const parsed = await simpleParser(readFileSync(row.path));
    const att = parsed.attachments.find((a) => createHash("sha256").update(a.content).digest("hex") === sha256);
    if (!att) throw new ConnectorError("not_found", "attachment not found");
    if (att.size > MAX_ATTACHMENT_FETCH_BYTES) throw new ConnectorError("forbidden", "attachment too large");
    if (!ALLOWED_ATTACHMENT_TYPES.some((re) => re.test(att.contentType))) {
      throw new ConnectorError("forbidden", `attachment type not allowed: ${att.contentType}`);
    }
    return { filename: att.filename ?? null, content_type: att.contentType, size: att.size, content_base64: att.content.toString("base64") };
  },
};
