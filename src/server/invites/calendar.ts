// Date formatting for invitation pages and calendar exports (.ics and Google Calendar links).

import { inviteTimes, type Invite } from "./store.ts";

/** "Saturday, November 14, 2026" and "4:00 – 7:00 PM EST", in the event's own time zone. */
export function displayWhen(inv: Invite): { date: string; time: string } {
  const { start, end } = inviteTimes(inv);
  const tz = inv.timezone;
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  if (!inv.ends_local) return { date, time: time.format(start) };
  return { date, time: time.formatRange(start, end) };
}

export function isPast(inv: Invite, now = Date.now()): boolean {
  return inviteTimes(inv).end.getTime() < now;
}

const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** RFC 5545 line folding: at most 75 octets per line, continuation lines start with a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function inviteIcs(inv: Invite, url: string, domain: string, now = new Date()): string {
  const { start, end } = inviteTimes(inv);
  const description = [inv.description, url].filter(Boolean).join("\n\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${domain}//muse-proxy invitations//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${inv.id}@${domain}`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText(inv.title)}`,
    `LOCATION:${icsText(inv.location)}`,
    `DESCRIPTION:${icsText(description)}`,
    `URL:${url}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(inv.title)}`,
    "TRIGGER:-PT2H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function googleCalendarUrl(inv: Invite, url: string): string {
  const { start, end } = inviteTimes(inv);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: inv.title,
    dates: `${icsStamp(start)}/${icsStamp(end)}`,
    location: inv.location,
    details: [inv.description, url].filter(Boolean).join("\n\n"),
    ctz: inv.timezone,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function mapsUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

/** A safe download name like "Emmas-5th-Birthday.ics". */
export function icsFilename(title: string): string {
  const base = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  return `${base || "event"}.ics`;
}
