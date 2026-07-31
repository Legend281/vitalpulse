/**
 * VitalPulse — Firestore Security Rules test suite (starter)
 * Run: firebase emulators:exec --only firestore "npx vitest run"
 * Deps: npm i -D @firebase/rules-unit-testing vitest firebase
 *
 * This file demonstrates the test matrix pattern: for each collection,
 * assert allow AND deny paths per role, including hostile cases.
 * Extend to full coverage before enabling the CI gate.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

let env;

const claims = {
  donorA:        { role: 'donor' },
  donorB:        { role: 'donor' },
  staffH1:       { role: 'hospital_staff', hospitalId: 'H1' },
  staffH2:       { role: 'hospital_staff', hospitalId: 'H2' },
  labH1:         { role: 'lab_tech', hospitalId: 'H1' },
  hAdminH1:      { role: 'hospital_admin', hospitalId: 'H1' },
  sysAdmin:      { role: 'system_admin' },
  suspendedAdmin:{ role: 'system_admin', suspended: true },
};

const ctx = (uid) => env.authenticatedContext(uid, claims[uid]).firestore();
const anon = () => env.unauthenticatedContext().firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'vitalpulse-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});
afterAll(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  // Seed fixtures with rules disabled
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'donors/donorA'), { name: 'A', bloodTypeSource: 'self_reported' });
    await setDoc(doc(db, 'bloodUnits/U1'), { hospitalId: 'H1', status: 'awaiting_test' });
    await setDoc(doc(db, 'bloodUnits/U2'), { hospitalId: 'H1', status: 'rejected' });
    await setDoc(doc(db, 'requests/R1'), { hospitalId: 'H1', status: 'open', bloodType: 'O-' });
    await setDoc(doc(db, 'auditLogs/L1'), { action: 'seed' });
  });
});

describe('donors collection', () => {
  it('donor reads own profile', async () =>
    assertSucceeds(getDoc(doc(ctx('donorA'), 'donors/donorA'))));

  it('HOSTILE: donor cannot read another donor', async () =>
    assertFails(getDoc(doc(ctx('donorB'), 'donors/donorA'))));

  it('donor updates allowed fields only', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'donors/donorA'), { city: 'Buea' })));

  it('HOSTILE: donor cannot flip bloodTypeSource to lab_verified', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'donors/donorA'),
      { bloodTypeSource: 'lab_verified' })));

  it('HOSTILE: donor cannot inflate livesSaved', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'donors/donorA'), { livesSaved: 999 })));
});

describe('bloodUnits lifecycle (Findings §2.2)', () => {
  it('lab_tech clears an awaiting_test unit at own hospital', async () =>
    assertSucceeds(updateDoc(doc(ctx('labH1'), 'bloodUnits/U1'),
      { status: 'cleared', clearedAt: new Date(), testResultsRef: 'T1' })));

  it('HOSTILE: staff cannot clear a unit (separation of duties)', async () =>
    assertFails(updateDoc(doc(ctx('staffH1'), 'bloodUnits/U1'), { status: 'cleared' })));

  it('HOSTILE: illegal transition rejected -> cleared', async () =>
    assertFails(updateDoc(doc(ctx('labH1'), 'bloodUnits/U2'), { status: 'cleared' })));

  it('HOSTILE: staff of H2 cannot read H1 stock', async () =>
    assertFails(getDoc(doc(ctx('staffH2'), 'bloodUnits/U1'))));

  it('HOSTILE: nobody creates units client-side', async () =>
    assertFails(setDoc(doc(ctx('hAdminH1'), 'bloodUnits/UX'),
      { hospitalId: 'H1', status: 'cleared' })));
});

describe('requests', () => {
  it('staff creates open request for own hospital', async () =>
    assertSucceeds(setDoc(doc(ctx('staffH1'), 'requests/R2'), {
      hospitalId: 'H1', bloodType: 'O-', component: 'whole', urgency: 'critical',
      category: 'obstetric_emergency', status: 'open', createdAt: new Date(),
    })));

  it('HOSTILE: staff cannot create request for another hospital', async () =>
    assertFails(setDoc(doc(ctx('staffH1'), 'requests/R3'), {
      hospitalId: 'H2', bloodType: 'A+', component: 'whole', urgency: 'high',
      category: 'normal', status: 'open', createdAt: new Date(),
    })));

  it('HOSTILE: client cannot close/modify a request directly', async () =>
    assertFails(updateDoc(doc(ctx('staffH1'), 'requests/R1'), { status: 'closed' })));
});

describe('public_requests — the only anonymous write path', () => {
  const valid = {
    patientName: 'Jane Doe', hospitalName: 'District Hosp', ward: 'Maternity',
    bloodType: 'O-', urgency: 'critical', submitterPhone: '+237670000000',
    relationship: 'family', createdAt: new Date(),
  };

  it('anonymous create with valid schema succeeds', async () =>
    assertSucceeds(setDoc(doc(anon(), 'public_requests/P1'), valid)));

  it('HOSTILE: cannot self-assign a verification label', async () =>
    assertFails(setDoc(doc(anon(), 'public_requests/P2'),
      { ...valid, verificationLabel: 'hospital_confirmed' })));

  it('HOSTILE: missing phone number rejected', async () => {
    const { submitterPhone, ...noPhone } = valid;
    await assertFails(setDoc(doc(anon(), 'public_requests/P3'), noPhone));
  });

  it('HOSTILE: anonymous cannot read anything', async () =>
    assertFails(getDoc(doc(anon(), 'requests/R1'))));
});

describe('audit logs and suspension', () => {
  it('HOSTILE: even system_admin cannot write audit logs', async () =>
    assertFails(setDoc(doc(ctx('sysAdmin'), 'auditLogs/L2'), { action: 'fake' })));

  it('system_admin reads audit logs', async () =>
    assertSucceeds(getDoc(doc(ctx('sysAdmin'), 'auditLogs/L1'))));

  it('HOSTILE: suspended admin is locked out everywhere', async () =>
    assertFails(getDoc(doc(ctx('suspendedAdmin'), 'auditLogs/L1'))));
});

describe('deny by default', () => {
  it('HOSTILE: unknown collection denied for everyone', async () =>
    assertFails(setDoc(doc(ctx('sysAdmin'), 'randomCollection/x'), { a: 1 })));
});
