import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { db } from './firebaseAdmin';
import { writeAudit } from './audit';
import { type CallerClaims } from './roles';
import {
  addInventoryStockSchema,
  deductInventoryStockSchema,
  resolveLabTestSchema,
  setInventoryThresholdSchema,
  issueBloodToPatientSchema,
} from './schemas';

/**
 * Inventory — Security Master Plan 1.5 "updateInventory" + Phase 3. The ONLY
 * path by which the `inventory` collection's stock counts and lab-test
 * lifecycle (`batches[].testStatus`) are mutated by the app, and — as of
 * issueBloodToPatient — the ONLY path by which `issuance_log` (Restricted-PHI)
 * is written. Replaces db.js's client-side updateInventoryStock/
 * deductInventoryStock/resolveLabTest/setInventoryThreshold/
 * issueBloodToPatient, which ran unauthenticated business logic (including
 * the "is this blood safe to issue" crossmatch gate) entirely in the browser.
 *
 * Roles that may add/remove/threshold stock: hospital_staff, hospital_admin,
 * system_admin — mirrors firestore.rules' canManageStock() (lab_tech is
 * separation-of-duties-excluded from managing stock directly, Master Plan
 * 1.2). Roles that may resolve a lab test: lab_tech, hospital_admin,
 * system_admin — the inverse split, since the point of resolveLabTest is
 * that whoever added the batch isn't the one clearing it. hospital_staff is
 * deliberately excluded from resolveLabTest so intake and clearance stay two
 * different people's jobs, not because it wasn't asked for.
 */

type BatchLike = {
  id: string;
  units: number;
  componentType?: string | null;
  testStatus?: string | null;
  [key: string]: unknown;
};

function invDocId(hospitalName: string, bloodType: string): string {
  return `${hospitalName.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${bloodType}`;
}

function computeAggregates(batches: BatchLike[]): {
  unitsAvailable: number;
  unitsPendingTest: number;
  unitsRejected: number;
  componentTotals: Record<string, number>;
} {
  let unitsAvailable = 0;
  let unitsPendingTest = 0;
  let unitsRejected = 0;
  const componentTotals: Record<string, number> = {};
  for (const b of batches) {
    const status = b.testStatus || 'Cleared';
    if (status === 'Cleared') {
      unitsAvailable += b.units;
      const component = b.componentType || 'Whole Blood';
      componentTotals[component] = (componentTotals[component] || 0) + b.units;
    } else if (status === 'Rejected, Not Safe') {
      unitsRejected += b.units;
    } else {
      unitsPendingTest += b.units;
    }
  }
  return { unitsAvailable, unitsPendingTest, unitsRejected, componentTotals };
}

const STOCK_MANAGER_ROLES = new Set(['hospital_staff', 'hospital_admin', 'system_admin']);
const LAB_RESOLVER_ROLES = new Set(['lab_tech', 'hospital_admin', 'system_admin']);

function requireCaller(request: CallableRequest, allowedRoles: Set<string>): CallerClaims {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call this function.');
  }
  const caller = (request.auth.token ?? {}) as CallerClaims;
  if (caller.suspended) {
    throw new HttpsError('permission-denied', 'Caller account is suspended.');
  }
  if (!caller.role || !allowedRoles.has(caller.role)) {
    throw new HttpsError('permission-denied', 'Caller role is not authorized for this operation.');
  }
  return caller;
}

/**
 * Resolves which (hospitalId, hospitalName) doc the operation targets.
 *
 * Hospital-scoped roles (hospital_staff/hospital_admin/lab_tech) are ALWAYS
 * resolved from their own claim, never from client input — closes any
 * identity-spoofing surface for the roles Master Plan 1.3 cares about most.
 *
 * system_admin is trusted with an explicit target, same as today's rules
 * (`allow create/update: if isSystemAdmin() || ...` with no hospitalId check
 * at all) — including hospitalName-only targets, which is required for
 * admin-proxy actions on shadow/unregistered hospitals (db.js's
 * ensureShadowHospital) that have no Firebase UID to look up.
 */
