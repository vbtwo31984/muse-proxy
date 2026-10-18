import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, type Config } from "../src/server/config.ts";
import { startServer, type RunningServer, type StartOptions } from "../src/server/main.ts";

export const DOMAIN = "muse.test";
export const HELPER_BUNDLE = join(import.meta.dirname, "..", "dist", "muse-helper.mjs");
const execFileP = promisify(execFile);

export function tempDir(prefix = "mp-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return loadConfig({
    domain: DOMAIN,
    dataDir,
    httpHost: "127.0.0.1",
    httpPort: 0,
    smtpHost: "127.0.0.1",
    smtpPort: 0,
    helperBundlePath: HELPER_BUNDLE,
    ...overrides,
  });
}

export const noDns = async (name: string): Promise<never> => {
  const err = new Error(`queryTxt ENOTFOUND ${name}`) as Error & { code: string };
  err.code = "ENOTFOUND";
  throw err;
};

export async function start(dataDir: string, overrides: Partial<Config> = {}, opts: StartOptions = {}): Promise<RunningServer> {
  return startServer(testConfig(dataDir, overrides), { resolver: noDns, ...opts });
}

export function baseUrl(server: RunningServer): string {
  return `http://127.0.0.1:${server.httpPort}`;
}

export async function runHelper(home: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [HELPER_BUNDLE, ...args], { env: { ...process.env, MUSE_PROXY_HOME: home } });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout, stderr: e.stderr, code: e.code };
  }
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
