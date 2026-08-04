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
  // UPDATED 2026-08-01 (Phase 3, issueBloodToPatient migration): this used to run
  // the deduct as a rules-constrained hospital_staff client transaction, mirroring
  // db.js's OLD direct-to-Firestore deductInventoryStock. That client function no
  // longer exists — deductInventoryStock (and every other inventory mutation,
  // including the last holdout, issueBloodToPatient) is now a Cloud Function, and
  // `inventory` writes are `allow write: if false` for every direct client caller,
  // including hospital_staff. The Cloud Functions' Admin SDK bypasses these rules
  // by design, so this test now runs the transaction through
  // withSecurityRulesDisabled to model that — it's still exercising genuine
  // Firestore transaction serialization (the actual property S5 cares about),
  // which behaves identically for the Admin SDK and the client SDK.
  async function deductOneUnitLikeInventoryFn(docPath) {
    await env.withSecurityRulesDisabled(async (c) => {
      const ref = doc(c.firestore(), docPath);
      await runTransaction(c.firestore(), async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('inventory missing');
        const current = snap.data().unitsAvailable;
        tx.update(ref, { unitsAvailable: Math.max(0, current - 1) });
      });
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

    // Every deduct runs as a Firestore transaction (same as
    // functions/src/inventory.ts's deductInventoryStockHandler), so Firestore
    // serializes them: each one sees the committed value written by the
    // previous one, and no update is lost.
    await Promise.all(
      Array.from({ length: concurrentDeducts }, () => deductOneUnitLikeInventoryFn('inventory/H1_O-'))
    );

    // Read back through a normal authenticated (rules-constrained) context, not a
    // second withSecurityRulesDisabled call — that doesn't reliably see the prior
    // write (see the historical note on this exact gotcha in firestore.rules.test.js).
    // hospital_staff still has a read path to their own hospital's inventory; only
    // writes were locked down.
    const staffFirestore = env.authenticatedContext('staffH1', { role: 'hospital_staff', hospitalId: 'H1' }).firestore();
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

    const addTwoUnits = async (docPath) => {
      await env.withSecurityRulesDisabled(async (c) => {
        const ref = doc(c.firestore(), docPath);
        await runTransaction(c.firestore(), async (tx) => {
          const snap = await tx.get(ref);
          const current = snap.data().unitsAvailable;
          tx.update(ref, { unitsAvailable: current + 2 });
        });
      });
    };

    await Promise.all([
      deductOneUnitLikeInventoryFn('inventory/H1_A+'),
      deductOneUnitLikeInventoryFn('inventory/H1_A+'),
      deductOneUnitLikeInventoryFn('inventory/H1_A+'),
      addTwoUnits('inventory/H1_A+'),
      addTwoUnits('inventory/H1_A+'),
    ]);

    const staffFirestore = env.authenticatedContext('staffH1', { role: 'hospital_staff', hospitalId: 'H1' }).firestore();
    const final = (await getDoc(doc(staffFirestore, 'inventory/H1_A+'))).data();
    expect(final.unitsAvailable).toBe(startingUnits - 3 + 4);
  });
});
