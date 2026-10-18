import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32. Sorts by creation time. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let random = "";
  for (let i = 0; i < 16; i++) random += CROCKFORD[rand[i]! % 32];
  return time + random;
}

/** Lowercase base32 string with `chars` characters (5 bits each), for unguessable aliases and codes. */
export function randomBase32(chars: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l for readability
  const bytes = randomBytes(chars);
  let out = "";
  for (let i = 0; i < chars; i++) out += alphabet[bytes[i]! % 32];
  return out;
}
