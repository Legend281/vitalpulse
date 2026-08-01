import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';
import { checkDuplicateCniSchema } from './schemas';

/**
 * checkDuplicateCni — Phase 3. The ONLY path that answers "is this national-ID
 * hash already registered?". Previously auth.js queried the users collection
 * directly from the client BEFORE account creation, i.e. unauthenticated —
 * deny-by-default rules reject that query outright, which broke donor
 * registration ("Missing or insufficient permissions").
 *
 * Flow: the client creates the Firebase Auth account first, then calls this
 * callable with the CNI hash. The check runs under the Admin SDK (bypasses
 * rules) against the same cniHash field the user doc will carry.
 *
 * If the hash is a duplicate, the function cleans up the just-created account
 * (email was already consumed by Auth) — but ONLY when the caller has no users
 * doc yet, i.e. they are provably mid-registration. An established user probing
 * the endpoint can never have their own account deleted.
 *
 * Exported as a plain async function (wrapped by `onCall` below) so unit
 * tests can call it directly with a fake CallableRequest, no emulator needed.
 */
export async function checkDuplicateCniHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to check a CNI hash.');
  }

  const parsed = checkDuplicateCniSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid cniHash payload.', parsed.error.flatten());
  }
  const { cniHash } = parsed.data;

  const matches = await db
    .collection('users')
    .where('cniHash', '==', cniHash)
    .limit(1)
    .get();
  const duplicate = !matches.empty;

  if (duplicate) {
    const callerDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!callerDoc.exists) {
      // Caller created their Auth account but registration never completed —
      // roll back so the email isn't left pointing at a half-registered donor.
      await auth.deleteUser(request.auth.uid);
      await writeAudit({
        actorUid: request.auth.uid,
        action: 'registrationDuplicateCniRollback',
        details: { actorRole: null },
      });
    }
  }

  return { duplicate };
}

export const checkDuplicateCni = onCall(checkDuplicateCniHandler);
