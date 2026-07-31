import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { auth } from './firebaseAdmin';
import { writeAudit } from './audit';
import { canGrant, type CallerClaims } from './roles';
import { revokeRoleSchema } from './schemas';

/**
 * revokeRole — Security Master Plan 1.4/1.5 + Policy 2 offboarding. Strips a
 * user's role/hospitalId claims (demoting them back to an unprivileged
 * account) and, if `suspend` is set, also flips the `suspended` kill-switch
 * claim. A grantor may revoke exactly the roles they would be allowed to
 * grant (symmetric with grantRole's canGrant check).
 *
 * Exported as a plain async function (wrapped by `onCall` below) so unit
 * tests can call it directly with a fake CallableRequest, no emulator needed.
 */
export async function revokeRoleHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call revokeRole.');
  }

  const parsed = revokeRoleSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid revokeRole payload.', parsed.error.flatten());
  }
  const { targetUid, suspend } = parsed.data;

  if (targetUid === request.auth.uid) {
    throw new HttpsError('permission-denied', 'Self-service role revocation is not permitted.');
  }

  // Gate on the caller alone, BEFORE resolving the target. This closes two
  // issues found in review: (1) a suspended caller must never get past this
  // point, even for a target with no existing role — that path used to skip
  // the suspended check entirely because canGrant() was only reached when
  // the target *had* a role; (2) resolving the target first let any
  // authenticated caller (donor included) use the not-found/permission-denied
  // split as a Firebase-UID existence oracle. Neither check depends on the
  // target, so both run first now.
  const callerClaims = (request.auth.token ?? {}) as CallerClaims;
  if (callerClaims.suspended) {
    throw new HttpsError('permission-denied', 'Caller account is suspended.');
  }
  if (callerClaims.role !== 'system_admin' && callerClaims.role !== 'hospital_admin') {
    throw new HttpsError('permission-denied', 'Caller role is not authorized to revoke roles.');
  }

  const targetUser = await auth.getUser(targetUid).catch(() => {
    throw new HttpsError('not-found', 'Target user does not exist.');
  });
  const existingClaims = (targetUser.customClaims ?? {}) as CallerClaims;

  if (existingClaims.role) {
    const decision = canGrant(callerClaims, existingClaims.role, existingClaims.hospitalId);
    if (!decision.allowed) {
      throw new HttpsError('permission-denied', decision.reason);
    }
  } else if (callerClaims.role !== 'system_admin') {
    // Nothing to revoke and caller isn't a system_admin — no-op they're not
    // entitled to perform anyway; reject rather than silently succeeding.
    throw new HttpsError('permission-denied', 'Caller role is not authorized to revoke roles.');
  }

  const newClaims: Record<string, unknown> = {};
  if (suspend || existingClaims.suspended === true) {
    newClaims.suspended = true;
  }

  await auth.setCustomUserClaims(targetUid, newClaims);
  await auth.revokeRefreshTokens(targetUid);

  await writeAudit({
    actorUid: request.auth.uid,
    action: 'revokeRole',
    targetUid,
    details: {
      actorRole: callerClaims.role ?? null,
      previousRole: existingClaims.role ?? null,
      suspended: newClaims.suspended === true,
    },
  });

  return { success: true, suspended: newClaims.suspended === true };
}

export const revokeRole = onCall(revokeRoleHandler);
