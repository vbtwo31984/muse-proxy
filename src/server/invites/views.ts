// Guest-facing invitation pages. No JavaScript: the RSVP form works with plain HTML + CSS.

import { html, type SafeHtml } from "../admin/html.ts";
import { displayWhen, googleCalendarUrl, isPast, mapsUrl } from "./calendar.ts";
import { MAX_GUESTS, type FieldErrors, type Invite, type Rsvp, type RsvpInput } from "./store.ts";

export interface PageLinks {
  /** https://domain/events/<id> */
  url: string;
  image?: string;
}

const icon = {
  calendar: html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  clock: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  pin: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  download: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>`,
};

function paragraphs(text: string): SafeHtml {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  return html`${blocks.map((b) => html`<p>${b.split("\n").map((line, i) => html`${i ? html`<br>` : ""}${line}`)}</p>`)}`;
}

function layout(inv: Invite, links: PageLinks, title: string, body: SafeHtml): string {
  const { date, time } = displayWhen(inv);
  const summary = `${date} · ${time} · ${inv.location}`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f6f1ea">
<title>${title}</title>
<meta name="description" content="${summary}">
<meta property="og:type" content="website">
<meta property="og:title" content="${inv.title}">
<meta property="og:description" content="${summary}">
<meta property="og:url" content="${links.url}">
${links.image ? html`<meta property="og:image" content="${links.image}"><meta name="twitter:card" content="summary_large_image">` : ""}
<link rel="stylesheet" href="/events/static/invite.css">
</head>
<body>
<main class="page">
<article class="card${links.image ? "" : " no-image"}">
  ${links.image ? html`<figure class="hero"><img class="backdrop" src="${new URL(links.image).pathname}" alt="" aria-hidden="true"><img class="photo" src="${new URL(links.image).pathname}" alt="" decoding="async"></figure>` : ""}
  <div class="content">
    ${body}
  </div>
</article>
</main>
</body>
</html>`.value;
}

function details(inv: Invite): SafeHtml {
  const { date, time } = displayWhen(inv);
  return html`<p class="eyebrow">You're invited</p>
    <h1>${inv.title}</h1>
    <ul class="facts">
      <li>${icon.calendar}<span>${date}</span></li>
      <li>${icon.clock}<span>${time}</span></li>
      <li>${icon.pin}<span>${inv.location}<a class="map" href="${mapsUrl(inv.location)}" target="_blank" rel="noopener noreferrer">Open in Maps</a></span></li>
    </ul>
    ${inv.description ? html`<div class="description">${paragraphs(inv.description)}</div>` : ""}`;
}

function err(errors: FieldErrors, name: string): SafeHtml | string {
  const e = errors[name];
  return e ? html`<p class="error" id="${name}-error">${e}</p>` : "";
}

const described = (errors: FieldErrors, name: string) => (errors[name] ? html` aria-invalid="true" aria-describedby="${name}-error"` : "");

