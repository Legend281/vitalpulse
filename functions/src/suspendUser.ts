import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';
import { type CallerClaims } from './roles';
import { suspendUserSchema } from './schemas';

/**
 * setUserSuspensionHandler — Security Master Plan 1.4/1.5 + Phase 3. The ONLY
 * path by which the `suspended` kill-switch claim is flipped. Replaces the old
 * client-side `suspendDonor`/`reactivateDonor` (db.js), which only wrote
 * cosmetic Firestore fields and never touched the claim that `signedIn()`
 * actually gates access on — a donor "suspended" that way kept full access.
 *
 * Runs as one server-side unit: flips the claim, revokes refresh tokens,
 * mirrors the state onto the users doc (Admin SDK bypasses rules), and audits.
 * Clients have no write path to the `suspended`/`isAvailable` fields at all.
 *
 * Exported as a plain async function (wrapped by `onCall` below) so unit
 * tests can call it directly with a fake CallableRequest, no emulator needed.
 * `suspendUser` and `reactivateUser` are two names over the same handler so
 * the client UI keeps two natural functions.
 */
export async function setUserSuspensionHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call suspendUser.');
  }

  const parsed = suspendUserSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid suspendUser payload.', parsed.error.flatten());
  }
  const { targetUid, suspend, reason } = parsed.data;

  if (targetUid === request.auth.uid) {
    throw new HttpsError('permission-denied', 'Self-service suspension is not permitted.');
  }

  // Gate on the caller alone, BEFORE resolving the target, so a suspended or
  // unauthorized caller can never use the not-found/permission-denied split as
  // a Firebase-UID existence oracle (same closure as revokeRole).
  const callerClaims = (request.auth.token ?? {}) as CallerClaims;
  if (callerClaims.suspended) {
    throw new HttpsError('permission-denied', 'Caller account is suspended.');
  }
  if (callerClaims.role !== 'system_admin') {
    throw new HttpsError('permission-denied', 'Caller role is not authorized to manage suspensions.');
  }

  const targetUser = await auth.getUser(targetUid).catch(() => {
    throw new HttpsError('not-found', 'Target user does not exist.');
  });
  const existingClaims = (targetUser.customClaims ?? {}) as CallerClaims;

  // setCustomUserClaims REPLACES the claim set, so preserve role/hospitalId
  // and only add/clear the kill-switch. Reactivation leaves `suspended` unset.
  const newClaims: Record<string, unknown> = {
    role: existingClaims.role ?? null,
    hospitalId: existingClaims.hospitalId ?? null,
  };
  if (suspend) {
    newClaims.suspended = true;
  }

  await auth.setCustomUserClaims(targetUid, newClaims);
  await auth.revokeRefreshTokens(targetUid);

  // Mirror the state onto the users doc (the donor-dashboard reads isAvailable
  // to show availability; suspend forces it off so the donor leaves the pool).
  await db.collection('users').doc(targetUid).set(
    {
      isSuspended: suspend,
      isAvailable: !suspend,
      statusChangedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAudit({
    actorUid: request.auth.uid,
    action: suspend ? 'suspendUser' : 'reactivateUser',
    targetUid,
    details: {
      actorRole: callerClaims.role ?? null,
      previousSuspended: existingClaims.suspended === true,
      reason: reason ?? null,
    },
  });

  return { success: true, suspended: suspend };
}

export const suspendUser = onCall({ cors: true }, setUserSuspensionHandler);
export const reactivateUser = onCall({ cors: true }, setUserSuspensionHandler);
