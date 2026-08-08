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
  donorC:   { role: 'donor' },
  donorD:   { role: 'donor' },
  donorE:   { role: 'donor' },
  donorF:   { role: 'donor' },
  staffH1:  { role: 'hospital_staff', hospitalId: 'H1' },
  staffH2:  { role: 'hospital_staff', hospitalId: 'H2' },
  labH1:    { role: 'lab_tech', hospitalId: 'H1' },
  hAdminH1: { role: 'hospital_admin', hospitalId: 'H1' },
  hAdminH2: { role: 'hospital_admin', hospitalId: 'H2' },
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
    // R7: donorA already en route — the state the live-GPS, arrival-signal and
    // reception check-in rules operate on. Deliberately NOT R3/R4/R5/R6: those IDs
    // belong to the create tests below, which need the document to be ABSENT so
    // that setDoc is evaluated as a create. Seeding one of them silently turned
    // its create into an update and failed the rule it was asserting.
    await setDoc(doc(db, 'requests/R7'), { hospital: 'Hospital One', hospitalId: 'H1', bloodType: 'O-', status: 'Donor En Route', matchedDonor: 'donorA', matchedAt: 'now', enRouteAt: 'now', requestedAt: 'now', isEmergency: true });

    await setDoc(doc(db, 'public_requests/PR1'), { hospital: 'Hospital One', hospitalId: 'H1', bloodType: 'O-', status: 'Broadcasting' });

    // B7 (Auth & Onboarding Stream B) fixtures: donorA has NO donors/ doc, representing
    // every pre-existing donor today (grandfathered — see firestore.rules' isKycEligible
    // comment). Schema per donor UI/KYC_fix.md (2026-08-07): base64 evidence fields, plus
    // an explicit 'not_submitted' initial state distinct from 'pending' (submitted, awaiting
    // review) — donorE/donorF below exercise the two states KYC_fix.md's rules distinguish
    // that the older schema couldn't (there was no 'not_submitted').
    await setDoc(doc(db, 'donors/donorB'), { kycStatus: 'pending', kycDocType: 'national_id', kycIdImageBase64: 'BASE64_FRONT', kycIdBackImageBase64: 'BASE64_BACK', kycSelfieImageBase64: null, kycSubmittedAt: 'now', kycRejectionReason: null, kycReviewedBy: null, kycReviewedAt: null });
    await setDoc(doc(db, 'donors/donorC'), { kycStatus: 'verified', kycDocType: 'national_id', kycIdImageBase64: 'BASE64_FRONT', kycIdBackImageBase64: 'BASE64_BACK', kycSelfieImageBase64: 'BASE64_SELFIE', kycSubmittedAt: 'now', kycRejectionReason: null, kycReviewedBy: 'sysAdmin', kycReviewedAt: 'now' });
    // donorD: pending but with a rejection reason already on the doc (e.g. rejected once,
    // then re-opened to pending for resubmission without the reason being cleared) — the
    // only fixture shape that can actually exercise the rejectionReason field-lock, since
    // diff().affectedKeys() can't see a same-value write (null -> null on donorB is a true
    // no-op, invisible to rules; see firestore.rules' unchangedExcept() comment).
    await setDoc(doc(db, 'donors/donorD'), { kycStatus: 'pending', kycDocType: 'national_id', kycIdImageBase64: 'BASE64_FRONT', kycIdBackImageBase64: null, kycSelfieImageBase64: null, kycSubmittedAt: 'now', kycRejectionReason: 'Document was blurry.', kycReviewedBy: 'sysAdmin', kycReviewedAt: 'now' });
    // donorE: brand-new account, never submitted anything yet.
    await setDoc(doc(db, 'donors/donorE'), { kycStatus: 'not_submitted', kycDocType: null, kycIdImageBase64: null, kycIdBackImageBase64: null, kycSelfieImageBase64: null, kycSubmittedAt: null, kycRejectionReason: null, kycReviewedBy: null, kycReviewedAt: null });
    // donorF: was rejected, cleared for resubmission.
    await setDoc(doc(db, 'donors/donorF'), { kycStatus: 'rejected', kycDocType: 'national_id', kycIdImageBase64: 'BASE64_OLD', kycIdBackImageBase64: null, kycSelfieImageBase64: null, kycSubmittedAt: 'now', kycRejectionReason: 'Expired ID', kycReviewedBy: 'sysAdmin', kycReviewedAt: 'now' });

    await setDoc(doc(db, 'inventory/H1_O-'), { bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: 10 });
    await setDoc(doc(db, 'inventory/H2_A+'), { bloodType: 'A+', hospital: 'Hospital Two', hospitalId: 'H2', unitsAvailable: 3 });

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

  it('system_admin rejects a hospital (rejectHospital write shape)', async () =>
    assertSucceeds(updateDoc(doc(ctx('sysAdmin'), 'users/H2'), {
      isVerified: false, rejected: true, rejectedAt: 'now',
    })));

  it('system_admin deactivates/reactivates a hospital (isActive write shape)', async () => {
    await assertSucceeds(updateDoc(doc(ctx('sysAdmin'), 'users/H2'), { isActive: false, statusChangedAt: 'now' }));
    await assertSucceeds(updateDoc(doc(ctx('sysAdmin'), 'users/H2'), { isActive: true, statusChangedAt: 'now' }));
  });

  it('HOSTILE: donor cannot self-write isActive (privilege-adjacent field)', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'users/donorA'), { isActive: false })));
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

  // B7: a grandfathered donor (no donors/{uid} record) can still accept — already covered
  // by "donor accepts an Open request as themselves" above (donorA has no donors/ doc seeded).

  it('B7 HOSTILE: a donor with a pending (unverified) KYC record cannot accept an Open request', async () =>
    assertFails(updateDoc(doc(ctx('donorB'), 'requests/R1'), {
      status: 'Donor Assigned', matchedDonor: 'donorB', matchedAt: 'now',
    })));

  it('B7: a donor with a verified KYC record can accept an Open request', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorC'), 'requests/R1'), {
      status: 'Donor Assigned', matchedDonor: 'donorC', matchedAt: 'now',
    })));

  // ---- Whitelist reconciliation, 2026-08-08 ----
  // These pin the rules to the ACTUAL client write shapes. Every one of them
  // failed before this pass, which meant the corresponding user action was
  // denied in production while the rule read as though it allowed it.

  it('donor accept succeeds with the FULL field set db.js actually writes', async () =>
    // acceptRequest's transaction writes seven fields. `checkInTokenExpiresAt`
    // and `nudgeSent` were missing from the whitelist, so unchangedExcept()
    // failed and every real accept was denied.
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'requests/R1'), {
      status: 'Donor Assigned',
      matchedDonor: 'donorA',
      matchedAt: 'now',
      checkInToken: 'VP-0001-ABCD',
      checkInTokenExpiresAt: 'later',
      nudgeSent: false,
      donorScreeningPassed: true,
    })));

  it('the matched donor may push live GPS position while en route', async () =>
    // No rule permitted these fields before, so updateDonorLiveLocation was
    // denied on every tick (silently — the caller try/catches) and the
    // hospital's tracking map never moved off "Waiting for signal…".
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'requests/R7'), {
      donorLat: 4.15, donorLng: 9.24, donorLocationUpdatedAt: 'now',
    })));

  it('HOSTILE: a donor cannot smuggle a status change into a location update', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'requests/R7'), {
      donorLat: 4.15, donorLng: 9.24, status: 'Checked In',
    })));

  it('the matched donor signals arrival WITHOUT advancing to Checked In', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'requests/R7'), {
      status: 'Donor En Route', arrivedAt: 'now', receptionStatus: 'Awaiting Verification',
    })));

  it('HOSTILE: a donor cannot check THEMSELVES in — only hospital staff may', async () =>
    // The whole point of the reception handshake: the pass code has to be
    // presented to a person. Self-check-in made it decorative.
    assertFails(updateDoc(doc(ctx('donorA'), 'requests/R7'), {
      status: 'Checked In', checkedInAt: 'now',
    })));

  it('the owning hospital checks a donor in with the full write shape', async () =>
    // checkInDonor writes checkedInByStaffUid and receptionStatus too; both were
    // missing from the whitelist, so the front desk's own check-in was denied.
    assertSucceeds(updateDoc(doc(ctx('staffH1'), 'requests/R7'), {
      status: 'Checked In', checkedInAt: 'now', checkedInByStaffUid: 'staffH1', receptionStatus: 'Checked In',
    })));

  it('HOSTILE: staff of another hospital cannot check in this hospital\'s donor', async () =>
    assertFails(updateDoc(doc(ctx('staffH2'), 'requests/R7'), {
      status: 'Checked In', checkedInAt: 'now', checkedInByStaffUid: 'staffH2',
    })));
});

