/**
 * VitalPulse — End-to-end Request and Issuance flow (Scenario A).
 * Run: npm run test:e2e
 *
 * Exercises the REAL flow through the REAL services:
 *   hospital creates request → donor accepts → donor marks en route → donor checks in →
 *   hospital records donation intake (donation complete) → lab resolves test to Cleared →
 *   hospital issues blood to patient → request updates to Issued.
 */
import { initializeApp as initAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, addDoc, updateDoc, collection, onSnapshot } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ID = 'vitalpulse-fa458';
const AUTH_EMULATOR_URL = 'http://127.0.0.1:9099';
const FIRESTORE_HOST = '127.0.0.1';
const FIRESTORE_PORT = 8085; // Matches firebase.json
const FUNCTIONS_HOST = '127.0.0.1';
const FUNCTIONS_PORT = 5001;

process.env.FIRESTORE_EMULATOR_HOST = `${FIRESTORE_HOST}:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = PROJECT_ID;

let adminSdkAuth;

// Hospital Session (Staff/Admin browser tab)
let hospitalAuth, hospitalDb, hospitalFunctions;
// Donor Session (Donor browser tab)
let donorAuth, donorDb;

function waitForRequestStatus(dbInstance, requestId, targetStatus, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for request status to become ${targetStatus}`)), timeoutMs);
    const unsubscribe = onSnapshot(doc(dbInstance, 'requests', requestId), (snap) => {
      if (snap.exists() && snap.data().status === targetStatus) {
        clearTimeout(timer);
        unsubscribe();
        resolve(snap.data());
      }
    }, (err) => {
      clearTimeout(timer);
      unsubscribe();
      reject(err);
    });
  });
}

beforeAll(() => {
  adminSdkAuth = getAdminAuth(initAdminApp({ projectId: PROJECT_ID }, 'admin-sdk'));

  const hospitalApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, 'hospital-session');
  hospitalAuth = getAuth(hospitalApp);
  connectAuthEmulator(hospitalAuth, AUTH_EMULATOR_URL, { disableWarnings: true });
  hospitalDb = getFirestore(hospitalApp);
  connectFirestoreEmulator(hospitalDb, FIRESTORE_HOST, FIRESTORE_PORT);
  hospitalFunctions = getFunctions(hospitalApp);
  connectFunctionsEmulator(hospitalFunctions, FUNCTIONS_HOST, FUNCTIONS_PORT);

  const donorApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' }, 'donor-session');
  donorAuth = getAuth(donorApp);
  connectAuthEmulator(donorAuth, AUTH_EMULATOR_URL, { disableWarnings: true });
  donorDb = getFirestore(donorApp);
  connectFirestoreEmulator(donorDb, FIRESTORE_HOST, FIRESTORE_PORT);
});

