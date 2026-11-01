import type { AliasRecord, KeyRecord } from "../store.ts";
import type { Passkey } from "./passkeys.ts";
import { html, type SafeHtml } from "./html.ts";
import { invitesSection } from "./invites.ts";
import type { InviteSummary } from "../invites/store.ts";

export interface Flash {
  kind: "ok" | "err";
  text: string;
}

export interface SessionView {
  email: string;
  csrf: string;
  passkeyId: string;
}

export interface EventSummary {
  seq: number;
  kind: string;
  created_at: string;
  source: string;
  trust: string;
  from: string | null;
  subject: string | null;
  bytes: number;
}

export interface CursorView {
  key_id: string;
  name: string | null;
  acked_seq: number;
  updated_at: string;
}

export interface DashboardData {
  domain: string;
  fingerprint: string;
  version: string;
  connected: number;
  disconnectedMs: number;
  lastSeq: number;
  cursors: CursorView[];
  aliases: AliasRecord[];
  keys: KeyRecord[];
  events: EventSummary[];
  eventCount: number;
  passkeys: Passkey[];
  invites: (InviteSummary & { past: boolean })[];
}

export interface EventDetail {
  seq: number;
  id: string;
  kind: string;
  created_at: string;
  source: string;
  trust: string;
  payload: unknown;
}

function when(iso: string | null | undefined): string {
  return iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z").replace(/Z$/, " UTC") : "";
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

function csrfField(s: SessionView): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${s.csrf}">`;
}

export function layout(title: string, body: SafeHtml, session?: SessionView, opts: { webauthn?: boolean } = {}): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="stylesheet" href="/admin/static/admin.css">
${opts.webauthn ? html`<script src="/admin/static/webauthn.js" defer></script>` : ""}
<script src="/admin/static/admin.js" defer></script>
</head>
<body>
<header>
  <h1><a href="/admin">muse-proxy</a></h1>
  ${
    session
      ? html`<div class="who"><span>${session.email}</span>
    <form class="inline" method="post" action="/admin/logout">${csrfField(session)}<button class="small" type="submit">Sign out</button></form></div>`
      : ""
  }
</header>
<main>
${body}
</main>
</body>
</html>`.value;
}

export function loginPage(enrolled: boolean): string {
  return layout(
    "Sign in · muse-proxy",
    html`<div class="login">
  <section>
    <h2>Admin sign-in</h2>
    <p class="danger" id="passkey-error" role="alert" hidden></p>
    <p><button class="primary" type="button" data-passkey="login">Sign in with a passkey</button></p>
    <p class="muted">${
      enrolled
        ? "Uses Face ID, Touch ID or your device's screen lock."
        : html`No passkey is enrolled yet. On the server, run <span class="mono">mp admin-enroll</span> and open the link it prints.`
    }</p>
  </section>
</div>`,
    undefined,
    { webauthn: true },
  );
}

export function enrollPage(p: { code: string } | { error: string }): string {
  return layout(
    "Add a passkey · muse-proxy",
    html`<div class="login">
  <section>
    <h2>Add a passkey</h2>
    ${
      "error" in p
        ? html`<p class="danger">${p.error}</p>`
        : html`<p class="danger" id="passkey-error" role="alert" hidden></p>
    <form data-passkey="enroll" data-code="${p.code}">
      <input type="text" name="name" placeholder="Name, e.g. iPhone" maxlength="40" required autocomplete="off">
      <button class="primary" type="submit">Create passkey</button>
    </form>
    <p class="muted">The passkey is saved to this device (or your iCloud Keychain / password manager) and signs you in to this admin. This link works once.</p>`
    }
  </section>
</div>`,
    undefined,
    { webauthn: true },
  );
}

function flashBox(flash?: Flash): SafeHtml | string {
  return flash ? html`<div class="flash ${flash.kind}">${flash.text}</div>` : "";
}

function statusSection(d: DashboardData): SafeHtml {
  const keyNames = new Map(d.keys.map((k) => [k.key_id, k.name]));
  return html`<section>
  <h2>Status</h2>
  <div class="stats">
    <div class="stat"><div class="label">Muse helper</div><div class="value">${
      d.connected > 0
        ? html`<span class="ok">Connected${d.connected > 1 ? ` (${d.connected})` : ""}</span>`
        : html`<span class="warn">Offline ${ago(d.disconnectedMs)}</span>`
    }</div></div>
    <div class="stat"><div class="label">Last event seq</div><div class="value">${d.lastSeq}</div></div>
    <div class="stat"><div class="label">Events stored</div><div class="value">${d.eventCount}</div></div>
    <div class="stat"><div class="label">Version</div><div class="value mono">${d.version}</div></div>
  </div>
  ${
    d.cursors.length
      ? html`<h3>Ack positions</h3>
  <div class="table-wrap"><table>
    <tr><th>Client</th><th>Acked</th><th>Behind</th><th>Updated</th></tr>
    ${d.cursors.map(
      (c) => html`<tr><td>${keyNames.get(c.key_id) ?? c.name ?? c.key_id}</td><td>${c.acked_seq}</td><td>${Math.max(0, d.lastSeq - c.acked_seq)}</td><td class="nowrap">${when(c.updated_at)}</td></tr>`,
    )}
  </table></div>`
      : ""
  }
  <p class="muted">Domain <span class="mono">${d.domain}</span> · server key <span class="mono">${d.fingerprint}</span></p>
