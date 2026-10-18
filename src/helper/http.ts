import { randomNonce, verifyString, type Identity } from "../protocol/crypto.ts";
import { HEADER_SERVER_SIGNATURE, responseString, signedRequestHeaders } from "../protocol/messages.ts";
import type { HelperConfig } from "./state.ts";

export class ServerAuthError extends Error {}

/**
 * Signed request to the server. Verifies the server's response signature
 * against the pinned server key before returning anything.
 */
export async function signedFetch(
  config: HelperConfig,
  identity: Identity,
  method: "GET" | "POST",
  pathAndQuery: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<{ status: number; json: unknown }> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const nonce = randomNonce(18);
  const headers: Record<string, string> = signedRequestHeaders(identity, method, config.domain, pathAndQuery, text, nonce);
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(new URL(pathAndQuery, config.url), {
    method,
    headers,
    body: body === undefined ? undefined : text,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  const sig = res.headers.get(HEADER_SERVER_SIGNATURE);
  const verified = !!sig && verifyString(config.server_public_key, responseString(res.status, raw, nonce), sig);
  if (!verified) {
    // Some errors (bad auth, rate limits, malformed requests) are rejected before the
    // server signs anything. Report the status, but never trust an unsigned body.
    if (res.status >= 400) return { status: res.status, json: { error: "unverified_error", status: res.status } };
    throw new ServerAuthError("response signature invalid: this is not your muse-proxy server");
  }
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = { error: "invalid_json", raw: raw.slice(0, 200) };
  }
  return { status: res.status, json };
}
