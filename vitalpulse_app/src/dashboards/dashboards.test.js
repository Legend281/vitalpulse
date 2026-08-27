import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../firebase.js', () => ({
  db: {},
  auth: {}
}));

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn().mockResolvedValue({ data: { success: true } }))
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db, path) => ({ __type: 'collection', path })),
  doc: vi.fn((_db, path, id) => ({ __type: 'doc', path, id })),
  query: vi.fn((...args) => ({ __type: 'query', args })),
  where: vi.fn((field, op, value) => ({ __type: 'where', field, op, value })),
  orderBy: vi.fn((field, dir) => ({ __type: 'orderBy', field, dir })),
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  addDoc: vi.fn().mockResolvedValue({ id: 'mock-doc-id' }),
  updateDoc: vi.fn().mockResolvedValue(undefined),
  setDoc: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../main.js', () => ({
  showToast: vi.fn()
}));

vi.mock('../auth.js', () => ({
  getCurrentUser: vi.fn(() => ({
    uid: 'nurse123',
    email: 'nurse@hospital.com',
    hospitalId: 'HOSP_DOUALA_01',
    hospitalName: 'Laquintinie Hospital',
    city: 'Douala',
    role: 'hospital',
    roles: ['nurse']
  })),
  getEffectiveHospitalName: vi.fn(() => 'Laquintinie Hospital'),
  getEffectiveHospitalId: vi.fn(() => 'HOSP_DOUALA_01'),
  getEffectiveHospitalCity: vi.fn(() => 'Douala')
}));

vi.mock('../db.js', () => ({
  createEmergencyRequest: vi.fn().mockResolvedValue({ id: 'em-123' }),
  logActivity: vi.fn().mockResolvedValue({ id: 'log-123' }),
  fetchHospitalRequests: vi.fn().mockResolvedValue([]),
  issueBloodToPatient: vi.fn().mockResolvedValue({ success: true }),
  submitHemovigilanceReport: vi.fn().mockResolvedValue({ id: 'hemo-123' }),
  resolveLabTest: vi.fn().mockResolvedValue({ success: true }),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn()
}));

import { addDoc, getDoc, updateDoc, getDocs, collection, where } from 'firebase/firestore';
import { createNursePatientRequest, fetchNurseActiveRequests } from './nurse/nurseClinicalRequest.js';
import { verifyAndIssueBloodBag } from './nurse/nurseBedsideVerification.js';
import { logTransfusionVitals, fetchActiveTransfusions } from './nurse/nurseVitalsMonitor.js';
import { fetchAllLabBatches } from './lab/labDashboard.js';

describe('Nurse Clinical Request Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects if patientName, wardNumber, or bloodType is missing', async () => {
    await expect(createNursePatientRequest({ patientName: '', wardNumber: 'Ward 3', bloodTypeNeeded: 'O+' }))
      .rejects.toThrow('Patient Name, Ward/Room #, and Blood Type are required.');
  });

  it('rejects Track A emergency request if waiver is not signed', async () => {
    await expect(createNursePatientRequest({
      patientName: 'John Doe',
      wardNumber: 'Ward 3',
      bloodTypeNeeded: 'O+',
      emergencyTrack: 'Track A',
      emergencyWaiverSigned: false
    })).rejects.toThrow('Track A Emergency Release requires physician emergency waiver check.');
  });

  it('creates Track B clinical request with hospitalId, requestedAt, and isEmergency: false', async () => {
    const res = await createNursePatientRequest({
      patientName: 'Alice Smith',
      wardNumber: 'Maternity 2B',
      attendingDoctor: 'Dr. Mbarga',
      bloodTypeNeeded: 'A+',
      unitsNeeded: 2,
      emergencyTrack: 'Track B',
      clinicalDiagnosis: 'Elective Surgery'
    });

    expect(addDoc).toHaveBeenCalledTimes(1);
    const addedPayload = addDoc.mock.calls[0][1];
    expect(addedPayload.hospitalId).toBe('HOSP_DOUALA_01');
    expect(addedPayload.hospitalName).toBe('Laquintinie Hospital');
    expect(addedPayload.requestedAt).toBeDefined();
    expect(addedPayload.isEmergency).toBe(false);
    expect(addedPayload.status).toBe('Pending Crossmatch');
    expect(res.id).toBe('mock-doc-id');
  });

  it('creates Track A clinical request with isEmergency: true and triggers emergency broadcast', async () => {
    const res = await createNursePatientRequest({
      patientName: 'Jane Doe',
      wardNumber: 'ER Bed 1',
      attendingDoctor: 'Dr. Eto',
      bloodTypeNeeded: 'O-',
      unitsNeeded: 3,
      emergencyTrack: 'Track A',
      emergencyWaiverSigned: true,
      clinicalDiagnosis: 'Severe Maternal Hemorrhage'
    });

    expect(addDoc).toHaveBeenCalledTimes(1);
    const addedPayload = addDoc.mock.calls[0][1];
    expect(addedPayload.hospitalId).toBe('HOSP_DOUALA_01');
    expect(addedPayload.isEmergency).toBe(true);
    expect(addedPayload.status).toBe('Emergency Dispatch');
  });
});

