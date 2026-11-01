# Deploying muse-proxy (runbook)

Target: GCP e2-micro (free tier) in `us-west1-b`, domain `muse.example.com`, about $3/month (static IPv4).

> **Day-to-day admin:** use `bin/mp` (run `bin/mp help`). Copy `.mp.env.example` to `.mp.env` (gitignored) and set your
> project, zone, VM and domain there; then you don't need any of the gcloud commands below. Examples: `mp status`, `mp alias add packages`, `mp events`,
> `mp events body 6`, `mp env set MP_ALERT_URL` (prompts, hidden), `mp logs -f`, `mp deploy`, `mp dns`.
See `docs/specs/` for the reasoning.

## 0. Prerequisites (once)

- A GCP project with billing enabled (required even for the free tier) and the `gcloud` CLI logged in.
- Your billing account ID, for the $5 budget alert: `gcloud billing accounts list`.
- DNS access for your domain.

## 1. Provision the VM

```bash
GCP_PROJECT=<project> MP_DOMAIN=<domain> BILLING_ACCOUNT=<billing-account-id> deploy/gcp/provision.sh
```

This creates a dedicated VPC (no default allow-all SSH), firewall rules for 25/80/443 (plus 22 from IAP only),
a static IP, the e2-micro (pd-standard 30 GB, Debian 13, Shielded VM, OS Login), and a $5 budget alert.
The startup script installs Docker, adds 2 GB of swap, and enables unattended upgrades.

## 2. DNS (Cloudflare, all records **DNS only**, grey cloud)

| Name | Type | Value |
|---|---|---|
| `muse` | A | *static IP printed by provision.sh* |
| `muse` | MX (priority 10) | `muse.example.com` |
| `muse` | TXT | `v=spf1 -all` |
| `_dmarc.muse` | TXT | `v=DMARC1; p=reject` |

Proxying must stay off: mail (port 25) can't go through Cloudflare's HTTP proxy, and Caddy needs the real IP to get its certificate.

## 3. Server config

```bash
gcloud compute ssh muse-proxy --zone us-west1-b --tunnel-through-iap
sudo install -m 600 /dev/null /opt/muse-proxy/.env && sudo nano /opt/muse-proxy/.env   # contents: deploy/.env.example
```

At minimum, set `MP_DOMAIN=muse.example.com` and `ACME_EMAIL`. Optional settings: `MP_ALERT_URL` (e.g. a private ntfy.sh topic)
for a disconnect alert.

## 4. Deploy (and every later update)

```bash
GCP_PROJECT=<project> deploy/deploy.sh
```

This ships the committed `HEAD` over IAP, then runs `docker compose up -d --build` on the VM. The first build takes a few minutes on the e2-micro.
Check it: `curl https://muse.example.com/healthz`.

### Keeping it up to date

- **VM OS:** unattended-upgrades installs Debian security updates and Docker's packages daily. When an update needs a
  reboot (kernel, libc), the VM reboots at 11:00 UTC and the containers come back on their own (`startup.sh`). A
  Docker upgrade restarts the containers too, around 06:00–07:00 UTC.
- **Dependencies and image versions:** Dependabot opens PRs weekly for npm packages, the Dockerfile base images and
  the Caddy image. Once CI passes, merge, then `git pull && mp deploy`.
- **Base image OS patches:** upstream republishes pinned tags like `node:24.21.0-trixie-slim` with Debian fixes.
  `mp update` (or `deploy/deploy.sh --pull`) fetches them again and redeploys. Run it every month or so.

## 5. Pair Muse

```bash
GCP_PROJECT=<project> deploy/admin.sh pair
```

Give Muse `docs/MUSE_SETUP.md` plus the three values printed (URL, server key, code). After Muse pairs, confirm the fingerprint:

```bash
GCP_PROJECT=<project> deploy/admin.sh keys list
```

## 6. Email addresses

```bash
GCP_PROJECT=<project> deploy/admin.sh alias add --label packages
#   packages-7hq3k9vx2m4b@muse.example.com
```

Use it for shipping notifications, USPS Informed Delivery, or a Gmail auto-forward filter. Mail to any address that
isn't an active alias is rejected. If an address gets spam: `deploy/admin.sh alias revoke <address>` and create a new one.

## 7. Publishing your own events (optional)

On your laptop:

```bash
npm run -s build:helper
node dist/muse-publish.mjs init --url https://muse.example.com --server-key <server key> --name laptop
GCP_PROJECT=<project> deploy/admin.sh publisher add --name laptop --pubkey <printed key>
echo '{"text":"pick up dry cleaning"}' | node dist/muse-publish.mjs send --kind reminder
```

