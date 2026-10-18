# 02 — Muse Proxy: design and build plan

Status: **Approved 2026-10-10.**
Placeholders: `<dom>` = your domain. Hostname layout is Option A (§6.1): a single `muse.<dom>` serves the API, the mail host, and the mail domain (`<alias>@muse.<dom>`).

---

## 1. Goals and non-goals

**Goals**
1. A durable, always-on endpoint that Muse (outbound-only) connects to over a WebSocket and keeps open, receiving events in real time. Events are queued while Muse is offline and replayed on reconnect.
2. Receive email sent to random aliases `@muse.<dom>` and turn each message into an `email.received` event for Muse.
3. A small set of **named connectors** (starting with `usps.track`) that Muse can call to fetch data from sites that block it.
4. A **publish API** so your own scripts and services can push arbitrary events to Muse.
5. **Mutual authentication**: Muse can verify it's talking to *your* server, and the server can verify it's talking to *your* Muse.

**Non-goals (v1)**
- Sending email. The server is receive-only, which avoids deliverability and IP-reputation work.
- A generic HTTP proxy or "fetch any URL" endpoint. That would be an open proxy and an SSRF hole.
- Multi-user or multi-tenant support.
- A web UI. Administration is a CLI over SSH.

## 2. Muse runtime facts and assumptions

**Confirmed:** the Muse Helper runs in its **own Linux VM** and can install and run whatever it needs (runtimes, packages, long-lived scripts). So it can hold a WebSocket open, keep a private key on disk, and do Ed25519 signing. That makes the full mutual-auth design (§4) workable, and the bearer-token fallback is dropped.

| # | Remaining assumption | If false |
|---|---|---|
| A1 | The Muse VM stays running, or at least resumes, long enough to hold a connection. | Nothing breaks: events queue on the server and are replayed on reconnect (§5.2). The helper's supervisor restarts it after a VM resume. |
| A2 | Muse's Sentinel may ask for your approval the first time the helper reaches `muse.<dom>`. | Approve once (or allowlist the domain) during setup. |
| A3 | Muse treats the content of forwarded events as **untrusted data**, not instructions. | Required regardless. See §7.4 and §3a. |

## 3. Components

Everything runs as one TypeScript (Node 24 LTS, run directly via type stripping) service plus Caddy, plus a separate **browser container**, in Docker Compose on a single **GCP e2-micro** (1 GB, us-west1; see spec 01). Nothing in the app depends on the provider. Memory budget: ~300 MB for Caddy plus the app, and a 450 MB cap on the browser container (only while a page is loading). A 2 GB swap file is the safety net. If that proves too tight, resize to e2-small (2 GB) without changing anything else.