</section>`;
}

function aliasesSection(d: DashboardData, s: SessionView): SafeHtml {
  const active = d.aliases.filter((a) => !a.revoked_at);
  const revoked = d.aliases.filter((a) => a.revoked_at);
  return html`<section id="aliases">
  <h2>Email addresses</h2>
  ${
    active.length
      ? html`<div class="table-wrap"><table>
    <tr><th>Address</th><th>Label</th><th>Created</th><th></th></tr>
    ${active.map(
      (a) => html`<tr>
      <td class="mono">${a.local_part}@${d.domain}</td><td>${a.label}</td><td class="nowrap">${when(a.created_at)}</td>
      <td><form class="inline" method="post" action="/admin/aliases/revoke" data-confirm="Stop accepting mail for ${a.local_part}@${d.domain}?">
        ${csrfField(s)}<input type="hidden" name="alias" value="${a.local_part}"><button class="small danger" type="submit">Revoke</button></form></td>
    </tr>`,
    )}
  </table></div>`
      : html`<p class="muted">No active addresses.</p>`
  }
  <form class="row" method="post" action="/admin/aliases">
    ${csrfField(s)}
    <input type="text" name="label" placeholder="label, e.g. packages" pattern="[a-z0-9][a-z0-9\\-]{0,30}" required>
    <button class="primary" type="submit">Create address</button>
  </form>
  ${revoked.length ? html`<h3>Revoked</h3><p class="muted mono">${revoked.map((a) => `${a.local_part} (${a.label})`).join(", ")}</p>` : ""}
</section>`;
}

function eventsSection(d: DashboardData, s: SessionView): SafeHtml {
  return html`<section id="events">
  <h2>Recent events</h2>
  ${
    d.events.length
      ? html`<div class="table-wrap"><table>
    <tr><th>Seq</th><th>Time</th><th>Kind</th><th>Summary</th><th>Trust</th></tr>
    ${d.events.map(
      (e) => html`<tr>
      <td><a href="/admin/events/${e.seq}">${e.seq}</a></td>
      <td class="nowrap">${when(e.created_at)}</td>
      <td class="mono">${e.kind}</td>
      <td>${e.subject !== null || e.from !== null ? html`${e.subject ?? "(no subject)"} <span class="muted">— ${e.from ?? "?"}</span>` : html`<span class="muted">${e.source}, ${e.bytes} B</span>`}</td>
      <td>${e.trust}</td>
    </tr>`,
    )}
  </table></div>`
      : html`<p class="muted">No events.</p>`
  }
  ${
    d.eventCount > 0
      ? html`<form class="row" method="post" action="/admin/events/clear" data-confirm="Delete all ${d.eventCount} events and their stored emails? This can't be undone.">
    ${csrfField(s)}<button class="danger" type="submit">Delete all events</button>
  </form>`
      : ""
  }
</section>`;
}

function keysSection(d: DashboardData, s: SessionView): SafeHtml {
  return html`<section id="keys">
  <h2>Muse &amp; keys</h2>
  <div class="table-wrap"><table>
    <tr><th>Name</th><th>Role</th><th>Key ID</th><th>Scopes</th><th>Created</th><th></th></tr>
    ${d.keys.map(
      (k) => html`<tr class="${k.revoked_at ? "muted" : ""}">
      <td>${k.name}</td><td>${k.role}</td><td class="mono">${k.key_id}</td><td class="mono">${k.scopes.join(", ")}</td>
      <td class="nowrap">${when(k.created_at)}</td>
      <td>${
        k.revoked_at
          ? html`revoked ${when(k.revoked_at)}`
          : html`<form class="inline" method="post" action="/admin/keys/revoke" data-confirm="Revoke ${k.role} key ${k.name}? It will be disconnected and can't reconnect until re-paired.">
        ${csrfField(s)}<input type="hidden" name="key_id" value="${k.key_id}"><button class="small danger" type="submit">Revoke</button></form>`
      }</td>
    </tr>`,
    )}
  </table></div>
  <form class="row" method="post" action="/admin/pair">
    ${csrfField(s)}
    <input type="text" name="name" value="muse-main" pattern="[a-z0-9][a-z0-9\\-]{0,40}" required>
    <button type="submit">Create pairing code</button>
  </form>
