// Invitations and RSVPs: validation, SQLite access, image files and time-zone math.
// Shared by the admin pages (create/edit) and the public pages (view/RSVP).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBase32 } from "../../protocol/ids.ts";
import { nowIso, type Db } from "../db.ts";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_GUESTS = 30;

export interface Invite {
  id: string;
  title: string;
  description: string;
  location: string;
  starts_local: string;
  ends_local: string | null;
  timezone: string;
  image: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Rsvp {
  id: string;
  invite_id: string;
  name: string;
  contact: string;
  contact_key: string;
  attending: boolean;
  adults: number;
  kids: number;
  created_at: string;
  updated_at: string;
}

export interface InviteSummary extends Invite {
  yes: number;
  no: number;
  adults: number;
  kids: number;
}

// --- Time zones --------------------------------------------------------------

let zones: string[] | undefined;
export function timeZones(): string[] {
  zones ??= [...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])];
  return zones;
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` from UTC at instant `ts`. */
function tzOffset(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ts);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ts / 1000) * 1000;
}

/** Converts wall-clock 'YYYY-MM-DDTHH:MM' in `tz` to an instant. */
export function zonedToUtc(local: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`bad local time ${local}`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes settle the offset, including across DST changes.
  let ts = wall - tzOffset(wall, tz);
  ts = wall - tzOffset(ts, tz);
  return new Date(ts);
}

/** Start and end instants. Without an end time, events last two hours; an end before the start means it ends the next day. */
export function inviteTimes(inv: Pick<Invite, "starts_local" | "ends_local" | "timezone">): { start: Date; end: Date } {
  const start = zonedToUtc(inv.starts_local, inv.timezone);
  let end = inv.ends_local ? zonedToUtc(inv.ends_local, inv.timezone) : new Date(start.getTime() + 2 * 3_600_000);
  if (end <= start) end = new Date(end.getTime() + 86_400_000);
  return { start, end };
}

// --- Validation --------------------------------------------------------------

export interface InviteInput {
  title: string;
  description: string;
  location: string;
  date: string; // YYYY-MM-DD
  start: string; // HH:MM
  end: string; // HH:MM or ""
  timezone: string;
}

export type FieldErrors = Partial<Record<string, string>>;

const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

export function readInviteInput(body: Record<string, unknown>): InviteInput {
  return {
    title: clean(body.title, 120),
    description: clean(body.description, 4000),
    location: clean(body.location, 300),
    date: clean(body.date, 10),
    start: clean(body.start, 5),
    end: clean(body.end, 5),
    timezone: clean(body.timezone, 64),
  };
}

export function validateInvite(input: InviteInput): FieldErrors {
  const errors: FieldErrors = {};
  if (!input.title) errors.title = "Give the event a name.";
  if (!input.location) errors.location = "Where is it?";
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date);
  if (!d || Number.isNaN(Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!)) || new Date(Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!)).getUTCDate() !== +d[3]!) {
    errors.date = "Pick a date.";
  }
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(input.start)) errors.start = "Pick a start time.";
  if (input.end && !time.test(input.end)) errors.end = "That isn't a valid time.";
  if (!isTimeZone(input.timezone)) errors.timezone = "Pick a time zone.";
  return errors;
}

/** Recognizes JPEG, PNG, WebP and GIF by their magic bytes; anything else is refused. */
export function imageType(buf: Buffer): { ext: string; mime: string } | undefined {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return { ext: "gif", mime: "image/gif" };
  return undefined;
}

export const IMAGE_MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

// --- Invites -----------------------------------------------------------------

export function imageDir(dataDir: string): string {
  return join(dataDir, "invites");
}

function storeImage(dataDir: string, id: string, buf: Buffer): string {
  const type = imageType(buf);
  if (!type) throw new Error("not an image");
  mkdirSync(imageDir(dataDir), { recursive: true });
  // A new name per upload, so browsers and link previews never show a stale cached picture.
  const file = `${id}-${randomBase32(8)}.${type.ext}`;
  writeFileSync(join(imageDir(dataDir), file), buf, { mode: 0o600 });
  return file;
}

function removeImage(dataDir: string, file: string | null): void {
  if (file) rmSync(join(imageDir(dataDir), file), { force: true });
}

const toLocal = (input: InviteInput) => ({
  starts_local: `${input.date}T${input.start}`,
  ends_local: input.end ? `${input.date}T${input.end}` : null,
});

export function createInvite(db: Db, dataDir: string, input: InviteInput, image?: Buffer): Invite {
  const id = randomBase32(16); // 80 random bits
  const now = nowIso();
  const file = image?.length ? storeImage(dataDir, id, image) : null;
  const { starts_local, ends_local } = toLocal(input);
  db.prepare(
    `INSERT INTO invites (id, title, description, location, starts_local, ends_local, timezone, image, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.title, input.description, input.location, starts_local, ends_local, input.timezone, file, now, now);
  return getInvite(db, id)!;
}

