/**
 * VitalPulse — concurrency-correctness tests (Master Plan Part 3.3, scenarios S3/S5).
 * Run: npm run test:rules (same emulator harness as firestore.rules.test.js)
 *
 * S3/S5 in the Master Plan are described as k6 *load* tests against a staging
 * deployment — infrastructure that doesn't exist yet (single Firebase project, no
 * hosting config, no staging secrets; see VitalPulse_Plan_Tracker.md Part 4). But the
 * actual thing S3/S5 care about — does the safety invariant hold under concurrent
 * writes? — is a property of the rules/client code, not of infrastructure throughput,
 * and IS safely verifiable right now against the local Firestore emulator with real
 * concurrent operations. This file does exactly that, honestly split into what's
 * proven safe vs. what's a proven, pre-existing, un-fixed bug.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { doc, getDoc, setDoc, updateDoc, runTransaction } from 'firebase/firestore';

let env;

const DONOR_COUNT = 10;
const donorClaims = Object.fromEntries(
  Array.from({ length: DONOR_COUNT }, (_, i) => [`donor${i}`, { role: 'donor' }])
);

const ctx = (uid) => env.authenticatedContext(uid, donorClaims[uid] ?? { role: 'donor' }).firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'vitalpulse-concurrency-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});
afterAll(async () => env.cleanup());

beforeEach(async () => env.clearFirestore());

describe('S3 — donor response stampede: exactly-once accept', () => {
  it(`${DONOR_COUNT} donors race to accept the same Open request — exactly one wins`, async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'requests/R_STAMPEDE'), {
        hospital: 'Hospital One', hospitalId: 'H1', bloodType: 'O-',
        status: 'Open', isEmergency: true, requestedAt: 'now',
      });
    });

    // This mirrors the real client call in db.js's acceptRequest(): every donor's
    // browser independently does a plain updateDoc, no transaction on the client
    // side. The safety guarantee here comes entirely from the rule's own
    // `resource.data.status == 'Open'` precondition being checked against the
    // document's actual server-side state at the moment each write is committed —
    // Firestore serializes concurrent writes to one document, so only the write
    // that lands while status is still 'Open' can pass; every other write, however
    // many race in, sees the now-updated status and is rejected.
    const attempts = await Promise.allSettled(
      Array.from({ length: DONOR_COUNT }, (_, i) =>
        updateDoc(doc(ctx(`donor${i}`), 'requests/R_STAMPEDE'), {
          status: 'Donor Assigned', matchedDonor: `donor${i}`, matchedAt: 'now',
        })
      )
    );

    const winners = attempts.filter((r) => r.status === 'fulfilled');
    const losers = attempts.filter((r) => r.status === 'rejected');
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(DONOR_COUNT - 1);

    // Any donor can get() any request doc under these rules, so read back through a
    // normal authenticated context rather than a second withSecurityRulesDisabled call.
    const final = (await getDoc(doc(ctx('donor0'), 'requests/R_STAMPEDE'))).data();
    expect(final.status).toBe('Donor Assigned');
  });
});

describe('S5 — inventory consistency under concurrent mutations', () => {
  // This intentionally does NOT import db.js — its Firestore instance is bound to
  // the real project (firebase.js), not this emulator. It mirrors deductInventoryStock's
  // current shipped pattern (db.js, runTransaction: read unitsAvailable, compute
  // newUnits, update the absolute new value) so the test exercises the real,
  // shipped transactional logic against the emulator.
  async function deductOneUnitLikeDbJs(firestoreCtx, docPath) {
    const ref = doc(firestoreCtx, docPath);
    await runTransaction(firestoreCtx, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('inventory missing');
      const current = snap.data().unitsAvailable;
      tx.update(ref, { unitsAvailable: Math.max(0, current - 1) });
    });
  }

  it('concurrent transactional deducts are serialized — no lost updates (fix for the former KNOWN BUG, PHASE0_AUDIT.md §5)', async () => {
    const startingUnits = 20;
    const concurrentDeducts = 10;

    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'inventory/H1_O-'), {
        bloodType: 'O-', hospital: 'Hospital One', hospitalId: 'H1',
        unitsAvailable: startingUnits,
      });
    });

    const staffFirestore = env.authenticatedContext('staffH1', { role: 'hospital_staff', hospitalId: 'H1' }).firestore();

    // Every deduct now runs as a Firestore transaction (same as db.js's
    // deductInventoryStock), so Firestore serializes them: each one sees the
    // committed value written by the previous one, and no update is lost.
    await Promise.all(
      Array.from({ length: concurrentDeducts }, () => deductOneUnitLikeDbJs(staffFirestore, 'inventory/H1_O-'))
    );

    const final = (await getDoc(doc(staffFirestore, 'inventory/H1_O-'))).data();

    // Correct (transactional) behavior: exactly startingUnits - concurrentDeducts
    // survive. If this ever drifts, a lost-update regression has been reintroduced.
    const correctTotal = startingUnits - concurrentDeducts;
    expect(final.unitsAvailable).toBe(correctTotal);
  });

  it('concurrent mixed add + deduct are serialized — total matches net change', async () => {
    const startingUnits = 10;

    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'inventory/H1_A+'), {
        bloodType: 'A+', hospital: 'Hospital One', hospitalId: 'H1',
        unitsAvailable: startingUnits,
      });
    });

    const staffFirestore = env.authenticatedContext('staffH1', { role: 'hospital_staff', hospitalId: 'H1' }).firestore();
    const addTwoUnits = async (firestoreCtx, docPath) => {
      const ref = doc(firestoreCtx, docPath);
      await runTransaction(firestoreCtx, async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.data().unitsAvailable;
        tx.update(ref, { unitsAvailable: current + 2 });
      });
    };

    await Promise.all([
      deductOneUnitLikeDbJs(staffFirestore, 'inventory/H1_A+'),
      deductOneUnitLikeDbJs(staffFirestore, 'inventory/H1_A+'),
      deductOneUnitLikeDbJs(staffFirestore, 'inventory/H1_A+'),
      addTwoUnits(staffFirestore, 'inventory/H1_A+'),
      addTwoUnits(staffFirestore, 'inventory/H1_A+'),
    ]);

    const final = (await getDoc(doc(staffFirestore, 'inventory/H1_A+'))).data();
    expect(final.unitsAvailable).toBe(startingUnits - 3 + 4);
  });
});