describe('staff credential collections are server-only (2026-08-08 remediation)', () => {
  // PERMANENT GUARANTEE. `staff_accounts` was `allow get, list: if true` and
  // held every hospital staff member's PIN hash — an unauthenticated GET
  // returned the national staff directory, and the 4-digit PIN behind each
  // unsalted SHA-256 cracked instantly. The PIN also derived the account's
  // Firebase Auth password, so recovery meant takeover. No caller, at any role,
  // may read or write any of these collections again.
  it('HOSTILE: an unauthenticated visitor cannot list staff_accounts', async () =>
    assertFails(getDocs(collection(anon(), 'staff_accounts'))));

  it('HOSTILE: a signed-in donor cannot read staff_accounts', async () =>
    assertFails(getDocs(collection(ctx('donorA'), 'staff_accounts'))));

  it('HOSTILE: a signed-in donor cannot FORGE a staff_accounts record', async () =>
    // The old rule was `allow write: if signedIn()`.
    assertFails(setDoc(doc(ctx('donorA'), 'staff_accounts/evil@x.com'), {
      uid: 'donorA', roles: ['hospital_admin'], hospitalId: 'H1', active: true,
    })));

  it('HOSTILE: even a system_admin has no client path to staff_accounts', async () =>
    assertFails(getDocs(collection(ctx('sysAdmin'), 'staff_accounts'))));

  it('HOSTILE: nobody can read the staff_index routing table', async () =>
    assertFails(getDoc(doc(ctx('sysAdmin'), 'staff_index/patricia@hospital.cm'))));

  it('HOSTILE: nobody can reset their own PIN lockout counter', async () =>
    assertFails(setDoc(doc(ctx('donorA'), 'staff_login_attempts/login_patricia@hospital.cm'), { attempts: 0 })));

  it('a hospital_admin may READ its own hospital\'s staff roster', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'hospitals/H1/staff/S1'), {
        uid: 'S1', name: 'Patricia', roles: ['reception'], hospitalId: 'H1', active: true,
      });
    });
    await assertSucceeds(getDoc(doc(ctx('hAdminH1'), 'hospitals/H1/staff/S1')));
  });

  it('HOSTILE: hospital_staff (non-admin) cannot read the staff roster', async () =>
    assertFails(getDoc(doc(ctx('staffH1'), 'hospitals/H1/staff/S1'))));

  it('HOSTILE: a hospital_admin cannot WRITE a staff record — creation is Cloud-Function-only', async () =>
    // Writing was the path that put a client-computed PIN hash in Firestore.
    assertFails(setDoc(doc(ctx('hAdminH1'), 'hospitals/H1/staff/S2'), {
      uid: 'S2', name: 'Forged', roles: ['hospital_admin'], hospitalId: 'H1', active: true, pinHash: 'x',
    })));

  it('HOSTILE: staff of another hospital cannot read this hospital\'s roster', async () =>
    assertFails(getDoc(doc(ctx('hAdminH2'), 'hospitals/H1/staff/S1'))));
});

