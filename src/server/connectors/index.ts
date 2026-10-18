import { canonicalize } from "../../protocol/canonical.ts";
import { sha256hex } from "../../protocol/crypto.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { RateLimiter } from "../ratelimit.ts";
import { allowlistedFetch } from "./http.ts";
import { ConnectorError, type Connector, type ConnectorErrorCode } from "./types.ts";

export type RpcOutcome = { ok: true; result: unknown; cached: boolean } | { ok: false; error: { code: ConnectorErrorCode; message: string } };

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector<any>>();
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly db: Db;
  private readonly config: Config;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { db: Db; config: Config; fetchImpl?: typeof fetch }) {
    this.db = opts.db;
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  register(connector: Connector<any>): void {
    this.connectors.set(connector.name, connector);
    this.limiters.set(connector.name, new RateLimiter(connector.perHour, 3_600_000));
  }

  list(): { name: string; description: string }[] {
    return [...this.connectors.values()].map((c) => ({ name: c.name, description: c.description }));
  }

  has(name: string): boolean {
    return this.connectors.has(name);
  }

  async call(name: string, rawParams: unknown, now = Date.now()): Promise<RpcOutcome> {
    const connector = this.connectors.get(name);
    if (!connector) return { ok: false, error: { code: "unknown_method", message: `unknown method: ${name}` } };
    const parsed = connector.params.safeParse(rawParams ?? {});
    if (!parsed.success) {
      return { ok: false, error: { code: "invalid_params", message: parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ") } };
    }
    const cacheKey = `${name}:${sha256hex(canonicalize(parsed.data ?? null))}`;
    if (connector.cacheTtlSec > 0) {
      const row = this.db.prepare("SELECT value FROM connector_cache WHERE cache_key = ? AND expires_at > ?").get(cacheKey, now) as
        | { value: string }
        | undefined;
      if (row) return { ok: true, result: JSON.parse(row.value), cached: true };
    }
    if (!this.limiters.get(name)!.hit("all", now)) {
      return { ok: false, error: { code: "rate_limited", message: `${name} is limited to ${connector.perHour} calls/hour` } };
    }
    try {
      const result = await connector.run(parsed.data, {
        fetch: allowlistedFetch(connector.allowedHosts, this.fetchImpl),
        config: this.config,
        db: this.db,
      });
      if (connector.cacheTtlSec > 0) {
        this.db
          .prepare("INSERT OR REPLACE INTO connector_cache (cache_key, value, expires_at) VALUES (?, ?, ?)")
          .run(cacheKey, JSON.stringify(result ?? null), now + connector.cacheTtlSec * 1000);
      }
      return { ok: true, result, cached: false };
    } catch (err) {
      if (err instanceof ConnectorError) return { ok: false, error: { code: err.code, message: err.message } };
      console.error(`[connector ${name}] unexpected error`, err);
      return { ok: false, error: { code: "internal", message: "internal error" } };
    }
  }

  purgeCache(now = Date.now()): void {
    this.db.prepare("DELETE FROM connector_cache WHERE expires_at <= ?").run(now);
  }
}
