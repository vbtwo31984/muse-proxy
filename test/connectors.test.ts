import { test } from "node:test";
import assert from "node:assert/strict";
import { allowlistedFetch } from "../src/server/connectors/http.ts";
import { ConnectorError } from "../src/server/connectors/types.ts";
import { ConnectorRegistry } from "../src/server/connectors/index.ts";
import { openDb } from "../src/server/db.ts";
import { z } from "zod";
import { testConfig, tempDir, cleanup } from "./util.ts";

test("allowlisted fetch refuses other hosts, plain http and redirects off the allowlist", async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://ok.example/redirect-out") return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    if (url === "https://ok.example/redirect-in") return new Response(null, { status: 301, headers: { location: "/final" } });
    return new Response("body", { status: 200 });
  };
  const f = allowlistedFetch(["ok.example"], fake);
  assert.equal((await f("https://ok.example/x")).text, "body");
  assert.equal((await f("https://ok.example/redirect-in")).text, "body");
  assert.deepEqual(calls.slice(-1), ["https://ok.example/final"]);
  for (const bad of ["https://evil.example/", "http://ok.example/", "https://ok.example/redirect-out", "file:///etc/passwd"]) {
    await assert.rejects(f(bad), (err: unknown) => err instanceof ConnectorError && err.code === "forbidden", bad);
  }
  assert.ok(!calls.some((c) => c.includes("169.254")));
});

test("allowlisted fetch caps response size", async () => {
  const big: typeof fetch = async () => new Response("x".repeat(3 * 1024 * 1024));
  await assert.rejects(allowlistedFetch(["ok.example"], big)("https://ok.example/"), /too large/);
});

test("registry validates params, rate-limits and caches", async () => {
  const dir = tempDir();
  try {
    const db = openDb(":memory:");
    const registry = new ConnectorRegistry({ db, config: testConfig(dir) });
    let runs = 0;
    registry.register({
      name: "demo.echo",
      description: "",
      params: z.object({ n: z.number().int() }),
      perHour: 2,
      cacheTtlSec: 60,
      allowedHosts: [],
      async run({ n }) {
        runs++;
        return { n };
      },
    });
    assert.deepEqual(await registry.call("demo.echo", { n: "x" }), { ok: false, error: { code: "invalid_params", message: "n: Invalid input: expected number, received string" } });
    assert.deepEqual(await registry.call("demo.echo", { n: 1 }), { ok: true, result: { n: 1 }, cached: false });
    assert.deepEqual(await registry.call("demo.echo", { n: 1 }), { ok: true, result: { n: 1 }, cached: true });
    assert.equal((await registry.call("demo.echo", { n: 2 })).ok, true);
    const limited = await registry.call("demo.echo", { n: 3 });
    assert.equal(limited.ok ? "" : limited.error.code, "rate_limited");
    assert.equal(runs, 2);
  } finally {
    cleanup(dir);
  }
});