async function resolveTargetHospital(
  caller: CallerClaims,
  payload: { hospitalId?: string; hospitalName?: string },
): Promise<{ hospitalId: string | null; hospitalName: string }> {
  if (caller.role === 'system_admin') {
    if (payload.hospitalId) {
      const snap = await db.collection('users').doc(payload.hospitalId).get();
      if (!snap.exists) {
        throw new HttpsError('not-found', 'Target hospital account does not exist.');
      }
      const name = (snap.data()?.name as string | undefined) ?? payload.hospitalName;
      if (!name) {
        throw new HttpsError('failed-precondition', 'Target hospital account has no name on file.');
      }
      return { hospitalId: payload.hospitalId, hospitalName: name };
    }
    if (!payload.hospitalName) {
      throw new HttpsError('invalid-argument', 'hospitalId or hospitalName is required for system_admin calls.');
    }
    return { hospitalId: null, hospitalName: payload.hospitalName };
  }

  if (!caller.hospitalId) {
    throw new HttpsError('permission-denied', 'Caller has no hospitalId claim.');
  }
  const snap = await db.collection('users').doc(caller.hospitalId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Caller hospital account does not exist.');
  }
  const name = snap.data()?.name as string | undefined;
  if (!name) {
    throw new HttpsError('failed-precondition', 'Caller hospital account has no name on file.');
  }
  return { hospitalId: caller.hospitalId, hospitalName: name };
}

async function addInventoryStockHandler(request: CallableRequest) {
  const caller = requireCaller(request, STOCK_MANAGER_ROLES);
  const parsed = addInventoryStockSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid addInventoryStock payload.', parsed.error.flatten());
  }
  const input = parsed.data;
  const { hospitalId, hospitalName } = await resolveTargetHospital(caller, input);
  const docRef = db.collection('inventory').doc(invDocId(hospitalName, input.bloodType));

  const result = await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(docRef);
    const existing = snap.exists ? snap.data()! : {};
    const batches: BatchLike[] = existing.batches || [];

    batches.push({
      id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      units: input.units,
      componentType: input.componentType || 'Whole Blood',
      expiresAt: input.expiresAt || null,
      testStatus: input.testStatus || 'Waiting for Lab Test',
      rejectionReason: null,
      sourceDonationId: input.sourceDonationId || null,
      addedAt: new Date().toISOString(),
    });

    const aggregates = computeAggregates(batches);
    tx.set(
      docRef,
      {
        bloodType: input.bloodType,
        hospital: hospitalName,
        hospitalId,
        unitsAvailable: aggregates.unitsAvailable,
        unitsPendingTest: aggregates.unitsPendingTest,
        unitsRejected: aggregates.unitsRejected,
        unitsReserved: existing.unitsReserved || 0,
        batches,
        componentTotals: aggregates.componentTotals,
        minimumThreshold: existing.minimumThreshold ?? 5,
        lastUpdated: new Date().toISOString(),
      },
      { merge: true },
    );

    return aggregates.unitsAvailable;
  });

  await writeAudit({
    actorUid: request.auth!.uid,
    action: 'addInventoryStock',
    targetUid: hospitalId ?? undefined,
    details: {
      actorRole: caller.role ?? null,
      hospitalName,
      bloodType: input.bloodType,
      units: input.units,
      testStatus: input.testStatus || 'Waiting for Lab Test',
    },
  });

  return { bloodType: input.bloodType, unitsAvailable: result };
}

async function deductInventoryStockHandler(request: CallableRequest) {
  const caller = requireCaller(request, STOCK_MANAGER_ROLES);
  const parsed = deductInventoryStockSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid deductInventoryStock payload.', parsed.error.flatten());
  }
  const input = parsed.data;
  const { hospitalId, hospitalName } = await resolveTargetHospital(caller, input);
  const docRef = db.collection('inventory').doc(invDocId(hospitalName, input.bloodType));

  const result = await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new HttpsError('not-found', `No inventory found for ${input.bloodType} at ${hospitalName}.`);
    }
    const data = snap.data()!;
    const currentUnits: number = data.unitsAvailable || 0;
    if (currentUnits < input.units) {
      throw new HttpsError(
        'failed-precondition',
        `Insufficient stock: ${currentUnits} units available, ${input.units} requested.`,
      );
    }

    let toDeduct = input.units;
    const batches: BatchLike[] = (data.batches || []).filter((b: BatchLike) => {
      if (toDeduct <= 0) return true;
      if (b.units <= toDeduct) {
        toDeduct -= b.units;
        return false;
      }
      b.units -= toDeduct;
      toDeduct = 0;
      return true;
    });

    const aggregates = computeAggregates(batches);
    tx.update(docRef, {
      unitsAvailable: aggregates.unitsAvailable,
      unitsPendingTest: aggregates.unitsPendingTest,
      unitsRejected: aggregates.unitsRejected,
      batches,
      componentTotals: aggregates.componentTotals,
      lastUpdated: new Date().toISOString(),
    });

    return aggregates.unitsAvailable;
  });

  await writeAudit({
    actorUid: request.auth!.uid,
    action: 'deductInventoryStock',
    targetUid: hospitalId ?? undefined,
    details: {
      actorRole: caller.role ?? null,
      hospitalName,
      bloodType: input.bloodType,
      units: input.units,
      reason: input.reason ?? null,
    },
  });

  return { bloodType: input.bloodType, unitsAvailable: result, deducted: input.units };
}