export function invitePage(inv: Invite, links: PageLinks, form: { values?: Partial<RsvpInput>; errors?: FieldErrors } = {}): string {
  const v = form.values ?? {};
  const e = form.errors ?? {};
  let rsvp: SafeHtml;
  if (inv.closed_at || isPast(inv)) {
    rsvp = html`<section class="rsvp closed"><h2>RSVP</h2><p>${isPast(inv) ? "This event has already happened. Thanks for being part of it!" : "RSVPs for this event are closed."}</p></section>`;
  } else {
    rsvp = html`<section class="rsvp" id="rsvp">
      <h2>Will you join us?</h2>
      ${Object.keys(e).length ? html`<p class="error-summary" role="alert">Please check the highlighted fields.</p>` : ""}
      <form method="post" action="/events/${inv.id}/rsvp#rsvp" novalidate>
        <div class="field">
          <label for="name">Your name</label>
          <input id="name" name="name" type="text" autocomplete="name" maxlength="100" required value="${v.name ?? ""}"${described(e, "name")}>
          ${err(e, "name")}
        </div>
        <div class="field">
          <label for="contact">Phone or email</label>
          <input id="contact" name="contact" type="text" autocomplete="email" maxlength="200" required value="${v.contact ?? ""}"${described(e, "contact")}>
          ${err(e, "contact")}
          <p class="hint">Only the host sees this. Use the same one to change your answer later.</p>
        </div>
        <fieldset class="field attending"${described(e, "attending")}>
          <legend>Attending?</legend>
          <div class="choice">
            <input type="radio" id="attending-yes" name="attending" value="yes" required${v.attending === "yes" ? html` checked` : ""}>
            <label for="attending-yes"><span class="mark">✓</span> Yes, I'll be there</label>
            <input type="radio" id="attending-no" name="attending" value="no"${v.attending === "no" ? html` checked` : ""}>
            <label for="attending-no"><span class="mark">✕</span> Sorry, can't make it</label>
          </div>
          ${err(e, "attending")}
        </fieldset>
        <div class="counts">
          <div class="field">
            <label for="adults">Adults</label>
            <input id="adults" name="adults" type="number" inputmode="numeric" min="0" max="${MAX_GUESTS}" step="1" value="${v.adults || "1"}"${described(e, "adults")}>
            ${err(e, "adults")}
          </div>
          <div class="field">
            <label for="kids">Kids</label>
            <input id="kids" name="kids" type="number" inputmode="numeric" min="0" max="${MAX_GUESTS}" step="1" value="${v.kids || "0"}"${described(e, "kids")}>
            ${err(e, "kids")}
          </div>
        </div>
        <button type="submit">Send RSVP</button>
      </form>
    </section>`;
  }
  return layout(inv, links, inv.title, html`${details(inv)}${rsvp}`);
}

export function thanksPage(inv: Invite, links: PageLinks, r: Rsvp): string {
  const first = r.name.split(" ")[0];
  const party = [r.adults ? `${r.adults} adult${r.adults === 1 ? "" : "s"}` : "", r.kids ? `${r.kids} kid${r.kids === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  const { date, time } = displayWhen(inv);
  const body = r.attending
    ? html`<p class="eyebrow">RSVP received</p>
    <h1>Thank you, ${first}!</h1>
    <p class="lead">We can't wait to see you at <strong>${inv.title}</strong>. You're down for ${party}.</p>
    <ul class="facts">
      <li>${icon.calendar}<span>${date}</span></li>
      <li>${icon.clock}<span>${time}</span></li>
      <li>${icon.pin}<span>${inv.location}<a class="map" href="${mapsUrl(inv.location)}" target="_blank" rel="noopener noreferrer">Open in Maps</a></span></li>
    </ul>
    <div class="calendar">
      <a class="button" href="/events/${inv.id}/event.ics">${icon.download} Add to calendar</a>
      <a class="button secondary" href="${googleCalendarUrl(inv, links.url)}" target="_blank" rel="noopener noreferrer">Google Calendar</a>
    </div>
    <p class="hint">The calendar file works with Apple Calendar, Outlook and most other calendar apps.</p>`
    : html`<p class="eyebrow">RSVP received</p>
    <h1>Thanks for letting us know, ${first}.</h1>
    <p class="lead">We'll miss you at <strong>${inv.title}</strong>.</p>`;
  return layout(
    inv,
    links,
    `RSVP received · ${inv.title}`,
    html`${body}<p class="change"><a href="/events/${inv.id}#rsvp">Change your response</a></p>`,
  );
}

export function notFoundPage(): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Invitation not found</title>
<link rel="stylesheet" href="/events/static/invite.css">
</head>
<body>
<main class="page">
<article class="card no-image"><div class="content">
  <p class="eyebrow">Hmm</p>
  <h1>We couldn't find that invitation</h1>
  <p class="lead">Check that the link is complete, or ask the host to send it again.</p>
</div></article>
</main>
</body>
</html>`.value;
}
