import crypto from 'node:crypto';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { auth, db } from './firebaseAdmin';
import { requestPasswordResetSchema, checkPasswordResetTokenSchema, confirmPasswordResetSchema } from './schemas';
import { writeAudit } from './audit';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
// Firebase Hosting's default web.app domain for this project — override via functions/.env
// (or `firebase functions:config`) if a custom domain is fronting the app instead.
const APP_BASE_URL = defineString('APP_BASE_URL', { default: 'https://vitalpulse-fa458.web.app' });

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes — Security Lead instruction, 2026-08-04
const RESEND_COOLDOWN_MS = 60 * 1000; // don't re-send more than once a minute for the same account

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

async function sendResetEmail(apiKey: string, toEmail: string, resetUrl: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Vital Pulse Team <onboarding@resend.dev>',
      to: [toEmail],
      subject: 'Reset your VitalPulse password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#af101a;">Reset your password</h2>
          <p>We received a request to reset the password for your VitalPulse account. This link expires in <strong>30 minutes</strong> and can only be used once.</p>
          <p style="margin: 24px 0;">
            <a href="${resetUrl}" style="background:#af101a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Reset Password</a>
          </p>
          <p>If you didn't request this, you can safely ignore this email — your password will not be changed.</p>
          <p style="color:#666;font-size:12px;margin-top:32px;">— The Vital Pulse Team</p>
        </div>
      `,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

/**
 * requestPasswordReset — replaces Firebase Auth's built-in sendPasswordResetEmail so the
 * reset link can carry a real, enforced 30-minute expiry (Security Lead instruction,
 * 2026-08-04) and a custom "Vital Pulse Team" sender identity — neither of which Firebase's
 * built-in oobCode-based email flow supports (fixed ~1hr TTL, not configurable via any
 * public API; sender display name only configurable insofar as the Firebase Console
 * templates allow, and still not per-project-branded the way this needed).
 *
 * UNAUTHENTICATED BY NECESSITY, same class as resolveSignInIdentifier.ts /
 * checkPasswordBreach.ts: called before any Firebase Auth session exists. No App Check yet
 * (PHASE0_AUDIT.md §10) — residual abuse risk same as those two, flagged not silently
 * ignored, mitigated here by a 60s per-account cooldown (not a full rate limiter).
 *
 * ANTI-ENUMERATION, LOAD-BEARING: ALWAYS returns { success: true } regardless of whether
 * the email is registered, disabled, cooled-down, or the send itself fails — mirrors
 * resolveSignInIdentifier's contract. The only real signal of account existence is the
 * email arriving or not, exactly as forgot-password.html's own UI copy already promises
 * ("If an account exists for that... we've sent a link").
 */
export async function requestPasswordResetHandler(request: CallableRequest) {
  const parsed = requestPasswordResetSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid requestPasswordReset payload.', parsed.error.flatten());
  }
  const { email } = parsed.data;

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
  } catch {
    return { success: true }; // no such account — say nothing
  }
  if (userRecord.disabled) {
    return { success: true }; // suspended account — say nothing, don't help re-enable via reset
  }

  const tokenRef = db.collection('passwordResetTokens').doc(userRecord.uid);
  const existing = await tokenRef.get();
  if (existing.exists) {
    const createdAtMs = (existing.data()?.createdAtMs as number | undefined) ?? 0;
    if (Date.now() - createdAtMs < RESEND_COOLDOWN_MS) {
      return { success: true }; // recently sent — don't spam a second email
    }
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await tokenRef.set({
    tokenHash: hashToken(rawToken),
    createdAtMs: now,
    expiresAtMs: now + TOKEN_TTL_MS,
    used: false,
    email,
  });

  const resetUrl = `${APP_BASE_URL.value()}/reset-password.html?uid=${encodeURIComponent(userRecord.uid)}&token=${rawToken}`;
  try {
    await sendResetEmail(RESEND_API_KEY.value(), email, resetUrl);
  } catch (err) {
    // Fails open on the RESPONSE (never reveal send failures to the caller — same
    // anti-enumeration contract as every other branch above), but the token doc above
    // still exists; a retry within the cooldown window will silently no-op until it
    // expires, which is an acceptable trade-off rather than deleting the token doc and
    // risking a race with a legitimate concurrent request.
    console.error('Failed to send password reset email:', err);
    return { success: true };
  }

  await writeAudit({ actorUid: userRecord.uid, action: 'requestPasswordReset', targetUid: userRecord.uid });
  return { success: true };
}

function invalidLinkError(): HttpsError {
  return new HttpsError('failed-precondition', 'This reset link is invalid or has expired. Please request a new one.');
}

// Shared by checkPasswordResetTokenHandler (read-only) and confirmPasswordResetHandler
// (which goes on to consume it) — token existence/used/expiry/hash-match is exactly the
// same check either way, only what happens after differs.
async function validateResetToken(uid: string, token: string) {
  const tokenRef = db.collection('passwordResetTokens').doc(uid);
  const snap = await tokenRef.get();
  if (!snap.exists) throw invalidLinkError();

  const data = snap.data()!;
  if (data.used) throw invalidLinkError();
  if (Date.now() > (data.expiresAtMs as number)) throw invalidLinkError();

  const storedHash = Buffer.from(data.tokenHash as string, 'hex');
  const providedHash = Buffer.from(hashToken(token), 'hex');
  if (storedHash.length !== providedHash.length || !crypto.timingSafeEqual(storedHash, providedHash)) {
    throw invalidLinkError();
  }

  return tokenRef;
}

/**
 * checkPasswordResetToken — read-only pre-check so reset-password.html can tell a dead
 * link apart from a live one BEFORE the donor fills out a new password, matching the UX
 * the old Firebase verifyPasswordResetCode + confirmPasswordReset two-step already had.
 * Does not consume the token — only confirmPasswordReset does that.
 */
export async function checkPasswordResetTokenHandler(request: CallableRequest) {
  const parsed = checkPasswordResetTokenSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid checkPasswordResetToken payload.', parsed.error.flatten());
  }
  await validateResetToken(parsed.data.uid, parsed.data.token);
  return { valid: true };
}

/**
 * confirmPasswordReset — re-validates the single-use token (constant-time hash comparison)
 * and, if still valid and unexpired, updates the password via the Admin SDK. Revokes all
 * existing refresh tokens afterward, same as every other credential/claim mutation in this
 * codebase (kyc.ts, roles.ts) — a password reset should end every other active session, not
 * just issue a new one alongside them.
 */
export async function confirmPasswordResetHandler(request: CallableRequest) {
  const parsed = confirmPasswordResetSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid confirmPasswordReset payload.', parsed.error.flatten());
  }
  const { uid, token, newPassword } = parsed.data;
  const tokenRef = await validateResetToken(uid, token);

  await auth.updateUser(uid, { password: newPassword });
  await tokenRef.update({ used: true });
  await auth.revokeRefreshTokens(uid);
  await writeAudit({ actorUid: uid, action: 'confirmPasswordReset', targetUid: uid });

  return { success: true };
}

export const requestPasswordReset = onCall({ secrets: [RESEND_API_KEY] }, requestPasswordResetHandler);
export const checkPasswordResetToken = onCall(checkPasswordResetTokenHandler);
export const confirmPasswordReset = onCall(confirmPasswordResetHandler);