async function resolveLabTestHandler(request: CallableRequest) {
  const caller = requireCaller(request, LAB_RESOLVER_ROLES);
  const parsed = resolveLabTestSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid resolveLabTest payload.', parsed.error.flatten());
  }
  const input = parsed.data;
  const { hospitalId, hospitalName } = await resolveTargetHospital(caller, input);
  const docRef = db.collection('inventory').doc(invDocId(hospitalName, input.bloodType));

  const resolvedBatch = await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Inventory record not found.');
    }
    const data = snap.data()!;
    const batches: BatchLike[] = data.batches || [];
    const target = batches.find((b) => b.id === input.batchId);
    if (!target) {
      throw new HttpsError('not-found', 'Batch not found.');
    }
    if ((target.testStatus || 'Cleared') !== 'Waiting for Lab Test') {
      throw new HttpsError('failed-precondition', 'This batch has already been resolved.');
    }

    target.testStatus = input.result;
    target.rejectionReason = input.result === 'Rejected, Not Safe' ? input.rejectionReason || 'Not specified' : null;
    target.resolvedAt = new Date().toISOString();
    if (input.labTechName) target.labTechName = input.labTechName;
    if (input.screeningResults) target.screeningResults = input.screeningResults;
    if (input.componentType) target.componentType = input.componentType;
    if (input.expiryDate) target.expiryDate = input.expiryDate;

    const aggregates = computeAggregates(batches);
    tx.set(
      docRef,
      {
        ...data,
        batches,
        hospitalId,
        unitsAvailable: aggregates.unitsAvailable,
        unitsPendingTest: aggregates.unitsPendingTest,
        unitsRejected: aggregates.unitsRejected,
        componentTotals: aggregates.componentTotals,
        lastUpdated: new Date().toISOString(),
      },
      { merge: true },
    );

    return { ...target };
  });

  await writeAudit({
    actorUid: request.auth!.uid,
    action: 'resolveLabTest',
    targetUid: hospitalId ?? undefined,
    details: {
      actorRole: caller.role ?? null,
      hospitalName,
      bloodType: input.bloodType,
      batchId: input.batchId,
      result: input.result,
    },
  });

  return { bloodType: input.bloodType, batch: resolvedBatch };
}

async function setInventoryThresholdHandler(request: CallableRequest) {
  const caller = requireCaller(request, STOCK_MANAGER_ROLES);
  const parsed = setInventoryThresholdSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid setInventoryThreshold payload.', parsed.error.flatten());
  }
  const input = parsed.data;
  const { hospitalId, hospitalName } = await resolveTargetHospital(caller, input);
  const docRef = db.collection('inventory').doc(invDocId(hospitalName, input.bloodType));

  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(docRef);
    if (snap.exists) {
      tx.update(docRef, { minimumThreshold: input.threshold });
    } else {
      tx.set(docRef, {
        bloodType: input.bloodType,
        hospital: hospitalName,
        hospitalId,
        unitsAvailable: 0,
        unitsReserved: 0,
        minimumThreshold: input.threshold,
        batches: [],
        componentTotals: {},
        lastUpdated: new Date().toISOString(),
      });
    }
  });

  await writeAudit({
    actorUid: request.auth!.uid,
    action: 'setInventoryThreshold',
    targetUid: hospitalId ?? undefined,
    details: {
      actorRole: caller.role ?? null,
      hospitalName,
      bloodType: input.bloodType,
      threshold: input.threshold,
    },
  });

  return { bloodType: input.bloodType, minimumThreshold: input.threshold };
}

/**
 * issueBloodToPatient — the last direct-client write path into `inventory`,
 * deferred from the original updateInventory pass (2026-08-01). Unlike
 * add/deduct/threshold, this deducts ONLY from batches whose testStatus is
 * already 'Cleared' — untested or rejected units must never leave the
 * building (Master Plan 1.3 ABAC rule 3). It's also the only inventory
 * operation that produces a Restricted-PHI record (`issuance_log`: patient
 * name, diagnosis, ward, attending doctor), so it's held to a stricter bar
 * than a stock adjustment.
 */
