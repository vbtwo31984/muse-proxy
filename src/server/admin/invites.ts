// Admin pages for invitations: list (on the dashboard), create/edit form and the RSVP list.

import { displayWhen } from "../invites/calendar.ts";
import type { FieldErrors, Invite, InviteInput, InviteSummary, Rsvp } from "../invites/store.ts";
import { html, type SafeHtml } from "./html.ts";
import { layout, type Flash, type SessionView } from "./views.ts";

const csrfField = (s: SessionView) => html`<input type="hidden" name="_csrf" value="${s.csrf}">`;
const flashBox = (flash?: Flash) => (flash ? html`<div class="flash ${flash.kind}">${flash.text}</div>` : "");
const when = (iso: string | null) => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z").replace(/Z$/, " UTC") : "");

function status(inv: Invite & { past?: boolean }): SafeHtml {
  if (inv.closed_at) return html`<span class="badge">RSVPs closed</span>`;
  if (inv.past) return html`<span class="badge">Past</span>`;
  return html`<span class="badge ok">Open</span>`;
}

export function invitesSection(invites: (InviteSummary & { past: boolean })[]): SafeHtml {
  return html`<section id="invites">
  <h2>Invitations</h2>
  ${
    invites.length
      ? html`<div class="table-wrap"><table>
    <tr><th>Event</th><th>When</th><th>Going</th><th>Not going</th><th></th></tr>
    ${invites.map((i) => {
      const { date, time } = displayWhen(i);
      return html`<tr>
      <td><a href="/admin/invites/${i.id}">${i.title}</a></td>
      <td>${date}<br><span class="muted">${time}</span></td>
      <td>${i.yes} <span class="muted">(${i.adults} adults, ${i.kids} kids)</span></td>
      <td>${i.no}</td>
      <td>${status(i)}</td>
    </tr>`;
    })}
  </table></div>`
      : html`<p class="muted">No invitations yet.</p>`
  }
  <p><a class="button primary" href="/admin/invites/new">New invitation</a></p>
</section>`;
}

export function inviteFormPage(
  p: { inv?: Invite; values: InviteInput; errors: FieldErrors; timezones: string[]; isNew: boolean },
  s: SessionView,
): string {
  const { values: v, errors: e } = p;
  const err = (name: string) => (e[name] ? html`<p class="danger field-error">${e[name]}</p>` : "");
  const action = p.inv ? `/admin/invites/${p.inv.id}` : "/admin/invites";
  return layout(
    `${p.inv ? "Edit" : "New"} invitation · muse-proxy`,
    html`<section>
  <h2>${p.inv ? html`Edit “${p.inv.title}”` : "New invitation"}</h2>
  ${Object.keys(e).length ? html`<div class="flash err">Please fix the highlighted fields.</div>` : ""}
  <form class="stack" method="post" action="${action}" enctype="multipart/form-data" data-invite-form${p.isNew ? html` data-guess-timezone` : ""}>
    ${csrfField(s)}
    <label>Event name
      <input type="text" name="title" maxlength="120" required value="${v.title}" placeholder="Emma's 5th birthday">
      ${err("title")}
    </label>
    <div class="grid3">
      <label>Date
        <input type="date" name="date" required value="${v.date}">
        ${err("date")}
      </label>
      <label>Starts
        <input type="time" name="start" required value="${v.start}">
        ${err("start")}
      </label>
      <label><span>Ends <span class="muted">(optional)</span></span>
        <input type="time" name="end" value="${v.end}">
        ${err("end")}
      </label>
    </div>
    <label>Time zone
      <select name="timezone" required>
        ${p.timezones.map((tz) => html`<option value="${tz}"${tz === v.timezone ? html` selected` : ""}>${tz.replace(/_/g, " ")}</option>`)}
      </select>
      ${err("timezone")}
    </label>
    <label>Location
      <input type="text" name="location" maxlength="300" required value="${v.location}" placeholder="Name and address, e.g. Sunny Park Pavilion, 12 Elm St, Springfield">
      ${err("location")}
    </label>
    <label><span>Details <span class="muted">(optional)</span></span>
      <textarea name="description" rows="6" maxlength="4000" placeholder="What to bring, parking, dress code…">${v.description}</textarea>
    </label>
    <div>
      <label><span>Picture <span class="muted">(JPEG, PNG, WebP or GIF, up to 15 MB)</span></span>
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif" data-max-bytes="${15 * 1024 * 1024}">
        ${err("image")}
      </label>
      ${
        p.inv?.image
          ? html`<div class="current-image">
        <img src="/events/${p.inv.id}/image/${p.inv.image}" alt="Current picture">
        <label class="check"><input type="checkbox" name="remove_image" value="1"> Remove this picture</label>
      </div>`
          : ""
      }
    </div>
    <p class="actions">
      <button class="primary" type="submit">${p.inv ? "Save changes" : "Create invitation"}</button>
      <a href="${p.inv ? `/admin/invites/${p.inv.id}` : "/admin#invites"}">Cancel</a>
    </p>
  </form>
</section>`,
    s,
  );
}

