import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import * as crypto from 'crypto';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';
import { hasAnyRole, type CallerClaims, type Role } from './roles';
import { createStaffAccountSchema, verifyStaffPinSchema } from './schemas';

// In-memory rate limiting map for PIN verification: staffUid -> { attempts: number, lockUntil: number }
const pinAttempts = new Map<string, { attempts: number; lockUntil: number }>();

function hashPin(pin: string): string {
  return crypto.createHash('sha256').update(`VitalPulse_PIN_${pin}`).digest('hex');
}

export async function createStaffAccountHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to create staff accounts.');
  }

  const caller = (request.auth.token ?? {}) as CallerClaims;
  if (!hasAnyRole(caller, ['hospital_admin', 'system_admin'])) {
    throw new HttpsError('permission-denied', 'Only hospital_admin or system_admin can manage staff accounts.');
  }

  const parsed = createStaffAccountSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid createStaffAccount payload.', parsed.error.flatten());
  }

  const { name, email, roles, hospitalId: targetHospitalId, pin } = parsed.data;
  const hospitalId = caller.hospitalId || targetHospitalId;

  if (!hospitalId) {
    throw new HttpsError('invalid-argument', 'hospitalId is required to create a staff account.');
  }

  if (caller.roles && !hasAnyRole(caller, ['system_admin']) && caller.hospitalId !== hospitalId) {
    throw new HttpsError('permission-denied', 'You may only create staff accounts for your own hospital.');
  }

  let userRecord;
  try {
    userRecord = await auth.createUser({
      email,
      displayName: name,
      emailVerified: true,
    });
  } catch (e: any) {
    throw new HttpsError('already-exists', e.message || 'Failed to create user account.');
  }

  const staffUid = userRecord.uid;
  const primaryRole = roles[0] as Role;

  const customClaims = {
    roles,
    role: primaryRole,
    hospitalId,
    staffUid,
  };

  await auth.setCustomUserClaims(staffUid, customClaims);

  const pinHash = pin ? hashPin(pin) : null;
  const staffData = {
    uid: staffUid,
    name,
    email,
    roles,
    hospitalId,
    active: true,
    pinHash,
    createdAt: new Date().toISOString(),
    createdBy: request.auth.uid,
  };

  await db.collection('hospitals').doc(hospitalId).collection('staff').doc(staffUid).set(staffData);
  await db.collection('users').doc(staffUid).set({
    uid: staffUid,
    name,
    email,
    roles,
    role: primaryRole,
    hospitalId,
    userType: 'hospital_staff',
    active: true,
    createdAt: new Date().toISOString(),
  }, { merge: true });

  await writeAudit({
    actorUid: request.auth.uid,
    action: 'createStaffAccount',
    targetUid: staffUid,
    details: {
      staffName: name,
      roles,
      hospitalId,
    },
  });

  return { success: true, staffUid, email, roles, hospitalId };
}

export async function verifyStaffPinHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to verify PIN.');
  }

  const parsed = verifyStaffPinSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid verifyStaffPin payload.', parsed.error.flatten());
  }

  const { staffUid, pin, hospitalId: payloadHospitalId } = parsed.data;
  const caller = (request.auth.token ?? {}) as CallerClaims;
  const hospitalId = caller.hospitalId || payloadHospitalId;

  if (!hospitalId) {
    throw new HttpsError('invalid-argument', 'hospitalId is required to verify PIN.');
  }

  const now = Date.now();
  const attemptRecord = pinAttempts.get(staffUid) || { attempts: 0, lockUntil: 0 };

  if (attemptRecord.lockUntil > now) {
    const remainingMins = Math.ceil((attemptRecord.lockUntil - now) / 60000);
    throw new HttpsError('resource-exhausted', `Account PIN locked due to 5 consecutive failed attempts. Try again in ${remainingMins} minutes.`);
  }

  const staffDoc = await db.collection('hospitals').doc(hospitalId).collection('staff').doc(staffUid).get();
  if (!staffDoc.exists) {
    throw new HttpsError('not-found', 'Staff account not found.');
  }

  const staffData = staffDoc.data()!;
  if (staffData.active === false) {
    throw new HttpsError('permission-denied', 'Staff account is inactive or deactivated.');
  }

  const targetHash = hashPin(pin);
  if (!staffData.pinHash || staffData.pinHash !== targetHash) {
    const newAttempts = attemptRecord.attempts + 1;
    const lockUntil = newAttempts >= 5 ? now + 15 * 60 * 1000 : 0;
    pinAttempts.set(staffUid, { attempts: newAttempts, lockUntil });

    await writeAudit({
      actorUid: request.auth.uid,
      action: 'STAFF_PIN_FAILED',
      targetUid: staffUid,
      details: {
        hospitalId,
        failedAttemptCount: newAttempts,
        isLockedOut: newAttempts >= 5,
      },
    });

    if (newAttempts >= 5) {
      throw new HttpsError('resource-exhausted', 'PIN verification failed 5 times. Account locked for 15 minutes for security.');
    }
    throw new HttpsError('permission-denied', `Incorrect 4-digit PIN. (${5 - newAttempts} attempts remaining)`);
  }

  pinAttempts.delete(staffUid);
  return { success: true, staffUid: staffData.uid, name: staffData.name, roles: staffData.roles || [staffData.role] };
}

export const createStaffAccount = onCall(createStaffAccountHandler);
export const verifyStaffPin = onCall(verifyStaffPinHandler);
