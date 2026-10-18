#!/usr/bin/env node
// muse-publish: push events to Muse from your own scripts (laptop, cron jobs, other servers).

import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generateIdentity, identityFromPem, privateKeyPem } from "../protocol/crypto.ts";
import { signedFetch } from "../helper/http.ts";
import { writeFileAtomic, type HelperConfig } from "../helper/state.ts";

const USAGE = `muse-publish — send events to Muse through muse-proxy

  init --url URL --server-key KEY --name NAME [--domain HOST]
      Create this publisher's key. Then on the server run:
        muse-proxy publisher add --name NAME --pubkey <printed key>
  send --kind KIND [--payload JSON] [--dedupe KEY]
      Publish an event (payload from --payload or stdin). Arrives as "publish.<name>.<kind>".

Environment: MUSE_PUBLISH_HOME (default ~/.muse-publish)
`;

const home = process.env.MUSE_PUBLISH_HOME ?? join(homedir(), ".muse-publish");
const configPath = join(home, "config.json");
const keyPath = join(home, "publisher.key");

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "init") {
    const { values } = parseArgs({ args: rest, options: { url: { type: "string" }, "server-key": { type: "string" }, name: { type: "string" }, domain: { type: "string" } } });
    if (!values.url || !values["server-key"] || !values.name) die("init needs --url, --server-key and --name");
    if (existsSync(keyPath)) die(`${keyPath} already exists`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const identity = generateIdentity();
    const url = new URL(values.url);
    const config: HelperConfig = { url: url.origin, domain: values.domain ?? url.hostname, server_public_key: values["server-key"], name: values.name, key_id: identity.fingerprint };
    writeFileAtomic(keyPath, privateKeyPem(identity));
    chmodSync(keyPath, 0o600);
    writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`publisher key created (${identity.fingerprint}). On the server run:\n`);
    console.log(`  muse-proxy publisher add --name ${values.name} --pubkey ${identity.publicKeyB64}`);
    return;
  }
  if (cmd === "send") {
    const { values } = parseArgs({ args: rest, options: { kind: { type: "string" }, payload: { type: "string" }, dedupe: { type: "string" } } });
    if (!values.kind) die("send needs --kind");
    const text = values.payload ?? (await readStdin());
    let payload: unknown;
    try {
      payload = text.trim() ? JSON.parse(text) : null;
    } catch {
      die("payload must be JSON");
    }
    const config = JSON.parse(readFileSync(configPath, "utf8")) as HelperConfig;
    const identity = identityFromPem(readFileSync(keyPath, "utf8"));
    const res = await signedFetch(config, identity, "POST", "/v1/publish", { kind: values.kind, payload, dedupe_key: values.dedupe });
    console.log(JSON.stringify(res.json));
    if (res.status !== 200) process.exitCode = 2;
    return;
  }
  console.log(USAGE);
  if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err: unknown) => die(`error: ${(err as Error).message}`));
