import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { identityFromPem, type Identity } from "../protocol/crypto.ts";

export interface HelperConfig {
  url: string;
  /** Logical domain bound into signatures. Normally the URL's hostname. */
  domain: string;
  server_public_key: string;
  name: string;
  key_id: string;
}

export interface HelperState {
  last_acked_seq: number;
  connected: boolean;
  last_connected_at: string | null;
  last_disconnected_at: string | null;
  last_error: string | null;
  pid: number | null;
  updated_at: string;
}

export interface Paths {
  home: string;
  config: string;
  key: string;
  state: string;
  inbox: string;
  processed: string;
  hooks: string;
}

export function paths(home = process.env.MUSE_PROXY_HOME ?? join(homedir(), ".muse-proxy")): Paths {
  return {
    home,
    config: join(home, "config.json"),
    key: join(home, "client.key"),
    state: join(home, "state.json"),
    inbox: join(home, "inbox"),
    processed: join(home, "processed"),
    hooks: join(home, "hooks"),
  };
}

export function ensureDirs(p: Paths): void {
  for (const dir of [p.home, p.inbox, p.processed, p.hooks]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(p.home, 0o700);
}

/** Writes via temp file + rename so readers never see a partial file. */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export function loadConfig(p: Paths): HelperConfig {
  if (!existsSync(p.config)) throw new Error(`not paired: ${p.config} missing (run: muse-helper pair ...)`);
  return JSON.parse(readFileSync(p.config, "utf8")) as HelperConfig;
}

export function loadIdentity(p: Paths): Identity {
  return identityFromPem(readFileSync(p.key, "utf8"));
}

export function loadState(p: Paths): HelperState {
  const empty: HelperState = {
    last_acked_seq: 0,
    connected: false,
    last_connected_at: null,
    last_disconnected_at: null,
    last_error: null,
    pid: null,
    updated_at: new Date().toISOString(),
  };
  if (!existsSync(p.state)) return empty;
  try {
    return { ...empty, ...(JSON.parse(readFileSync(p.state, "utf8")) as Partial<HelperState>) };
  } catch {
    return empty;
  }
}

export function saveState(p: Paths, state: HelperState): void {
  writeFileAtomic(p.state, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2) + "\n");
}