export function updateInvite(db: Db, dataDir: string, id: string, input: InviteInput, opts: { image?: Buffer; removeImage?: boolean } = {}): Invite | undefined {
  const existing = getInvite(db, id);
  if (!existing) return undefined;
  let file = existing.image;
  if (opts.image?.length) file = storeImage(dataDir, id, opts.image);
  else if (opts.removeImage) file = null;
  const { starts_local, ends_local } = toLocal(input);
  db.prepare(
    `UPDATE invites SET title = ?, description = ?, location = ?, starts_local = ?, ends_local = ?, timezone = ?, image = ?, updated_at = ?
     WHERE id = ?`,
  ).run(input.title, input.description, input.location, starts_local, ends_local, input.timezone, file, nowIso(), id);
  if (file !== existing.image) removeImage(dataDir, existing.image);
  return getInvite(db, id);
}

export function getInvite(db: Db, id: string): Invite | undefined {
  if (!/^[a-z2-9]{16}$/.test(id)) return undefined;
  return db.prepare("SELECT * FROM invites WHERE id = ?").get(id) as Invite | undefined;
}

export function listInvites(db: Db, id?: string): InviteSummary[] {
  return db
    .prepare(
      `SELECT i.*,
         COALESCE(SUM(r.attending = 1), 0) AS yes,
         COALESCE(SUM(r.attending = 0), 0) AS no,
         COALESCE(SUM(CASE WHEN r.attending = 1 THEN r.adults END), 0) AS adults,
         COALESCE(SUM(CASE WHEN r.attending = 1 THEN r.kids END), 0) AS kids
       FROM invites i LEFT JOIN rsvps r ON r.invite_id = i.id
       ${id ? "WHERE i.id = ?" : ""}
       GROUP BY i.id ORDER BY i.starts_local DESC`,
    )
    .all(...(id ? [id] : [])) as unknown as InviteSummary[];
}

export function inviteSummary(db: Db, id: string): InviteSummary | undefined {
  return listInvites(db, id)[0];
}

export function setInviteClosed(db: Db, id: string, closed: boolean): number {
  return Number(db.prepare("UPDATE invites SET closed_at = ?, updated_at = ? WHERE id = ?").run(closed ? nowIso() : null, nowIso(), id).changes);
}

export function deleteInvite(db: Db, dataDir: string, id: string): number {
  const existing = getInvite(db, id);
  if (!existing) return 0;
  db.prepare("DELETE FROM invites WHERE id = ?").run(id);
  removeImage(dataDir, existing.image);
  return 1;
}

// --- RSVPs -------------------------------------------------------------------

export interface RsvpInput {
  name: string;
  contact: string;
  attending: "yes" | "no" | "";
  adults: string;
  kids: string;
}

