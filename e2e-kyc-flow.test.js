/**
 * VitalPulse — End-to-end KYC flow (Stream F4, donor UI/VitalPulse_Plan_Tracker.md).
 * Run: npm run test:e2e
 *
 * Exercises the REAL flow through the REAL services (Auth + Firestore + Functions + Storage
 * emulators, actual deployed Cloud Function code from functions/lib, actual firestore.rules/
 * storage.rules) rather than mocking any layer:
 *
 *   sign up → onDonorSignUp bootstraps the donor → pending dashboard (live donors/{uid}
 *   listener, same as donor-dashboard.js's initDonorStatusListener) → submitKYC → admin
 *   verifyDonor → the donor's ALREADY-OPEN listener (never re-subscribed, never manually
 *   refetched) receives the verified status — proving Stream D's "real-time unlock" claim
 *   end-to-end, not just at the unit level.
 *
 * Two separate Firebase app instances simulate two separate browser sessions (donor +
 * admin) talking to the same backend, which is what actually proves the realtime path —
 * a single shared session wouldn't catch a listener that only happens to work because it's
 * also the one making the write.
 */
import { initializeApp as initAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, onSnapshot } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ID = 'vitalpulse-fa458';
const AUTH_EMULATOR_URL = 'http://127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8080;
const FUNCTIONS_HOST = '127.0.0.1';
const FUNCTIONS_PORT = 5001;

process.env.FIRESTORE_EMULATOR_HOST = `${FIRESTORE_HOST}:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = PROJECT_ID;

let adminSdkAuth;

// Donor session — one Firebase app instance, standing in for the donor's browser tab.
let donorAuth, donorDb, donorFunctions;
// Admin session — a SEPARATE app instance, standing in for the reviewer's browser tab.
let adminAuth, adminFunctions;

function waitForSnapshot(predicate, snapshots, timeoutMs = 15000) {
  const already = snapshots.find(predicate);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for a matching snapshot. Seen: ${JSON.stringify(snapshots)}`)), timeoutMs);
    const check = setInterval(() => {
      const match = snapshots.find(predicate);
      if (match) { clearInterval(check); clearTimeout(timer); resolve(match); }
    }, 100);
  });
}

beforeAll(() => {
  adminSdkAuth = getAdminAuth(initAdminApp({ projectId: PROJECT_ID }, 'admin-sdk'));

  const donorApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, 'donor-session');
  donorAuth = getAuth(donorApp);
  connectAuthEmulator(donorAuth, AUTH_EMULATOR_URL, { disableWarnings: true });
  donorDb = getFirestore(donorApp);
  connectFirestoreEmulator(donorDb, FIRESTORE_HOST, FIRESTORE_PORT);
  donorFunctions = getFunctions(donorApp);
  connectFunctionsEmulator(donorFunctions, FUNCTIONS_HOST, FUNCTIONS_PORT);

  const adminApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, 'admin-session');
  adminAuth = getAuth(adminApp);
  connectAuthEmulator(adminAuth, AUTH_EMULATOR_URL, { disableWarnings: true });
  adminFunctions = getFunctions(adminApp);
  connectFunctionsEmulator(adminFunctions, FUNCTIONS_HOST, FUNCTIONS_PORT);
});

describe('End-to-end: sign up → KYC → pending dashboard → admin verifies → real-time unlock', () => {
  it('runs the full flow against real emulated services', async () => {
    const donorEmail = `donor-${Date.now()}@example.com`;
    const adminEmail = `admin-${Date.now()}@example.com`;

    // ---- 1. Sign up (client SDK, Auth emulator) ----
    const donorCred = await createUserWithEmailAndPassword(donorAuth, donorEmail, 'Str0ng!Passw0rd');
    const donorUid = donorCred.user.uid;

    // ---- 2. onDonorSignUp bootstraps role + donors/{uid} (real Cloud Function) ----
    const callOnDonorSignUp = httpsCallable(donorFunctions, 'onDonorSignUp');
    const bootstrapResult = await callOnDonorSignUp();
    expect(bootstrapResult.data).toEqual({ success: true, kycStatus: 'pending' });

    // Custom claims only take effect on a fresh ID token — same reason donor-dashboard.js
    // uses the Firestore doc (not the claim) for live UI, but Functions calls DO need the
    // refreshed claim to pass hasRole()-equivalent checks server-side.
    await donorAuth.currentUser.getIdToken(true);

    // ---- 3. Pending dashboard — a real-time listener, same shape as
    //         initDonorStatusListener() in donor-dashboard.js (D1) ----
    const donorSnapshots = [];
    const unsubscribe = onSnapshot(doc(donorDb, 'donors', donorUid), (snap) => {
      if (snap.exists()) donorSnapshots.push(snap.data());
    }, (err) => { throw err; });

    const pendingSnap = await waitForSnapshot((s) => s.kycStatus === 'pending', donorSnapshots);
    expect(pendingSnap.kycDocRef).toBeNull(); // skipped/not-yet-submitted state

    // ---- 4. submitKYC (real Cloud Function — writes Storage + donors/{uid} + adminQueue) ----
    const callSubmitKyc = httpsCallable(donorFunctions, 'submitKYC');
    const tinyBase64 = Buffer.from('not a real ID document, just test bytes').toString('base64');
    const submitResult = await callSubmitKyc({
      docType: 'national_id',
      fileBase64: tinyBase64,
      fileName: 'id.jpg',
      mimeType: 'image/jpeg',
    });
    expect(submitResult.data.success).toBe(true);

    const underReviewSnap = await waitForSnapshot((s) => Boolean(s.kycDocRef), donorSnapshots);
    expect(underReviewSnap.kycStatus).toBe('pending');
    expect(underReviewSnap.kycDocType).toBe('national_id');

    // ---- 5. Bootstrap ONE system_admin out-of-band (Admin SDK) — mirrors how a real
    //         deployment bootstraps its first admin; there is no self-service path to
    //         become system_admin, by design (grantRole itself requires an existing one). ----
    const adminRecord = await adminSdkAuth.createUser({ email: adminEmail, password: 'Str0ng!Passw0rd' });
    await adminSdkAuth.setCustomUserClaims(adminRecord.uid, { role: 'system_admin' });

    // ---- 6. Admin session signs in (a SEPARATE browser tab) and verifies the donor ----
    await signInWithEmailAndPassword(adminAuth, adminEmail, 'Str0ng!Passw0rd');
    await adminAuth.currentUser.getIdToken(true);

    const callVerifyDonor = httpsCallable(adminFunctions, 'verifyDonor');
    const verifyResult = await callVerifyDonor({ targetUid: donorUid });
    expect(verifyResult.data).toEqual({ success: true, kycStatus: 'verified' });

    // ---- 7. Real-time unlock — the donor's listener from step 3 is STILL open and was
    //         never re-subscribed or manually refetched. If this resolves, the admin's
    //         write in a completely different session reached the donor's live dashboard
    //         on its own, exactly like Stream D promises. ----
    const verifiedSnap = await waitForSnapshot((s) => s.kycStatus === 'verified', donorSnapshots);
    expect(verifiedSnap.kycRejectionReason).toBeNull();

    unsubscribe();
  }, 45000);
});

afterAll(async () => {
  // No explicit admin app cleanup needed — emulators:exec tears down the whole emulator
  // suite (and this process) after the test run.
});