</section>`;
}

function passkeysSection(d: DashboardData, s: SessionView): SafeHtml {
  const only = d.passkeys.length <= 1;
  return html`<section id="passkeys">
  <h2>Admin passkeys</h2>
  <div class="table-wrap"><table>
    <tr><th>Name</th><th>Created</th><th>Last used</th><th>ID</th><th></th></tr>
    ${d.passkeys.map(
      (p) => html`<tr>
      <td>${p.name}${p.id === s.passkeyId ? html` <span class="muted">(this session)</span>` : ""}</td>
      <td class="nowrap">${when(p.created_at)}</td><td class="nowrap">${when(p.last_used_at) || "never"}</td>
      <td class="mono">${p.id.slice(0, 12)}…</td>
      <td>${
        only
          ? ""
          : html`<form class="inline" method="post" action="/admin/passkeys/remove" data-confirm="Remove passkey ${p.name}? It won't be able to sign in any more.">
        ${csrfField(s)}<input type="hidden" name="id" value="${p.id}"><button class="small danger" type="submit">Remove</button></form>`
      }</td>
    </tr>`,
    )}
  </table></div>
  <p class="muted">To add one (e.g. for another device), run <span class="mono">mp admin-enroll</span> and open the link on that device.</p>
</section>`;
}

export function dashboardPage(d: DashboardData, s: SessionView, flash?: Flash): string {
  return layout(
    "muse-proxy admin",
    html`${flashBox(flash)}${statusSection(d)}${invitesSection(d.invites)}${aliasesSection(d, s)}${eventsSection(d, s)}${keysSection(d, s)}${passkeysSection(d, s)}`,
    s,
  );
}

export function pairPage(p: { name: string; code: string; expiresAt: number; url: string; serverKey: string }, s: SessionView): string {
  const command = `muse-helper pair --url ${p.url} --server-key ${p.serverKey} --code ${p.code} --name ${p.name}`;
  return layout(
    "Pairing code · muse-proxy",
    html`<section>
  <h2>Pairing code for ${p.name}</h2>
  <p>Single use, expires ${when(new Date(p.expiresAt).toISOString())}. This page isn't saved; copy what you need now.</p>
  <dl class="meta">
    <dt>url</dt><dd class="mono">${p.url}</dd>
    <dt>server key</dt><dd class="mono">${p.serverKey}</dd>
    <dt>code</dt><dd class="mono">${p.code}</dd>
  </dl>
  <h3>Muse runs</h3>
  <pre>${command}</pre>
  <p><a href="/admin#keys">Back</a></p>
</section>`,
    s,
  );
}

interface EmailPayload {
  from?: string[];
  to?: string[];
  cc?: string[];
  reply_to?: string[];
  subject?: string | null;
  date?: string | null;
  alias?: string | null;
  alias_label?: string | null;
  envelope_from?: string | null;
  remote_ip?: string | null;
  auth?: Record<string, string>;
  attachments?: { filename?: string | null; content_type?: string; size?: number }[];
  text?: string;
  text_truncated?: boolean;
}

export function eventPage(e: EventDetail, s: SessionView): string {
  let body: SafeHtml;
  if (e.kind === "email.received" && e.payload && typeof e.payload === "object") {
    const p = e.payload as EmailPayload;
    const { text, ...rest } = p;
    body = html`<dl class="meta">
    <dt>From</dt><dd>${(p.from ?? []).join(", ")}</dd>
    <dt>To</dt><dd>${(p.to ?? []).join(", ")}</dd>
    ${p.cc?.length ? html`<dt>Cc</dt><dd>${p.cc.join(", ")}</dd>` : ""}
    <dt>Subject</dt><dd>${p.subject ?? "(no subject)"}</dd>
    <dt>Date</dt><dd>${p.date ?? ""}</dd>
    <dt>Address</dt><dd class="mono">${p.alias ?? ""} ${p.alias_label ? html`<span class="muted">(${p.alias_label})</span>` : ""}</dd>
    <dt>Auth</dt><dd class="mono">${Object.entries(p.auth ?? {}).map(([k, v]) => `${k}=${v}`).join("  ")}</dd>
    ${p.attachments?.length ? html`<dt>Attachments</dt><dd>${p.attachments.map((a) => `${a.filename ?? "(unnamed)"} · ${a.content_type ?? "?"} · ${a.size ?? "?"} B`).join("; ")}</dd>` : ""}
  </dl>
  <h3>Text${p.text_truncated ? " (truncated)" : ""}</h3>
  <pre>${text ?? ""}</pre>
  <details><summary class="muted">Raw metadata</summary><pre>${JSON.stringify(rest, null, 2)}</pre></details>`;
  } else {
    body = html`<pre>${JSON.stringify(e.payload, null, 2)}</pre>`;
  }
  return layout(
    `Event ${e.seq} · muse-proxy`,
    html`<section>
  <h2>Event ${e.seq} <span class="muted mono">${e.kind}</span></h2>
  <p class="muted">${when(e.created_at)} · source ${e.source} · trust ${e.trust} · <span class="mono">${e.id}</span></p>
  ${body}
  <p><a href="/admin#events">Back</a></p>
</section>`,
    s,
  );
}