export function readRsvpInput(body: Record<string, unknown>): RsvpInput {
  const attending = clean(body.attending, 3);
  return {
    name: clean(body.name, 100).replace(/\s+/g, " "),
    contact: clean(body.contact, 200).replace(/\s+/g, " "),
    attending: attending === "yes" || attending === "no" ? attending : "",
    adults: clean(body.adults, 3),
    kids: clean(body.kids, 3),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]+$/;

/** "email" or "phone", or undefined if it's neither. */
export function contactType(contact: string): "email" | "phone" | undefined {
  if (EMAIL.test(contact)) return "email";
  const digits = contact.replace(/\D/g, "");
  if (PHONE.test(contact) && digits.length >= 7 && digits.length <= 15) return "phone";
  return undefined;
}

export function contactKey(contact: string): string {
  return contactType(contact) === "phone" ? "tel:" + contact.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") : "mail:" + contact.toLowerCase();
}

export interface ValidRsvp {
  name: string;
  contact: string;
  attending: boolean;
  adults: number;
  kids: number;
}

export function validateRsvp(input: RsvpInput): { ok: true; value: ValidRsvp } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  if (!input.name) errors.name = "Please tell us your name.";
  if (!input.contact) errors.contact = "Add a phone number or email so we can reach you.";
  else if (!contactType(input.contact)) errors.contact = "That doesn't look like a phone number or email.";
  if (!input.attending) errors.attending = "Will you be there?";
  const count = (v: string, fallback: number) => (v === "" ? fallback : /^\d+$/.test(v) ? Number(v) : NaN);
  const adults = input.attending === "yes" ? count(input.adults, 1) : 0;
  const kids = input.attending === "yes" ? count(input.kids, 0) : 0;
  if (!(adults >= 0 && adults <= MAX_GUESTS)) errors.adults = `Enter a number from 0 to ${MAX_GUESTS}.`;
  if (!(kids >= 0 && kids <= MAX_GUESTS)) errors.kids = `Enter a number from 0 to ${MAX_GUESTS}.`;
  if (!errors.adults && !errors.kids && input.attending === "yes" && adults + kids === 0) errors.adults = "How many people are coming?";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name: input.name, contact: input.contact, attending: input.attending === "yes", adults, kids } };
}

interface RsvpRow extends Omit<Rsvp, "attending"> {
  attending: number;
}
const toRsvp = (r: RsvpRow): Rsvp => ({ ...r, attending: r.attending === 1 });

/** Records an RSVP. Answering again with the same phone/email updates the earlier answer. */
export function saveRsvp(db: Db, inviteId: string, v: ValidRsvp): { rsvp: Rsvp; updated: boolean } {
  const key = contactKey(v.contact);
  const now = nowIso();
  const existing = db.prepare("SELECT id FROM rsvps WHERE invite_id = ? AND contact_key = ?").get(inviteId, key) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE rsvps SET name = ?, contact = ?, attending = ?, adults = ?, kids = ?, updated_at = ? WHERE id = ?").run(
      v.name,
      v.contact,
      v.attending ? 1 : 0,
      v.adults,
      v.kids,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      "INSERT INTO rsvps (id, invite_id, name, contact, contact_key, attending, adults, kids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(randomBase32(16), inviteId, v.name, v.contact, key, v.attending ? 1 : 0, v.adults, v.kids, now, now);
  }
  const rsvp = db.prepare("SELECT * FROM rsvps WHERE invite_id = ? AND contact_key = ?").get(inviteId, key) as unknown as RsvpRow;
  return { rsvp: toRsvp(rsvp), updated: !!existing };
}

export function getRsvp(db: Db, inviteId: string, id: string): Rsvp | undefined {
  const row = db.prepare("SELECT * FROM rsvps WHERE invite_id = ? AND id = ?").get(inviteId, id) as RsvpRow | undefined;
  return row && toRsvp(row);
}

export function listRsvps(db: Db, inviteId: string): Rsvp[] {
  return (db.prepare("SELECT * FROM rsvps WHERE invite_id = ? ORDER BY updated_at DESC").all(inviteId) as unknown as RsvpRow[]).map(toRsvp);
}
