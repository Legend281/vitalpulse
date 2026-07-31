/**
 * VitalPulse — Firestore Security Rules test suite (Phase 2, real schema).
 * Run: npm run test:rules
 *
 * Covers the real 10-collection schema (see PHASE0_AUDIT.md §7) against
 * firestore.rules: collection x role x action, including hostile cases per
 * Master Plan 3.1 (cross-hospital access, self-elevation, unauthenticated
 * writes, illegal status transitions).
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc, addDoc } from 'firebase/firestore';

let env;

const claims = {
  donorA:   { role: 'donor' },
  donorB:   { role: 'donor' },
  staffH1:  { role: 'hospital_staff', hospitalId: 'H1' },
  staffH2:  { role: 'hospital_staff', hospitalId: 'H2' },
  labH1:    { role: 'lab_tech', hospitalId: 'H1' },
  hAdminH1: { role: 'hospital_admin', hospitalId: 'H1' },
  sysAdmin: { role: 'system_admin' },
  nbtp:     { role: 'nbtp_viewer' },
  suspended:{ role: 'donor', suspended: true },
  noRole:   {}, // signed in, but grantRole never ran — the real state of every account today
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
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'users/donorA'), { role: 'donor', email: 'a@x.com', name: 'Donor A', bloodType: 'O-', city: 'Douala' });
    await setDoc(doc(db, 'users/H1'), { role: 'hospital', email: 'h1@x.com', name: 'Hospital One', city: 'Douala', isVerified: true });
    await setDoc(doc(db, 'users/H2'), { role: 'hospital', email: 'h2@x.com', name: 'Hospital Two', city: 'Yaounde', isVerified: false });

    await setDoc(doc(db, 'requests/R1'), { hospital: 'Hospital One', hospitalId: 'H1', bloodType: 'O-', status: 'Open', isEmergency: true, requestedAt: 'now' });
    await setDoc(doc(db, 'requests/R2'), { hospital: 'Hospital One', hospitalId: 'H1', bloodType: 'O-', status: 'Donor Assigned', matchedDonor: 'donorA', matchedAt: 'now', requestedAt: 'now', isEmergency: true });

    await setDoc(doc(db, 'inventory/H1_O-'), { bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: 10 });

    await setDoc(doc(db, 'donation_requests/D1'), { donorId: 'donorA', bloodType: 'O-', status: 'pending' });

    await setDoc(doc(db, 'activity_logs/L1'), { title: 'seed', type: 'info' });
    await setDoc(doc(db, 'auditLogs/A1'), { action: 'seed' });

    await setDoc(doc(db, 'donor_notifications/N1'), { donorId: 'donorA', title: 'x', read: false });
    await setDoc(doc(db, 'hospital_notifications/HN1'), { hospitalId: 'H1', title: 'x', read: false });

    await setDoc(doc(db, 'issuance_log/I1'), { hospitalId: 'H1', hospital: 'Hospital One', bloodType: 'O-', units: 1, patientName: 'P' });

    await setDoc(doc(db, 'campaigns/C1'), { title: 'Drive', participants: [], participantCount: 0 });
    await setDoc(doc(db, 'system_settings/config'), { autoMatchDonors: true });
  });
});

describe('deny by default', () => {
  it('HOSTILE: unknown collection denied for everyone, even system_admin', async () =>
    assertFails(setDoc(doc(ctx('sysAdmin'), 'randomCollection/x'), { a: 1 })));

  it('HOSTILE: unauthenticated cannot read anything', async () =>
    assertFails(getDoc(doc(anon(), 'requests/R1'))));

  it('HOSTILE: a signed-in user with no role claim (grantRole never ran) is denied everywhere', async () =>
    assertFails(getDoc(doc(ctx('noRole'), 'users/donorA'))));

  it('HOSTILE: suspended claim locks out an otherwise-valid role', async () =>
    assertFails(getDoc(doc(ctx('suspended'), 'users/donorA'))));
});

describe('users', () => {
  it('any signed-in user can read any profile (matching/notification needs)', async () =>
    assertSucceeds(getDoc(doc(ctx('staffH1'), 'users/donorA'))));

  it('donor signs up declaring only their own uid + donor role', async () =>
    assertSucceeds(setDoc(doc(ctx('donorB'), 'users/donorB'), { role: 'donor', email: 'b@x.com' })));

  it('HOSTILE: cannot self-declare role=admin at signup', async () =>
    assertFails(setDoc(doc(ctx('donorB'), 'users/donorB'), { role: 'system_admin', email: 'b@x.com' })));

  it('HOSTILE: cannot create a doc for someone else\'s uid', async () =>
    assertFails(setDoc(doc(ctx('donorB'), 'users/donorA'), { role: 'donor', email: 'x@x.com' })));

  it('donor edits their own safe profile fields', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'users/donorA'), { city: 'Buea', phone: '123' })));

  it('HOSTILE: donor cannot self-grant isVerified', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'users/donorA'), { isVerified: true })));

  it('HOSTILE: donor cannot self-elevate role', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'users/donorA'), { role: 'system_admin' })));

  it('HOSTILE: hospital cannot self-verify (Master Plan: only system_admin verifies)', async () =>
    assertFails(updateDoc(doc(ctx('hAdminH1'), 'users/H1'), { isVerified: true })));

  it('system_admin verifies a hospital', async () =>
    assertSucceeds(updateDoc(doc(ctx('sysAdmin'), 'users/H2'), { isVerified: true, verifiedAt: 'now' })));

  it('system_admin suspends a donor', async () =>
    assertSucceeds(updateDoc(doc(ctx('sysAdmin'), 'users/donorA'), { isSuspended: true })));

  it('HOSTILE: hospital_admin cannot suspend a donor (not their call)', async () =>
    assertFails(updateDoc(doc(ctx('hAdminH1'), 'users/donorA'), { isSuspended: true })));
});

describe('requests', () => {
  it('hospital_staff creates a request for their own hospital', async () =>
    assertSucceeds(setDoc(doc(ctx('staffH1'), 'requests/R3'), {
      hospital: 'Hospital One', hospitalId: 'H1', bloodType: 'O-',
      status: 'Open', isEmergency: true, requestedAt: 'now',
    })));

  it('HOSTILE: hospital_staff cannot create a request for another hospital', async () =>
    assertFails(setDoc(doc(ctx('staffH1'), 'requests/R4'), {
      hospital: 'Hospital Two', hospitalId: 'H2', bloodType: 'A+',
      status: 'Open', isEmergency: true, requestedAt: 'now',
    })));

  it('HOSTILE: lab_tech cannot create a request (Master Plan 1.2 separation of duties)', async () =>
    assertFails(setDoc(doc(ctx('labH1'), 'requests/R6'), {
      hospital: 'Hospital One', hospitalId: 'H1', bloodType: 'O-',
      status: 'Open', isEmergency: true, requestedAt: 'now',
    })));

  it('system_admin creates a system-wide request with no owning hospital', async () =>
    assertSucceeds(setDoc(doc(ctx('sysAdmin'), 'requests/R5'), {
      hospital: 'Central Command', bloodType: 'O-',
      status: 'Open', isEmergency: true, requestedAt: 'now',
    })));

  it('donor reads an Open request to consider accepting', async () =>
    assertSucceeds(getDoc(doc(ctx('donorA'), 'requests/R1'))));

  it('HOSTILE: hospital_staff of H2 cannot read H1\'s request', async () =>
    assertFails(getDoc(doc(ctx('staffH2'), 'requests/R1'))));

  it('donor accepts an Open request as themselves', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'requests/R1'), {
      status: 'Donor Assigned', matchedDonor: 'donorA', matchedAt: 'now',
    })));

  it('HOSTILE: donor cannot assign a DIFFERENT donor to accept', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'requests/R1'), {
      status: 'Donor Assigned', matchedDonor: 'donorB', matchedAt: 'now',
    })));

  it('HOSTILE: donor cannot double-accept an already-assigned request', async () =>
    assertFails(updateDoc(doc(ctx('donorB'), 'requests/R2'), {
      status: 'Donor Assigned', matchedDonor: 'donorB', matchedAt: 'now',
    })));

  it('the matched donor marks themselves en route', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'requests/R2'), {
      status: 'Donor En Route', enRouteAt: 'now',
    })));

  it('HOSTILE: an uninvolved donor cannot mark someone else\'s request en route', async () =>
    assertFails(updateDoc(doc(ctx('donorB'), 'requests/R2'), {
      status: 'Donor En Route', enRouteAt: 'now',
    })));

  it('HOSTILE: client cannot delete a request', async () =>
    assertFails(deleteDoc(doc(ctx('sysAdmin'), 'requests/R1'))));
});

describe('inventory', () => {
  it('hospital_staff reads/writes their own hospital\'s inventory', async () =>
    assertSucceeds(setDoc(doc(ctx('staffH1'), 'inventory/H1_O-'), {
      bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: 12,
    }, { merge: true })));

  it('HOSTILE: hospital_staff of H2 cannot write H1\'s inventory', async () =>
    assertFails(setDoc(doc(ctx('staffH2'), 'inventory/H1_O-'), {
      bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: 999,
    }, { merge: true })));

  it('HOSTILE: cannot write negative stock', async () =>
    assertFails(setDoc(doc(ctx('staffH1'), 'inventory/H1_O-'), {
      bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: -5,
    }, { merge: true })));

  it('system_admin can write inventory for any hospital (e.g. admin stock-add flow)', async () =>
    assertSucceeds(setDoc(doc(ctx('sysAdmin'), 'inventory/H2_A+'), {
      bloodType: 'A+', hospital: 'Hospital Two', hospitalId: 'H2', unitsAvailable: 3,
    }, { merge: true })));

  it('HOSTILE: donor cannot read hospital inventory', async () =>
    assertFails(getDoc(doc(ctx('donorA'), 'inventory/H1_O-'))));

  it('HOSTILE: lab_tech cannot edit stock directly (Master Plan 1.2 separation of duties)', async () =>
    assertFails(setDoc(doc(ctx('labH1'), 'inventory/H1_O-'), {
      bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: 50,
    }, { merge: true })));

  it('lab_tech CAN still read their own hospital\'s inventory', async () =>
    assertSucceeds(getDoc(doc(ctx('labH1'), 'inventory/H1_O-'))));
});

describe('donation_requests', () => {
  it('donor submits their own donation request', async () =>
    assertSucceeds(setDoc(doc(ctx('donorA'), 'donation_requests/D2'), {
      donorId: 'donorA', bloodType: 'O-', status: 'pending',
    })));

  it('HOSTILE: donor cannot submit a request claiming to be someone else', async () =>
    assertFails(setDoc(doc(ctx('donorB'), 'donation_requests/D3'), {
      donorId: 'donorA', bloodType: 'O-', status: 'pending',
    })));

  it('any hospital_staff can approve a pending donation request', async () =>
    assertSucceeds(updateDoc(doc(ctx('staffH1'), 'donation_requests/D1'), { status: 'approved' })));

  it('donor cancels their own pending request', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'donation_requests/D1'), {
      status: 'cancelled', cancelledAt: 'now', updatedAt: 'now',
    })));

  it('HOSTILE: a different donor cannot cancel someone else\'s request', async () =>
    assertFails(updateDoc(doc(ctx('donorB'), 'donation_requests/D1'), {
      status: 'cancelled', cancelledAt: 'now', updatedAt: 'now',
    })));
});

describe('activity_logs — locked down (Master Plan: no role writes audit logs directly)', () => {
  it('HOSTILE: nobody can write activity_logs client-side, not even system_admin', async () =>
    assertFails(addDoc(collection(ctx('sysAdmin'), 'activity_logs'), { title: 'x', type: 'info' })));

  it('system_admin can read activity_logs', async () =>
    assertSucceeds(getDoc(doc(ctx('sysAdmin'), 'activity_logs/L1'))));

  it('HOSTILE: hospital_admin cannot read activity_logs', async () =>
    assertFails(getDoc(doc(ctx('hAdminH1'), 'activity_logs/L1'))));
});

describe('auditLogs — Cloud Function only', () => {
  it('HOSTILE: even system_admin cannot write audit logs client-side', async () =>
    assertFails(setDoc(doc(ctx('sysAdmin'), 'auditLogs/A2'), { action: 'fake' })));

  it('system_admin reads audit logs', async () =>
    assertSucceeds(getDoc(doc(ctx('sysAdmin'), 'auditLogs/A1'))));
});

describe('donor_notifications', () => {
  it('donor reads their own notification', async () =>
    assertSucceeds(getDoc(doc(ctx('donorA'), 'donor_notifications/N1'))));

  it('HOSTILE: donor cannot read another donor\'s notification', async () =>
    assertFails(getDoc(doc(ctx('donorB'), 'donor_notifications/N1'))));

  it('hospital_staff creates a notification for a donor', async () =>
    assertSucceeds(setDoc(doc(ctx('staffH1'), 'donor_notifications/N2'), {
      donorId: 'donorA', title: 'Match found', read: false,
    })));

  it('donor marks their own notification read', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'donor_notifications/N1'), { read: true })));

  it('HOSTILE: donor cannot rewrite the notification content, only "read"', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'donor_notifications/N1'), { title: 'tampered' })));
});

describe('hospital_notifications', () => {
  it('hospital_staff reads their own hospital\'s notification', async () =>
    assertSucceeds(getDoc(doc(ctx('staffH1'), 'hospital_notifications/HN1'))));

  it('HOSTILE: staff of H2 cannot read H1\'s notification', async () =>
    assertFails(getDoc(doc(ctx('staffH2'), 'hospital_notifications/HN1'))));

  it('a donor can notify a hospital (e.g. accepting their request)', async () =>
    assertSucceeds(setDoc(doc(ctx('donorA'), 'hospital_notifications/HN2'), {
      hospitalId: 'H1', title: 'Donor Assigned', read: false,
    })));
});

describe('issuance_log — Restricted-PHI', () => {
  it('hospital_staff of the owning hospital reads issuance records', async () =>
    assertSucceeds(getDoc(doc(ctx('staffH1'), 'issuance_log/I1'))));

  it('HOSTILE: staff of another hospital cannot read patient-identifying issuance records', async () =>
    assertFails(getDoc(doc(ctx('staffH2'), 'issuance_log/I1'))));

  it('HOSTILE: donor can never read issuance_log', async () =>
    assertFails(getDoc(doc(ctx('donorA'), 'issuance_log/I1'))));

  it('HOSTILE: nbtp_viewer cannot read patient-level PHI', async () =>
    assertFails(getDoc(doc(ctx('nbtp'), 'issuance_log/I1'))));

  it('HOSTILE: issuance_log is append-only, no updates', async () =>
    assertFails(updateDoc(doc(ctx('staffH1'), 'issuance_log/I1'), { units: 999 })));

  it('HOSTILE: lab_tech cannot issue blood directly (Master Plan 1.2 separation of duties)', async () =>
    assertFails(addDoc(collection(ctx('labH1'), 'issuance_log'), {
      hospitalId: 'H1', hospital: 'Hospital One', bloodType: 'O-', units: 1, patientName: 'X',
    })));
});

describe('campaigns', () => {
  it('any signed-in user can browse campaigns', async () =>
    assertSucceeds(getDoc(doc(ctx('donorA'), 'campaigns/C1'))));

  it('hospital_staff can join/leave (participants fields only)', async () =>
    assertSucceeds(updateDoc(doc(ctx('staffH1'), 'campaigns/C1'), {
      participants: [{ hospitalName: 'Hospital One' }], participantCount: 1, updatedAt: 'now',
    })));

  it('HOSTILE: hospital_staff cannot rewrite the campaign title', async () =>
    assertFails(updateDoc(doc(ctx('staffH1'), 'campaigns/C1'), { title: 'Hijacked' })));

  it('HOSTILE: hospital_staff cannot create/delete campaigns', async () =>
    assertFails(deleteDoc(doc(ctx('staffH1'), 'campaigns/C1'))));
});

describe('system_settings', () => {
  it('any signed-in user can read global settings', async () =>
    assertSucceeds(getDoc(doc(ctx('donorA'), 'system_settings/config'))));

  it('HOSTILE: only system_admin can write settings', async () =>
    assertFails(setDoc(doc(ctx('hAdminH1'), 'system_settings/config'), { autoMatchDonors: false }, { merge: true })));
});

// ---------------------------------------------------------------------------
// Abuse-case tests (Part 3.2 review, 2026-07-25): list()-level IDOR.
//
// Every test above uses getDoc() on a known document ID. None of them exercise
// Firestore's *list* rule evaluation, which is a genuinely different code path — a
// `list` rule that doesn't reference resource.data grants the query unconditionally,
// regardless of what a per-document get() rule says. This review found two real,
// previously-untested instances of that exact mismatch (donation_requests,
// donor_notifications: list() had no resource.data.donorId check, so any donor could
// run an unfiltered query and read every other donor's records) — fixed in
// firestore.rules. The rest of this block is regression coverage for collections that
// were already correctly scoped but had zero list()-level tests either way.
// ---------------------------------------------------------------------------
describe('abuse-case: list() IDOR — donation_requests (fixed 2026-07-25)', () => {
  it('donor lists only their own donation requests when filtered by donorId==self', async () =>
    assertSucceeds(getDocs(query(collection(ctx('donorA'), 'donation_requests'), where('donorId', '==', 'donorA')))));

  it('HOSTILE: donor cannot list ALL donation requests with an unfiltered query', async () =>
    assertFails(getDocs(collection(ctx('donorB'), 'donation_requests'))));

  it('HOSTILE: donor cannot list another donor\'s donation requests by probing their ID', async () =>
    assertFails(getDocs(query(collection(ctx('donorB'), 'donation_requests'), where('donorId', '==', 'donorA')))));
});

describe('abuse-case: list() IDOR — donor_notifications (fixed 2026-07-25)', () => {
  it('donor lists only their own notifications when filtered by donorId==self', async () =>
    assertSucceeds(getDocs(query(collection(ctx('donorA'), 'donor_notifications'), where('donorId', '==', 'donorA')))));

  it('HOSTILE: donor cannot list ALL donor notifications with an unfiltered query', async () =>
    assertFails(getDocs(collection(ctx('donorB'), 'donor_notifications'))));

  it('HOSTILE: donor cannot list another donor\'s notifications by probing their ID', async () =>
    assertFails(getDocs(query(collection(ctx('donorB'), 'donor_notifications'), where('donorId', '==', 'donorA')))));
});

describe('abuse-case: list() regression coverage — collections already correctly scoped', () => {
  it('hospital_staff lists their own hospital\'s requests when filtered by hospitalId==self', async () =>
    assertSucceeds(getDocs(query(collection(ctx('staffH1'), 'requests'), where('hospitalId', '==', 'H1')))));

  it('HOSTILE: hospital_staff cannot list ALL requests with an unfiltered query', async () =>
    assertFails(getDocs(collection(ctx('staffH2'), 'requests'))));

  it('HOSTILE: hospital_staff cannot list another hospital\'s requests by probing its ID', async () =>
    assertFails(getDocs(query(collection(ctx('staffH2'), 'requests'), where('hospitalId', '==', 'H1')))));

  it('HOSTILE: hospital_staff cannot list ALL inventory with an unfiltered query', async () =>
    assertFails(getDocs(collection(ctx('staffH2'), 'inventory'))));

  it('HOSTILE: hospital_staff cannot list another hospital\'s inventory by probing its ID', async () =>
    assertFails(getDocs(query(collection(ctx('staffH2'), 'inventory'), where('hospitalId', '==', 'H1')))));

  it('HOSTILE: hospital_staff cannot list ALL hospital_notifications with an unfiltered query', async () =>
    assertFails(getDocs(collection(ctx('staffH2'), 'hospital_notifications'))));

  it('HOSTILE: hospital_staff cannot list another hospital\'s notifications by probing its ID', async () =>
    assertFails(getDocs(query(collection(ctx('staffH2'), 'hospital_notifications'), where('hospitalId', '==', 'H1')))));

  it('HOSTILE (Restricted-PHI): hospital_staff cannot list ALL issuance_log with an unfiltered query', async () =>
    assertFails(getDocs(collection(ctx('staffH2'), 'issuance_log'))));

  it('HOSTILE (Restricted-PHI): hospital_staff cannot list another hospital\'s issuance_log by probing its ID', async () =>
    assertFails(getDocs(query(collection(ctx('staffH2'), 'issuance_log'), where('hospitalId', '==', 'H1')))));
});

describe('GAP (not fixed here — Phase 3 scope): admin.html\'s suspendDonor/reactivateDonor are broken by these rules', () => {
  // db.js's suspendDonor()/reactivateDonor() — still called directly from admin.html via
  // window.handleAdminSuspendUser/ReactivateUser, per PHASE0_AUDIT.md §4 — write
  // { isSuspended, isAvailable, statusChangedAt } in one updateDoc call. The system_admin
  // privileged-update rule only whitelists ['isVerified','isSuspended','rejected',
  // 'verifiedAt','statusChangedAt'] — isAvailable isn't in it, so this exact write is
  // rejected outright, for ANY caller including system_admin, once these rules are deployed.
  //
  // Not widened to allow isAvailable here, because that would only paper over the *visible*
  // symptom. The deeper problem: this flow never touches the `suspended` custom claim that
  // signedIn() actually gates Firestore access on (it's a leftover from the pre-Phase-1,
  // pre-custom-claims suspension model). Even a "fixed" version of this exact client call
  // would only ever update a cosmetic Firestore field — a donor "suspended" this way keeps
  // full read/write access to every collection these rules protect, indefinitely, because
  // nothing ever calls revokeRole to set the claim. PHASE0_AUDIT.md §9 already scoped
  // moving suspendDonor/reactivateDonor into a Cloud Function for Phase 3; this test just
  // pins the specific, concrete way the current client code breaks so it isn't
  // rediscovered as a mystery bug report once rules deploy, and isn't "fixed" halfway by
  // someone widening the whitelist without also closing the claims gap.
  it('system_admin\'s suspendDonor() write (isSuspended+isAvailable+statusChangedAt) is currently rejected', async () =>
    assertFails(updateDoc(doc(ctx('sysAdmin'), 'users/donorA'), {
      isSuspended: true, isAvailable: false, statusChangedAt: 'now',
    })));

  it('system_admin\'s reactivateDonor() write (isSuspended+isAvailable+statusChangedAt) is currently rejected', async () =>
    assertFails(updateDoc(doc(ctx('sysAdmin'), 'users/donorA'), {
      isSuspended: false, isAvailable: true, statusChangedAt: 'now',
    })));
});