export function inviteDetailPage(p: { inv: InviteSummary & { past: boolean }; rsvps: Rsvp[]; url: string }, s: SessionView, flash?: Flash): string {
  const { inv, rsvps } = p;
  const { date, time } = displayWhen(inv);
  return layout(
    `${inv.title} · muse-proxy`,
    html`${flashBox(flash)}<section>
  <h2>${inv.title} ${status(inv)}</h2>
  <div class="invite-head">
    ${inv.image ? html`<img class="thumb" src="/events/${inv.id}/image/${inv.image}" alt="">` : ""}
    <dl class="meta">
      <dt>When</dt><dd>${date}, ${time}</dd>
      <dt>Where</dt><dd>${inv.location}</dd>
      <dt>Link</dt><dd><input type="text" class="mono link" readonly value="${p.url}" data-select-on-focus>
        <button class="small" type="button" data-copy="${p.url}">Copy</button> <a href="${p.url}" target="_blank" rel="noopener">Open</a></dd>
    </dl>
  </div>
  <div class="stats">
    <div class="stat"><div class="label">Going</div><div class="value ok">${inv.yes}</div></div>
    <div class="stat"><div class="label">Adults</div><div class="value">${inv.adults}</div></div>
    <div class="stat"><div class="label">Kids</div><div class="value">${inv.kids}</div></div>
    <div class="stat"><div class="label">Not going</div><div class="value">${inv.no}</div></div>
  </div>
  <form class="row" method="get" action="/admin/invites/${inv.id}/edit"><button type="submit">Edit details</button></form>
</section>
<section>
  <h2>RSVPs</h2>
  ${
    rsvps.length
      ? html`<div class="table-wrap"><table>
    <tr><th>Name</th><th>Contact</th><th>Attending</th><th>Adults</th><th>Kids</th><th>Answered</th></tr>
    ${rsvps.map(
      (r) => html`<tr>
      <td>${r.name}</td><td>${r.contact}</td>
      <td>${r.attending ? html`<span class="ok">Yes</span>` : html`<span class="muted">No</span>`}</td>
      <td>${r.attending ? r.adults : ""}</td><td>${r.attending ? r.kids : ""}</td>
      <td class="nowrap">${when(r.updated_at)}</td>
    </tr>`,
    )}
  </table></div>`
      : html`<p class="muted">No responses yet. Send the link above to your guests.</p>`
  }
</section>
<section>
  <h2>Manage</h2>
  <form class="row" method="post" action="/admin/invites/${inv.id}/${inv.closed_at ? "reopen" : "close"}">
    ${csrfField(s)}
    <button type="submit">${inv.closed_at ? "Reopen RSVPs" : "Close RSVPs"}</button>
    <span class="muted">${inv.closed_at ? "Guests can see the invitation but can't answer." : "Guests can still see the invitation after you close it."}</span>
  </form>
  <form class="row" method="post" action="/admin/invites/${inv.id}/delete" data-confirm="Delete “${inv.title}” and its ${rsvps.length} RSVP(s)? The link will stop working. This can't be undone.">
    ${csrfField(s)}<button class="danger" type="submit">Delete invitation</button>
  </form>
  <p><a href="/admin#invites">Back</a></p>
</section>`,
    s,
  );
}
