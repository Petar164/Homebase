import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Passwords are never stored. What is stored is the output of scrypt, a hash
// that is slow and memory-hungry on purpose: checking one password takes a
// fraction of a second for us, but guessing billions of them from a stolen
// database becomes impractical.
//
// Parameters follow the OWASP password storage cheat sheet for scrypt
// (N = 2^17, r = 8, p = 1), with a random 16-byte salt per password.
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 12;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs about 128 * N * r bytes of memory; raise Node's default cap.
    const options = { N: n, r, p, maxmem: 256 * n * r };
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Returns "scrypt$N$r$p$salt$hash". The parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  // timingSafeEqual takes the same time whether the first or the last byte
  // differs, so response time does not leak how close a guess was.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// A valid hash of a random password nobody knows. When the username does not
// exist we still verify against this, so "unknown user" takes as long as
// "wrong password" and the response time does not reveal which one it was.
let dummyHash: Promise<string> | undefined;
export function verifyAgainstDummy(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  return dummyHash.then((hash) => verifyPassword(password, hash)).then(() => false);
}
