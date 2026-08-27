import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';
import { type CallerClaims } from './roles';

export async function deleteUserAccountHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call deleteUserAccount.');
  }

  const callerClaims = (request.auth.token ?? {}) as CallerClaims;
  if (callerClaims.suspended) {
    throw new HttpsError('permission-denied', 'Caller account is suspended.');
  }
  if (callerClaims.role !== 'system_admin') {
    throw new HttpsError('permission-denied', 'Caller role is not authorized to delete user accounts.');
  }

  const { targetUid, email } = request.data ?? {};
  let uidToDelete = targetUid;

  if (!uidToDelete && email) {
    try {
      const userRecord = await auth.getUserByEmail(email);
      uidToDelete = userRecord.uid;
    } catch {
      // not found by email in Firebase Auth
    }
  }

  if (!uidToDelete && targetUid) {
    uidToDelete = targetUid;
  }

  if (!uidToDelete && !email) {
    throw new HttpsError('invalid-argument', 'Must provide targetUid or email to delete.');
  }

  if (uidToDelete && uidToDelete === request.auth.uid) {
    throw new HttpsError('permission-denied', 'Cannot delete your own admin account.');
  }

  // 1. Delete from Firebase Auth by UID (or lookup email if UID failed)
  try {
    if (uidToDelete) {
      await auth.deleteUser(uidToDelete);
    }
  } catch (err) {
    console.warn(`Failed to delete Firebase Auth user by UID ${uidToDelete}:`, err);
  }

  if (email) {
    try {
      const userByEmail = await auth.getUserByEmail(email);
      if (userByEmail?.uid) {
        await auth.deleteUser(userByEmail.uid);
      }
    } catch {
      // ignore if already deleted
    }
  }

  // 2. Delete from Firestore users collection
  try {
    if (uidToDelete) {
      await db.collection('users').doc(uidToDelete).delete();
    }
  } catch (err) {
    console.warn(`Failed to delete Firestore user doc ${uidToDelete}:`, err);
  }

  // 3. Delete from Firestore donors collection if present
  try {
    if (uidToDelete) {
      await db.collection('donors').doc(uidToDelete).delete();
    }
  } catch {
    // ignore
  }

  await writeAudit({
    actorUid: request.auth.uid,
    action: 'deleteUserAccount',
    targetUid: uidToDelete || email,
    details: {
      actorRole: callerClaims.role ?? null,
      email: email ?? null,
    },
  });

  return { success: true, deletedUid: uidToDelete };
}

export const deleteUserAccountFn = onCall({ cors: true }, deleteUserAccountHandler);
