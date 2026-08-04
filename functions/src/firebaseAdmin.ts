import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// storageBucket is set explicitly rather than relying on initializeApp()'s ambient
// FIREBASE_CONFIG auto-detection: this project's default bucket uses the newer
// "<project-id>.firebasestorage.app" naming (see vitalpulse_app/.env's
// VITE_FIREBASE_STORAGE_BUCKET), and Cloud Functions v2's auto-populated FIREBASE_CONFIG has
// been observed to still resolve to the legacy "<project-id>.appspot.com" bucket for projects
// on this newer naming scheme — a bucket that doesn't exist, so getStorage().bucket() (used
// by kyc.ts's submitKYC/submitLivenessSelfie) throws, surfacing to the client as a generic
// "internal" FirebaseError. Pinning it here removes the ambiguity at the source instead of
// patching every getStorage().bucket() call site individually.
if (getApps().length === 0) {
  initializeApp({
    storageBucket: process.env.STORAGE_BUCKET || 'vitalpulse-fa458.firebasestorage.app',
  });
}

export const auth = getAuth();
export const db = getFirestore();
