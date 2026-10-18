import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Identity } from "../protocol/crypto.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { EventStore } from "./events.ts";
import { buildApp } from "./http.ts";
import { createMailServer, emailAttachment, purgeMail } from "./email.ts";
import { ConnectorRegistry } from "./connectors/index.ts";
import { BrowserPool } from "./browser.ts";
import { loadOrCreateServerIdentity, purgeNonces } from "./store.ts";
import { purgeAdmin } from "./admin/passkeys.ts";

export function serverKeyPath(config: Config): string {
  return join(config.dataDir, "server.key");
}

export function dbPath(config: Config): string {
  return join(config.dataDir, "muse-proxy.sqlite");
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export interface RunningServer {
  config: Config;
  db: Db;
  identity: Identity;
  events: EventStore;
  connectors: ConnectorRegistry;
  httpPort: number;
  smtpPort: number;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Injected DNS resolver for mailauth (tests). */
  resolver?: (name: string, rrtype: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  smtp?: boolean;
}

export async function startServer(config: Config, opts: StartOptions = {}): Promise<RunningServer> {
  const db = openDb(dbPath(config));
  const identity = loadOrCreateServerIdentity(serverKeyPath(config));
  const events = new EventStore(db, identity);
  const browser = config.browserWsEndpoint ? new BrowserPool(config.browserWsEndpoint) : undefined;
  const connectors = new ConnectorRegistry({ db, config, browser, fetchImpl: opts.fetchImpl });
  connectors.register(emailAttachment);

  const { app, hub } = await buildApp({ config, db, identity, events, connectors, version: packageVersion() });
  await app.listen({ host: config.httpHost, port: config.httpPort });
  const httpPort = (app.server.address() as AddressInfo).port;

  let smtpPort = 0;
  const smtp = opts.smtp === false ? undefined : createMailServer({ config, db, events, resolver: opts.resolver });
  if (smtp) {
    await new Promise<void>((resolve, reject) => {
      smtp.once("error", reject);
      smtp.listen(config.smtpPort, config.smtpHost, () => resolve());
    });
    smtpPort = ((smtp as unknown as { server: { address(): AddressInfo } }).server.address()).port;
  }

  let alerted = false;
  const maintenance = setInterval(() => {
    try {
      purgeNonces(db);
      purgeAdmin(db);
      connectors.purgeCache();
      events.purge(config.eventRetentionDays, config.unackedRetentionDays);
      purgeMail(db, config.mailRetentionDays);
    } catch (err) {
      console.error("[maintenance]", err);
    }
  }, 3_600_000);
  const watchdog = setInterval(() => {
    const down = hub.disconnectedForMs();
    if (down === 0) {
      alerted = false;
      return;
    }
    if (!alerted && config.alertUrl && down > config.disconnectAlertMinutes * 60_000) {
      alerted = true;
      fetch(config.alertUrl, {
        method: "POST",
        body: `muse-proxy: no Muse Helper connected for ${Math.round(down / 60_000)} minutes`,
        signal: AbortSignal.timeout(10_000),
      }).catch((err) => console.error("[alert] failed", (err as Error).message));
    }
  }, 60_000);

  return {
    config,
    db,
    identity,
    events,
    connectors,
    httpPort,
    smtpPort,
    async stop() {
      clearInterval(maintenance);
      clearInterval(watchdog);
      hub.closeAll();
      await app.close();
      if (smtp) await new Promise<void>((resolve) => smtp.close(() => resolve()));
      db.close();
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const server = await startServer(config);
  console.log(`muse-proxy listening: https via Caddy → :${server.httpPort}, smtp :${server.smtpPort}, domain ${config.domain}`);
  console.log(`server key fingerprint: ${server.identity.fingerprint}`);
  const shutdown = () => {
    server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
