import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => {
  const usersDocGet = vi.fn();
  const usersDoc = vi.fn(() => ({ get: usersDocGet }));
  const inventoryDoc = vi.fn((id: string) => ({ __docId: id }));
  const txGet = vi.fn();
  const txSet = vi.fn();
  const txUpdate = vi.fn();
  const runTransaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb({ get: txGet, set: txSet, update: txUpdate }));
  const issuanceAdd = vi.fn(async () => ({ id: 'ISSUE1' }));
  const collection = vi.fn((name: string) => {
    if (name === 'users') return { doc: usersDoc };
    if (name === 'inventory') return { doc: inventoryDoc };
    if (name === 'issuance_log') return { add: issuanceAdd };
    throw new Error(`unexpected collection: ${name}`);
  });
  return { usersDocGet, usersDoc, inventoryDoc, txGet, txSet, txUpdate, runTransaction, issuanceAdd, collection };
});

vi.mock('./firebaseAdmin', () => ({
  db: { collection: mocks.collection, runTransaction: mocks.runTransaction },
}));
vi.mock('./audit', () => ({ writeAudit: vi.fn() }));

import {
  addInventoryStockHandler,
  deductInventoryStockHandler,
  resolveLabTestHandler,
  setInventoryThresholdHandler,
  issueBloodToPatientHandler,
} from './inventory';
import { writeAudit } from './audit';

function req(auth: { uid: string; token: Record<string, unknown> } | undefined, data: unknown): CallableRequest {
  return { auth, data } as unknown as CallableRequest;
}

function hospitalSnap(name: string | undefined) {
  return { exists: true, data: () => (name === undefined ? {} : { name }) };
}

function missingSnap() {
  return { exists: false, data: () => undefined };
}

function invSnap(data: Record<string, unknown> | undefined) {
  return data === undefined ? { exists: false, data: () => undefined } : { exists: true, data: () => data };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usersDocGet.mockResolvedValue(hospitalSnap('General Hospital'));
});