async function issueBloodToPatientHandler(request: CallableRequest) {
  const caller = requireCaller(request, STOCK_MANAGER_ROLES);
  const parsed = issueBloodToPatientSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid issueBloodToPatient payload.', parsed.error.flatten());
  }
  const input = parsed.data;
  const { hospitalId, hospitalName } = await resolveTargetHospital(caller, input);
  const docRef = db.collection('inventory').doc(invDocId(hospitalName, input.bloodType));

  const { aggregates, deductedBatches } = await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new HttpsError('not-found', `No inventory found for ${input.bloodType} at ${hospitalName}.`);
    }
    const data = snap.data()!;
    const batches: BatchLike[] = (data.batches || []).map((b: BatchLike) => ({ ...b }));

    const clearedAvailable = batches
      .filter((b) => (b.testStatus || 'Cleared') === 'Cleared')
      .reduce((sum, b) => sum + b.units, 0);
    if (input.units > clearedAvailable) {
      throw new HttpsError(
        'failed-precondition',
        `Only ${clearedAvailable} tested and cleared unit(s) of ${input.bloodType} are available to issue.`,
      );
    }

    let toDeduct = input.units;
    const deductedBatches: BatchLike[] = [];
    const remainingBatches = batches.filter((b) => {
      if (toDeduct <= 0) return true;
      if ((b.testStatus || 'Cleared') !== 'Cleared') return true;
      if (b.units <= toDeduct) {
        toDeduct -= b.units;
        deductedBatches.push(b);
        return false;
      }
      deductedBatches.push({ ...b, units: toDeduct });
      b.units -= toDeduct;
      toDeduct = 0;
      return true;
    });

    const newAggregates = computeAggregates(remainingBatches);
    tx.set(
      docRef,
      {
        ...data,
        batches: remainingBatches,
        hospitalId,
        unitsAvailable: newAggregates.unitsAvailable,
        unitsPendingTest: newAggregates.unitsPendingTest,
        unitsRejected: newAggregates.unitsRejected,
        componentTotals: newAggregates.componentTotals,
        lastUpdated: new Date().toISOString(),
      },
      { merge: true },
    );

    return { aggregates: newAggregates, deductedBatches };
  });

  const issuanceRef = await db.collection('issuance_log').add({
    bloodType: input.bloodType,
    units: input.units,
    patientName: input.patientName,
    patientId: input.patientId || '',
    patientBloodType: input.patientBloodType || input.bloodType,
    ward: input.ward || '',
    requestingDoctor: input.requestingDoctor || '',
    diagnosis: input.diagnosis || '',
    crossmatchConfirmed: true,
    crossmatchResult: 'Compatible',
    crossmatchTechnician: input.crossmatchTechnician || 'Staff Tech',
    hospital: hospitalName,
    hospitalId,
    issuedAt: new Date().toISOString(),
  });

  // Per Policy 5, audit events log actor/action/target/timestamp REFERENCES
  // only, never PHI values — the patient's name/diagnosis/ward live solely
  // in issuance_log, pointed to here by ID, not duplicated into the log.
  await writeAudit({
    actorUid: request.auth!.uid,
    action: 'issueBloodToPatient',
    targetUid: hospitalId ?? undefined,
    details: {
      actorRole: caller.role ?? null,
      hospitalName,
      bloodType: input.bloodType,
      units: input.units,
      issuanceLogId: issuanceRef.id,
    },
  });

  return {
    bloodType: input.bloodType,
    unitsAvailable: aggregates.unitsAvailable,
    issuanceLogId: issuanceRef.id,
    deductedBatches: deductedBatches.map((b) => ({
      id: b.id,
      units: b.units,
      sourceDonationId: (b.sourceDonationId as string | null | undefined) ?? null,
    })),
  };
}

export const addInventoryStock = onCall(addInventoryStockHandler);
export const deductInventoryStock = onCall(deductInventoryStockHandler);
export const resolveLabTest = onCall(resolveLabTestHandler);
export const setInventoryThreshold = onCall(setInventoryThresholdHandler);
export const issueBloodToPatient = onCall(issueBloodToPatientHandler);

// Exported for unit tests only.
export {
  addInventoryStockHandler,
  deductInventoryStockHandler,
  resolveLabTestHandler,
  setInventoryThresholdHandler,
  issueBloodToPatientHandler,
  computeAggregates,
  invDocId,
};
