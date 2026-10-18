# muse-proxy

A small always-on server that lets **Meta Muse** (outbound-only) receive things and reach sites that block it:

- **Event stream:** Muse's helper holds a WebSocket open; events queue while it's offline and replay on reconnect.
- **Email:** receive-only SMTP for random, revocable addresses `@muse.example.com`. Every message becomes an event.
- **Connectors:** named, allowlisted fetchers (`email.attachment` so far), with an on-demand headless browser when there's no API.
- **Publish API:** your own scripts can push events to Muse.

Both sides authenticate with Ed25519 keys (mutual challenge-response, signed requests, signed events, signed helper
bundle). There are no shared passwords anywhere. Details: [`docs/specs/02-proxy-server-design.md`](docs/specs/02-proxy-server-design.md).

## Layout

```
src/protocol/    shared wire format, canonical JSON, Ed25519 helpers (used by every component)
src/server/      server: HTTP/WebSocket API, SMTP ingest, event store, connectors, admin CLI, web admin (admin/)
src/helper/      Muse Helper (bundled to dist/muse-helper.mjs, served signed by the server)
src/publisher/   muse-publish tool for your own scripts
bin/mp           admin command (addresses, events, pairing, status, logs, settings, deploy)
deploy/          Dockerfile/Compose/Caddy config, GCP provisioning, deploy/admin/backup scripts
docs/            specs, DEPLOY.md (runbook), MUSE_SETUP.md (instructions for Muse)
```

## Development

Requires Node 24+ (runs TypeScript directly via type stripping; no build step except the helper bundle).

```bash
npm install
npm test            # builds the helper bundle, then runs unit + end-to-end tests
npm run typecheck
MP_DOMAIN=localhost MP_DATA_DIR=./data MP_SMTP_PORT=2525 npm start
```

Deploying: see [`docs/DEPLOY.md`](docs/DEPLOY.md). Day-to-day admin: `bin/mp help`, or the web admin at `/admin`
(passkey sign-in, enabled with `MP_ADMIN_ENABLED=true`).
