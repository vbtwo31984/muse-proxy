import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createEnrollCode } from "../src/server/admin/passkeys.ts";
import { inviteIcs } from "../src/server/invites/calendar.ts";
import { contactKey, imageDir, inviteTimes, listRsvps, validateRsvp, zonedToUtc, type Invite } from "../src/server/invites/store.ts";
import type { RunningServer } from "../src/server/main.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { baseUrl, cleanup, DOMAIN, start, tempDir } from "./util.ts";

const ORIGIN = `https://${DOMAIN}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const sample: Invite = {
  id: "abcdefghijkmnpqr",
  title: "Emma's 5th Birthday, with cake; and games",
  description: "Bring a swimsuit.\nParking on Elm St.",
  location: "Sunny Park Pavilion, 12 Elm St, Springfield",
  starts_local: "2026-11-14T16:00",
  ends_local: "2026-11-14T19:00",
  timezone: "America/New_York",
  image: null,
  created_at: "",
  updated_at: "",
  closed_at: null,
};

describe("invitation helpers", () => {
  test("wall-clock times convert to UTC in the event's time zone, across DST", () => {
    assert.equal(zonedToUtc("2026-07-04T18:00", "America/New_York").toISOString(), "2026-07-04T22:00:00.000Z");
    assert.equal(zonedToUtc("2026-12-24T18:00", "America/New_York").toISOString(), "2026-12-24T23:00:00.000Z");
    assert.equal(zonedToUtc("2026-03-29T09:30", "Europe/Berlin").toISOString(), "2026-03-29T07:30:00.000Z");
    assert.equal(zonedToUtc("2026-01-01T00:00", "UTC").toISOString(), "2026-01-01T00:00:00.000Z");
    // No end time: two hours. End before start: the next day.
    const noEnd = inviteTimes({ starts_local: "2026-05-01T20:00", ends_local: null, timezone: "UTC" });
    assert.equal(noEnd.end.toISOString(), "2026-05-01T22:00:00.000Z");
    const late = inviteTimes({ starts_local: "2026-05-01T21:00", ends_local: "2026-05-01T01:00", timezone: "UTC" });
    assert.equal(late.end.toISOString(), "2026-05-02T01:00:00.000Z");
  });

  test("RSVP validation", () => {
    const ok = validateRsvp({ name: "Ann", contact: "ann@example.com", attending: "yes", adults: "2", kids: "3" });
    assert.deepEqual(ok, { ok: true, value: { name: "Ann", contact: "ann@example.com", attending: true, adults: 2, kids: 3 } });
    const no = validateRsvp({ name: "Bo", contact: "+1 (555) 123-4567", attending: "no", adults: "4", kids: "x" });
    assert.deepEqual(no, { ok: true, value: { name: "Bo", contact: "+1 (555) 123-4567", attending: false, adults: 0, kids: 0 } });
    const bad = validateRsvp({ name: "", contact: "hello", attending: "", adults: "1", kids: "0" });
    assert.ok(!bad.ok && bad.errors.name && bad.errors.contact && bad.errors.attending);
    const zero = validateRsvp({ name: "C", contact: "c@d.ef", attending: "yes", adults: "0", kids: "0" });
    assert.ok(!zero.ok && zero.errors.adults);
    const many = validateRsvp({ name: "C", contact: "c@d.ef", attending: "yes", adults: "99", kids: "-1" });
    assert.ok(!many.ok && many.errors.adults && many.errors.kids);
    // The same person, written differently.
    assert.equal(contactKey("+1 (555) 123-4567"), contactKey("555.123.4567"));
    assert.equal(contactKey("Ann@Example.com"), contactKey("ann@example.com"));
  });

  test(".ics output is a valid, escaped, folded VEVENT", () => {
    const ics = inviteIcs(sample, `${ORIGIN}/events/${sample.id}`, DOMAIN, new Date("2026-11-01T12:00:00Z"));
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
    assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
    assert.match(ics, /\r\nDTSTART:20261114T210000Z\r\n/);
    assert.match(ics, /\r\nDTEND:20261115T000000Z\r\n/);
    assert.match(ics, /\r\nUID:abcdefghijkmnpqr@muse\.test\r\n/);
    assert.match(ics, /\r\nSUMMARY:Emma's 5th Birthday\\, with cake\\; and games\r\n/);
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
    const unfolded = ics.replace(/\r\n /g, "");
    assert.match(unfolded, /DESCRIPTION:Bring a swimsuit\.\\nParking on Elm St\.\\n\\nhttps:\/\/muse\.test\/events\/abcdefghijkmnpqr/);
  });
});

describe("invitations end to end", () => {
  let dataDir: string;
  let server: RunningServer;
  let url: string;
  let cookie: string;
  let csrf: string;
  let ip = 0;
  const headers = (extra: Record<string, string> = {}) => ({ "x-forwarded-for": `203.0.113.${ip}`, ...extra });
  const get = (path: string, c = "") => fetch(`${url}${path}`, { headers: headers({ cookie: c }), redirect: "manual" });
  const postForm = (path: string, form: Record<string, string>, c = "") =>
    fetch(`${url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: headers({ cookie: c, "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams(form).toString(),
    });
  function multipart(path: string, fields: Record<string, string>, image?: Buffer, c = cookie): Promise<Response> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append("image", new Blob(image ? [new Uint8Array(image)] : []), image ? "party.png" : "");
    return fetch(`${url}${path}`, { method: "POST", redirect: "manual", headers: headers({ cookie: c }), body: fd });
  }
  const details = {
    title: "Emma's <b>5th</b> birthday",
    date: "2099-06-13",
    start: "16:00",
    end: "19:00",
    timezone: "America/Los_Angeles",
    location: "Sunny Park Pavilion, 12 Elm St",
    description: "Bring a swimsuit!\n\nCake at 5.",
  };

  async function createInvite(extra: Record<string, string> = {}, image: Buffer | undefined = PNG): Promise<string> {
    const res = await multipart("/admin/invites", { _csrf: csrf, ...details, ...extra }, image);
    assert.equal(res.status, 303, await res.clone().text());
    const m = /^\/admin\/invites\/([a-z2-9]{16})\?ok=invite_created$/.exec(res.headers.get("location")!);
    assert.ok(m, res.headers.get("location")!);
    return m[1]!;
  }

  before(async () => {
    dataDir = tempDir();
    server = await start(dataDir, { admin: { enabled: true, email: "you@example.com", sessionHours: 12, enrollMinutes: 15 } }, { smtp: false });
    url = baseUrl(server);
    const auth = new SoftAuthenticator(DOMAIN, ORIGIN);
    const { code } = createEnrollCode(server.db, 15);
    const post = (p: string, body: unknown) => fetch(`${url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const options = await (await post("/admin/enroll/options", { code })).json();
    const res = await post("/admin/enroll/verify", { code, name: "laptop", response: auth.register(options) });
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    csrf = /name="_csrf" value="([^"]+)"/.exec(await (await get("/admin", cookie)).text())![1]!;
  });

  beforeEach(() => {
    ip++;
  });

  after(async () => {
    await server.stop();
    cleanup(dataDir);
  });

  test("admin creates an invitation; guests see it at an unguessable link", async () => {
    const id = await createInvite();
    const admin = await (await get(`/admin/invites/${id}?ok=invite_created`, cookie)).text();
    assert.match(admin, new RegExp(`https://muse\\.test/events/${id}`));
    assert.match(admin, /Invitation created/);
    assert.match(await (await get("/admin", cookie)).text(), new RegExp(`href="/admin/invites/${id}"`));

    const res = await get(`/events/${id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
    const page = await res.text();
    assert.match(page, /Emma&#39;s &lt;b&gt;5th&lt;\/b&gt; birthday/);
    assert.doesNotMatch(page, /<b>5th<\/b>/);
    assert.match(page, /Saturday, June 13, 2099/);
    assert.match(page, /4:00\s*–\s*7:00\sPM PDT/);
    assert.match(page, /<p>Bring a swimsuit!<\/p><p>Cake at 5\.<\/p>/);
    assert.match(page, /name="attending" value="yes"/);
    assert.match(page, /name="kids"/);
    assert.match(page, /name="adults"/);
    assert.doesNotMatch(page, /<script/);

    const img = /<img class="photo" src="(\/events\/[^"]+\/image\/[^"]+)"/.exec(page)![1]!;
    assert.match(page, new RegExp(`<meta property="og:image" content="https://muse\\.test${img}">`));
    const picture = await get(img);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get("content-type"), "image/png");
    assert.match(picture.headers.get("cache-control")!, /immutable/);
    assert.deepEqual(Buffer.from(await picture.arrayBuffer()), PNG);
  });

  test("RSVP: validation errors keep what was typed; a valid answer becomes a Muse event", async () => {
    const id = await createInvite();
    const bad = await postForm(`/events/${id}/rsvp`, { name: "Ann <3", contact: "nope", attending: "yes", adults: "2", kids: "1" });
    assert.equal(bad.status, 400);
    const badPage = await bad.text();
    assert.match(badPage, /doesn&#39;t look like a phone number or email/);
    assert.match(badPage, /value="Ann &lt;3"/);

    const seq = server.events.lastSeq();
    const res = await postForm(`/events/${id}/rsvp`, { name: "Ann Lee", contact: "+1 555 123 4567", attending: "yes", adults: "2", kids: "3" });
    assert.equal(res.status, 303);
    const thanks = res.headers.get("location")!;
    assert.match(thanks, new RegExp(`^/events/${id}/thanks/[a-z2-9]{16}$`));

    const [event] = server.events.listAfter(seq);
    assert.ok(event);
    assert.equal(event.kind, "invite.rsvp");
    assert.equal(event.trust, "untrusted");
    assert.equal(event.source, `invite:${id}`);
    const payload = event.payload as Record<string, any>;
    assert.deepEqual(payload.invite, {
      id,
      title: details.title,
      starts_at: "2099-06-13T23:00:00.000Z",
      timezone: "America/Los_Angeles",
      location: details.location,
      url: `https://muse.test/events/${id}`,
    });
    assert.equal(payload.rsvp.name, "Ann Lee");
    assert.equal(payload.rsvp.contact_type, "phone");
    assert.equal(payload.rsvp.attending, true);
    assert.equal(payload.rsvp.adults, 2);
    assert.equal(payload.rsvp.kids, 3);
    assert.equal(payload.rsvp.updated, false);
    assert.deepEqual(payload.totals, { yes: 1, no: 0, adults: 2, kids: 3 });

    const page = await (await get(thanks)).text();
    assert.match(page, /Thank you, Ann!/);
    assert.match(page, /2 adults and 3 kids/);
    assert.match(page, new RegExp(`href="/events/${id}/event\\.ics"`));
    assert.match(page, /https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);

    const ics = await get(`/events/${id}/event.ics`);
    assert.equal(ics.status, 200);
    assert.equal(ics.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(ics.headers.get("content-disposition"), 'attachment; filename="Emmas-b5thb-birthday.ics"');
    const body = await ics.text();
    assert.match(body, /DTSTART:20990613T230000Z\r\nDTEND:20990614T020000Z/);

    // Answering again with the same number (formatted differently) updates the RSVP.
    const again = await postForm(`/events/${id}/rsvp`, { name: "Ann Lee", contact: "(555) 123-4567", attending: "no" });
    assert.equal(again.status, 303);
    assert.equal(again.headers.get("location"), thanks);
    const update = server.events.listAfter(seq).at(-1)!.payload as Record<string, any>;
    assert.equal(update.rsvp.updated, true);
    assert.equal(update.rsvp.attending, false);
    assert.deepEqual(update.totals, { yes: 0, no: 1, adults: 0, kids: 0 });
    assert.equal(listRsvps(server.db, id).length, 1);
    const sorry = await (await get(thanks)).text();
    assert.match(sorry, /Thanks for letting us know, Ann/);
    assert.doesNotMatch(sorry, /event\.ics/);

    const admin = await (await get(`/admin/invites/${id}`, cookie)).text();
    assert.match(admin, /Ann Lee/);
    assert.match(admin, /\(555\) 123-4567/);
  });

  test("closed and past events don't accept RSVPs", async () => {
    const id = await createInvite();
    assert.equal((await postForm(`/admin/invites/${id}/close`, { _csrf: csrf }, cookie)).status, 303);
    assert.match(await (await get(`/events/${id}`)).text(), /RSVPs for this event are closed/);
    const seq = server.events.lastSeq();
    const res = await postForm(`/events/${id}/rsvp`, { name: "Z", contact: "z@example.com", attending: "yes", adults: "1", kids: "0" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/events/${id}`);
    assert.equal(server.events.lastSeq(), seq);
    await postForm(`/admin/invites/${id}/reopen`, { _csrf: csrf }, cookie);
    assert.match(await (await get(`/events/${id}`)).text(), /Send RSVP/);

    const past = await createInvite({ date: "2001-01-01" });
    assert.match(await (await get(`/events/${past}`)).text(), /already happened/);
  });

  test("editing replaces the picture and deleting removes everything", async () => {
    const id = await createInvite();
    const before = readdirSync(imageDir(dataDir)).filter((f) => f.startsWith(id));
    assert.equal(before.length, 1);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
    const res = await multipart(`/admin/invites/${id}`, { _csrf: csrf, ...details, title: "Renamed" }, jpeg);
    assert.equal(res.headers.get("location"), `/admin/invites/${id}?ok=invite_saved`);
    const after = readdirSync(imageDir(dataDir)).filter((f) => f.startsWith(id));
    assert.equal(after.length, 1);
    assert.match(after[0]!, /\.jpg$/);
    assert.notEqual(after[0], before[0]);
    assert.match(await (await get(`/events/${id}`)).text(), /<h1>Renamed<\/h1>/);
    // The old picture URL is gone.
    assert.equal((await get(`/events/${id}/image/${before[0]}`)).status, 404);

    await multipart(`/admin/invites/${id}`, { _csrf: csrf, ...details, remove_image: "1" });
    assert.equal(readdirSync(imageDir(dataDir)).filter((f) => f.startsWith(id)).length, 0);
    assert.doesNotMatch(await (await get(`/events/${id}`)).text(), /og:image/);

    const del = await postForm(`/admin/invites/${id}/delete`, { _csrf: csrf }, cookie);
    assert.equal(del.headers.get("location"), "/admin?ok=invite_deleted#invites");
    assert.equal((await get(`/events/${id}`)).status, 404);
  });

  test("admin input is validated; uploads need a session and CSRF token; non-images are refused", async () => {
    const bad = await multipart("/admin/invites", { _csrf: csrf, ...details, title: "", date: "2026-02-30", timezone: "Mars/Olympus" });
    assert.equal(bad.status, 400);
    const page = await bad.text();
    assert.match(page, /Give the event a name/);
    assert.match(page, /Pick a date/);
    assert.match(page, /Pick a time zone/);

    const notImage = await multipart("/admin/invites", { _csrf: csrf, ...details }, Buffer.from("<svg onload=alert(1)>"));
    assert.equal(notImage.status, 400);
    assert.match(await notImage.text(), /isn&#39;t a JPEG, PNG, WebP or GIF/);

    const count = () => (server.db.prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number }).n;
    const n = count();
    assert.equal((await multipart("/admin/invites", { ...details }, PNG)).status, 403);
    assert.equal((await multipart("/admin/invites", { _csrf: "wrong", ...details }, PNG)).status, 403);
    assert.equal((await multipart("/admin/invites", { _csrf: csrf, ...details }, PNG, "")).status, 403);
    assert.equal(count(), n);
    assert.equal((await get("/admin/invites/new")).status, 303);
  });

  test("unknown ids are 404 and guessing is rate limited", async () => {
    const miss = await get("/events/aaaaaaaaaaaaaaaa");
    assert.equal(miss.status, 404);
    assert.match(await miss.text(), /couldn't find that invitation/);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await get(`/events/zzzzzzzzzzzzzzz${i % 10}`)).status;
    assert.equal(last, 429);
  });

  test("deleting an invitation keeps no stray picture files", async () => {
    const id = await createInvite();
    const file = readdirSync(imageDir(dataDir)).find((f) => f.startsWith(id))!;
    await postForm(`/admin/invites/${id}/delete`, { _csrf: csrf }, cookie);
    assert.ok(!existsSync(`${imageDir(dataDir)}/${file}`));
  });
});
