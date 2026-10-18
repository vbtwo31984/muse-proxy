import type { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";

export type ConnectorErrorCode =
  | "invalid_params"
  | "not_found"
  | "not_configured"
  | "upstream_unavailable"
  | "upstream_blocked"
  | "rate_limited"
  | "forbidden"
  | "unknown_method"
  | "internal";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ConnectorContext {
  /** fetch restricted to the connector's allowedHosts, https only, with timeout and size cap. */
  fetch: (url: string, init?: RequestInit) => Promise<{ status: number; headers: Headers; text: string }>;
  config: Config;
  db: Db;
}

export interface Connector<P = unknown> {
  name: string;
  description: string;
  params: z.ZodType<P>;
  /** Max calls per hour across all callers (cache hits don't count). */
  perHour: number;
  cacheTtlSec: number;
  /** Hosts ctx.fetch may reach. */
  allowedHosts: string[];
  run(params: P, ctx: ConnectorContext): Promise<unknown>;
}
