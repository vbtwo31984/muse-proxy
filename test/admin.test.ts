import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { addKey } from "../src/server/store.ts";
import { createEnrollCode, listPasskeys } from "../src/server/admin/passkeys.ts";
import type { RunningServer } from "../src/server/main.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { baseUrl, cleanup, DOMAIN, start, tempDir } from "./util.ts";

const ORIGIN = `https://${DOMAIN}`;
const ADMIN = "you@example.com";
const execFileP = promisify(execFile);

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

describe("web admin", () => {
  let dataDir: string;
  let server: RunningServer;
  let url: string;
  let ip = 0;
  // Each test gets its own client IP so the failure rate limit doesn't leak between tests.
  const headers = (extra: Record<string, string> = {}) => ({ "x-forwarded-for": `198.51.100.${ip}`, ...extra });

  before(async () => {
    dataDir = tempDir();
    server = await start(dataDir, { admin: { enabled: true, email: ADMIN, sessionHours: 12, enrollMinutes: 15 } }, { smtp: false });
    url = baseUrl(server);
  });

  beforeEach(() => {
    ip++;
  });

  after(async () => {
    await server.stop();
    cleanup(dataDir);
  });

  async function postJson(path: string, body: unknown, cookie = ""): Promise<Response> {
    return fetch(`${url}${path}`, { method: "POST", headers: headers({ "content-type": "application/json", cookie }), body: JSON.stringify(body) });
  }

  async function post(path: string, cookie: string, form: Record<string, string>): Promise<Response> {
    return fetch(`${url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: headers({ cookie, "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams(form).toString(),
    });
  }

  const get = (path: string, cookie = "") => fetch(`${url}${path}`, { headers: headers({ cookie }), redirect: "manual" });

  /** Enrolls a new software passkey through a fresh link; returns it and the session cookie. */
  async function enroll(name = "laptop"): Promise<{ auth: SoftAuthenticator; cookie: string }> {
    const auth = new SoftAuthenticator(DOMAIN, ORIGIN);
    const { code } = createEnrollCode(server.db, 15);
    const options = await (await postJson("/admin/enroll/options", { code })).json();
    const res = await postJson("/admin/enroll/verify", { code, name, response: auth.register(options) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { redirect: "/admin?ok=enrolled#passkeys" });
    return { auth, cookie: cookieHeader(res) };
  }

  async function loginOptions(): Promise<{ challenge: string; rpId: string; userVerification: string; allowCredentials?: unknown[] }> {
    const res = await postJson("/admin/login/options", {});
    assert.equal(res.status, 200);
    return res.json();
  }

  async function signIn(auth: SoftAuthenticator): Promise<string> {
    const res = await postJson("/admin/login/verify", { response: auth.assert(await loginOptions()) });
    assert.equal(res.status, 200, await res.clone().text());
    return cookieHeader(res);
  }

  function csrfOf(page: string): string {
    return /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
  }

  test("unauthenticated requests go to the login page", async () => {
    const res = await get("/admin");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/login");
    const login = await get("/admin/login");
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /Sign in with a passkey/);
    assert.match(body, /<script src="\/admin\/static\/webauthn\.js" defer>/);
    assert.doesNotMatch(body, /<script>|\son[a-z]+="/);
    const csp = login.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.equal((await post("/admin/aliases", "", { label: "x" })).status, 403);
    const lib = await get("/admin/static/webauthn.js");
    assert.equal(lib.status, 200);
    assert.match(await lib.text(), /SimpleWebAuthnBrowser/);
  });

  test("enrollment: a valid link registers a passkey and signs in", async () => {
    const { code } = createEnrollCode(server.db, 15);
    const page = await get(`/admin/enroll?code=${code}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Create passkey/);

    const auth = new SoftAuthenticator(DOMAIN, ORIGIN);
    const options = await (await postJson("/admin/enroll/options", { code })).json();
    assert.equal(options.rp.id, DOMAIN);
    assert.equal(options.user.name, ADMIN);
    assert.equal(options.authenticatorSelection.userVerification, "required");
    assert.equal(options.authenticatorSelection.residentKey, "required");
    const res = await postJson("/admin/enroll/verify", { code, name: "iPhone", response: auth.register(options) });
    assert.equal(res.status, 200);
    const cookie = cookieHeader(res);
    assert.match(cookie, /__Host-mp_admin=/);
    assert.match(res.headers.getSetCookie()[0]!, /; HttpOnly; Secure; SameSite=Lax/);
    assert.ok(listPasskeys(server.db).some((p) => p.id === auth.id && p.name === "iPhone"));
    const dash = await (await get("/admin", cookie)).text();
    assert.match(dash, /iPhone <span class="muted">\(this session\)<\/span>/);
    assert.match(dash, new RegExp(ADMIN));

    // The code is single use: the page, new options and a second registration all refuse it.
    assert.equal((await get(`/admin/enroll?code=${code}`)).status, 410);
    assert.equal((await postJson("/admin/enroll/options", { code })).status, 410);
  });

  test("enrollment: expired, unknown and reused codes are refused", async () => {
    const expired = createEnrollCode(server.db, 1, Date.now() - 2 * 60_000).code;
    assert.equal((await get(`/admin/enroll?code=${expired}`)).status, 410);
    assert.equal((await postJson("/admin/enroll/options", { code: expired })).status, 410);
    assert.equal((await get("/admin/enroll?code=nope")).status, 410);
    assert.equal((await get("/admin/enroll")).status, 410);

    // Two ceremonies started with one code: only the first to finish gets a passkey.
    const { code } = createEnrollCode(server.db, 15);
    const a = new SoftAuthenticator(DOMAIN, ORIGIN);
    const b = new SoftAuthenticator(DOMAIN, ORIGIN);
    const optA = await (await postJson("/admin/enroll/options", { code })).json();
    const optB = await (await postJson("/admin/enroll/options", { code })).json();
    assert.equal((await postJson("/admin/enroll/verify", { code, name: "a", response: a.register(optA) })).status, 200);
    const second = await postJson("/admin/enroll/verify", { code, name: "b", response: b.register(optB) });
    assert.equal(second.status, 410);
    assert.equal(cookieHeader(second), "");
    assert.ok(!listPasskeys(server.db).some((p) => p.id === b.id));

    // A challenge issued for one code can't be redeemed with another.
    const other = createEnrollCode(server.db, 15).code;
    const c = new SoftAuthenticator(DOMAIN, ORIGIN);
    const optC = await (await postJson("/admin/enroll/options", { code: other })).json();
    const fresh = createEnrollCode(server.db, 15).code;
    assert.equal((await postJson("/admin/enroll/verify", { code: fresh, name: "c", response: c.register(optC) })).status, 400);
  });

  test("enrollment: wrong origin, rpId or missing user verification is refused", async () => {
    for (const o of [{ origin: "https://evil.example" }, { rpId: "evil.example" }, { uv: false }, { type: "webauthn.get" }]) {
      const { code } = createEnrollCode(server.db, 15);
      const auth = new SoftAuthenticator(DOMAIN, ORIGIN);
      const options = await (await postJson("/admin/enroll/options", { code })).json();
      const res = await postJson("/admin/enroll/verify", { code, name: "x", response: auth.register(options, o) });
      assert.equal(res.status, 400, JSON.stringify(o));
      assert.ok(!listPasskeys(server.db).some((p) => p.id === auth.id));
      // The code survives a failed ceremony (it's only burned on success).
      assert.equal((await get(`/admin/enroll?code=${code}`)).status, 200);
    }
  });

  test("login with an enrolled passkey (discoverable, UV required)", async () => {
    const { auth } = await enroll();
    const options = await loginOptions();
    assert.equal(options.rpId, DOMAIN);
    assert.equal(options.userVerification, "required");
    assert.ok(!options.allowCredentials?.length);
    const res = await postJson("/admin/login/verify", { response: auth.assert(options) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { redirect: "/admin" });
    const cookie = cookieHeader(res);
    assert.equal((await get("/admin", cookie)).status, 200);
    const stored = listPasskeys(server.db).find((p) => p.id === auth.id)!;
    assert.equal(stored.counter, auth.counter);
    assert.ok(stored.last_used_at);
  });

  test("rejects wrong-origin, wrong-challenge, replayed and cloned assertions", async () => {
    const { auth } = await enroll();
    const refused = async (response: object, why: string) => {
      const res = await postJson("/admin/login/verify", { response });
      assert.equal(res.status, 403, why);
      assert.equal(cookieHeader(res), "", why);
    };
    await refused(auth.assert(await loginOptions(), { origin: "https://evil.example" }), "wrong origin");
    await refused(auth.assert(await loginOptions(), { origin: `http://${DOMAIN}` }), "http origin");
    await refused(auth.assert(await loginOptions(), { rpId: "evil.example" }), "wrong rpId");
    await refused(auth.assert(await loginOptions(), { uv: false }), "no user verification");
    await refused(auth.assert({ challenge: "bm90LWlzc3VlZC1ieS10aGUtc2VydmVy" }), "challenge the server never issued");

    // A challenge from the enrollment flow can't be used to log in.
    const { code } = createEnrollCode(server.db, 15);
    const enrollOptions = await (await postJson("/admin/enroll/options", { code })).json();
    await refused(auth.assert(enrollOptions), "enrollment challenge");

    // Replay: the same signed assertion twice.
    const assertion = auth.assert(await loginOptions());
    assert.equal((await postJson("/admin/login/verify", { response: assertion })).status, 200);
    await refused(assertion, "replayed assertion");

    // Signature counter must go up (a cloned authenticator would reuse it).
    await refused(auth.assert(await loginOptions(), { counter: auth.counter }), "stale counter");

    // An unknown or removed credential.
    await refused(new SoftAuthenticator(DOMAIN, ORIGIN).assert(await loginOptions()), "unknown credential");

    // Still works with a fresh, honest assertion.
    assert.match(await signIn(auth), /__Host-mp_admin=/);
  });

  test("repeated failures are rate limited", async () => {
    const auth = new SoftAuthenticator(DOMAIN, ORIGIN);
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await postJson("/admin/login/verify", { response: auth.assert({ challenge: "eA" }) })).status;
    assert.equal(last, 429);
    assert.equal((await postJson("/admin/login/options", {})).status, 429);
  });

  test("actions need the CSRF token", async () => {
    const { cookie } = await enroll();
    const page = await (await get("/admin", cookie)).text();
    assert.equal((await post("/admin/aliases", cookie, { label: "packages" })).status, 403);
    assert.equal((await post("/admin/aliases", cookie, { label: "packages", _csrf: "wrong" })).status, 403);
    const ok = await post("/admin/aliases", cookie, { label: "packages", _csrf: csrfOf(page) });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get("location")!, /^\/admin\?created=packages-/);
    const after = await (await get(ok.headers.get("location")!, cookie)).text();
    assert.match(after, new RegExp(`Created packages-[a-z0-9]+@${DOMAIN.replace(".", "\\.")}`));
  });

  test("pairing, key revocation and clearing events", async () => {
    const { cookie } = await enroll();
    const csrf = csrfOf(await (await get("/admin", cookie)).text());
    const pair = await post("/admin/pair", cookie, { name: "muse-2", _csrf: csrf });
    assert.equal(pair.status, 200);
    assert.match(await pair.text(), /muse-helper pair --url https:\/\/muse\.test --server-key \S+ --code [A-Z0-9-]+ --name muse-2/i);

    const { generateIdentity } = await import("../src/protocol/crypto.ts");
    const key = addKey(server.db, "revoke-me", "publisher", generateIdentity().publicKeyB64);
    const res = await post("/admin/keys/revoke", cookie, { key_id: key.key_id, _csrf: csrf });
    assert.equal(res.headers.get("location"), "/admin?ok=revoked_key#keys");
    assert.ok((server.db.prepare("SELECT revoked_at FROM keys WHERE key_id = ?").get(key.key_id) as { revoked_at: string | null }).revoked_at);

    server.events.append({ kind: "test.thing", source: "test", trust: "owner", payload: { a: 1 } });
    assert.equal((await post("/admin/events/clear", cookie, { _csrf: csrf })).headers.get("location"), "/admin?ok=cleared#events");
    assert.equal((server.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
  });

  test("passkeys can be removed, but not the last one", async () => {
    const { auth: phone, cookie } = await enroll("phone");
    const { auth: laptop } = await enroll("laptop-2");
    const csrf = csrfOf(await (await get("/admin", cookie)).text());
    const laptopCookie = await signIn(laptop);
    const res = await post("/admin/passkeys/remove", cookie, { id: laptop.id, _csrf: csrf });
    assert.equal(res.headers.get("location"), "/admin?ok=removed_passkey#passkeys");
    // Its sessions end and it can't sign in any more.
    assert.equal((await get("/admin", laptopCookie)).status, 303);
    assert.equal((await postJson("/admin/login/verify", { response: laptop.assert(await loginOptions()) })).status, 403);

    // Remove every other passkey, then the last one is refused.
    for (const p of listPasskeys(server.db)) if (p.id !== phone.id) await post("/admin/passkeys/remove", cookie, { id: p.id, _csrf: csrf });
    assert.equal(listPasskeys(server.db).length, 1);
    assert.equal((await post("/admin/passkeys/remove", cookie, { id: phone.id, _csrf: csrf })).headers.get("location"), "/admin?ok=last_passkey#passkeys");
    assert.equal(listPasskeys(server.db).length, 1);
  });

  test("untrusted email content is escaped", async () => {
    const { cookie } = await enroll();
    const { event } = server.events.append({
      kind: "email.received",
      source: "smtp",
      trust: "untrusted",
      payload: { from: ['"x" <a@b.c>'], to: [], subject: "<script>alert(1)</script>", text: "<img src=x onerror=alert(1)>", auth: {} },
    });
    const list = await (await get("/admin", cookie)).text();
    assert.doesNotMatch(list, /<script>alert/);
    assert.match(list, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const detail = await (await get(`/admin/events/${event.seq}`, cookie)).text();
    assert.doesNotMatch(detail, /<img src=x/);
    assert.match(detail, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test("passkey names are escaped", async () => {
    const { cookie } = await enroll('<b onmouseover="x">');
    const page = await (await get("/admin", cookie)).text();
    assert.doesNotMatch(page, /<b onmouseover/);
    assert.match(page, /&lt;b onmouseover=&quot;x&quot;&gt;/);
  });

  test("sign out ends the session", async () => {
    const { cookie } = await enroll();
    const csrf = csrfOf(await (await get("/admin", cookie)).text());
    const res = await post("/admin/logout", cookie, { _csrf: csrf });
    assert.equal(res.headers.get("location"), "/admin/login");
    assert.match(res.headers.getSetCookie()[0]!, /^__Host-mp_admin=; Path=\/; Max-Age=0/);
    assert.equal((await get("/admin", cookie)).status, 303);
  });

  test("CLI enrolls, lists and revokes passkeys", async () => {
    const env = { ...process.env, MP_DOMAIN: DOMAIN, MP_DATA_DIR: dataDir, MP_ADMIN_ENABLED: "true" };
    const cli = (...args: string[]) => execFileP(process.execPath, [join(import.meta.dirname, "..", "src", "server", "cli.ts"), ...args], { env });
    const { stdout } = await cli("admin-enroll", "--minutes", "5");
    const link = new URL(/https:\/\/\S+/.exec(stdout)![0]);
    assert.equal(link.origin, ORIGIN);
    assert.equal(link.pathname, "/admin/enroll");
    const code = link.searchParams.get("code")!;
    assert.equal((await get(`/admin/enroll?code=${code}`)).status, 200);

    const auth = new SoftAuthenticator(DOMAIN, ORIGIN);
    const options = await (await postJson("/admin/enroll/options", { code })).json();
    assert.equal((await postJson("/admin/enroll/verify", { code, name: "from-cli", response: auth.register(options) })).status, 200);
    const cookie = await signIn(auth);

    assert.match((await cli("admin-passkeys", "list")).stdout, new RegExp(`from-cli\\s+${auth.id}`));
    assert.match((await cli("admin-passkeys", "revoke", auth.id)).stdout, /removed 1 passkey/);
    assert.equal((await get("/admin", cookie)).status, 303);
    assert.equal((await postJson("/admin/login/verify", { response: auth.assert(await loginOptions()) })).status, 403);
  });
});

describe("web admin disabled", () => {
  test("is not served unless MP_ADMIN_ENABLED=true", async () => {
    const dataDir = tempDir();
    const server = await start(dataDir, { admin: { enabled: false, email: ADMIN, sessionHours: 12, enrollMinutes: 15 } }, { smtp: false });
    try {
      for (const path of ["/admin", "/admin/login", "/admin/enroll?code=x", "/admin/static/webauthn.js"]) {
        assert.equal((await fetch(`${baseUrl(server)}${path}`, { redirect: "manual" })).status, 404, path);
      }
    } finally {
      await server.stop();
      cleanup(dataDir);
    }
  });
});
