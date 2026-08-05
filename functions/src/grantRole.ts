import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { auth } from './firebaseAdmin';
import { writeAudit } from './audit';
import { canGrant, isHospitalScopedRole, type CallerClaims } from './roles';
import { grantRoleSchema } from './schemas';

/**
 * grantRole — Security Master Plan 1.4/1.5. The ONLY path by which a
 * privileged role (anything other than the default 'donor') is ever set.
 * There is no client write path to custom claims; this function is it.
 *
 * Exported as a plain async function (wrapped by `onCall` below) so unit
 * tests can call it directly with a fake CallableRequest, no emulator needed.
 */
export async function grantRoleHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call grantRole.');
  }

  const parsed = grantRoleSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid grantRole payload.', parsed.error.flatten());
  }
  const { targetUid, role, hospitalId } = parsed.data;

  if (targetUid === request.auth.uid) {
    throw new HttpsError('permission-denied', 'Self-service role elevation is not permitted.');
  }

  if (isHospitalScopedRole(role) && !hospitalId) {
    throw new HttpsError('invalid-argument', `hospitalId is required when granting role "${role}".`);
  }
  if (!isHospitalScopedRole(role) && hospitalId) {
    throw new HttpsError('invalid-argument', `hospitalId must not be set when granting role "${role}".`);
  }

  const callerClaims = (request.auth.token ?? {}) as CallerClaims;
  const decision = canGrant(callerClaims, role, hospitalId);
  if (!decision.allowed) {
    throw new HttpsError('permission-denied', decision.reason);
  }

  const targetUser = await auth.getUser(targetUid).catch(() => {
    throw new HttpsError('not-found', 'Target user does not exist.');
  });
  const existingClaims = (targetUser.customClaims ?? {}) as CallerClaims;

  const existingRoles = existingClaims.roles && existingClaims.roles.length > 0
    ? existingClaims.roles
    : existingClaims.role
      ? [existingClaims.role]
      : [];
  const updatedRoles = Array.from(new Set([...existingRoles, role]));

  const newClaims: Record<string, unknown> = {
    roles: updatedRoles,
    role,
  };
  if (isHospitalScopedRole(role)) {
    newClaims.hospitalId = hospitalId;
  }
  if (existingClaims.suspended === true) {
    // grantRole never lifts a suspension — that is revokeRole/reactivate's job.
    newClaims.suspended = true;
  }

  await auth.setCustomUserClaims(targetUid, newClaims);
  await auth.revokeRefreshTokens(targetUid);

  await writeAudit({
    actorUid: request.auth.uid,
    action: 'grantRole',
    targetUid,
    details: { actorRole: callerClaims.role ?? null, role, hospitalId: hospitalId ?? null },
  });

  return { success: true, role, hospitalId: hospitalId ?? null };
}

export const grantRole = onCall(grantRoleHandler);
