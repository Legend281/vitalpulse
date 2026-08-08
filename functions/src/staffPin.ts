import * as crypto from 'crypto';

/**
 * PIN hashing for hospital staff accounts.
 *
 * SECURITY CONTEXT (remediation 2026-08-08). The previous scheme was
 * `sha256('VitalPulse_PIN_' + pin)`: unsalted, no KDF, over a 4-digit keyspace.
 * The full 10,000-candidate rainbow table builds in milliseconds, and the hash
 * was published to a world-readable `staff_accounts` collection, so the PIN of
 * every hospital staff member in the country was effectively public. Worse, the
 * same PIN was fed through `formatStaffAuthPassword()` to derive the account's
 * actual Firebase Auth password (`VP_PIN_1234`), turning PIN recovery directly
 * into account takeover.
 *
 * A 4-digit PIN cannot be made strong by hashing alone — the keyspace is the
 * problem. Three things together make it acceptable here:
 *   1. scrypt with a per-account random salt, so there is no shared precomputed
 *      table and each guess costs real CPU;
 *   2. the hash never leaves the server (see staffManagement.ts — it lives only
 *      in hospitals/{hid}/staff/{uid}, which no client can read);
 *   3. hard rate limiting + lockout on the verify path, so the 10,000-guess
 *      space cannot be walked online.
 *
 * Legacy hashes are still accepted on the verify path and transparently
 * upgraded to scrypt on the first successful login, so existing staff are not
 * locked out by this change. See verifyPin()'s `needsUpgrade` return.
 */

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N — ~100ms/derivation on Cloud Functions' CPU
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export const PIN_ALGO_SCRYPT = 'scrypt-n16384-r8-p1';

/** Legacy, pre-2026-08-08. Kept ONLY so existing staff can log in once and be upgraded. */
function legacySha256(pin: string): string {
  return crypto.createHash('sha256').update(`VitalPulse_PIN_${pin}`).digest('hex');
}

function scryptHash(pin: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      pin,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived.toString('hex'));
      },
    );
  });
}

export interface PinRecord {
  pinAlgo: string;
  pinSalt: string;
  pinHash: string;
}

/** Produces a fresh salted scrypt record for a new or rotated PIN. */
export async function hashPin(pin: string): Promise<PinRecord> {
  const pinSalt = crypto.randomBytes(16).toString('hex');
  const pinHash = await scryptHash(pin, pinSalt);
  return { pinAlgo: PIN_ALGO_SCRYPT, pinSalt, pinHash };
}

/**
 * Constant-time comparison. `timingSafeEqual` throws on length mismatch, so the
 * lengths are compared first — that leak is harmless (hash length is a function
 * of the algorithm, not the secret).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a PIN against a stored record, accepting both the current scrypt
 * scheme and the legacy unsalted SHA-256 one.
 *
 * @returns `ok` — whether the PIN matched. `needsUpgrade` — true when the match
 *   came from a legacy hash, meaning the caller should re-hash with hashPin()
 *   and persist the result.
 */
export async function verifyPin(
  pin: string,
  stored: { pinAlgo?: string | null; pinSalt?: string | null; pinHash?: string | null },
): Promise<{ ok: boolean; needsUpgrade: boolean }> {
  if (!stored.pinHash) return { ok: false, needsUpgrade: false };

  if (stored.pinAlgo === PIN_ALGO_SCRYPT && stored.pinSalt) {
    const candidate = await scryptHash(pin, stored.pinSalt);
    return { ok: safeEqual(candidate, stored.pinHash), needsUpgrade: false };
  }

  // No algo marker and no salt => legacy record written before this remediation.
  const ok = safeEqual(legacySha256(pin), stored.pinHash);
  return { ok, needsUpgrade: ok };
}