## 8. Backups (optional, recommended)

On the VM, add to root's crontab: `17 3 * * * /opt/muse-proxy/src/deploy/backup.sh`.
To get backups off the VM, install `age` and `rclone` and set `BACKUP_AGE_RECIPIENT` and `BACKUP_RCLONE_DEST` in `.env`.
The backup includes `server.key`. Losing it means re-pairing Muse.

## 9. Web admin (optional)

`https://muse.example.com/admin` covers the day-to-day `mp` tasks: status, addresses, recent events (with email
bodies), pairing codes, key revocation and clearing events. The only way in is a passkey (Face ID / Touch ID, synced
through iCloud Keychain or a password manager). There are no passwords and no third-party sign-in. Passkeys can only be
added with a single-use link from `mp admin-enroll`, so adding one requires access to the VM.

1. `mp env set MP_ADMIN_ENABLED true` (and `mp env set MP_ADMIN_EMAIL you@example.com`, which is only the
   passkey's user name). Each `mp env set` recreates the app container. Run `mp deploy` if this code isn't on the VM yet.
2. `mp admin-enroll` prints `https://muse.example.com/admin/enroll?code=…`, valid once for 15 minutes
   (`mp admin-enroll 60` for longer). Open it on the device that should hold the passkey, name it (e.g. `iPhone`) and
   confirm with Face ID / Touch ID. You're then signed in.
3. After that, use **Sign in with a passkey** at `/admin`. Run `mp admin-enroll` again for each extra device; a passkey
   synced through iCloud Keychain already works on your other Apple devices.

The dashboard's **Admin passkeys** section lists passkeys and removes them (all but the last one). If you're locked out or
a device is lost, use `mp passkeys` and `mp passkeys revoke <id|name>`. Revoking a passkey also ends its sessions.

The browser checks the passkey against `muse.example.com` (the WebAuthn RP ID is `MP_DOMAIN`), so passkeys stop
working if the domain changes. Re-enroll in that case. Sessions last 12 hours (`MP_ADMIN_SESSION_HOURS`), and signing out
deletes the session on the server. Sign-ins, rejected attempts and admin actions are logged (`mp logs`, lines starting
`[admin]`).

## 10. Invitations and RSVPs (optional, needs the web admin)

In the web admin, **Invitations → New invitation** takes a name, date, start/end time, time zone, location, details and a
picture. Saving it gives you a link like `https://muse.example.com/events/k7m2q9xv4b8n3hcd`. The id is 80 random bits, so
links can't be guessed or enumerated (lookups of unknown ids are also rate limited per IP). Send the link to your guests.

Guests see the details and answer with their name, phone or email, yes/no, and the number of adults and kids. The
thank-you page has **Add to calendar** (an `.ics` file for Apple Calendar, Outlook and others) and a Google Calendar link.
Answering again with the same phone number or email updates the earlier answer instead of adding a new one.

Every answer becomes an `invite.rsvp` event for Muse (trust `untrusted`, since guests typed it) with the guest's answer
and the running totals. The invitation page in the admin lists all answers, shows totals, and can edit the event,
close or reopen RSVPs, or delete the invitation. Pictures are stored under `MP_DATA_DIR/invites/` on the data volume.
The nightly `deploy/backup.sh` includes them; `muse-proxy backup` on its own copies only the database.

`MP_TIMEZONE` sets the time zone the form starts with (default `UTC`). The form picks your browser's time zone for new invitations.

## Operations

| Task | Command |
|---|---|
| Logs | `gcloud compute ssh muse-proxy --zone us-west1-b --tunnel-through-iap -- sudo docker logs -f muse-proxy-app` |
| Recent events | `deploy/admin.sh events tail` |
| Revoke a key | `deploy/admin.sh keys revoke <name or key id>` |
| Server key | `deploy/admin.sh server-key` |
| Resize if you need more RAM | `gcloud compute instances stop muse-proxy --zone us-west1-b && gcloud compute instances set-machine-type muse-proxy --zone us-west1-b --machine-type e2-small && gcloud compute instances start muse-proxy --zone us-west1-b` (~$15/mo) |

## Known gaps / to verify after first deploy

- There's no USPS tracking connector. The API route wasn't workable and usps.com blocks headless Chromium (Akamai, HTTP 403 even from a residential IP), so `usps.track` was removed.
- There's no headless browser. The Playwright browser container was removed on 2026-10-18 because no connector used it (it's in git history if a future connector needs one).
