import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';
import { hasAnyRole, type CallerClaims, type Role } from './roles';
import {
  createStaffAccountSchema,
  verifyStaffPinSchema,
  staffDirectLoginSchema,
} from './schemas';
import { hashPin, verifyPin } from './staffPin';

/**
 * Staff account management and authentication.
 *
 * SECURITY REWRITE 2026-08-08 — this module previously leaked a full hospital
 * takeover path. See staffPin.ts's header for the PIN half. The other half was
 * structural: staff records (including the PIN hash) were written CLIENT-SIDE
 * into a `staff_accounts/{email}` collection whose rules were `allow get, list:
 * if true`, and the client also performed the PIN comparison itself. Anyone
 * could enumerate every hospital's staff, recover the PIN offline, and sign in.
 *
 * The model now:
 *   - PIN hashes live ONLY in hospitals/{hospitalId}/staff/{staffUid}, which no
 *     client can read (see firestore.rules) and only the Admin SDK writes.
 *   - Email -> staff lookup uses `staff_index/{emailKey}`, also Admin-SDK-only.
 *     It stores the routing keys needed to find the staff doc — never a hash.
 *   - Authentication happens here and returns a Firebase CUSTOM TOKEN. There is
 *     no password derived from the PIN any more, so PIN recovery no longer
 *     implies account access, and the client never sees a hash to compare.
 *   - Rate limiting is persisted in Firestore rather than an in-memory Map: the
 *     old Map reset on every cold start and was per-instance, so an attacker got
 *     effectively unlimited attempts by spreading them out.
 */

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function emailKey(email: string): string {
  // Firestore doc IDs cannot contain '/'. Emails cannot either, but normalise
  // defensively so a malformed value can never escape its collection.
  return email.trim().toLowerCase().replace(/\//g, '_');
}

interface StaffRecord {
  uid: string;
  name: string;
  email: string;
  roles: Role[];
  hospitalId: string;
  hospitalName: string | null;
  active: boolean;
  pinAlgo?: string | null;
  pinSalt?: string | null;
  pinHash?: string | null;
}

/** Resolves the hospital's display name from its own users doc. */
async function resolveHospitalName(hospitalId: string): Promise<string | null> {
  const snap = await db.collection('users').doc(hospitalId).get();
  if (!snap.exists) return null;
  return (snap.data()?.name as string | undefined) ?? null;
}

/**
 * Finds a staff record by email using the Admin SDK only.
 * Tries the server-side index first, then falls back to a collectionGroup scan
 * for accounts created before the index existed (which then self-heals).
 */
async function findStaffByEmail(email: string): Promise<{ record: StaffRecord; ref: FirebaseFirestore.DocumentReference } | null> {
  const key = emailKey(email);

  const indexSnap = await db.collection('staff_index').doc(key).get();
  if (indexSnap.exists) {
    const { hospitalId, staffUid } = indexSnap.data() as { hospitalId?: string; staffUid?: string };
    if (hospitalId && staffUid) {
      const ref = db.collection('hospitals').doc(hospitalId).collection('staff').doc(staffUid);
      const staffSnap = await ref.get();
      if (staffSnap.exists) {
        return { record: staffSnap.data() as StaffRecord, ref };
      }
    }
  }

  const groupSnap = await db
    .collectionGroup('staff')
    .where('email', '==', key)
    .limit(1)
    .get();
  if (groupSnap.empty) return null;

  const doc = groupSnap.docs[0];
  const record = doc.data() as StaffRecord;
  // Self-heal the index so the next login takes the fast path.
  await db.collection('staff_index').doc(key).set(
    { hospitalId: record.hospitalId, staffUid: record.uid ?? doc.id, email: key },
    { merge: true },
  );
  return { record, ref: doc.ref };
}

/**
 * Persisted attempt counter. Returns the remaining lockout in ms, or 0 if the
 * caller may proceed.
 */
async function checkLockout(key: string): Promise<number> {
  const snap = await db.collection('staff_login_attempts').doc(key).get();
  if (!snap.exists) return 0;
  const { lockUntil } = snap.data() as { lockUntil?: number };
  if (!lockUntil) return 0;
  const remaining = lockUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

async function recordFailure(key: string): Promise<number> {
  const ref = db.collection('staff_login_attempts').doc(key);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? (snap.data() as { attempts?: number; firstAttemptAt?: number }) : {};
    // Attempts older than the window don't count toward a lockout.
    const withinWindow = data.firstAttemptAt != null && now - data.firstAttemptAt < ATTEMPT_WINDOW_MS;
    const attempts = (withinWindow ? data.attempts ?? 0 : 0) + 1;
    tx.set(
      ref,
      {
        attempts,
        firstAttemptAt: withinWindow ? data.firstAttemptAt : now,
        lockUntil: attempts >= MAX_PIN_ATTEMPTS ? now + LOCKOUT_MS : 0,
        updatedAt: now,
      },
      { merge: true },
    );
    return attempts;
  });
}