describe('addInventoryStockHandler', () => {
  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(
      addInventoryStockHandler(req(undefined, { bloodType: 'O+', units: 1 })),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('HOSTILE: rejects an invalid blood type', async () => {
    await expect(
      addInventoryStockHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'Z+', units: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects zero/negative units', async () => {
    await expect(
      addInventoryStockHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'O+', units: 0 }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects an unrecognized extra field (strict schema)', async () => {
    await expect(
      addInventoryStockHandler(
        req(
          { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
          { bloodType: 'O+', units: 1, unitsAvailable: 999999 },
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: a suspended hospital_staff caller is denied, hospital never resolved', async () => {
    await expect(
      addInventoryStockHandler(
        req(
          { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1', suspended: true } },
          { bloodType: 'O+', units: 1 },
        ),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.usersDocGet).not.toHaveBeenCalled();
  });

  it('HOSTILE: a donor cannot add stock', async () => {
    await expect(
      addInventoryStockHandler(req({ uid: 'd1', token: { role: 'donor' } }, { bloodType: 'O+', units: 1 })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: lab_tech cannot add stock (separation of duties, Master Plan 1.2)', async () => {
    await expect(
      addInventoryStockHandler(
        req({ uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } }, { bloodType: 'O+', units: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: hospital_staff with no hospitalId claim is denied', async () => {
    await expect(
      addInventoryStockHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff' } }, { bloodType: 'O+', units: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: a client-supplied hospitalId is ignored for hospital-scoped roles (own claim wins)', async () => {
    mocks.txGet.mockResolvedValue(invSnap(undefined));
    await addInventoryStockHandler(
      req(
        { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
        { bloodType: 'O+', units: 1, hospitalId: 'SOMEONE-ELSES-HOSPITAL' },
      ),
    );
    expect(mocks.usersDoc).toHaveBeenCalledWith('H1');
    expect(mocks.usersDoc).not.toHaveBeenCalledWith('SOMEONE-ELSES-HOSPITAL');
  });

  it('HOSTILE: system_admin with neither hospitalId nor hospitalName is rejected', async () => {
    await expect(
      addInventoryStockHandler(req({ uid: 'a1', token: { role: 'system_admin' } }, { bloodType: 'O+', units: 1 })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: system_admin targeting a nonexistent hospital account is rejected', async () => {
    mocks.usersDocGet.mockResolvedValue(missingSnap());
    await expect(
      addInventoryStockHandler(
        req({ uid: 'a1', token: { role: 'system_admin' } }, { bloodType: 'O+', units: 1, hospitalId: 'ghost' }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('hospital_staff adds stock to their own hospital: batch appended, aggregates recomputed, audited', async () => {
    mocks.txGet.mockResolvedValue(invSnap({ batches: [{ id: 'b0', units: 3, testStatus: 'Cleared', componentType: 'Whole Blood' }] }));
    const result = await addInventoryStockHandler(
      req(
        { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
        { bloodType: 'O+', units: 5, componentType: 'Plasma' },
      ),
    );

    expect(result).toEqual({ bloodType: 'O+', unitsAvailable: 3 }); // new batch defaults to 'Waiting for Lab Test' — not yet available
    expect(mocks.inventoryDoc).toHaveBeenCalledWith('General_Hospital_O+');
    expect(mocks.txSet).toHaveBeenCalledWith(
      { __docId: 'General_Hospital_O+' },
      expect.objectContaining({
        hospitalId: 'H1',
        hospital: 'General Hospital',
        unitsAvailable: 3,
        unitsPendingTest: 5,
        batches: expect.arrayContaining([
          expect.objectContaining({ units: 5, componentType: 'Plasma', testStatus: 'Waiting for Lab Test' }),
        ]),
      }),
      { merge: true },
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUid: 'h1', action: 'addInventoryStock', targetUid: 'H1' }),
    );
  });

  it('HOSTILE: system_admin hospitalId lookup with no name on file and no fallback name is rejected', async () => {
    mocks.usersDocGet.mockResolvedValue(hospitalSnap(undefined));
    await expect(
      addInventoryStockHandler(
        req({ uid: 'a1', token: { role: 'system_admin' } }, { bloodType: 'O+', units: 1, hospitalId: 'H2' }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('system_admin falls back to the payload hospitalName when the account has none on file', async () => {
    mocks.usersDocGet.mockResolvedValue(hospitalSnap(undefined));
    mocks.txGet.mockResolvedValue(invSnap(undefined));
    const result = await addInventoryStockHandler(
      req(
        { uid: 'a1', token: { role: 'system_admin' } },
        { bloodType: 'O+', units: 1, hospitalId: 'H2', hospitalName: 'Fallback Name Hospital' },
      ),
    );
    expect(result).toEqual({ bloodType: 'O+', unitsAvailable: 0 });
    expect(mocks.inventoryDoc).toHaveBeenCalledWith('Fallback_Name_Hospital_O+');
  });

  it('HOSTILE: rejects when the hospital-scoped caller\'s own hospital account does not exist', async () => {
    mocks.usersDocGet.mockResolvedValue(missingSnap());
    await expect(
      addInventoryStockHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'O+', units: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HOSTILE: rejects when the hospital-scoped caller\'s own hospital account has no name on file', async () => {
    mocks.usersDocGet.mockResolvedValue(hospitalSnap(undefined));
    await expect(
      addInventoryStockHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'O+', units: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('system_admin proxies for a shadow (unregistered) hospital by name only — no hospitalId stamped', async () => {
    mocks.txGet.mockResolvedValue(invSnap(undefined));
    const result = await addInventoryStockHandler(
      req(
        { uid: 'a1', token: { role: 'system_admin' } },
        { bloodType: 'AB-', units: 2, hospitalName: 'Unregistered Clinic', testStatus: 'Cleared' },
      ),
    );
    expect(result).toEqual({ bloodType: 'AB-', unitsAvailable: 2 });
    expect(mocks.usersDoc).not.toHaveBeenCalled();
    expect(mocks.inventoryDoc).toHaveBeenCalledWith('Unregistered_Clinic_AB-');
    expect(mocks.txSet).toHaveBeenCalledWith(
      { __docId: 'Unregistered_Clinic_AB-' },
      expect.objectContaining({ hospitalId: null }),
      { merge: true },
    );
  });
});

describe('deductInventoryStockHandler', () => {
  it('HOSTILE: rejects an invalid payload (missing bloodType)', async () => {
    await expect(
      deductInventoryStockHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { units: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: lab_tech cannot deduct stock', async () => {
    await expect(
      deductInventoryStockHandler(
        req({ uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } }, { bloodType: 'O+', units: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects deducting more than is available', async () => {
    mocks.txGet.mockResolvedValue(invSnap({ unitsAvailable: 2, batches: [] }));
    await expect(
      deductInventoryStockHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'O+', units: 5 }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects deducting from a hospital with no inventory doc yet', async () => {
    mocks.txGet.mockResolvedValue(invSnap(undefined));
    await expect(
      deductInventoryStockHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'O+', units: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('deducts oldest batches first and recomputes aggregates', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({
        unitsAvailable: 8,
        batches: [
          { id: 'b1', units: 3, testStatus: 'Cleared', componentType: 'Whole Blood' },
          { id: 'b2', units: 5, testStatus: 'Cleared', componentType: 'Whole Blood' },
        ],
      }),
    );
    const result = await deductInventoryStockHandler(
      req({ uid: 'h1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { bloodType: 'O+', units: 4, reason: 'spoilage' }),
    );

    expect(result).toEqual({ bloodType: 'O+', unitsAvailable: 4, deducted: 4 });
    expect(mocks.txUpdate).toHaveBeenCalledWith(
      { __docId: 'General_Hospital_O+' },
      expect.objectContaining({
        unitsAvailable: 4,
        batches: [{ id: 'b2', units: 4, testStatus: 'Cleared', componentType: 'Whole Blood' }],
      }),
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'deductInventoryStock', details: expect.objectContaining({ reason: 'spoilage' }) }),
    );
  });

  it('leaves untouched batches beyond what was needed to satisfy the deduction alone', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({
        unitsAvailable: 9,
        batches: [
          { id: 'b1', units: 2, testStatus: 'Cleared', componentType: 'Whole Blood' },
          { id: 'b2', units: 3, testStatus: 'Cleared', componentType: 'Whole Blood' },
          { id: 'b3', units: 4, testStatus: 'Cleared', componentType: 'Whole Blood' },
        ],
      }),
    );
    await deductInventoryStockHandler(
      req({ uid: 'h1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { bloodType: 'O+', units: 2 }),
    );
    expect(mocks.txUpdate).toHaveBeenCalledWith(
      { __docId: 'General_Hospital_O+' },
      expect.objectContaining({
        batches: [
          { id: 'b2', units: 3, testStatus: 'Cleared', componentType: 'Whole Blood' },
          { id: 'b3', units: 4, testStatus: 'Cleared', componentType: 'Whole Blood' },
        ],
      }),
    );
  });
});

describe('resolveLabTestHandler', () => {
  it('HOSTILE: rejects an invalid payload (bad result enum)', async () => {
    await expect(
      resolveLabTestHandler(
        req(
          { uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } },
          { bloodType: 'O+', batchId: 'b1', result: 'Probably Fine' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects when the inventory doc does not exist at all', async () => {
    mocks.txGet.mockResolvedValue(invSnap(undefined));
    await expect(
      resolveLabTestHandler(
        req(
          { uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } },
          { bloodType: 'O+', batchId: 'b1', result: 'Cleared' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HOSTILE: hospital_staff cannot resolve a lab test (separation of duties: intake vs. clearance)', async () => {
    await expect(
      resolveLabTestHandler(
        req(
          { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
          { bloodType: 'O+', batchId: 'b1', result: 'Cleared' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('lab_tech CAN resolve a lab test for their own hospital — this is their actual job', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({ batches: [{ id: 'b1', units: 4, testStatus: 'Waiting for Lab Test', componentType: 'Whole Blood' }] }),
    );
    const result = await resolveLabTestHandler(
      req(
        { uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } },
        { bloodType: 'O+', batchId: 'b1', result: 'Cleared', labTechName: 'T. Nkeng' },
      ),
    );
    expect(result.batch).toMatchObject({ id: 'b1', testStatus: 'Cleared', labTechName: 'T. Nkeng', rejectionReason: null });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'resolveLabTest', details: expect.objectContaining({ result: 'Cleared' }) }),
    );
  });

  it('treats a batch with no testStatus at all as already-Cleared (defaults closed, not open)', async () => {
    mocks.txGet.mockResolvedValue(invSnap({ batches: [{ id: 'b1', units: 4, componentType: 'Whole Blood' }] }));
    await expect(
      resolveLabTestHandler(
        req(
          { uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } },
          { bloodType: 'O+', batchId: 'b1', result: 'Cleared' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a batch that has already been resolved (no double-resolution)', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({ batches: [{ id: 'b1', units: 4, testStatus: 'Cleared', componentType: 'Whole Blood' }] }),
    );
    await expect(
      resolveLabTestHandler(
        req(
          { uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } },
          { bloodType: 'O+', batchId: 'b1', result: 'Rejected, Not Safe' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects an unknown batchId', async () => {
    mocks.txGet.mockResolvedValue(invSnap({ batches: [] }));
    await expect(
      resolveLabTestHandler(
        req(
          { uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } },
          { bloodType: 'O+', batchId: 'missing', result: 'Cleared' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('records screeningResults/componentType/expiryDate when the caller supplies them', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({ batches: [{ id: 'b1', units: 4, testStatus: 'Waiting for Lab Test', componentType: 'Whole Blood' }] }),
    );
    const result = await resolveLabTestHandler(
      req(
        { uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } },
        {
          bloodType: 'O+',
          batchId: 'b1',
          result: 'Cleared',
          screeningResults: { HIV: 'Non-reactive' },
          componentType: 'Packed Red Cells',
          expiryDate: '2026-09-01',
        },
      ),
    );
    expect(result.batch).toMatchObject({
      screeningResults: { HIV: 'Non-reactive' },
      componentType: 'Packed Red Cells',
      expiryDate: '2026-09-01',
    });
  });

  it('marks a rejected batch with a rejectionReason and excludes it from unitsAvailable', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({ batches: [{ id: 'b1', units: 4, testStatus: 'Waiting for Lab Test', componentType: 'Whole Blood' }] }),
    );
    const result = await resolveLabTestHandler(
      req(
        { uid: 'ha1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
        { bloodType: 'O+', batchId: 'b1', result: 'Rejected, Not Safe', rejectionReason: 'Reactive HIV screen' },
      ),
    );
    expect(result.batch).toMatchObject({ testStatus: 'Rejected, Not Safe', rejectionReason: 'Reactive HIV screen' });
    expect(mocks.txSet).toHaveBeenCalledWith(
      { __docId: 'General_Hospital_O+' },
      expect.objectContaining({ unitsAvailable: 0, unitsRejected: 4 }),
      { merge: true },
    );
  });

  it('system_admin resolves a lab test for a shadow (unregistered) hospital by name only', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({ batches: [{ id: 'b1', units: 4, testStatus: 'Waiting for Lab Test', componentType: 'Whole Blood' }] }),
    );
    const result = await resolveLabTestHandler(
      req(
        { uid: 'a1', token: { role: 'system_admin' } },
        { bloodType: 'O+', batchId: 'b1', result: 'Cleared', hospitalName: 'Unregistered Clinic' },
      ),
    );
    expect(result.batch).toMatchObject({ id: 'b1', testStatus: 'Cleared' });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'resolveLabTest', targetUid: undefined }),
    );
  });
});

describe('setInventoryThresholdHandler', () => {
  it('HOSTILE: rejects a negative threshold', async () => {
    await expect(
      setInventoryThresholdHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'O+', threshold: -1 }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: lab_tech cannot set a threshold', async () => {
    await expect(
      setInventoryThresholdHandler(
        req({ uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } }, { bloodType: 'O+', threshold: 10 }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('updates minimumThreshold on an existing doc without touching stock fields', async () => {
    mocks.txGet.mockResolvedValue(invSnap({ unitsAvailable: 7, minimumThreshold: 5 }));
    const result = await setInventoryThresholdHandler(
      req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'O+', threshold: 10 }),
    );
    expect(result).toEqual({ bloodType: 'O+', minimumThreshold: 10 });
    expect(mocks.txUpdate).toHaveBeenCalledWith({ __docId: 'General_Hospital_O+' }, { minimumThreshold: 10 });
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it('creates a placeholder doc if none exists yet', async () => {
    mocks.txGet.mockResolvedValue(invSnap(undefined));
    await setInventoryThresholdHandler(
      req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, { bloodType: 'O+', threshold: 10 }),
    );
    expect(mocks.txSet).toHaveBeenCalledWith(
      { __docId: 'General_Hospital_O+' },
      expect.objectContaining({ minimumThreshold: 10, unitsAvailable: 0 }),
    );
  });

  it('system_admin sets a threshold for a shadow (unregistered) hospital by name only', async () => {
    mocks.txGet.mockResolvedValue(invSnap(undefined));
    const result = await setInventoryThresholdHandler(
      req(
        { uid: 'a1', token: { role: 'system_admin' } },
        { bloodType: 'O+', threshold: 3, hospitalName: 'Unregistered Clinic' },
      ),
    );
    expect(result).toEqual({ bloodType: 'O+', minimumThreshold: 3 });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'setInventoryThreshold', targetUid: undefined }),
    );
  });
});

describe('issueBloodToPatientHandler', () => {
  const validPayload = (overrides: Record<string, unknown> = {}) => ({
    bloodType: 'O+',
    units: 2,
    patientName: 'Jane Doe',
    crossmatchConfirmed: true,
    crossmatchResult: 'Compatible',
    ...overrides,
  });

  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(issueBloodToPatientHandler(req(undefined, validPayload()))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('HOSTILE: rejects a payload that doesn\'t confirm the crossmatch (medical safety gate, Master Plan 1.3)', async () => {
    await expect(
      issueBloodToPatientHandler(
        req(
          { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
          validPayload({ crossmatchConfirmed: false }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a crossmatchResult other than the exact literal "Compatible" — the gate cannot be relabeled around', async () => {
    await expect(
      issueBloodToPatientHandler(
        req(
          { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
          validPayload({ crossmatchResult: 'Incompatible' }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a payload missing patientName', async () => {
    const { patientName: _patientName, ...rest } = validPayload();
    await expect(
      issueBloodToPatientHandler(req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, rest)),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: lab_tech cannot issue blood (separation of duties: clearance vs. issuance)', async () => {
    await expect(
      issueBloodToPatientHandler(
        req({ uid: 'l1', token: { role: 'lab_tech', hospitalId: 'H1' } }, validPayload()),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: donor cannot issue blood', async () => {
    await expect(
      issueBloodToPatientHandler(req({ uid: 'd1', token: { role: 'donor' } }, validPayload())),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: a client-supplied hospitalId is ignored for hospital-scoped roles (own claim wins)', async () => {
    mocks.txGet.mockResolvedValue(invSnap({ batches: [{ id: 'b1', units: 5, testStatus: 'Cleared' }] }));
    await issueBloodToPatientHandler(
      req(
        { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
        validPayload({ units: 1, hospitalId: 'SOMEONE-ELSES-HOSPITAL' }),
      ),
    );
    expect(mocks.usersDoc).toHaveBeenCalledWith('H1');
    expect(mocks.usersDoc).not.toHaveBeenCalledWith('SOMEONE-ELSES-HOSPITAL');
  });

  it('HOSTILE: rejects issuing from a hospital with no inventory doc yet', async () => {
    mocks.txGet.mockResolvedValue(invSnap(undefined));
    await expect(
      issueBloodToPatientHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, validPayload()),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HOSTILE: rejects issuing more than is testStatus "Cleared" — Waiting/Rejected batches never count, and nothing is written', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({
        batches: [
          { id: 'b1', units: 5, testStatus: 'Waiting for Lab Test', componentType: 'Whole Blood' },
          { id: 'b2', units: 1, testStatus: 'Cleared', componentType: 'Whole Blood' },
        ],
      }),
    );
    await expect(
      issueBloodToPatientHandler(
        req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, validPayload({ units: 2 })),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mocks.txSet).not.toHaveBeenCalled();
    expect(mocks.issuanceAdd).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('deducts Cleared batches oldest-first, leaves non-Cleared batches untouched, writes issuance_log and an audit event with no PHI', async () => {
    mocks.txGet.mockResolvedValue(
      invSnap({
        batches: [
          { id: 'b1', units: 2, testStatus: 'Cleared', componentType: 'Whole Blood', sourceDonationId: 'D1' },
          { id: 'b2', units: 1, testStatus: 'Waiting for Lab Test', componentType: 'Whole Blood' },
          { id: 'b3', units: 5, testStatus: 'Cleared', componentType: 'Whole Blood', sourceDonationId: 'D2' },
        ],
      }),
    );

    const result = await issueBloodToPatientHandler(
      req(
        { uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
        validPayload({ units: 3, patientId: 'P1', diagnosis: 'Trauma', ward: 'ICU' }),
      ),
    );

    // Cleared total was 2 + 5 = 7; issuing 3 leaves 4 Cleared. b1 (oldest) is
    // fully consumed first, then 1 of b3's 5 units; b2 (not Cleared) is untouched.
    expect(result).toMatchObject({
      bloodType: 'O+',
      unitsAvailable: 4,
      issuanceLogId: 'ISSUE1',
      deductedBatches: [
        { id: 'b1', units: 2, sourceDonationId: 'D1' },
        { id: 'b3', units: 1, sourceDonationId: 'D2' },
      ],
    });

    expect(mocks.inventoryDoc).toHaveBeenCalledWith('General_Hospital_O+');
    expect(mocks.txSet).toHaveBeenCalledWith(
      { __docId: 'General_Hospital_O+' },
      expect.objectContaining({
        unitsAvailable: 4,
        unitsPendingTest: 1,
        batches: [
          { id: 'b2', units: 1, testStatus: 'Waiting for Lab Test', componentType: 'Whole Blood' },
          { id: 'b3', units: 4, testStatus: 'Cleared', componentType: 'Whole Blood', sourceDonationId: 'D2' },
        ],
      }),
      { merge: true },
    );

    expect(mocks.issuanceAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        bloodType: 'O+',
        units: 3,
        patientName: 'Jane Doe',
        patientId: 'P1',
        diagnosis: 'Trauma',
        ward: 'ICU',
        crossmatchConfirmed: true,
        crossmatchResult: 'Compatible',
        hospital: 'General Hospital',
        hospitalId: 'H1',
      }),
    );

    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUid: 'h1',
        action: 'issueBloodToPatient',
        targetUid: 'H1',
        details: expect.objectContaining({ issuanceLogId: 'ISSUE1', bloodType: 'O+', units: 3 }),
      }),
    );
    // Policy 5: audit events log references, never PHI values — patientName/
    // diagnosis must never appear in the audit trail itself.
    const auditPayload = JSON.stringify((writeAudit as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(auditPayload).not.toContain('Jane Doe');
    expect(auditPayload).not.toContain('Trauma');
  });

  it('system_admin issues blood on behalf of a shadow (unregistered) hospital by name only', async () => {
    mocks.txGet.mockResolvedValue(invSnap({ batches: [{ id: 'b1', units: 5, testStatus: 'Cleared' }] }));
    const result = await issueBloodToPatientHandler(
      req(
        { uid: 'a1', token: { role: 'system_admin' } },
        validPayload({ units: 2, hospitalName: 'Unregistered Clinic' }),
      ),
    );
    expect(result.unitsAvailable).toBe(3);
    expect(mocks.usersDoc).not.toHaveBeenCalled();
    expect(mocks.inventoryDoc).toHaveBeenCalledWith('Unregistered_Clinic_O+');
    expect(mocks.issuanceAdd).toHaveBeenCalledWith(
      expect.objectContaining({ hospital: 'Unregistered Clinic', hospitalId: null }),
    );
  });
});