describe('public_requests — B7 KYC gate mirrors requests/', () => {
  it('donor reads a Broadcasting public request', async () =>
    assertSucceeds(getDoc(doc(ctx('donorA'), 'public_requests/PR1'))));

  it('a grandfathered donor (no donors/ doc) can accept a Broadcasting public request', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorA'), 'public_requests/PR1'), {
      status: 'Donor Assigned', matchedDonor: 'donorA', matchedAt: 'now',
    })));

  it('B7 HOSTILE: a donor with a pending (unverified) KYC record cannot accept a Broadcasting public request', async () =>
    assertFails(updateDoc(doc(ctx('donorB'), 'public_requests/PR1'), {
      status: 'Donor Assigned', matchedDonor: 'donorB', matchedAt: 'now',
    })));

  it('B7: a donor with a verified KYC record can accept a Broadcasting public request', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorC'), 'public_requests/PR1'), {
      status: 'Donor Assigned', matchedDonor: 'donorC', matchedAt: 'now',
    })));
});

// donor UI/KYC_fix.md (Security Lead spec, 2026-08-07, superseding the Storage-ref version
// of this block that SPARK_PLAN_MIGRATION.md §6 had started 2026-08-05): donors/{uid}
// evidence is base64 text on the document itself, no Storage, no Cloud Function. These tests
// are the entire safety argument for self-approval and self-verification-via-create — they
// must stay exhaustive, not just "happy path."
describe('donors/{uid} — KYC records (base64-in-Firestore, KYC_fix.md)', () => {
  it('a donor reads their own KYC record', async () =>
    assertSucceeds(getDoc(doc(ctx('donorB'), 'donors/donorB'))));

  it('HOSTILE: a donor cannot read another donor\'s KYC record', async () =>
    assertFails(getDoc(doc(ctx('donorB'), 'donors/donorC'))));

  it('system_admin reads any donor\'s KYC record (review queue)', async () =>
    assertSucceeds(getDoc(doc(ctx('sysAdmin'), 'donors/donorB'))));

  it('HOSTILE: hospital_staff cannot read a donor\'s KYC record', async () =>
    assertFails(getDoc(doc(ctx('staffH1'), 'donors/donorB'))));

  it('system_admin lists all donors\' KYC records (review queue)', async () =>
    assertSucceeds(getDocs(query(collection(ctx('sysAdmin'), 'donors'), where('kycStatus', '==', 'pending')))));

  it('HOSTILE: a donor cannot list donors\' KYC records', async () =>
    assertFails(getDocs(collection(ctx('donorB'), 'donors'))));

  // ---- create: donor bootstraps their own record (in practice pre-empted by the
  // onDonorSignUp Cloud Function's Admin SDK write, which runs first and bypasses rules —
  // this is defense in depth for the direct-client path KYC_fix.md's spec allows) ----
  it('a donor creates their own donors/{uid} doc with the fixed not_submitted shape', async () =>
    assertSucceeds(setDoc(doc(ctx('donorA'), 'donors/donorA'), {
      kycStatus: 'not_submitted', kycDocType: null, kycIdImageBase64: null, kycIdBackImageBase64: null,
      kycSelfieImageBase64: null, kycSubmittedAt: null, kycRejectionReason: null,
      kycReviewedBy: null, kycReviewedAt: null,
    })));

  it('HOSTILE: a donor cannot create their own doc pre-verified (closes the gap KYC_fix.md\'s literal create clause left open)', async () =>
    assertFails(setDoc(doc(ctx('donorA'), 'donors/donorA'), {
      kycStatus: 'verified', kycDocType: null, kycIdImageBase64: null, kycIdBackImageBase64: null,
      kycSelfieImageBase64: null, kycSubmittedAt: null, kycRejectionReason: null,
      kycReviewedBy: null, kycReviewedAt: null,
    })));

  it('HOSTILE: a donor cannot create their own doc with evidence already attached', async () =>
    assertFails(setDoc(doc(ctx('donorA'), 'donors/donorA'), {
      kycStatus: 'not_submitted', kycDocType: 'national_id', kycIdImageBase64: 'BASE64_X', kycIdBackImageBase64: null,
      kycSelfieImageBase64: null, kycSubmittedAt: null, kycRejectionReason: null,
      kycReviewedBy: null, kycReviewedAt: null,
    })));

  it('HOSTILE: a donor cannot create a KYC record for someone else', async () =>
    assertFails(setDoc(doc(ctx('donorA'), 'donors/donorB2'), {
      kycStatus: 'not_submitted', kycDocType: null, kycIdImageBase64: null, kycIdBackImageBase64: null,
      kycSelfieImageBase64: null, kycSubmittedAt: null, kycRejectionReason: null,
      kycReviewedBy: null, kycReviewedAt: null,
    })));

  // ---- update (donor): submitting (not_submitted/rejected -> pending) — TEST 5 ----
  it('TEST 5a: a not_submitted donor CAN submit (donorE)', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorE'), 'donors/donorE'), {
      kycStatus: 'pending', kycDocType: 'national_id',
      kycIdImageBase64: 'BASE64_FRONT', kycIdBackImageBase64: 'BASE64_BACK', kycSubmittedAt: 'now',
    })));

  it('TEST 5b: a pending donor CANNOT submit again (donorB)', async () =>
    assertFails(updateDoc(doc(ctx('donorB'), 'donors/donorB'), {
      kycStatus: 'pending', kycIdImageBase64: 'BASE64_NEW',
    })));

  it('TEST 5c: a rejected donor CAN resubmit (donorF)', async () =>
    assertSucceeds(updateDoc(doc(ctx('donorF'), 'donors/donorF'), {
      kycStatus: 'pending', kycIdImageBase64: 'BASE64_NEW', kycSubmittedAt: 'now',
    })));

  it('TEST 5d: a verified donor CANNOT submit again (donorC)', async () =>
    assertFails(updateDoc(doc(ctx('donorC'), 'donors/donorC'), {
      kycStatus: 'pending', kycIdImageBase64: 'BASE64_NEW',
    })));

  // ---- TEST 1/2: the CORE self-approval guards ----
  it('TEST 1: HOSTILE — a donor cannot set their own kycStatus to verified', async () =>
    assertFails(updateDoc(doc(ctx('donorB'), 'donors/donorB'), { kycStatus: 'verified' })));

  it('HOSTILE: a donor cannot set kycStatus to verified even alongside a legitimate-looking resubmission', async () =>
    assertFails(updateDoc(doc(ctx('donorF'), 'donors/donorF'), {
      kycIdImageBase64: 'BASE64_NEW', kycStatus: 'verified',
    })));

  it('HOSTILE: a donor cannot tamper with kycReviewedBy/kycReviewedAt while submitting', async () =>
    assertFails(updateDoc(doc(ctx('donorE'), 'donors/donorE'), {
      kycStatus: 'pending', kycIdImageBase64: 'BASE64_FRONT', kycReviewedBy: 'donorE',
    })));

  it('TEST 2: HOSTILE — a donor cannot write to another donor\'s KYC record', async () =>
    assertFails(updateDoc(doc(ctx('donorA'), 'donors/donorB'), { kycIdImageBase64: 'BASE64_X' })));

  // ---- update (admin): approve/reject — TEST 4 ----
  it('TEST 4a: system_admin approves a pending donor', async () =>
    assertSucceeds(updateDoc(doc(ctx('sysAdmin'), 'donors/donorB'), {
      kycStatus: 'verified', kycReviewedBy: 'sysAdmin', kycReviewedAt: 'now',
      kycIdImageBase64: null, kycIdBackImageBase64: null, kycSelfieImageBase64: null,
    })));

  it('TEST 4b: system_admin rejects a pending donor with a reason', async () =>
    assertSucceeds(updateDoc(doc(ctx('sysAdmin'), 'donors/donorB'), {
      kycStatus: 'rejected', kycRejectionReason: 'Document was blurry.',
      kycReviewedBy: 'sysAdmin', kycReviewedAt: 'now',
      kycIdImageBase64: null, kycIdBackImageBase64: null, kycSelfieImageBase64: null,
    })));

  it('HOSTILE: hospital_admin cannot approve/reject a donor — system_admin only', async () =>
    assertFails(updateDoc(doc(ctx('hAdminH1'), 'donors/donorB'), { kycStatus: 'rejected' })));

  it('HOSTILE: hospital_staff cannot approve/reject a donor', async () =>
    assertFails(updateDoc(doc(ctx('staffH1'), 'donors/donorB'), { kycStatus: 'verified' })));
});