async function clearFailures(key: string): Promise<void> {
  await db.collection('staff_login_attempts').doc(key).delete().catch(() => {});
}

/** Upgrades a legacy PIN hash in place after a successful legacy verification. */
async function upgradeLegacyPin(ref: FirebaseFirestore.DocumentReference, pin: string): Promise<void> {
  try {
    const fresh = await hashPin(pin);
    await ref.set(fresh, { merge: true });
  } catch {
    // Never fail a valid login because the opportunistic upgrade failed.
  }
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

  const cleanEmail = emailKey(email);

  // The hospital's display name is resolved SERVER-SIDE and stamped onto the
  // staff record + users doc. Without it, every hospital-scoped query the staff
  // member's dashboard runs (incoming donors, inventory, requests — all keyed on
  // the hospital NAME) silently returns the empty set, because the client falls
  // back to the staff member's own name. This was the root cause of "the
  // receptionist's dashboard is blank".
  const hospitalName = await resolveHospitalName(hospitalId);
  if (!hospitalName) {
    throw new HttpsError('failed-precondition', 'Hospital account has no name on file; cannot scope staff to it.');
  }

  let userRecord;
  try {
    userRecord = await auth.createUser({
      email: cleanEmail,
      displayName: name,
      emailVerified: true,
    });
  } catch (e: unknown) {
    const err = e as Error;
    throw new HttpsError('already-exists', err.message || 'Failed to create user account.');
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

  const pinRecord = pin ? await hashPin(pin) : { pinAlgo: null, pinSalt: null, pinHash: null };
  const staffData = {
    uid: staffUid,
    name,
    email: cleanEmail,
    roles,
    hospitalId,
    hospitalName,
    active: true,
    ...pinRecord,
    createdAt: new Date().toISOString(),
    createdBy: request.auth.uid,
  };

  await db.collection('hospitals').doc(hospitalId).collection('staff').doc(staffUid).set(staffData);

  // Admin-SDK-only routing index. Deliberately carries NO credential material —
  // just enough to locate the staff doc from an email at login time.
  await db.collection('staff_index').doc(cleanEmail).set({
    email: cleanEmail,
    hospitalId,
    staffUid,
    updatedAt: new Date().toISOString(),
  });

  await db.collection('users').doc(staffUid).set({
    uid: staffUid,
    name,
    email: cleanEmail,
    roles,
    role: primaryRole,
    hospitalId,
    hospitalName,
    userType: 'hospital_staff',
    isStaffAccount: true,
    active: true,
    createdAt: new Date().toISOString(),
  }, { merge: true });

  await writeAudit({
    actorUid: request.auth.uid,
    action: 'createStaffAccount',
    targetUid: staffUid,
    details: {
      staffName: name,
      roles: roles.join(', '),
      hospitalId,
    },
  });

  return { success: true, staffUid, email: cleanEmail, roles, hospitalId, hospitalName };
}

/**
 * Shared-device quick switch: an already-signed-in hospital session hands the
 * dashboard over to a named staff member after PIN entry. This does NOT mint a
 * new Firebase session — the underlying auth identity stays the hospital's —
 * so it is a UI-scoping mechanism, not an authentication boundary. Real staff
 * authentication is authenticateStaffDirectLogin below.
 */
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

  const lockKey = `pin_${hospitalId}_${staffUid}`;
  const remaining = await checkLockout(lockKey);
  if (remaining > 0) {
    throw new HttpsError(
      'resource-exhausted',
      `Account PIN locked after ${MAX_PIN_ATTEMPTS} failed attempts. Try again in ${Math.ceil(remaining / 60000)} minutes.`,
    );
  }

  const ref = db.collection('hospitals').doc(hospitalId).collection('staff').doc(staffUid);
  const staffDoc = await ref.get();
  if (!staffDoc.exists) {
    throw new HttpsError('not-found', 'Staff account not found.');
  }

  const staffData = staffDoc.data() as StaffRecord;
  if (staffData.active === false) {
    throw new HttpsError('permission-denied', 'Staff account is inactive or deactivated.');
  }

  const { ok, needsUpgrade } = await verifyPin(pin, staffData);
  if (!ok) {
    const attempts = await recordFailure(lockKey);
    await writeAudit({
      actorUid: request.auth.uid,
      action: 'STAFF_PIN_FAILED',
      targetUid: staffUid,
      details: { hospitalId, failedAttemptCount: attempts, isLockedOut: attempts >= MAX_PIN_ATTEMPTS },
    });
    if (attempts >= MAX_PIN_ATTEMPTS) {
      throw new HttpsError('resource-exhausted', `PIN verification failed ${MAX_PIN_ATTEMPTS} times. Account locked for 15 minutes for security.`);
    }
    throw new HttpsError('permission-denied', `Incorrect 4-digit PIN. (${MAX_PIN_ATTEMPTS - attempts} attempts remaining)`);
  }

  if (needsUpgrade) await upgradeLegacyPin(ref, pin);
  await clearFailures(lockKey);

  return {
    success: true,
    staffUid: staffData.uid,
    name: staffData.name,
    roles: staffData.roles || [],
    hospitalId,
    hospitalName: staffData.hospitalName ?? (await resolveHospitalName(hospitalId)),
  };
}

