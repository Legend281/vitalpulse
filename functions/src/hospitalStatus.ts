import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';
import { type CallerClaims } from './roles';
import { hospitalStatusSchema } from './schemas';

const MAX_USER_PAGES = 100;

/**
 * setHospitalActiveHandler — Security Master Plan 1.4/1.5 + Phase 3. The ONLY
 * path by which a hospital is deactivated/reactivated. Replaces the dead
 * client-side `deactivateHospital`/`reactivateHospital` (db.js), which only
 * wrote a cosmetic `isActive` field and never touched the `suspended`
 * kill-switch claim — a "deactivated" hospital's staff kept full access.
 *
 * One server-side unit: verifies the target is a hospital account, flips the
 * `suspended` claim (and revokes refresh tokens) for EVERY account scoped to
 * that hospitalId — including the hospital's own account, which holds a
 * hospital-admin-style claim — mirrors `isActive` onto the users doc, and
 * audits with a staffAffected count.
 *
 * Individual suspensions are preserved across reactivation: deactivation
 * stamps `hospitalSuspendedAt` on each staff claim; reactivation only clears
 * `suspended` for accounts carrying that marker. An account suspended
 * individually (suspendUser/revokeRole) without the marker keeps its
 * suspension.
 *
 * Exported as a plain async function (wrapped by `onCall` below) so unit
 * tests can call it directly with a fake CallableRequest, no emulator needed.
 */
export async function setHospitalActiveHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call deactivateHospital.');
  }

  const parsed = hospitalStatusSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid hospital status payload.', parsed.error.flatten());
  }
  const { hospitalId, active, reason } = parsed.data;

  if (hospitalId === request.auth.uid) {
    throw new HttpsError('permission-denied', 'Self-service hospital deactivation is not permitted.');
  }

  // Gate on the caller alone, BEFORE resolving the target (no UID oracle).
  const callerClaims = (request.auth.token ?? {}) as CallerClaims;
  if (callerClaims.suspended) {
    throw new HttpsError('permission-denied', 'Caller account is suspended.');
  }
  if (callerClaims.role !== 'system_admin') {
    throw new HttpsError('permission-denied', 'Caller role is not authorized to manage hospitals.');
  }

  const hospitalDoc = await db
    .collection('users')
    .doc(hospitalId)
    .get()
    .catch(() => {
      throw new HttpsError('not-found', 'Target hospital does not exist.');
    });
  if (!hospitalDoc.exists) {
    throw new HttpsError('not-found', 'Target hospital does not exist.');
  }
  if (hospitalDoc.data()?.role !== 'hospital') {
    throw new HttpsError('invalid-argument', 'Target is not a hospital account.');
  }

  // Resolve every account scoped to this hospitalId (staff + the hospital's
  // own account), flipping the kill-switch claim on each.
  let staffAffected = 0;
  let pageToken: string | undefined;
  do {
    const page = pageToken ? await auth.listUsers(1000, pageToken) : await auth.listUsers(1000);
    for (const user of page.users) {
      const claims = (user.customClaims ?? {}) as CallerClaims;
      if (claims.hospitalId !== hospitalId) continue;

      if (active) {
        // Reactivate: only lift suspensions this function set. Individual
        // suspensions (no hospitalSuspendedAt marker) are left untouched.
        if (claims.hospitalSuspendedAt !== undefined) {
          const { hospitalSuspendedAt: _marker, suspended: _suspended, ...rest } = claims;
          await auth.setCustomUserClaims(user.uid, { ...rest });
          await auth.revokeRefreshTokens(user.uid);
          staffAffected++;
        }
      } else {
        await auth.setCustomUserClaims(user.uid, {
          ...claims,
          suspended: true,
          hospitalSuspendedAt: new Date().toISOString(),
        });
        await auth.revokeRefreshTokens(user.uid);
        staffAffected++;
      }
    }
    pageToken = page.pageToken;
  } while (pageToken && staffAffected < MAX_USER_PAGES * 1000);

  // Mirror the state onto the hospital's users doc (donor-dashboard filters
  // isActive !== false when building the verified network).
  await db.collection('users').doc(hospitalId).set(
    {
      isActive: active,
      statusChangedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAudit({
    actorUid: request.auth.uid,
    action: active ? 'reactivateHospital' : 'deactivateHospital',
    targetUid: hospitalId,
    details: {
      actorRole: callerClaims.role ?? null,
      staffAffected,
      reason: reason ?? null,
    },
  });

  return { success: true, active, staffAffected };
}

export const deactivateHospital = onCall(setHospitalActiveHandler);
export const reactivateHospital = onCall(setHospitalActiveHandler);
