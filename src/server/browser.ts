// On-demand headless Chromium via a separate Playwright run-server container.
// The browser process only exists while a call is in flight; nothing persists
// between calls. One page at a time, because the target VM has 1 GB of RAM.

import { isIP } from "node:net";
import type { Page } from "playwright-core";
import { ConnectorError } from "./connectors/types.ts";

const MAX_QUEUE = 5;
const CALL_TIMEOUT_MS = 45_000;
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

function isPrivateHost(hostname: string): boolean {
  if (!hostname.includes(".")) return true; // docker service names, localhost
  const ipVersion = isIP(hostname.replace(/^\[|\]$/g, ""));
  if (ipVersion === 0) return hostname.endsWith(".internal") || hostname.endsWith(".local");
  // Any IP literal is refused: real sites are reached by name.
  return true;
}

export interface BrowserCall<T> {
  /** Hosts top-level navigations may go to. Subresources may come from other public hosts. */
  allowedHosts: string[];
  run: (page: Page) => Promise<T>;
}

export class BrowserPool {
  private readonly wsEndpoint: string;
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;

  constructor(wsEndpoint: string) {
    this.wsEndpoint = wsEndpoint;
  }

  withPage<T>(call: BrowserCall<T>): Promise<T> {
    if (this.queued >= MAX_QUEUE) return Promise.reject(new ConnectorError("rate_limited", "browser queue is full"));
    this.queued++;
    const next = this.chain.then(() => this.runOne(call)).finally(() => this.queued--);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runOne<T>(call: BrowserCall<T>): Promise<T> {
    const { chromium } = await import("playwright-core");
    let browser;
    try {
      browser = await chromium.connect(this.wsEndpoint, { timeout: 15_000 });
    } catch (err) {
      throw new ConnectorError("upstream_unavailable", `browser unavailable: ${(err as Error).message}`);
    }
    const timer = setTimeout(() => void browser.close().catch(() => undefined), CALL_TIMEOUT_MS);
    try {
      const context = await browser.newContext({
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
        viewport: { width: 1280, height: 900 },
      });
      await context.route("**/*", (route) => {
        const req = route.request();
        let url: URL;
        try {
          url = new URL(req.url());
        } catch {
          return route.abort();
        }
        if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
        if (url.protocol !== "https:" && url.protocol !== "http:") return route.abort();
        if (isPrivateHost(url.hostname)) return route.abort();
        if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) return route.abort();
        if (req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame() && !call.allowedHosts.includes(url.hostname)) {
          return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(25_000);
      return await call.run(page);
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      throw new ConnectorError("upstream_unavailable", `browser call failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      await browser.close().catch(() => undefined);
    }
  }
}
