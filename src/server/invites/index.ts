// Public invitation pages at /events/<id>: details, RSVP form, thank-you page, calendar file and picture.
// Ids are 80 random bits, and lookups of unknown ids are rate limited per IP, so links can't be guessed.
// Each RSVP becomes an `invite.rsvp` event for Muse.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { EventStore } from "../events.ts";
import { RateLimiter } from "../ratelimit.ts";
import { icsFilename, inviteIcs, isPast } from "./calendar.ts";
import {
  contactType,
  getInvite,
  getRsvp,
  IMAGE_MIME,
  imageDir,
  inviteTimes,
  inviteSummary,
  readRsvpInput,
  saveRsvp,
  validateRsvp,
  type Invite,
} from "./store.ts";
import { invitePage, notFoundPage, thanksPage, type PageLinks } from "./views.ts";

const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const CSS = readFileSync(new URL("./invite.css", import.meta.url), "utf8");

export interface InviteDeps {
  config: Config;
  db: Db;
  events: EventStore;
}

export function inviteUrl(domain: string, id: string): string {
  return `https://${domain}/events/${id}`;
}

export function inviteLinks(domain: string, inv: Invite): PageLinks {
  return { url: inviteUrl(domain, inv.id), image: inv.image ? `https://${domain}/events/${inv.id}/image/${inv.image}` : undefined };
}

export async function registerInvites(app: FastifyInstance, deps: InviteDeps): Promise<void> {
  const { config, db, events } = deps;
  const misses = new RateLimiter(30, 15 * 60_000);
  const submissions = new RateLimiter(30, 3_600_000);

  await app.register(async (pub) => {
    pub.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    pub.addHook("onSend", async (_req, reply, payload) => {
      reply.header("content-security-policy", CSP);
      reply.header("x-frame-options", "DENY");
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
      return payload;
    });

    const page = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").send(body);

    /** Looks up the invite in the URL; unknown ids count towards a per-IP limit. */
    function lookup(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Invite | undefined {
      if (misses.blocked(req.ip)) {
        reply.code(429).type("text/plain").send("Too many requests. Try again later.");
        return undefined;
      }
      const inv = getInvite(db, req.params.id);
      if (!inv) {
        misses.hit(req.ip);
        page(reply.code(404), notFoundPage());
      }
      return inv;
    }

    pub.get("/events/static/invite.css", async (_req, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "public, max-age=3600").send(CSS));

    pub.get<{ Params: { id: string } }>("/events/:id", async (req, reply) => {
      const inv = lookup(req, reply);
      if (!inv) return reply;
      return page(reply, invitePage(inv, inviteLinks(config.domain, inv)));
    });

    pub.post<{ Params: { id: string } }>("/events/:id/rsvp", async (req, reply) => {
      const inv = lookup(req, reply);
      if (!inv) return reply;
      if (inv.closed_at || isPast(inv)) return reply.redirect(`/events/${inv.id}`, 303);
      if (!submissions.hit(req.ip)) return reply.code(429).type("text/plain").send("Too many RSVPs from this connection. Try again later.");
      const input = readRsvpInput((req.body ?? {}) as Record<string, unknown>);
      const result = validateRsvp(input);
      if (!result.ok) return page(reply.code(400), invitePage(inv, inviteLinks(config.domain, inv), { values: input, errors: result.errors }));

      const { rsvp, updated } = saveRsvp(db, inv.id, result.value);
      const totals = inviteSummary(db, inv.id)!;
      events.append({
        kind: "invite.rsvp",
        source: `invite:${inv.id}`,
        trust: "untrusted",
        payload: {
          invite: {
            id: inv.id,
            title: inv.title,
            starts_at: inviteTimes(inv).start.toISOString(),
            timezone: inv.timezone,
            location: inv.location,
            url: inviteUrl(config.domain, inv.id),
          },
          rsvp: {
            id: rsvp.id,
            name: rsvp.name,
            contact: rsvp.contact,
            contact_type: contactType(rsvp.contact),
            attending: rsvp.attending,
            adults: rsvp.adults,
            kids: rsvp.kids,
            updated,
          },
          totals: { yes: totals.yes, no: totals.no, adults: totals.adults, kids: totals.kids },
        },
      });
      console.log(`[invites] ${updated ? "updated" : "new"} RSVP for ${inv.id}: ${rsvp.attending ? "yes" : "no"}`);
      return reply.redirect(`/events/${inv.id}/thanks/${rsvp.id}`, 303);
    });

    pub.get<{ Params: { id: string; rsvp: string } }>("/events/:id/thanks/:rsvp", async (req, reply) => {
      const inv = lookup(req, reply);
      if (!inv) return reply;
      const rsvp = getRsvp(db, inv.id, req.params.rsvp);
      if (!rsvp) return reply.redirect(`/events/${inv.id}`, 303);
      return page(reply, thanksPage(inv, inviteLinks(config.domain, inv), rsvp));
    });

    pub.get<{ Params: { id: string } }>("/events/:id/event.ics", async (req, reply) => {
      const inv = lookup(req, reply);
      if (!inv) return reply;
      return reply
        .type("text/calendar; charset=utf-8")
        .header("content-disposition", `attachment; filename="${icsFilename(inv.title)}"`)
        .send(inviteIcs(inv, inviteUrl(config.domain, inv.id), config.domain));
    });

    pub.get<{ Params: { id: string; file: string } }>("/events/:id/image/:file", async (req, reply) => {
      const inv = lookup(req, reply);
      if (!inv) return reply;
      if (!inv.image || req.params.file !== inv.image) return reply.code(404).send();
      const path = join(imageDir(config.dataDir), inv.image);
      if (!existsSync(path)) return reply.code(404).send();
      const ext = inv.image.split(".").pop()!;
      // The file name changes with every upload, so it can be cached for a long time.
      return reply.type(IMAGE_MIME[ext] ?? "application/octet-stream").header("cache-control", "public, max-age=31536000, immutable").send(readFileSync(path));
    });
  });
}
