// Admin CLI. Runs on the server (docker compose exec app muse-proxy <cmd>), never over HTTP.

import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { dbPath, serverKeyPath } from "./main.ts";
import { clearAllEvents } from "./email.ts";
import { createEnrollCode, listPasskeys, removePasskey } from "./admin/passkeys.ts";
import {
  addAlias,
  addKey,
  createPairingCode,
  listAliases,
  listKeys,
  loadOrCreateServerIdentity,
  revokeAlias,
  revokeKey,
  DEFAULT_PUBLISHER_SCOPES,
} from "./store.ts";

const USAGE = `muse-proxy admin CLI

  server-key                         Show the server public key + fingerprint (pin this in the Muse Helper)
  pair [--name muse-main]            Create a one-time pairing code (15 min)
  keys list
  keys add --name N --pubkey B64 [--role client|publisher] [--scopes a,b]
  keys revoke <key_id|name>
  publisher add --name N --pubkey B64 [--kinds prefix1,prefix2]
  alias add --label packages         Create a random receiving address
  alias list
  alias revoke <alias[@domain]>
  events tail [--limit 20]           Show recent events (metadata only)
  events clear [--yes]               Delete all queued events and stored emails
  admin-enroll [--minutes 15]        Single-use link that adds a passkey for the web admin
  admin-passkeys list
  admin-passkeys revoke <id|name>    Remove a web admin passkey and end its sessions
  backup <dest.sqlite>               Consistent online copy of the database
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  const config = loadConfig();
  const db = openDb(dbPath(config));
  const identity = loadOrCreateServerIdentity(serverKeyPath(config));

  switch (cmd) {
    case "server-key": {
      console.log(`domain:       ${config.domain}`);
      console.log(`public key:   ${identity.publicKeyB64}`);
      console.log(`fingerprint:  ${identity.fingerprint}`);
      return;
    }
    case "pair": {
      const { values } = parseArgs({ args: [sub, ...rest].filter((a): a is string => a !== undefined), options: { name: { type: "string", default: "muse-main" } } });
      const { code, expiresAt } = createPairingCode(db, values.name!);
      console.log(`Pairing code (single use, expires ${new Date(expiresAt).toISOString()}):\n`);
      console.log(`  ${code}\n`);
      console.log(`Give Muse these three values:`);
      console.log(`  url:         https://${config.domain}`);
      console.log(`  server key:  ${identity.publicKeyB64}`);
      console.log(`  code:        ${code}`);
      console.log(`\nMuse runs: muse-helper pair --url https://${config.domain} --server-key ${identity.publicKeyB64} --code ${code} --name ${values.name}`);
      return;
    }
    case "keys": {
      if (sub === "list") {
        for (const k of listKeys(db)) {
          console.log(`${k.revoked_at ? "REVOKED " : ""}${k.role.padEnd(9)} ${k.name.padEnd(20)} ${k.key_id}  scopes=${k.scopes.join(",")}  created=${k.created_at}`);
        }
        return;
      }
      if (sub === "add") {
        const { values } = parseArgs({
          args: rest,
          options: { name: { type: "string" }, pubkey: { type: "string" }, role: { type: "string", default: "client" }, scopes: { type: "string" } },
        });
        if (!values.name || !values.pubkey) die("keys add needs --name and --pubkey");
        const role = values.role === "publisher" ? "publisher" : values.role === "client" ? "client" : die("--role must be client or publisher");
        const k = addKey(db, values.name, role, values.pubkey, values.scopes?.split(",").map((s) => s.trim()).filter(Boolean));
        console.log(`added ${k.role} ${k.name} ${k.key_id}`);
        return;
      }
      if (sub === "revoke") {
        if (!rest[0]) die("keys revoke <key_id|name>");
        console.log(`revoked ${revokeKey(db, rest[0])} key(s)`);
        return;
      }
      break;
    }
    case "publisher": {
      if (sub === "add") {
        const { values } = parseArgs({ args: rest, options: { name: { type: "string" }, pubkey: { type: "string" } } });
        if (!values.name || !values.pubkey) die("publisher add needs --name and --pubkey (from: muse-publish keygen)");
        const k = addKey(db, values.name, "publisher", values.pubkey, DEFAULT_PUBLISHER_SCOPES);
        console.log(`added publisher ${k.name} ${k.key_id}. Its events arrive as kind "publish.${k.name}.<kind>".`);
        return;
      }
      break;
    }
    case "alias": {
      if (sub === "add") {
        const { values } = parseArgs({ args: rest, options: { label: { type: "string" } } });
        if (!values.label) die("alias add needs --label");
        const a = addAlias(db, values.label);
        console.log(`${a.local_part}@${config.domain}   (label: ${a.label})`);
        return;
      }
      if (sub === "list") {
        for (const a of listAliases(db)) console.log(`${a.revoked_at ? "REVOKED " : ""}${a.local_part}@${config.domain}  label=${a.label}  created=${a.created_at}`);
        return;
      }
      if (sub === "revoke") {
        if (!rest[0]) die("alias revoke <alias>");
        console.log(`revoked ${revokeAlias(db, rest[0])} alias(es)`);
        return;
      }
      break;
    }
    case "events": {
      if (sub === "tail") {
        const { values } = parseArgs({ args: rest, options: { limit: { type: "string", default: "20" } } });
        const rows = db
          .prepare("SELECT seq, id, kind, created_at, source, trust, length(payload) AS bytes FROM events ORDER BY seq DESC LIMIT ?")
          .all(Number(values.limit)) as { seq: number; id: string; kind: string; created_at: string; source: string; trust: string; bytes: number }[];
        for (const r of rows.reverse()) console.log(`${String(r.seq).padStart(6)} ${r.created_at} ${r.kind.padEnd(28)} ${r.source.padEnd(20)} ${r.trust.padEnd(9)} ${r.bytes}B`);
        const cursors = db.prepare("SELECT key_id, acked_seq, updated_at FROM cursors").all() as { key_id: string; acked_seq: number; updated_at: string }[];
        for (const c of cursors) console.log(`cursor ${c.key_id} acked=${c.acked_seq} at ${c.updated_at}`);
        return;
      }
      if (sub === "clear") {
        const { values } = parseArgs({ args: rest, options: { yes: { type: "boolean", default: false } } });
        const count = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
        if (!values.yes) die(`would delete ${count} event(s) and their stored emails; re-run with --yes`);
        const deleted = clearAllEvents(db);
        console.log(`deleted ${deleted.events} event(s) and ${deleted.emails} stored email(s)`);
        return;
      }
      break;
    }
    case "admin-enroll": {
      const { values } = parseArgs({
        args: [sub, ...rest].filter((a): a is string => a !== undefined),
        options: { minutes: { type: "string", default: String(config.admin.enrollMinutes) } },
      });
      const minutes = Number(values.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) die("--minutes must be 1..1440");
      if (!config.admin.enabled) console.error("note: the web admin is disabled; set MP_ADMIN_ENABLED=true or the link won't open");
      const { code, expiresAt } = createEnrollCode(db, minutes);
      console.log(`Open on the device that should hold the passkey (single use, expires ${new Date(expiresAt).toISOString()}):\n`);
      console.log(`  https://${config.domain}/admin/enroll?code=${code}`);
      return;
    }
    case "admin-passkeys": {
      if (!sub || sub === "list") {
        const passkeys = listPasskeys(db);
        if (!passkeys.length) console.log("no passkeys (run admin-enroll)");
        for (const p of passkeys) console.log(`${p.name.padEnd(20)} ${p.id}  created=${p.created_at}  last_used=${p.last_used_at ?? "never"}`);
        return;
      }
      if (sub === "revoke") {
        if (!rest[0]) die("admin-passkeys revoke <id|name>");
        console.log(`removed ${removePasskey(db, rest[0])} passkey(s)`);
        return;
      }
      break;
    }
    case "backup": {
      if (!sub) die("backup <dest.sqlite>");
      const { backup } = await import("node:sqlite");
      await backup(db, sub);
      console.log(`backed up to ${sub}`);
      return;
    }
  }
  die(USAGE);
}

main(process.argv.slice(2)).catch((err: unknown) => die((err as Error).message));