/**
 * Staff sign-in with email + PIN, returning a Firebase custom token.
 *
 * Intentionally callable while unauthenticated — this IS the sign-in path. The
 * protections that make that safe are: a persisted 5-attempt/15-minute lockout
 * keyed on the email, scrypt verification, and the fact that a failed lookup and
 * a failed PIN return the same error (no account-existence oracle).
 *
 * It also self-heals accounts created by the old client-side fallback, which
 * could not set custom claims: those accounts exist in Firestore with roles but
 * carry no claims, so every rules check and every Cloud Function authz check
 * denies them. Setting the claims here is what actually makes a sub-account
 * work end to end.
 */
export async function authenticateStaffDirectLoginHandler(request: CallableRequest) {
  const parsed = staffDirectLoginSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Email and 4-digit PIN are required.');
  }
  const { email, pin } = parsed.data;
  const key = emailKey(email);

  const remaining = await checkLockout(`login_${key}`);
  if (remaining > 0) {
    throw new HttpsError(
      'resource-exhausted',
      `Too many failed attempts. Try again in ${Math.ceil(remaining / 60000)} minutes.`,
    );
  }

  const found = await findStaffByEmail(key);

  // Uniform failure: never reveal whether the email corresponds to a staff
  // account. An attacker probing addresses learns nothing either way.
  const fail = async () => {
    const attempts = await recordFailure(`login_${key}`);
    if (attempts >= MAX_PIN_ATTEMPTS) {
      throw new HttpsError('resource-exhausted', 'Too many failed attempts. Account locked for 15 minutes.');
    }
    throw new HttpsError('permission-denied', 'Incorrect email or 4-digit PIN.');
  };

  if (!found) return fail();

  const { record, ref } = found;
  if (record.active === false) {
    throw new HttpsError('permission-denied', 'This staff account has been deactivated by the Hospital Admin.');
  }

  const { ok, needsUpgrade } = await verifyPin(pin, record);
  if (!ok) return fail();

  if (needsUpgrade) await upgradeLegacyPin(ref, pin);
  await clearFailures(`login_${key}`);

  const roles = (record.roles && record.roles.length > 0 ? record.roles : []) as Role[];
  if (roles.length === 0) {
    throw new HttpsError('failed-precondition', 'Staff account has no roles assigned. Contact your Hospital Admin.');
  }

  // Ensure a real Auth user backs this record, then (re)assert claims. Accounts
  // created by the removed client-side fallback have a synthetic uid and no Auth
  // user at all; those are repaired here rather than left permanently broken.
  let staffUid = record.uid;
  try {
    await auth.getUser(staffUid);
  } catch {
    try {
      const existing = await auth.getUserByEmail(key);
      staffUid = existing.uid;
    } catch {
      const created = await auth.createUser({ email: key, displayName: record.name, emailVerified: true });
      staffUid = created.uid;
    }
    await ref.set({ uid: staffUid }, { merge: true });
    await db.collection('staff_index').doc(key).set({ staffUid }, { merge: true });
  }

  const hospitalName = record.hospitalName ?? (await resolveHospitalName(record.hospitalId));

  await auth.setCustomUserClaims(staffUid, {
    roles,
    role: roles[0],
    hospitalId: record.hospitalId,
    staffUid,
  });

  await db.collection('users').doc(staffUid).set({
    uid: staffUid,
    email: key,
    name: record.name,
    roles,
    role: roles[0],
    hospitalId: record.hospitalId,
    hospitalName,
    userType: 'hospital_staff',
    isStaffAccount: true,
    active: true,
    lastActiveAt: new Date().toISOString(),
  }, { merge: true });

  const token = await auth.createCustomToken(staffUid);

  await writeAudit({
    actorUid: staffUid,
    action: 'staffDirectLogin',
    targetUid: staffUid,
    details: { hospitalId: record.hospitalId, roles: roles.join(', ') },
  });

  return {
    success: true,
    token,
    staffUid,
    name: record.name,
    email: key,
    roles,
    hospitalId: record.hospitalId,
    hospitalName: hospitalName ?? null,
  };
}

export const createStaffAccount = onCall({ cors: true }, createStaffAccountHandler);
export const verifyStaffPin = onCall({ cors: true }, verifyStaffPinHandler);
export const authenticateStaffDirectLogin = onCall({ cors: true }, authenticateStaffDirectLoginHandler);