describe('Nurse Bedside Verification & Vitals Monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects bedside verification without second verifier', async () => {
    await expect(verifyAndIssueBloodBag({
      patientName: 'Paul Biya',
      bloodType: 'B+',
      bloodBagBarcode: 'BAG-9999',
      secondVerifierName: ''
    })).rejects.toThrow('2-Clinician Bedside Check requires second verifier name/PIN.');
  });

  it('logs patient_transfusions with hospitalId and secondVerifier', async () => {
    const result = await verifyAndIssueBloodBag({
      patientName: 'Paul Biya',
      wardNumber: 'ICU 4',
      attendingDoctor: 'Dr. Smith',
      bloodType: 'B+',
      bloodBagBarcode: 'BAG-9999',
      secondVerifierName: 'Nurse Marie',
      secondVerifierRole: 'Head Nurse'
    });

    expect(addDoc).toHaveBeenCalledTimes(1);
    const payload = addDoc.mock.calls[0][1];
    expect(payload.hospitalId).toBe('HOSP_DOUALA_01');
    expect(payload.secondVerifier).toBe('Nurse Marie (Head Nurse)');
    expect(payload.status).toBe('Transfusing');
    expect(result.transfusionId).toBe('mock-doc-id');
  });

  it('logs vital sign check and updates transfusion record', async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ patientName: 'Paul Biya', vitalsChecked: {} })
    });

    const res = await logTransfusionVitals('trans-123', 'fifteenMin', {
      temperature: 37.2,
      systolicBp: 120,
      diastolicBp: 80,
      pulseRate: 75,
      respRate: 18,
      notes: 'Patient stable, no signs of shivering'
    });

    expect(updateDoc).toHaveBeenCalledTimes(1);
    const updatePayload = updateDoc.mock.calls[0][1];
    expect(updatePayload.vitalsChecked.fifteenMin.temperature).toBe(37.2);
    expect(updatePayload.vitalsChecked.fifteenMin.bp).toBe('120/80');
    expect(updatePayload.status).toBe('Transfusing');
    expect(res.success).toBe(true);
  });

  it('scopes fetchActiveTransfusions by hospitalId', async () => {
    getDocs.mockResolvedValueOnce({
      docs: [
        { id: 't1', data: () => ({ hospitalId: 'HOSP_DOUALA_01', patientName: 'P1', startedAt: '2026-08-19T10:00:00Z' }) }
      ]
    });

    const transfusions = await fetchActiveTransfusions('Laquintinie Hospital');
    expect(where).toHaveBeenCalledWith('hospitalId', '==', 'HOSP_DOUALA_01');
    expect(transfusions.length).toBe(1);
    expect(transfusions[0].patientName).toBe('P1');
  });
});

describe('Lab Tech Dashboard Query Scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes fetchAllLabBatches by hospitalId and separates batches by testStatus', async () => {
    getDocs.mockResolvedValueOnce({
      docs: [
        {
          id: 'inv-O-',
          data: () => ({
            hospitalId: 'HOSP_DOUALA_01',
            bloodType: 'O-',
            batches: [
              { batchId: 'B1', units: 2, testStatus: 'Waiting for Lab Test', addedAt: '2026-08-19T08:00:00Z' },
              { batchId: 'B2', units: 3, testStatus: 'Cleared', resolvedAt: '2026-08-19T09:00:00Z' },
              { batchId: 'B3', units: 1, testStatus: 'Rejected, Not Safe', resolvedAt: '2026-08-19T09:30:00Z' }
            ]
          })
        }
      ]
    });

    const result = await fetchAllLabBatches('Laquintinie Hospital');
    expect(where).toHaveBeenCalledWith('hospitalId', '==', 'HOSP_DOUALA_01');
    expect(result.pending.length).toBe(1);
    expect(result.pending[0].batchId).toBe('B1');
    expect(result.cleared.length).toBe(1);
    expect(result.cleared[0].batchId).toBe('B2');
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].batchId).toBe('B3');
  });
});
