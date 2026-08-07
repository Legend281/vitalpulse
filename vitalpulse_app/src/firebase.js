import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, connectStorageEmulator } from "firebase/storage";
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBWJIygZ5moqqgNvEv_v-oba0MvKllvPLg",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "vitalpulse-fa458.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "vitalpulse-fa458",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "vitalpulse-fa458.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "501893877118",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:501893877118:web:259f04174e4258108a372f"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const storage = getStorage(app);

// Secondary app instance for creating staff Auth users without logging out the active admin
export const secondaryApp = initializeApp(firebaseConfig, "SecondaryApp");
export const secondaryAuth = getAuth(secondaryApp);

// Functions: always target the deployed region explicitly so the SDK constructs the correct
// endpoint. When running locally (localhost/192.168.*), connect to the Functions emulator
// to avoid cross-origin issues with production endpoints.
export const functions = getFunctions(app, import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1');

function isLocalDev() {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') || h.startsWith('10.') || h.endsWith('.local');
}

if (isLocalDev()) {
  // Default emulator port (Firebase CLI) — adjust if your local setup uses a different port.
  try {
    connectFunctionsEmulator(functions, 'localhost', parseInt(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || '5001', 10));
    console.log('[firebase] Connected Functions to emulator on localhost');
  } catch (e) {
    // Non-fatal: keep using remote functions if emulator isn't available
    console.warn('[firebase] Could not connect Functions emulator:', e?.message || e);
  }
}

// Offline-first: reads are served from a local cache when there's no connection, and writes
// made while offline are queued on-device and automatically synced once it returns — this is
// the Firestore SDK's own behavior, enabled by using a persistent local cache instead of the
// default in-memory one. persistentMultipleTabManager lets the cache be shared safely if the
// user has VitalPulse open in more than one tab.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Opt-in ONLY (VITE_USE_FULL_EMULATOR_SUITE=true) — deliberately NOT tied to isLocalDev()
// alone, so normal local dev keeps hitting real Firestore/Auth exactly as it always has
// (existing test accounts, existing data). This is for running the full app against an
// isolated `firebase emulators:start` instance — Firestore rules changes that aren't
// deployed yet only take effect there, never against real prod data — not a change to the
// default local dev experience.
if (isLocalDev() && import.meta.env.VITE_USE_FULL_EMULATOR_SUITE === 'true') {
  try {
    connectFirestoreEmulator(db, 'localhost', parseInt(import.meta.env.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT || '8085', 10));
    connectAuthEmulator(auth, `http://localhost:${import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT || '9099'}`, { disableWarnings: true });
    connectStorageEmulator(storage, 'localhost', parseInt(import.meta.env.VITE_FIREBASE_STORAGE_EMULATOR_PORT || '9199', 10));
    console.log('[firebase] Full emulator suite connected (Firestore/Auth/Storage) — VITE_USE_FULL_EMULATOR_SUITE=true');
  } catch (e) {
    console.warn('[firebase] Could not connect full emulator suite:', e?.message || e);
  }
}