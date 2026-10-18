#!/usr/bin/env node
// muse-helper: runs inside Muse's VM. See docs/MUSE_SETUP.md.

import { existsSync, readFileSync, renameSync, statSync, watch, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { generateIdentity, privateKeyPem, sha256hex, verifyString } from "../protocol/crypto.ts";
import { helperBundleString, pairOkString, pairProof } from "../protocol/messages.ts";
import { HelperClient, listInbox } from "./client.ts";
import { signedFetch } from "./http.ts";
import { ensureDirs, loadConfig, loadIdentity, loadState, paths, writeFileAtomic, type HelperConfig } from "./state.ts";

const USAGE = `muse-helper — Muse side of muse-proxy

  pair --url URL --server-key KEY --code CODE [--name muse-main] [--domain HOST] [--force]
      Generate this helper's key, register it with the server, pin the server key.
  run
      Stay connected, write verified events to ~/.muse-proxy/inbox/, ack them. Run under a supervisor.
  events [--since SEQ] [--kind PREFIX] [--all] [--follow]
      Print inbox events as JSON lines (--all includes processed/).
  done <file|seq>...
      Move handled inbox files to processed/.
  rpc METHOD ['{"json":"params"}']
      Call a server connector, e.g. rpc email.attachment '{"event_id":"evt_...","sha256":"..."}'
  methods
      List available connectors.
  status
      Show connection state and the pinned server fingerprint.
  self-update
      Download the latest helper from your server, verify its signature, replace this file.

Environment: MUSE_PROXY_HOME (default ~/.muse-proxy)
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function cmdPair(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      "server-key": { type: "string" },
      code: { type: "string" },
      name: { type: "string", default: "muse-main" },
      domain: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  if (!values.url || !values["server-key"] || !values.code) die("pair needs --url, --server-key and --code");
  const p = paths();
  if (existsSync(p.key) && !values.force) die(`${p.key} already exists. This helper is already paired (use --force to replace its key).`);
  ensureDirs(p);
  const url = new URL(values.url);
  const domain = values.domain ?? url.hostname;
  const serverKey = values["server-key"];
  const name = values.name!;
  const identity = generateIdentity();
  const res = await fetch(new URL("/v1/pair", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, client_pubkey: identity.publicKeyB64, proof: pairProof(values.code.trim(), identity.publicKeyB64, name) }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { key_id?: string; server_public_key?: string; sig?: string; error?: string; domain?: string };
  if (res.status !== 200) die(`pairing failed: HTTP ${res.status} ${body.error ?? ""}`);
  if (body.server_public_key !== serverKey || !body.sig || !verifyString(serverKey, pairOkString(domain, identity.publicKeyB64, name), body.sig)) {
    die("pairing response is not signed by the server key you were given. Refusing (wrong server, or wrong --server-key/--domain).");
  }
  const config: HelperConfig = { url: url.origin, domain, server_public_key: serverKey, name, key_id: identity.fingerprint };
  writeFileAtomic(p.key, privateKeyPem(identity));
  chmodSync(p.key, 0o600);
  writeFileAtomic(p.config, JSON.stringify(config, null, 2) + "\n");
  console.log(`paired as "${name}" (${identity.fingerprint})`);
  console.log(`server verified: ${serverKey}`);
  console.log(`next: muse-helper run   (under systemd or a restart loop; see MUSE_SETUP.md)`);
}

async function cmdRun(): Promise<void> {
  const p = paths();
  ensureDirs(p);
  const client = new HelperClient({ paths: p, config: loadConfig(p), identity: loadIdentity(p) });
  const stop = () => {
    client.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  client.start();
}

function parseEventFile(file: string): { seq: number; kind: string; raw: string } | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { event: { seq: number; kind: string } };
    return { seq: parsed.event.seq, kind: parsed.event.kind, raw: JSON.stringify(parsed) };
  } catch {
    return undefined;
  }
}

async function cmdEvents(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { since: { type: "string", default: "0" }, kind: { type: "string" }, all: { type: "boolean", default: false }, follow: { type: "boolean", default: false } },
  });
  const p = paths();
  ensureDirs(p);
  let since = Number(values.since);
  const emit = () => {
    for (const file of listInbox(p, values.all!)) {
      const e = parseEventFile(file);
      if (!e || e.seq <= since) continue;
      if (values.kind && !e.kind.startsWith(values.kind)) continue;
      console.log(e.raw);
      since = e.seq;
    }
  };
  emit();
  if (!values.follow) return;
  let pending = false;
  watch(p.inbox, () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      emit();
    }, 200);
  });
  await new Promise(() => undefined);
}

function cmdDone(args: string[]): void {
  const p = paths();
  if (args.length === 0) die("done <file|seq>...");
  for (const arg of args) {
    let file = arg;
    if (/^\d+$/.test(arg)) {
      const prefix = arg.padStart(12, "0") + "-";
      file = listInbox(p, false).find((f) => basename(f).startsWith(prefix)) ?? "";
    } else if (!arg.includes("/")) {
      file = join(p.inbox, arg);
    }
    if (!file || !existsSync(file) || dirname(file) !== p.inbox) {
      console.error(`not in inbox: ${arg}`);
      continue;
    }
    renameSync(file, join(p.processed, basename(file)));
  }
}

async function cmdRpc(args: string[]): Promise<void> {
  const [method, paramsJson] = args;
  if (!method) die("rpc METHOD ['{...}']");
  let params: unknown = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson);
    } catch {
      die("params must be JSON");
    }
  }
  const p = paths();
  const res = await signedFetch(loadConfig(p), loadIdentity(p), "POST", `/v1/rpc/${encodeURIComponent(method)}`, { params }, 120_000);
  console.log(JSON.stringify(res.json, null, 2));
  if (res.status !== 200 || (res.json as { ok?: boolean }).ok === false) process.exitCode = 2;
}

async function cmdMethods(): Promise<void> {
  const p = paths();
  const res = await signedFetch(loadConfig(p), loadIdentity(p), "GET", "/v1/rpc");
  console.log(JSON.stringify(res.json, null, 2));
}

function cmdStatus(): void {
  const p = paths();
  const config = loadConfig(p);
  const state = loadState(p);
  const inbox = listInbox(p, false).length;
  console.log(JSON.stringify({ server: config.url, domain: config.domain, server_public_key: config.server_public_key, key_id: config.key_id, inbox_unprocessed: inbox, ...state }, null, 2));
}

async function cmdSelfUpdate(): Promise<void> {
  const p = paths();
  const config = loadConfig(p);
  const self = process.argv[1];
  if (!self || !self.endsWith(".mjs")) die("self-update only works when running the bundled muse-helper.mjs");
  const meta = (await (await fetch(new URL("/v1/helper/latest.json", config.url), { signal: AbortSignal.timeout(30_000) })).json()) as {
    version: string;
    sha256: string;
    sig: string;
  };
  if (!verifyString(config.server_public_key, helperBundleString(meta.sha256, meta.version), meta.sig)) die("update metadata is not signed by your server. Refusing.");
  const bytes = Buffer.from(await (await fetch(new URL("/v1/helper/latest", config.url), { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  if (sha256hex(bytes) !== meta.sha256) die("downloaded helper does not match the signed hash. Refusing.");
  if (sha256hex(readFileSync(self)) === meta.sha256) {
    console.log(`already up to date (${meta.version})`);
    return;
  }
  const tmp = `${self}.new`;
  writeFileSync(tmp, bytes, { mode: statSync(self).mode });
  renameSync(tmp, self);
  console.log(`updated to ${meta.version}; restart the running helper to use it`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "pair":
      return cmdPair(rest);
    case "run":
      return cmdRun();
    case "events":
      return cmdEvents(rest);
    case "done":
      return cmdDone(rest);
    case "rpc":
      return cmdRpc(rest);
    case "methods":
      return cmdMethods();
    case "status":
      return cmdStatus();
    case "self-update":
      return cmdSelfUpdate();
    default:
      console.log(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => die(`error: ${(err as Error).message}`));
