import { ConnectorError } from "./types.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function checkUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError("internal", "invalid URL");
  }
  if (url.protocol !== "https:") throw new ConnectorError("forbidden", `scheme not allowed: ${url.protocol}`);
  if (!allowedHosts.includes(url.hostname)) throw new ConnectorError("forbidden", `host not allowed: ${url.hostname}`);
  return url;
}

/**
 * fetch that only reaches allowlisted https hosts, follows redirects manually
 * (re-checking each hop), times out, and caps the response size. This is what
 * keeps a buggy connector from being an SSRF pivot or an open proxy.
 */
export function allowlistedFetch(allowedHosts: string[], fetchImpl: typeof fetch = fetch) {
  return async (raw: string, init: RequestInit = {}): Promise<{ status: number; headers: Headers; text: string }> => {
    let url = checkUrl(raw, allowedHosts);
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        throw new ConnectorError("upstream_unavailable", `request failed: ${(err as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= MAX_REDIRECTS) throw new ConnectorError("upstream_unavailable", "too many redirects");
        url = checkUrl(new URL(res.headers.get("location")!, url).toString(), allowedHosts);
        continue;
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ConnectorError("upstream_unavailable", "response too large");
          }
          chunks.push(value);
        }
      }
      return { status: res.status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
    }
  };
}
