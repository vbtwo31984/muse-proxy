import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../src/protocol/canonical.ts";
import { fingerprintOf, generateIdentity, identityFromPem, privateKeyPem, signString, verifyString } from "../src/protocol/crypto.ts";
import { clientAuthString, pairProof, pairProofFromHash, requestString, signEvent, verifyEvent, type EventBody } from "../src/protocol/messages.ts";
import { sha256hex } from "../src/protocol/crypto.ts";
import { randomBase32, ulid } from "../src/protocol/ids.ts";

test("canonicalize sorts keys, drops undefined, matches JCS for numbers and strings", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalize({ "é": 1, z: 2, A: 3 }), '{"A":3,"z":2,"é":1}');
  assert.equal(canonicalize(1e21), "1e+21");
  assert.equal(canonicalize(-0), "0");
  assert.equal(canonicalize("line\nbreak "), '"line\\nbreak "');
  assert.throws(() => canonicalize(Number.NaN));
});

test("Ed25519 identity round-trips through PEM and signs/verifies", () => {
  const id = generateIdentity();
  const again = identityFromPem(privateKeyPem(id));
  assert.equal(again.publicKeyB64, id.publicKeyB64);
  assert.equal(id.fingerprint, fingerprintOf(id.publicKeyB64));
  assert.match(id.fingerprint, /^SHA256:[A-Za-z0-9_-]{43}$/);
  const sig = signString(id, "hello");
  assert.ok(verifyString(id.publicKeyB64, "hello", sig));
  assert.ok(!verifyString(id.publicKeyB64, "hellO", sig));
  assert.ok(!verifyString(generateIdentity().publicKeyB64, "hello", sig));
  assert.ok(!verifyString("not-a-key", "hello", sig));
});

test("signing strings are fixed (test vectors for other implementations)", () => {
  assert.equal(clientAuthString("muse.example.com", "sn", "cn", 1700000000000), "muse-proxy/v1/client-auth|muse.example.com|sn|cn|1700000000000");
  assert.equal(
    requestString("post", "muse.example.com", "/v1/rpc/email.attachment", 1700000000000, "nonce", '{"params":{}}'),
    `muse-proxy/v1/req|POST|muse.example.com|/v1/rpc/email.attachment|1700000000000|nonce|${sha256hex('{"params":{}}')}`,
  );
  assert.equal(pairProof("code", "pk", "muse-main"), pairProofFromHash(sha256hex("code"), "pk", "muse-main"));
  assert.equal(pairProof("abc-def", "AAAA", "muse-main"), "RY_z2D9UqInbgL4FjiZtfbdZIL8hbkjCq6_jhnWqEwM");
});

test("event signatures cover every field", () => {
  const id = generateIdentity();
  const body: EventBody = { seq: 1, id: "evt_1", kind: "email.received", created_at: "2026-01-01T00:00:00.000Z", source: "smtp", trust: "untrusted", payload: { a: 1 } };
  const ev = signEvent(id, body);
  assert.ok(verifyEvent(id.publicKeyB64, ev));
  for (const tamper of [{ seq: 2 }, { kind: "x" }, { trust: "owner" as const }, { payload: { a: 2 } }, { source: "publisher:x" }]) {
    assert.ok(!verifyEvent(id.publicKeyB64, { ...ev, ...tamper }), JSON.stringify(tamper));
  }
});

test("ids", () => {
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_001);
  assert.equal(a.length, 26);
  assert.ok(a < b);
  assert.match(randomBase32(12), /^[a-z2-9]{12}$/);
});