describe('adminQueue/{id} — KYC review worklist (Cloud Function only)', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'adminQueue/kyc_donorB'), { type: 'kyc_review', donorUid: 'donorB', status: 'pending' });
    });
  });

  it('system_admin reads the review queue', async () =>
    assertSucceeds(getDoc(doc(ctx('sysAdmin'), 'adminQueue/kyc_donorB'))));

  it('HOSTILE: a donor cannot read the admin review queue, even their own entry', async () =>
    assertFails(getDoc(doc(ctx('donorB'), 'adminQueue/kyc_donorB'))));

  it('HOSTILE: hospital_admin cannot read the admin review queue', async () =>
    assertFails(getDoc(doc(ctx('hAdminH1'), 'adminQueue/kyc_donorB'))));

  it('HOSTILE: no client, including system_admin, can write to the review queue directly', async () =>
    assertFails(updateDoc(doc(ctx('sysAdmin'), 'adminQueue/kyc_donorB'), { status: 'verified' })));
});

describe('inventory', () => {
  it('hospital_staff reads their own hospital\'s inventory', async () =>
    assertSucceeds(getDoc(doc(ctx('staffH1'), 'inventory/H1_O-'))));

  it('HOSTILE: staff of H2 cannot read H1\'s inventory', async () =>
    assertFails(getDoc(doc(ctx('staffH2'), 'inventory/H1_O-'))));

  it('HOSTILE: donor cannot read hospital inventory', async () =>
    assertFails(getDoc(doc(ctx('donorA'), 'inventory/H1_O-'))));

  it('lab_tech CAN still read their own hospital\'s inventory', async () =>
    assertSucceeds(getDoc(doc(ctx('labH1'), 'inventory/H1_O-'))));

  it('nbtp_viewer can read inventory (national aggregate view)', async () =>
    assertSucceeds(getDoc(doc(ctx('nbtp'), 'inventory/H1_O-'))));
});

