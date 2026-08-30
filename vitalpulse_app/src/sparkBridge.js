// ============================================
// SPARK BRIDGE — client-side inventory operations
// ============================================
// The project is on the FREE (Spark) Firebase plan, which cannot deploy Cloud
// Functions — every callable returns 404 in production (surfacing as a CORS
// failure / FirebaseError "internal"). This module re-implements the exact
// five inventory operations in the browser with the same payloads, return
// shapes, business rules and audit events as functions/src/index.ts — so the
// rest of the app is untouched and a later move to Blaze is a one-file swap.
//
// SECURITY MODEL (documented trade-off — see Plan Tracker):
// The Cloud version carried zod validation + claim/role checks via the Admin
// SDK. In the browser those checks run from the signed-in session; the hard
// enforcement layer is firestore.rules (hospital-scoped writes, suspension
// kill-switch, deny-by-default). What rules cannot express — e.g. "only a
// lab rate may clear a batch" — is now client-side only; residual risk is a
// malicious client marking its own batch 'Cleared'. Acceptable on the free
// plan; revisit if/when the project moves to Blaze.
// ============================================

import {
    collection,
    doc,
    addDoc,
    runTransaction,
} from "firebase/firestore";
import { db } from './firebase';
import { getCurrentUser } from './auth';

function invDocId(hospitalName, bloodType) {
    return `${hospitalName.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${bloodType}`;
}

// Mirrors functions/src/inventory.ts computeAggregates exactly, so the
// aggregate counters land identical to what the server would have written.
function computeAggregates(batches) {
    let unitsAvailable = 0;
    let unitsPendingTest = 0;
    let unitsRejected = 0;
    let unitsExpired = 0;
    const now = new Date();
    const componentTotals = {};
    for (const b of batches) {
        const status = b.testStatus || 'Cleared';
        const isExpired = b.expiresAt ? new Date(b.expiresAt) < now : false;

        if (isExpired) {
            unitsExpired += b.units;
        } else if (status === 'Cleared') {
            unitsAvailable += b.units;
            const component = b.componentType || 'Whole Blood';
            componentTotals[component] = (componentTotals[component] || 0) + b.units;
        } else if (status === 'Rejected, Not Safe') {
            unitsRejected += b.units;
        } else {
            unitsPendingTest += b.units;
        }
    }
    return { unitsAvailable, unitsPendingTest, unitsRejected, unitsExpired, componentTotals };
}

function callerScope() {
    const current = getCurrentUser();
    if (!current) {
        const err = new Error('You must be signed in to manage inventory.');
        err.code = 'unauthenticated';
        throw err;
    }
    const isHospitalAccount = !current.hospitalId && current.role === 'hospital';
    const hospitalId = current.hospitalId || (current.role === 'hospital' ? current.uid : null);
    const hospitalName = isHospitalAccount
        ? (current.name || null)
        : (current.hospitalName || null);
    return {
        uid: current.uid,
        roles: Array.isArray(current.roles) && current.roles.length > 0 ? current.roles : (current.role ? [current.role] : []),
        hospitalId,
        hospitalName,
    };
}

function hasAnyRole(caller, allowed) {
    return caller.roles.some((r) => allowed.includes(r));
}

const STOCK_ADDER_ROLES = ['hospital', 'hospital_admin', 'hospital_staff', 'lab_tech', 'admin', 'system_admin'];
const DONOR_INTAKE_ROLES = ['hospital', 'nurse', 'hospital_admin', 'hospital_staff', 'lab_tech', 'admin', 'system_admin'];
const STOCK_REMOVER_ROLES = ['hospital', 'hospital_admin', 'hospital_staff', 'admin', 'system_admin'];
const THRESHOLD_MANAGER_ROLES = STOCK_REMOVER_ROLES;
const LAB_RESOLVER_ROLES = ['hospital', 'lab_tech', 'hospital_admin', 'admin', 'system_admin'];
const ISSUANCE_ROLES = LAB_RESOLVER_ROLES;

function requirePermission(caller, allowedRoles, opName) {
    if (!hasAnyRole(caller, allowedRoles)) {
        const err = new Error(`Caller role is not authorized for ${opName}.`);
        err.code = 'permission-denied';
        throw err;
    }
}

