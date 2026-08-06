import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getStorage } from "firebase/storage";

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

// Offline-first: reads are served from a local cache when there's no connection, and writes
// made while offline are queued on-device and automatically synced once it returns — this is
// the Firestore SDK's own behavior, enabled by using a persistent local cache instead of the
// default in-memory one. persistentMultipleTabManager lets the cache be shared safely if the
// user has VitalPulse open in more than one tab.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});