import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function sha256hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomNonce(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function hmacSha256b64(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface Identity {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKeyB64: string;
  fingerprint: string;
}

export function generateIdentity(): Identity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return identityFromPrivate(privateKey);
}

export function identityFromPrivate(privateKey: KeyObject): Identity {
  const publicKey = createPublicKey(privateKey);
  const publicKeyB64 = rawPublicKey(publicKey);
  return { privateKey, publicKey, publicKeyB64, fingerprint: fingerprintOf(publicKeyB64) };
}

export function identityFromPem(pem: string): Identity {
  return identityFromPrivate(createPrivateKey(pem));
}

export function privateKeyPem(identity: Identity): string {
  return identity.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function rawPublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("not an Ed25519 key");
  return jwk.x;
}

/** Imports a raw base64url Ed25519 public key. Throws on malformed input. */
export function publicKeyFromB64(publicKeyB64: string): KeyObject {
  if (fromB64url(publicKeyB64).length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64 }, format: "jwk" });
}

/** Stable key id: "SHA256:" + base64url(sha256(raw public key)). */
export function fingerprintOf(publicKeyB64: string): string {
  return "SHA256:" + b64url(createHash("sha256").update(fromB64url(publicKeyB64)).digest());
}

export function signString(identity: Identity, message: string | Uint8Array): string {
  return b64url(sign(null, typeof message === "string" ? Buffer.from(message) : message, identity.privateKey));
}

export function verifyString(
  publicKey: KeyObject | string,
  message: string | Uint8Array,
  signatureB64: string,
): boolean {
  try {
    const key = typeof publicKey === "string" ? publicKeyFromB64(publicKey) : publicKey;
    const data = typeof message === "string" ? Buffer.from(message) : message;
    return verify(null, data, key, fromB64url(signatureB64));
  } catch {
    return false;
  }
}