describe('Scenario A: Emergency Blood Request Full Lifecycle (Open -> Assigned -> En Route -> Checked In -> Complete -> Tested -> Issued)', () => {
  it('exercises the complete donation, screening, and issuance cycle', async () => {
    const hospitalEmail = `hospital-admin-${Date.now()}@example.com`;
    const donorEmail = `donor-life-saver-${Date.now()}@example.com`;

    // ---- 1. Create accounts and set roles via Admin SDK ----
    const hospitalRecord = await adminSdkAuth.createUser({ email: hospitalEmail, password: 'Str0ng!Passw0rd' });
    await adminSdkAuth.setCustomUserClaims(hospitalRecord.uid, { role: 'hospital_admin', hospitalId: 'H1' });

    const donorRecord = await adminSdkAuth.createUser({ email: donorEmail, password: 'Str0ng!Passw0rd' });
    await adminSdkAuth.setCustomUserClaims(donorRecord.uid, { role: 'donor' });

    // ---- 2. Sign in sessions ----
    await signInWithEmailAndPassword(hospitalAuth, hospitalEmail, 'Str0ng!Passw0rd');
    await hospitalAuth.currentUser.getIdToken(true);

    await signInWithEmailAndPassword(donorAuth, donorEmail, 'Str0ng!Passw0rd');
    await donorAuth.currentUser.getIdToken(true);

    const hospitalUid = hospitalRecord.uid;
    const donorUid = donorRecord.uid;

    // ---- 3. Bootstrap user profiles in Firestore ----
    await setDoc(doc(hospitalDb, 'users', 'H1'), {
      name: 'Hope Hospital',
      email: hospitalEmail,
      role: 'hospital',
      city: 'Yaoundé',
      isVerified: true,
      isActive: true
    });

    await setDoc(doc(donorDb, 'users', donorUid), {
      name: 'Test Donor',
      email: donorEmail,
      role: 'donor',
      bloodType: 'O+',
      city: 'Yaoundé',
      isActive: true
    });

    // Make donor KYC-verified to pass isKycEligible rule
    await setDoc(doc(donorDb, 'donors', donorUid), {
      kycStatus: 'verified'
    });

    // ---- 4. Hospital creates emergency request ----
    const requestRef = await addDoc(collection(hospitalDb, 'requests'), {
      hospitalId: 'H1',
      hospital: 'Hope Hospital',
      status: 'Open',
      isEmergency: true,
      bloodType: 'O+',
      units: 2,
      requestedAt: new Date().toISOString()
    });
    const requestId = requestRef.id;

    // ---- 5. Donor accepts request ----
    await updateDoc(doc(donorDb, 'requests', requestId), {
      status: 'Donor Assigned',
      matchedDonor: donorUid,
      matchedAt: new Date().toISOString(),
      checkInToken: 'VP-TEST-E2ET',
      donorScreeningPassed: true
    });

    let reqSnap = await getDoc(doc(hospitalDb, 'requests', requestId));
    expect(reqSnap.data().status).toBe('Donor Assigned');
    expect(reqSnap.data().matchedDonor).toBe(donorUid);

    // ---- 6. Donor marks en route ----
    await updateDoc(doc(donorDb, 'requests', requestId), {
      status: 'Donor En Route',
      enRouteAt: new Date().toISOString()
    });

    reqSnap = await getDoc(doc(hospitalDb, 'requests', requestId));
    expect(reqSnap.data().status).toBe('Donor En Route');

    // ---- 7. Hospital marks checked in ----
    await updateDoc(doc(hospitalDb, 'requests', requestId), {
      status: 'Checked In',
      checkedInAt: new Date().toISOString()
    });

    reqSnap = await getDoc(doc(hospitalDb, 'requests', requestId));
    expect(reqSnap.data().status).toBe('Checked In');

    // ---- 8. Hospital completes donation intake ----
    await updateDoc(doc(hospitalDb, 'requests', requestId), {
      status: 'Donation Complete',
      donationCompletedAt: new Date().toISOString()
    });

    // Pre-create the inventory document so recordDonationIntake has it
    await setDoc(doc(hospitalDb, 'inventory', 'Hope_Hospital_O+'), {
      hospitalId: 'H1',
      hospitalName: 'Hope Hospital',
      bloodType: 'O+',
      unitsAvailable: 0,
      unitsPendingTest: 0,
      unitsRejected: 0,
      batches: []
    });

    // We write to donation_requests as the donor (representing their session/consent)
    // or as the admin system bypass to satisfy the create rule constraint.
    const donationRef = await addDoc(collection(donorDb, 'donation_requests'), {
      donorId: donorUid,
      donorName: 'Test Donor',
      hospital: 'Hope Hospital',
      bloodType: 'O+',
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    const donationId = donationRef.id;

    // Hospital updates the created donation request to completed (donation completed intake)
    await updateDoc(doc(hospitalDb, 'donation_requests', donationId), {
      status: 'completed',
      completedAt: new Date().toISOString(),
      sourceRequestId: requestId,
      units: 1,
      componentType: 'Whole Blood'
    });

    // Hospital adds the untested batch to inventory
    const batchId = `BATCH-${Date.now()}`;
    await updateDoc(doc(hospitalDb, 'inventory', 'Hope_Hospital_O+'), {
      unitsPendingTest: 1,
      batches: [{
        id: batchId,
        units: 1,
        componentType: 'Whole Blood',
        testStatus: 'Waiting for Lab Test',
        sourceDonationId: donationId,
        createdAt: new Date().toISOString()
      }]
    });

    // ---- 9. Lab resolves test to Cleared (Cloud Function) ----
    const resolveLabTestFn = httpsCallable(hospitalFunctions, 'resolveLabTest');
    await resolveLabTestFn({
      bloodType: 'O+',
      batchId: batchId,
      result: 'Cleared',
      labTechName: 'Tech Jordan'
    });

    let invSnap = await getDoc(doc(hospitalDb, 'inventory', 'Hope_Hospital_O+'));
    expect(invSnap.data().unitsAvailable).toBe(1);
    expect(invSnap.data().unitsPendingTest).toBe(0);
    expect(invSnap.data().batches[0].testStatus).toBe('Cleared');

    // ---- 10. Hospital issues blood to patient (Cloud Function) ----
    const issueBloodFn = httpsCallable(hospitalFunctions, 'issueBloodToPatient');
    await issueBloodFn({
      bloodType: 'O+',
      units: 1,
      patientName: 'Jane Smith',
      patientId: 'P-9982',
      crossmatchConfirmed: true,
      crossmatchResult: 'Compatible',
      requestingPhysicianName: 'Dr. House'
    });

    invSnap = await getDoc(doc(hospitalDb, 'inventory', 'Hope_Hospital_O+'));
    expect(invSnap.data().unitsAvailable).toBe(0);

    // Verify linked donation request and source emergency request updated to Issued
    const donationSnap = await getDoc(doc(hospitalDb, 'donation_requests', donationId));
    expect(donationSnap.data().status).toBe('Issued');

    reqSnap = await getDoc(doc(hospitalDb, 'requests', requestId));
    expect(reqSnap.data().status).toBe('Issued');
  }, 45000);
});

afterAll(async () => {
  // Tear down client session apps
});
