// A software WebAuthn authenticator (ES256, "none" attestation) for tests: builds the
// registration and assertion responses a browser would send, with knobs to break them.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { b64url } from "../src/protocol/crypto.ts";

/** Just enough CBOR for attestation objects and COSE keys. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: unsupported ${typeof v}`);
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface Overrides {
  origin?: string;
  challenge?: string;
  rpId?: string;
  uv?: boolean;
  counter?: number;
  type?: string;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly privateKey: KeyObject;
  private readonly cosePublicKey: Buffer;
  readonly rpId: string;
  readonly origin: string;
  counter = 0;

  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cosePublicKey = cbor(
      new Map<number, unknown>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private clientData(type: string, challenge: string, o: Overrides): Buffer {
    return Buffer.from(JSON.stringify({ type: o.type ?? type, challenge: o.challenge ?? challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
  }

  private authData(flags: number, counter: number, o: Overrides, attested?: Buffer): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    const f = o.uv === false ? flags & ~UV : flags;
    return Buffer.concat([sha256(o.rpId ?? this.rpId), Buffer.from([f]), c, ...(attested ? [attested] : [])]);
  }

  /** Response to navigator.credentials.create() for the given options. */
  register(options: { challenge: string; rp: { id?: string } }, o: Overrides = {}): object {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16) /* aaguid */, len, this.credentialId, this.cosePublicKey]);
    const authData = this.authData(UP | UV | AT, this.counter, o, attested);
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, o)),
        attestationObject: b64url(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Response to navigator.credentials.get(); bumps the signature counter unless overridden. */
  assert(options: { challenge: string }, o: Overrides = {}): object {
    const counter = o.counter ?? ++this.counter;
    const authData = this.authData(UP | UV, counter, o);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, o);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}