| Component | Responsibility | Key libs |
|---|---|---|
| **Caddy** | TLS for `muse.<dom>` (Let's Encrypt), reverse-proxies HTTPS/WSS to app `:8080`, HSTS. | Caddy 2 |
| **HTTP/WS server** | `/v1/stream` (WebSocket), `/v1/events/poll`, `/v1/rpc/*`, `/v1/publish`, `/healthz`. | Fastify + `@fastify/websocket` |
| **Auth module** | Ed25519 challenge-response, signed-request verification, nonce cache, key registry. | `node:crypto` (built-in Ed25519) |
| **Event store** | Append-only events with monotonically increasing `seq`, ack cursor per client, retention. | SQLite (`better-sqlite3`, WAL mode) |
| **SMTP ingest** | Listens on :25, STARTTLS (reuses Caddy's cert), active-alias check (no catch-all), size limit, SPF/DKIM/DMARC/ARC evaluation, parse → event. Stores raw `.eml` on disk. | `smtp-server`, `mailparser`, `mailauth` (all from the Nodemailer project) |
| **Connectors** | Allowlisted RPC methods with schema-validated params, per-method rate limits and caching. | `zod`, `undici` |
| **Browser container** | Headless Chromium for connectors that must scrape. Isolated: no secrets, no DB access, no inbound ports. Reachable only from the app on an internal Docker network. **Chromium is started on demand** for each call and exits afterwards, so it uses no memory while idle. One page at a time. Memory-capped. Optional egress through a US Tailscale exit node (§7.5). | `mcr.microsoft.com/playwright` image, Playwright `connect()` over WebSocket |
| **CLI** | `muse-proxy pair`, `keys list/revoke/rotate`, `publisher add`, `events tail`, `doctor`. | `commander` |
| **Muse Helper** | Runs in Muse's Linux VM. Connects, authenticates, verifies server, acks events, reconnects with backoff, exposes events and RPC locally to Muse. See §3a. | Node 22, same `protocol` package as the server |

## 3a. Muse Helper (runs in Muse's VM)

The helper is written in **TypeScript** (runs on Node ≥ 22), sharing the `protocol` package with the server so both sides use identical signing and canonicalization code. Muse can install Node itself, so there's no need for a Python port.

**Distribution:** the server hosts the bundled helper (a single `muse-helper.mjs` built with esbuild) at `GET /v1/helper/latest`, along with a detached Ed25519 signature from the **server key**. Muse already has the pinned server public key from pairing, so it verifies the bundle before running it. That means no private Git access is needed, and nobody else can slip in a tampered helper. Updates use the same path: `muse-helper self-update` checks the signature and swaps the file atomically.

**Install and run (done by Muse, following `docs/MUSE_SETUP.md`):**
1. Install Node 22, then download and verify the helper.
2. `muse-helper pair --url https://muse.<dom> --server-key <pubkey> --code <pairing code>` generates the client key in `~/.muse-proxy/client.key` (mode 0600) and registers the public half.
3. Run it under a supervisor: a systemd user service if systemd is available, otherwise a `while true` restart loop under `nohup`/`tmux`. A `@reboot` cron entry covers VM restarts.

**How Muse consumes things locally.** The helper is the only thing that talks to the server. Muse's other scripts and its agent loop talk to the helper:

| Interface | Use |
|---|---|
| `~/.muse-proxy/inbox/<seq>-<kind>.json` | Each verified event is written atomically (tmp + rename). Muse can read, process, and move files to `processed/`. Simple, and survives helper restarts. |
| `muse-helper events [--since N] [--kind email.*] [--follow]` | Prints or streams events as JSONL. |
| `muse-helper rpc usps.track '{"tracking_number":"…"}'` | One-shot connector call. Prints the JSON result. |
| `muse-helper status` | Connection state, last event seq, server fingerprint. |
| `~/.muse-proxy/hooks/on-event` (optional executable) | Runs per event with the event JSON on stdin, for push-style reactions. |
| `http://127.0.0.1:7878` (optional) | Local-only HTTP equivalent of the commands above, bound to loopback with a random token in `~/.muse-proxy/local.token`. |

The helper acks an event only after it's durably written to the inbox. Every payload marked `trust: "untrusted"` is written inside an envelope that labels it as external data (see §7.4).

`docs/MUSE_SETUP.md` is written **for Muse to read**: step-by-step install, pairing, service setup, the local interfaces above, and the rules for handling untrusted content.

## 4. Security model

### 4.1 Threats we design against
- Someone else connects to the WebSocket and reads your email or events.
- Someone impersonates your server to Muse (DNS hijack or typo-squat) to feed it malicious events.
- Replay of captured requests or handshakes.
- Your server is abused as an open relay, an open proxy, or an SSRF pivot.
- Malicious email content prompt-injects Muse.
- Leaked credentials. They must be revocable and rotatable without redeploying.

### 4.2 Keys and identities

| Key | Where the private part lives | Purpose |
|---|---|---|
| **Server identity key** (Ed25519) | VM only, `/var/lib/muse-proxy/server.key`, mode 0600 | Proves to Muse that it's your server, independent of TLS/DNS. Its public key is **pinned** in the Muse Helper config. |
| **Muse client key** (Ed25519) | Generated **inside Muse** and never leaves it | Proves to the server that it's your Muse. The server stores only the public key. |
| **Publisher keys** (Ed25519) | Your own scripts | Scoped to `publish` only. Can't read events or call connectors. |
| TLS certificate | Caddy | Transport encryption and baseline server authentication. |

Ed25519 means neither side ever holds the other's secret, so a database leak on the server leaks no usable credentials.

### 4.3 Pairing (one-time secret exchange)

1. On the server: `muse-proxy pair --name muse-main` prints:
   - a **pairing code**: ~140-bit random value, single-use, expires in 15 min, stored only as a SHA-256 hash
   - the **server public key** and its fingerprint (for example `SHA256:ab12…`)
2. You give Muse (via its secure storage or vault) the pairing code, the server URL, and the server public key.
3. The Muse Helper generates its own Ed25519 keypair and calls
   `POST /v1/pair { name, client_pubkey, proof }`, where `proof = HMAC-SHA256(key = sha256_hex(pairing_code), "muse-proxy/v1/pair|" + client_pubkey + "|" + name)`. Keying on the hash means the server never needs to store the code itself.
4. The server verifies the proof, burns the code, and stores `client_pubkey`. The response is signed by the server key. The helper verifies it against the pinned server public key.
5. Done. Afterwards, `muse-proxy keys list` shows the client fingerprint so you can confirm it matches what the helper logged.

The pairing endpoint is disabled unless a pairing code is outstanding, and it's rate-limited to 5 attempts per hour per IP.

**Manual alternative:** you copy the helper's public key into the server with `muse-proxy keys add`. No pairing endpoint is needed.

### 4.4 WebSocket handshake (mutual challenge-response)

`wss://muse.<dom>/v1/stream`. Nothing except the handshake is accepted until both sides are verified. The server closes the connection if auth doesn't finish within 5 s.

```
S → C  {"t":"hello","v":1,"server_nonce":<32B b64>,"server_time":<unix ms>}
C → S  {"t":"auth","key_id":<client fp>,"client_nonce":<32B b64>,"ts":<unix ms>,
        "resume_after":<last acked seq>,
        "sig": Ed25519_c("muse-proxy/v1/client-auth|muse.<dom>|"+server_nonce+"|"+client_nonce+"|"+ts)}
S → C  {"t":"auth_ok","session_id":<uuid>,
        "sig": Ed25519_s("muse-proxy/v1/server-auth|muse.<dom>|"+client_nonce+"|"+server_nonce+"|"+session_id)}
```

- The client rejects the session if `sig` doesn't verify against the **pinned** server public key. That's what lets Muse know it's your server, even if DNS or TLS were somehow subverted.
- The server rejects if `ts` is more than ±60 s off, the key is unknown or revoked, or the signature fails. Failures return a generic `auth_failed` and close code 4401. Repeated failures from one IP are rate-limited (fail2ban-style).
- Both nonces are fresh per connection, and the hostname is bound into the signed string, so captured handshakes can't be replayed or relayed elsewhere.

### 4.5 Signed HTTP requests (RPC, poll, publish)

Every non-WebSocket call carries:

```
X-MP-Key:       <key fingerprint>
X-MP-Timestamp: <unix ms>
X-MP-Nonce:     <16B b64>
X-MP-Signature: Ed25519( "muse-proxy/v1/req|" + METHOD + "|" + host + "|" + path?query + "|" + ts + "|" + nonce + "|" + sha256_hex(body) )
```

The server enforces ±60 s on the timestamp and rejects any nonce it has seen in the last 5 min (in-memory LRU plus SQLite). Responses include `X-MP-Server-Signature` over `status|sha256(body)|request nonce`, so the client can verify the response came from your server.

### 4.6 No bearer tokens

Muse can sign requests, so there are no shared bearer secrets anywhere in the system. Every credential is an Ed25519 keypair whose private half never leaves the machine that created it.

### 4.7 Event integrity

Each event is signed by the server key over its canonical JSON (RFC 8785 JCS). The helper verifies before handing events to Muse, so even something injected on the path can't masquerade as your server. This is cheap defense in depth on top of TLS.

### 4.8 Scopes

| Principal | Scopes |
|---|---|
| Muse client key | `stream`, `poll`, `rpc:*` (or a per-connector list), `ack` |
| Publisher key | `publish` (optionally restricted to certain `kind` prefixes) |
| Admin | Local CLI only, over SSH. No admin HTTP surface. |

### 4.9 Host hardening
- GCP VPC firewall rules: allow **25/tcp, 443/tcp, 80/tcp** (ACME HTTP-01 only, redirects to 443). **No public SSH:** 22/tcp is open only to Google's IAP range `35.235.240.0/20`, and you connect with `gcloud compute ssh --tunnel-through-iap`. Access is gated by your Google account and IAM. The GCP serial console is the break-glass fallback.
- SSH keys only, no root login, `unattended-upgrades`, Docker containers run as non-root with read-only root filesystems where possible.
- Secrets live in `/var/lib/muse-proxy` (0700), never in the repo or image. `.env` holds non-secret config only.
- Logs never contain email bodies, signatures, or tokens. They record metadata only (seq, kind, sizes, auth results).

## 5. Event pipeline and protocol

### 5.1 Event shape
```json
{
  "t": "event",
  "seq": 1042,
  "id": "evt_01J…",            // ULID
  "kind": "email.received",    // namespaced: email.*, publish.<name>.*, system.*
  "created_at": "2026-10-10T18:22:01Z",
  "source": "smtp" | "publisher:<name>" | "system",
  "trust": "untrusted" | "owner",   // see §7.4
  "payload": { … },
  "sig": "<server Ed25519 sig over JCS(event without sig)>"
}
```

### 5.2 Delivery semantics
- **At-least-once.** Events persist before they're pushed. The client sends `{"t":"ack","seq":N}` (cumulative). On reconnect it sends `resume_after`, and the server replays everything after that.
- The client deduplicates by `id`.
- Retention: events are kept for 30 days or until acked + 7 days, whichever is longer. Raw `.eml` is kept for 30 days. Both are configurable.

### 5.3 Keep-alive
- The server sends a WebSocket ping every 25 s, and the client must pong. The client also sends app-level `{"t":"ping"}` every 30 s, because some middleboxes only count data frames.
- The client reconnects with exponential backoff (1 s → 60 s cap, ±20% jitter).
- `system.connected` / `system.disconnected` are logged. If Muse has been disconnected for more than N minutes (default 30), the server pings an optional alert hook (for example ntfy.sh or a healthchecks.io URL).

### 5.4 RPC over the socket
```
C → S {"t":"req","id":"r1","method":"usps.track","params":{"tracking_number":"9400…"}}
S → C {"t":"res","id":"r1","ok":true,"result":{…},"sig":"…"}
```
The same methods are available as `POST /v1/rpc/<method>` with signed requests (§4.5) for one-shot use.

### 5.5 Publish API (your scripts → Muse)
`POST /v1/publish` with a signed request from a publisher key. The body is `{ kind, payload, dedupe_key? }`. `kind` is automatically prefixed with `publish.<publisher-name>.`. `trust` is `owner`. Max body size is 256 KB.

### 5.6 Long-poll (debug / emergency only)
`GET /v1/events/poll?after=<seq>&wait=50` returns up to 100 events or waits up to 50 s. Acks go through `POST /v1/ack`. It uses the same signed-request auth. It isn't needed for normal operation, but it's handy for debugging with `curl`-style tools and costs little to keep.

## 6. Email ingest

### 6.1 Hostnames and DNS (Cloudflare proxy **off** for mail records)

**Decision pending.** Each name has one job:

| Name | Purpose | Needed? |
|---|---|---|
| **API host** (e.g. `muse.<dom>`) | HTTPS + WebSocket endpoint the helper connects to, plus the publish API and helper download. Gets a TLS cert. | Yes |
| **Mail host** (e.g. `mx.<dom>`) | The hostname an MX record points to. MX targets must be a hostname with an A record, not an IP or CNAME. Also the name on the SMTP TLS cert and PTR. | Can be the **same** as the API host |
| **Mail domain** (e.g. `in.<dom>`) | The part after `@` in the addresses. Kept off the root `<dom>` so your existing mail is untouched. | Can be the **same** as the API host |

**Option A (recommended): one subdomain does everything**, e.g. `muse.<dom>`
```
muse.<dom>         A      <VM static IPv4>
muse.<dom>         MX 10  muse.<dom>
muse.<dom>         TXT    "v=spf1 -all"        ; we never send from it
_dmarc.muse.<dom>  TXT    "v=DMARC1; p=reject"
```
Addresses look like `<random>@muse.<dom>`. Fewest records, one cert.

**Option B: split names** (`muse.` for the API, `mx.` for the mail host, `in.` for addresses). The only benefit is being able to move mail to another machine later without changing addresses. That's rarely worth it here.

Notes:
- Subdomain names are **not secret**: every Let's Encrypt cert is published in Certificate Transparency logs. Obscurity comes from the address local part (§6.2), not the hostname.
- PTR/rDNS for the mail host is nice to have. GCP allows a custom PTR on a static IP once you verify domain ownership.

### 6.2 SMTP behavior (any sender, obscure addresses)
- **Any sender is accepted.** Spam is kept out by making addresses unguessable rather than by allowlisting senders:
  - Addresses are **random aliases** generated by the CLI: `muse-proxy alias add --label packages` → e.g. `pkg-7hq3k9vx2m@muse.<dom>` (~50 bits of randomness). Each alias carries its label into the event so Muse knows its intended purpose.
  - **No catch-all.** Any recipient that isn't an active alias gets `550 5.1.1` at `RCPT TO`, before the message body is accepted. That defeats dictionary attacks (`info@`, `admin@`, …).
  - If an alias leaks and starts getting spam: `muse-proxy alias revoke <alias>`, then create a new one. Optional per-alias rate limit (default 50 messages/day).
- Receive-only. Relaying is never allowed.
- STARTTLS is offered, using the Caddy-managed cert. Certificates are reloaded on file change.
- Limits: 10 MB per message, 20 recipients, 5 concurrent connections per IP, a short timeout.
- Each message is checked with `mailauth` for SPF, DKIM, DMARC, and ARC:
  - DMARC `fail` where the sender's policy is `p=reject` → reject at SMTP time (forged mail).
    Exception: forwarded mail (e.g. a Gmail filter) often breaks the original DKIM and SPF. If the message has a valid **ARC** chain whose newest seal is from a trusted provider (Google, Microsoft, Proton, Fastmail, iCloud, Yahoo; `MP_ARC_TRUSTED_SEALERS`) and that seal recorded `dmarc=pass`, it's accepted and `auth.arc_vouched_by` names the provider. Rejections are logged with the From domain and auth results.
  - Everything else is accepted, with the results recorded in `auth` so Muse can weigh them.
  - Optional DNSBL check (Spamhaus ZEN via a local unbound resolver). Off by default; we'll turn it on if spam appears.
- The event payload contains `alias`, `alias_label`, `from`, `to`, `subject`, `date`, `message_id`, `auth` (spf/dkim/dmarc results), `text` (plain text, truncated to 100 KB), `html_to_text` if there's no text part, and an `attachments[]` list (name, type, size, sha256). Attachment bytes aren't included in the event. Muse can fetch them with `rpc: email.attachment {event_id, sha256}` (size-capped, allowlisted content types).
- Every email event is `trust: "untrusted"` (see §7.4). Accepting any sender makes this essential.

### 6.3 Ways to use it
- Give an alias directly to services (shipping notifications, newsletters, receipts).
- Auto-forward selected Gmail mail to an alias with a Gmail filter.
- Sign up for **USPS Informed Delivery** (free) and point its daily digest to an alias. Muse then learns about incoming packages automatically and can call `usps.track` on them.

## 7. Connectors (fetch proxies)

### 7.1 Framework
Each connector is a module with:
```ts
{ name: "usps.track",
  params: zod schema,                  // strict validation, e.g. /^[A-Z0-9]{10,35}$/
  rateLimit: { perMinute, perDay },
  cacheTtl: seconds,
  run(params, ctx): Promise<Result> }  // ctx gives a pre-configured HTTP client with host allowlist
```
- The outbound HTTP client only reaches hosts the connector declares (for example `apis.usps.com`). That prevents SSRF even if a connector has a bug.
- Results are normalized JSON. Raw HTML is never passed through.
- Errors are typed (`not_found`, `upstream_unavailable`, `rate_limited`, `invalid_params`).

### 7.2 `usps.track` (first connector)
- **Primary:** the official **USPS Tracking API v3.x** (`developers.usps.com`), using OAuth2 client credentials.
  - **Account needed:** a **USPS Business Account**. It's **free**, and individuals can create one (no company required). Then create an app in the Developer Portal. The default "Public Access" product includes Tracking.
  - **No CRID, Mailer ID, or payment account is needed for tracking.** Those are only needed for creating labels. USPS states tracking data access is **no-cost**.
  - Tokens are cached until expiry.
- **Risk:** USPS published "Tracking API Access Control Changes" (Feb–Apr 2026), and the details weren't publicly readable. A consumer account might get less detail for packages it didn't ship. Phase 5 starts with a spike to confirm what we get for inbound packages.
- **Fallbacks** (behind the same connector interface, picked by config):
  1. A tracking aggregator API with a free tier (for example Ship24 or 17TRACK).
  2. Headless Playwright scraping of usps.com via the browser container, First `direct` (GCP US IP). If usps.com's bot protection blocks the datacenter IP, switch to the `us-home` egress (§7.5).
- Output:
  ```json
  { "tracking_number":"…","carrier":"USPS","status":"in_transit|delivered|…",
    "status_text":"…","expected_delivery":"…","events":[{"time":"…","location":"…","description":"…"}],
    "source":"usps_api", "fetched_at":"…" }
  ```
- Cache for 10 min. Rate limit 30/hour (below USPS's default quota).

### 7.3 Future connectors
Adding one means writing a module and adding the method to the Muse key's scopes. There are no new endpoints or auth changes. Optionally, a `track.any` connector could later dispatch by carrier.

### 7.4 Prompt-injection hygiene
Email and fetched web content are attacker-controllable. Every event has `trust: "untrusted"` unless it comes from a publisher key you own. The Muse Helper should present untrusted payloads to Muse as **quoted data**, not as instructions. A recommended wrapper and guidance will ship in the helper README. The server also strips HTML, tracking pixels, and hidden text, and truncates long bodies.

### 7.5 Browser-based connectors
For sites with no usable API, a connector can request a browser session from the browser container:
- The app connects with `chromium.connect(ws://browser:3000)` on an internal-only Docker network. A fresh **incognito context** is used per call and destroyed afterwards, so cookies never persist between calls (unless a connector explicitly opts into a named, persisted profile, e.g. for a site that needs a login).
- The connector extracts specific fields with selectors and returns normalized JSON. Page HTML or screenshots are never passed through to Muse by default.
- Request interception blocks images, media, and fonts to save memory and bandwidth. A navigation allowlist per connector stops the browser from following redirects to unexpected domains.
- Resource limits for the 1 GB e2-micro: Chromium is launched per call with `--single-process`-style low-memory flags and closed afterwards. **One concurrent page**, with other calls queued (queue depth 5, then `rate_limited`). 45 s timeout per call, since the shared CPU is slow. The container is hard-capped at 450 MB.
- **Egress options** (per connector, set in config):
  - `direct` (default): the GCP us-west1 IP. US-based, so no geo-blocking, but some bot-protection systems block cloud IP ranges.
  - `us-home`: through a **Tailscale exit node** on a machine at your home, giving a US residential IP. The browser container runs its own `tailscale` sidecar using that exit node, so only browser traffic goes through your home connection. The app and API calls stay direct.
- Rate limits for scraping connectors are conservative (default 10/hour) to look like normal usage.

## 8. Repository layout (proposed)
```
muse-proxy/
  docs/specs/                 ← these documents
  docs/MUSE_SETUP.md          ← instructions written for Muse to follow
  packages/
    protocol/                 shared types, canonical JSON, signing/verification
    server/                   Fastify app, SMTP ingest, store, connectors, CLI
    helper/                   Muse Helper (bundled to one signed .mjs, served by the server)
  deploy/
    docker-compose.yml
    Caddyfile
    cloud-init.yaml           VM bootstrap (users, 2 GB swap, docker, unattended-upgrades)
    gcp/                      gcloud script: e2-micro in us-west1-b, pd-standard 30 GB, static IP, firewall rules (25/80/443, 22 from IAP only), $5 budget alert
    backup.sh                 nightly SQLite .backup → encrypted (age) → off-box (e.g. Cloudflare R2 free tier)
  .github/workflows/ci.yml    lint, typecheck, tests, build image
```

## 9. Build plan (phases)

| Phase | Deliverable | Done when |
|---|---|---|
| **0. Prereqs** (you) | GCP project with billing enabled (needed even for the free tier) and `gcloud` installed, Tailscale account (only if using the home exit node), domain DNS access, USPS developer account, decisions on the open questions | Tokens and credentials available |
| **1. Protocol package** | Types, JCS canonicalization, Ed25519 sign/verify, request-signing helpers. Unit tests including test vectors. | 100% coverage on the crypto paths |
| **2. Core server** | Event store, WebSocket hub with mutual handshake, ack/replay, publish API, long-poll, `/healthz`, CLI (`pair`, `keys`, `publisher`, `events tail`) | Integration tests: auth success and every failure mode, replay after disconnect, nonce replay rejected, scope enforcement |
| **3. Muse Helper** | Helper CLI and daemon: pairing, connect, verify server, ack, backoff, inbox and local interfaces, RPC, untrusted-content envelope, signed bundle and self-update. `docs/MUSE_SETUP.md`. | Runs in a throwaway Linux VM or container against the server. Survives server restarts and VM restarts with no lost or duplicated inbox entries. |
| **4. SMTP ingest** | smtp-server + mailauth + parsing → events. Recipient/sender allowlists, limits. | Tests with fixture .eml files (DKIM pass/fail, oversize, wrong recipient, relay attempt) |
| **5. Connectors + USPS + browser** | Connector framework, host-allowlisted HTTP client, browser container and session pool, `usps.track` (API first, browser fallback), optional Tailscale exit-node egress | Spike confirms API data availability. Recorded-response tests for the API. Browser fallback verified against the live site through the chosen egress. |
| **6. Deploy** | cloud-init, Compose, Caddyfile, DNS records, firewall, backups, uptime check, disconnect alert | Live: real email → Muse, `usps.track` from Muse, publish from your laptop |
| **7. Hardening review** | Run `/security-review`. Check open-relay testers, TLS (SSL Labs), port scan. | No high findings |

Rough effort: phases 1–4 are the bulk of the work. Each is a focused session or two.

## 10. Testing strategy
- Unit tests: crypto, canonicalization, signature strings (fixed test vectors, so a helper Muse writes or modifies itself can be checked against them).
- Integration tests: spin up the server in-process with a temp SQLite DB, then drive it with the reference helper and a raw SMTP client (`nodemailer` with direct transport).
- Negative tests are first-class: bad signatures, clock skew, reused nonces, revoked keys, unknown scopes, oversize mail, relay attempts, SSRF attempts against connectors.

## 11. Cloudflare-only variant (if chosen instead of a VM)
- The WebSocket hub becomes a **Durable Object** using the Hibernation API (idle connection isn't billed). The event store is DO SQLite.
- Email: **Email Routing** for `muse.<dom>` → **Email Worker** → `postal-mime` parse → appended to the DO. SPF/DKIM results come from Cloudflare's headers.
- Connectors run as Worker `fetch`. There's no Playwright fallback (except Cloudflare Browser Rendering, which is paid).
- The protocol, keys, pairing, and helper stay identical, so moving from a VM to Cloudflare (or the other way) later is cheap.

## 12. Implementation notes (2026-10-10)

- **`usps.track` was removed (2026-10-17).** The API route wasn't going to work, and neither does the browser fallback (below). The USPS sections above are kept as the original design only.
- **USPS browser fallback doesn't work.** Live test: tools.usps.com (Akamai) returned **HTTP 403 "Access Denied"** to headless Chromium, even from a US residential IP and with a standard Chrome user agent. Getting past that would mean bot-detection evasion, which is out of scope. The **USPS Tracking API is required** for `usps.track`. The browser pool stays as the base for scraping connectors on sites without aggressive bot protection.
- `usps.track` targets Tracking 3.2 (`/tracking/v3r2/`, configurable). Both the OAuth and tracking endpoints were confirmed live (401 without credentials).
- The **`us-home` Tailscale egress (§7.5) is not implemented yet.** Given the USPS result it's lower priority. Add it when a specific site needs a residential IP.
- Persistence uses Node's built-in `node:sqlite`, so there are no native modules to compile in the container.

## 13. Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Domain / hostnames | Option A: **`muse.example.com`** serves the API, the mail host, and the mail domain (aliases `@muse.example.com`). Set via config `MP_DOMAIN`, never hard-coded. |
| 2 | Muse Helper runtime | Muse has its own Linux VM. Helper is Node/TS (§3a). |
| 3 | Email scope | Any sender. Random unguessable aliases, no catch-all, revocable (§6.2). |
| 4 | Provider / region | **GCP e2-micro, us-west1 (`us-west1-b`)**, ~$3/mo. Hetzner had no cloud servers available. Upgrade path: resize to e2-small (~$15/mo) if the browser is too heavy. See spec 01. |
| 5 | SSH | GCP IAP tunnel. No public SSH port. |
| 6 | USPS | You'll create a free USPS Business Account plus a Developer Portal app before phase 5. |