function requireHospitalName(caller) {
    if (caller.hospitalName) return caller.hospitalName;
    const err = new Error('Hospital name is required for this operation.');
    err.code = 'failed-precondition';
    throw err;
}

async function auditWrite(actorUid, action, details) {
    try {
        await addDoc(collection(db, 'audit_logs'), {
            actorUid,
            action,
            details,
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        console.warn(`audit write failed (${action}):`, e);
    }
}

// ============================================
// addInventoryStock — a donated unit always enters the LAB QUARANTINE state
// ('Waiting for Lab Test') unless the caller explicitly logs already-cleared
// stock (testStatus: 'Cleared').
// ============================================
export async function sparkAddInventoryStock(payload) {
    const caller = callerScope();
    const isDonorIntake = !!payload.sourceDonationId && payload.testStatus !== 'Cleared';
    requirePermission(caller, isDonorIntake ? DONOR_INTAKE_ROLES : STOCK_ADDER_ROLES, 'addInventoryStock');
    if (!payload.bloodType || !(payload.units > 0)) {
        const err = new Error('Invalid addInventoryStock payload.');
        err.code = 'invalid-argument';
        throw err;
    }
    const hospitalName = payload.hospitalName || requireHospitalName(caller);
    const docId = invDocId(hospitalName, payload.bloodType);
    const docRef = doc(db, 'inventory', docId);

    const unitsAvailable = await runTransaction(db, async (tx) => {
        const snap = await tx.get(docRef);
        const existing = snap.exists() ? snap.data() : {};
        const batches = existing.batches || [];

        const defaultExpiry = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString();
        batches.push({
            id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            units: payload.units,
            componentType: payload.componentType || 'Whole Blood',
            expiresAt: payload.expiresAt || defaultExpiry,
            testStatus: payload.testStatus || 'Waiting for Lab Test',
            rejectionReason: null,
            sourceDonationId: payload.sourceDonationId || null,
            addedAt: new Date().toISOString(),
        });

        const aggregates = computeAggregates(batches);
        tx.set(docRef, {
            bloodType: payload.bloodType,
            hospital: hospitalName,
            hospitalId: caller.hospitalId,
            unitsAvailable: aggregates.unitsAvailable,
            unitsPendingTest: aggregates.unitsPendingTest,
            unitsRejected: aggregates.unitsRejected,
            unitsExpired: aggregates.unitsExpired,
            unitsReserved: existing.unitsReserved || 0,
            batches,
            componentTotals: aggregates.componentTotals,
            minimumThreshold: existing.minimumThreshold ?? 5,
            lastUpdated: new Date().toISOString(),
        }, { merge: true });

        return aggregates.unitsAvailable;
    });

    await auditWrite(caller.uid, 'addInventoryStock', {
        hospitalName,
        bloodType: payload.bloodType,
        units: payload.units,
        testStatus: payload.testStatus || 'Waiting for Lab Test',
    });

    return { bloodType: payload.bloodType, unitsAvailable };
}

// ============================================
// deductInventoryStock — FEFO over cleared-only batches.
// ============================================
export async function sparkDeductInventoryStock(payload) {
    const caller = callerScope();
    requirePermission(caller, STOCK_REMOVER_ROLES, 'deductInventoryStock');
    if (!payload.bloodType || !(payload.units > 0)) {
        const err = new Error('Invalid deductInventoryStock payload.');
        err.code = 'invalid-argument';
        throw err;
    }
    const hospitalName = payload.hospitalName || requireHospitalName(caller);
    const docRef = doc(db, 'inventory', invDocId(hospitalName, payload.bloodType));

    const unitsAvailable = await runTransaction(db, async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists()) {
            const err = new Error(`No inventory found for ${payload.bloodType} at ${hospitalName}.`);
            err.code = 'not-found';
            throw err;
        }
        const data = snap.data();
        const currentUnits = data.unitsAvailable || 0;
        if (currentUnits < payload.units) {
            const err = new Error(`Insufficient stock: ${currentUnits} units available, ${payload.units} requested.`);
            err.code = 'failed-precondition';
            throw err;
        }

        let toDeduct = payload.units;
        const allBatches = (data.batches || []).sort((a, b) => {
            const expA = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
            const expB = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
            return expA - expB;
        });

        const batches = allBatches.filter((b) => {
            if (toDeduct <= 0) return true;
            if ((b.testStatus || 'Cleared') !== 'Cleared') return true;
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

    await auditWrite(caller.uid, 'deductInventoryStock', {
        hospitalName,
        bloodType: payload.bloodType,
        units: payload.units,
        reason: payload.reason ?? null,
    });

    return { bloodType: payload.bloodType, unitsAvailable, deducted: payload.units };
}

// ============================================
// resolveLabTest — the ONLY path a batch leaves 'Waiting for Lab Test':
// 'Cleared' (available stock) or 'Rejected, Not Safe' (permanently excluded).
// ============================================
export async function sparkResolveLabTest(payload) {
    const caller = callerScope();
    requirePermission(caller, LAB_RESOLVER_ROLES, 'resolveLabTest');
    if (!payload.bloodType || !payload.batchId || !['Cleared', 'Rejected, Not Safe'].includes(payload.result)) {
        const err = new Error('Invalid resolveLabTest payload.');
        err.code = 'invalid-argument';
        throw err;
    }
    const hospitalName = payload.hospitalName || requireHospitalName(caller);
    const docRef = doc(db, 'inventory', invDocId(hospitalName, payload.bloodType));

    const resolvedBatch = await runTransaction(db, async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists()) {
            const err = new Error('Inventory record not found.');
            err.code = 'not-found';
            throw err;
        }
        const data = snap.data();
        const batches = data.batches || [];
        const target = batches.find((b) => b.id === payload.batchId);
        if (!target) {
            const err = new Error('Batch not found.');
            err.code = 'not-found';
            throw err;
        }
        if ((target.testStatus || 'Cleared') !== 'Waiting for Lab Test') {
            const err = new Error('This batch has already been resolved.');
            err.code = 'failed-precondition';
            throw err;
        }

        target.testStatus = payload.result;
        target.rejectionReason = payload.result === 'Rejected, Not Safe' ? (payload.rejectionReason || 'Not specified') : null;
        target.resolvedAt = new Date().toISOString();
        if (payload.labTechName) target.labTechName = payload.labTechName;
        if (payload.screeningResults) target.screeningResults = payload.screeningResults;
        if (payload.componentType) target.componentType = payload.componentType;
        if (payload.expiryDate) target.expiryDate = payload.expiryDate;

        const aggregates = computeAggregates(batches);
        tx.set(docRef, {
            ...data,
            batches,
            hospitalId: caller.hospitalId,
            unitsAvailable: aggregates.unitsAvailable,
            unitsPendingTest: aggregates.unitsPendingTest,
            unitsRejected: aggregates.unitsRejected,
            componentTotals: aggregates.componentTotals,
            lastUpdated: new Date().toISOString(),
        }, { merge: true });

        return { ...target };
    });

    await auditWrite(caller.uid, 'resolveLabTest', {
        hospitalName,
        bloodType: payload.bloodType,
        batchId: payload.batchId,
        result: payload.result,
    });

    return { bloodType: payload.bloodType, batch: resolvedBatch };
}

// ============================================
// setInventoryThreshold
// ============================================
export async function sparkSetInventoryThreshold(payload) {
    const caller = callerScope();
    requirePermission(caller, THRESHOLD_MANAGER_ROLES, 'setInventoryThreshold');
    if (!payload.bloodType || typeof payload.threshold !== 'number') {
        const err = new Error('Invalid setInventoryThreshold payload.');
        err.code = 'invalid-argument';
        throw err;
    }
    const hospitalName = payload.hospitalName || requireHospitalName(caller);
    const docRef = doc(db, 'inventory', invDocId(hospitalName, payload.bloodType));

    await runTransaction(db, async (tx) => {
        const snap = await tx.get(docRef);
        if (snap.exists()) {
            tx.update(docRef, { minimumThreshold: payload.threshold });
        } else {
            tx.set(docRef, {
                bloodType: payload.bloodType,
                hospital: hospitalName,
                hospitalId: caller.hospitalId,
                unitsAvailable: 0,
                unitsReserved: 0,
                minimumThreshold: payload.threshold,
                batches: [],
                componentTotals: {},
                lastUpdated: new Date().toISOString(),
            });
        }
    });

    await auditWrite(caller.uid, 'setInventoryThreshold', {
        hospitalName,
        bloodType: payload.bloodType,
        threshold: payload.threshold,
    });

    return { bloodType: payload.bloodType, minimumThreshold: payload.threshold };
}

// ============================================
// issueBloodToPatient — deducts ONLY cleared, unexpired batches and writes
// the Restricted-PHI issuance_log entry.
// ============================================
export async function sparkIssueBloodToPatient(payload) {
    const caller = callerScope();
    requirePermission(caller, ISSUANCE_ROLES, 'issueBloodToPatient');
    if (!payload.bloodType || !(payload.units > 0)) {
        const err = new Error('Invalid issueBloodToPatient payload.');
        err.code = 'invalid-argument';
        throw err;
    }
    const hospitalName = payload.hospitalName || requireHospitalName(caller);
    const docRef = doc(db, 'inventory', invDocId(hospitalName, payload.bloodType));

    const { aggregates, deductedBatches } = await runTransaction(db, async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists()) {
            const err = new Error(`No inventory found for ${payload.bloodType} at ${hospitalName}.`);
            err.code = 'not-found';
            throw err;
        }
        const data = snap.data();
        const batches = (data.batches || []).map((b) => ({ ...b }));

        const now = new Date();
        const clearedAvailable = batches
            .filter((b) => (b.testStatus || 'Cleared') === 'Cleared' && (!b.expiresAt || new Date(b.expiresAt) >= now))
            .reduce((sum, b) => sum + b.units, 0);
        if (payload.units > clearedAvailable) {
            const err = new Error(`Only ${clearedAvailable} tested and cleared unit(s) of ${payload.bloodType} are available to issue.`);
            err.code = 'failed-precondition';
            throw err;
        }

        let toDeduct = payload.units;
        const deducted = [];
        const remainingBatches = batches.filter((b) => {
            if (toDeduct <= 0) return true;
            if ((b.testStatus || 'Cleared') !== 'Cleared') return true;
            if (b.expiresAt && new Date(b.expiresAt) < now) return true;
            if (b.units <= toDeduct) {
                toDeduct -= b.units;
                deducted.push(b);
                return false;
            }
            deducted.push({ ...b, units: toDeduct });
            b.units -= toDeduct;
            toDeduct = 0;
            return true;
        });

        const newAggregates = computeAggregates(remainingBatches);
        tx.set(docRef, {
            ...data,
            batches: remainingBatches,
            hospitalId: caller.hospitalId,
            unitsAvailable: newAggregates.unitsAvailable,
            unitsPendingTest: newAggregates.unitsPendingTest,
            unitsRejected: newAggregates.unitsRejected,
            unitsExpired: newAggregates.unitsExpired,
            componentTotals: newAggregates.componentTotals,
            lastUpdated: new Date().toISOString(),
        }, { merge: true });

        return { aggregates: newAggregates, deductedBatches: deducted };
    });

    const issuanceRef = await addDoc(collection(db, 'issuance_log'), {
        bloodType: payload.bloodType,
        units: payload.units,
        patientName: payload.patientName,
        patientId: payload.patientId || '',
        patientBloodType: payload.patientBloodType || payload.bloodType,
        ward: payload.ward || '',
        requestingDoctor: payload.requestingDoctor || payload.requestingPhysicianName,
        requestingPhysicianName: payload.requestingPhysicianName,
        diagnosis: payload.diagnosis || '',
        crossmatchConfirmed: true,
        crossmatchResult: 'Compatible',
        crossmatchTechnician: payload.crossmatchTechnician || 'Staff Tech',
        hospital: hospitalName,
        hospitalId: caller.hospitalId,
        issuedAt: new Date().toISOString(),
        performedByUid: caller.uid,
        performedByRole: caller.roles.join(','),
    });

    await auditWrite(caller.uid, 'issueBloodToPatient', {
        hospitalName,
        bloodType: payload.bloodType,
        units: payload.units,
        issuanceLogId: issuanceRef?.id ?? null,
        requestingPhysicianName: payload.requestingPhysicianName,
    });

    return {
        bloodType: payload.bloodType,
        unitsAvailable: aggregates.unitsAvailable,
        issuanceLogId: issuanceRef?.id,
        deductedBatches: deductedBatches.map((b) => ({
            id: b.id,
            units: b.units,
            sourceDonationId: b.sourceDonationId ?? null,
        })),
    };
}