describe('inventory writes are server-only (Phase 3): all mutations go through addInventoryStock/deductInventoryStock/resolveLabTest/setInventoryThreshold/issueBloodToPatient', () => {
  // RESOLVED 2026-08-01 by issueBloodToPatient's migration (functions/src/
  // inventory.ts) — it was the last direct-client write path into this
  // collection (it needed to fabricate `batches[].testStatus: 'Cleared'`
  // client-side to issue blood, since a document-level rule can't distinguish
  // a legit deduction from a hostile one at the field level). These tests now
  // pin the PERMANENT guarantee: no caller, including system_admin, has any
  // direct client write path to `inventory` — the Cloud Functions' Admin SDK
  // bypasses these rules by design, so this lockdown doesn't affect them.
  it('HOSTILE: hospital_staff cannot write their own hospital\'s inventory directly any more', async () =>
    assertFails(setDoc(doc(ctx('staffH1'), 'inventory/H1_O-'), {
      bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: 12,
    }, { merge: true })));

  it('HOSTILE: hospital_staff cannot partial-update the minimum threshold directly any more', async () =>
    assertFails(updateDoc(doc(ctx('staffH1'), 'inventory/H1_O-'), { minimumThreshold: 3 })));

  it('HOSTILE: lab_tech cannot edit stock directly (separation of duties, doubly enforced)', async () =>
    assertFails(setDoc(doc(ctx('labH1'), 'inventory/H1_O-'), {
      bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: 50,
    }, { merge: true })));

  it('HOSTILE: system_admin cannot write inventory directly any more either', async () =>
    assertFails(setDoc(doc(ctx('sysAdmin'), 'inventory/H2_A+'), {
      bloodType: 'A+', hospital: 'Hospital Two', hospitalId: 'H2', unitsAvailable: 3,
    }, { merge: true })));

  it('HOSTILE: no caller can create a brand-new inventory doc directly', async () =>
    assertFails(setDoc(doc(ctx('staffH1'), 'inventory/H1_O+'), {
      bloodType: 'O+', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: 5,
    })));

  it('HOSTILE: hospital_staff cannot write negative stock directly (or any value — writes are closed)', async () =>
    assertFails(setDoc(doc(ctx('staffH1'), 'inventory/H1_O-'), {
      bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1', unitsAvailable: -5,
    }, { merge: true })));
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

  // Scheduling gate (Security Lead report, 2026-08-08) — same isKycEligible() rule the
  // accept-a-request paths (requests/{id}, public_requests/{id}) already enforced. donorA
  // above has no donors/ doc at all and stays allowed, covering the grandfather clause.
  it('verified donor can schedule a donation', async () =>
    assertSucceeds(setDoc(doc(ctx('donorC'), 'donation_requests/D4'), {
      donorId: 'donorC', bloodType: 'O-', status: 'pending',
    })));

  it('HOSTILE: donor still awaiting KYC review cannot schedule a donation', async () =>
    assertFails(setDoc(doc(ctx('donorB'), 'donation_requests/D5'), {
      donorId: 'donorB', bloodType: 'O-', status: 'pending',
    })));

  it('HOSTILE: donor with a not_submitted KYC cannot schedule a donation', async () =>
    assertFails(setDoc(doc(ctx('donorE'), 'donation_requests/D6'), {
      donorId: 'donorE', bloodType: 'O-', status: 'pending',
    })));

  it('HOSTILE: rejected donor cannot schedule a donation', async () =>
    assertFails(setDoc(doc(ctx('donorF'), 'donation_requests/D7'), {
      donorId: 'donorF', bloodType: 'O-', status: 'pending',
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

describe('passwordResetTokens — Cloud Function only, no client path at all', () => {
  it('HOSTILE: even system_admin cannot read a reset-token doc', async () =>
    assertFails(getDoc(doc(ctx('sysAdmin'), 'passwordResetTokens/donorA'))));

  it('HOSTILE: a donor cannot read their own reset-token doc', async () =>
    assertFails(getDoc(doc(ctx('donorA'), 'passwordResetTokens/donorA'))));

  it('HOSTILE: nobody can write a reset-token doc client-side', async () =>
    assertFails(setDoc(doc(ctx('sysAdmin'), 'passwordResetTokens/donorA'), { tokenHash: 'x', used: false })));
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

  // RESOLVED 2026-08-01: issueBloodToPatient is now a Cloud Function
  // (functions/src/inventory.ts) and the ONLY writer of this collection, via
  // the Admin SDK (bypasses these rules). Pinning the PERMANENT guarantee:
  // no caller, including hospital_staff (who used to write here directly)
  // and system_admin, has a client write path any more.
  it('HOSTILE: hospital_staff cannot write issuance_log directly any more', async () =>
    assertFails(addDoc(collection(ctx('staffH1'), 'issuance_log'), {
      hospitalId: 'H1', hospital: 'Hospital One', bloodType: 'O-', units: 1, patientName: 'X',
    })));

  it('HOSTILE: system_admin cannot write issuance_log directly either', async () =>
    assertFails(addDoc(collection(ctx('sysAdmin'), 'issuance_log'), {
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

describe('suspension is server-only (Phase 3): client writes to users.suspended/isAvailable stay denied', () => {
  // RESOLVED 2026-08-01 by Phase 3's suspendUser/reactivateUser Cloud Functions
  // (functions/src/suspendUser.ts). db.js's suspendDonor()/reactivateDonor() no
  // longer write { isSuspended, isAvailable, statusChangedAt } directly — they
  // call the callable functions, which flip the `suspended` custom claim (the
  // thing signedIn() actually gates access on), revoke refresh tokens, mirror
  // the state onto the users doc via the Admin SDK, and write the authoritative
  // audit event. These tests now pin the PERMANENT guarantee, not a GAP: no
  // client write path to suspension fields exists for ANY caller, including
  // system_admin — even though a whitelist entry for these fields would look
  // harmless, the claim can only be flipped server-side, so letting clients
  // write the cosmetic mirror would only create a desync vector.
  it('HOSTILE: system_admin cannot write the suspension mirror fields directly', async () =>
    assertFails(updateDoc(doc(ctx('sysAdmin'), 'users/donorA'), {
      isSuspended: true, isAvailable: false, statusChangedAt: 'now',
    })));

  it('HOSTILE: system_admin cannot write reactivation fields directly either', async () =>
    assertFails(updateDoc(doc(ctx('sysAdmin'), 'users/donorA'), {
      isSuspended: false, isAvailable: true, statusChangedAt: 'now',
    })));
});
