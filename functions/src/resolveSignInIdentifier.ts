import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { db } from './firebaseAdmin';
import { resolveSignInIdentifierSchema } from './schemas';
import { normalizeCameroonPhone } from './phone';

/**
 * resolveSignInIdentifier — Stream C1 (Sign In). `signInWithEmailAndPassword` needs a
 * real email, but the Sign In mockup accepts "Phone or Email." An unauthenticated client
 * can't query `users` directly (firestore.rules: `allow get, list: if hasRole()` — deny
 * by default, no anonymous-lookup exception), so this resolves phone -> email server-side
 * via the Admin SDK, which bypasses rules by design.
 *
 * UNAUTHENTICATED BY NECESSITY, FLAGGED: same class as checkPasswordBreach.ts — called
 * before any Firebase Auth session exists, no request.auth to gate on, no App Check yet
 * (PHASE0_AUDIT.md §10) to rate-limit it either.
 *
 * ANTI-ENUMERATION, LOAD-BEARING: always returns `{ email }`, string or null, never a
 * distinct "phone not found" vs anything-else signal. The client must show the exact
 * same generic error (C1.2: "Incorrect email/phone or password") whether this returns
 * null or whether the subsequent signInWithEmailAndPassword call fails — differentiating
 * the two would turn this into an account-existence oracle.
 */
export async function resolveSignInIdentifierHandler(request: CallableRequest) {
  const parsed = resolveSignInIdentifierSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid resolveSignInIdentifier payload.', parsed.error.flatten());
  }
  const { identifier } = parsed.data;

  if (identifier.includes('@')) {
    return { email: identifier.toLowerCase() };
  }

  const phone = normalizeCameroonPhone(identifier);
  if (!phone) {
    return { email: null };
  }

  const snap = await db.collection('users').where('phone', '==', phone).limit(1).get();
  if (snap.empty) {
    return { email: null };
  }
  const email = snap.docs[0].data().email;
  return { email: typeof email === 'string' ? email : null };
}

export const resolveSignInIdentifier = onCall({ cors: true }, resolveSignInIdentifierHandler);
