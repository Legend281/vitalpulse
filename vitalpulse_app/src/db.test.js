import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./firebase', () => ({
    db: {},
    auth: {},
}));

vi.mock('firebase/auth', () => ({
    getAuth: vi.fn(),
    createUserWithEmailAndPassword: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
    signOut: vi.fn(),
    onAuthStateChanged: vi.fn(),
    updateProfile: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendEmailVerification: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
    collection: vi.fn((_db, path) => ({ __type: 'collection', path })),
    doc: vi.fn((_db, path, id) => ({ __type: 'doc', path, id })),
    query: vi.fn((...args) => ({ __type: 'query', args })),
    where: vi.fn((field, op, value) => ({ __type: 'where', field, op, value })),
    orderBy: vi.fn((field, dir) => ({ __type: 'orderBy', field, dir })),
    limit: vi.fn((n) => ({ __type: 'limit', n })),
    getDocs: vi.fn(),
    getDoc: vi.fn(),
    addDoc: vi.fn().mockResolvedValue({ id: 'mock-id' }),
    updateDoc: vi.fn().mockResolvedValue(undefined),
    setDoc: vi.fn().mockResolvedValue(undefined),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    onSnapshot: vi.fn(),
    runTransaction: vi.fn(),
    collectionGroup: vi.fn((_db, path) => ({ __type: 'collectionGroup', path })),
}));

const functionsMocks = vi.hoisted(() => ({
    callables: {},
    getFunctions: vi.fn(() => ({ __type: 'functions' })),
    httpsCallable: vi.fn((_fns, name) => {
        if (!functionsMocks.callables[name]) {
            functionsMocks.callables[name] = vi.fn().mockResolvedValue({ data: { success: true } });
        }
        return functionsMocks.callables[name];
    }),
}));

vi.mock('firebase/functions', () => ({
    getFunctions: functionsMocks.getFunctions,
    httpsCallable: functionsMocks.httpsCallable,
}));

import { getDocs, getDoc, addDoc, updateDoc, setDoc, where, runTransaction } from 'firebase/firestore';
const { httpsCallable } = functionsMocks;
import {
    getCompatibleBloodTypes,
    getCompatibleDonorTypes,
    findMatchingDonors,
    autoMatchDonors,
    fetchMatchedRequestsForDonor,
} from './db.js';

function fakeSnapshot(items) {
    return { docs: items.map((item) => ({ id: item.id, data: () => item.data })) };
}

const ALL_TYPES = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

// Real-world ABO/Rh whole-blood tables (db.js WHOLE_BLOOD_DONOR_TO_RECIPIENT and its
// inverse). NOTE on direction semantics: getCompatibleBloodTypes(X) answers "who X can
// donate TO"; getCompatibleDonorTypes(X) answers "who can donate TO X / X can receive
// FROM". These are genuinely different matrices — confusing them was the 2026-07-24
// inverted-compatibility bug.
const DONATES_TO = {
    'O-':  ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
    'O+':  ['O+', 'A+', 'B+', 'AB+'],
    'A-':  ['A-', 'A+', 'AB-', 'AB+'],
    'A+':  ['A+', 'AB+'],
    'B-':  ['B-', 'B+', 'AB-', 'AB+'],
    'B+':  ['B+', 'AB+'],
    'AB-': ['AB-', 'AB+'],
    'AB+': ['AB+'],
};

describe('getCompatibleBloodTypes — "donates to" compatibility matrix (donor → recipients)', () => {
    it('O- (universal donor) donates to all 8 types', () => {
        expect(getCompatibleBloodTypes('O-').slice().sort()).toEqual([...ALL_TYPES].sort());
    });

    it('AB+ can only donate to AB+', () => {
        expect(getCompatibleBloodTypes('AB+')).toEqual(['AB+']);
    });

    it('matches real-world ABO/Rh compatibility for every blood type', () => {
        for (const type of ALL_TYPES) {
            expect(getCompatibleBloodTypes(type).slice().sort()).toEqual(DONATES_TO[type].slice().sort());
        }
    });

    it('falls back to [bloodType] for an unrecognized type', () => {
        expect(getCompatibleBloodTypes('X+')).toEqual(['X+']);
    });
});

describe('getCompatibleDonorTypes — "receives from" compatibility matrix (recipient → donors)', () => {
    it('O- (universal donor) can only receive from O-', () => {
        expect(getCompatibleDonorTypes('O-')).toEqual(['O-']);
    });

    it('AB+ (universal recipient) can receive from every type', () => {
        expect(getCompatibleDonorTypes('AB+').slice().sort()).toEqual([...ALL_TYPES].sort());
    });

    it('matches real-world ABO/Rh compatibility for every blood type', () => {
        const expected = {
            'O-': ['O-'],
            'O+': ['O-', 'O+'],
            'A-': ['A-', 'O-'],
            'A+': ['A-', 'A+', 'O-', 'O+'],
            'B-': ['B-', 'O-'],
            'B+': ['B-', 'B+', 'O-', 'O+'],
            'AB-': ['A-', 'B-', 'AB-', 'O-'],
            'AB+': ['A-', 'A+', 'B-', 'B+', 'AB-', 'AB+', 'O-', 'O+'],
        };
        for (const type of ALL_TYPES) {
            expect(getCompatibleDonorTypes(type).slice().sort()).toEqual(expected[type].slice().sort());
        }
    });

    it('falls back to [bloodType] for an unrecognized type', () => {
        expect(getCompatibleDonorTypes('X+')).toEqual(['X+']);
    });
});

describe('direction regression guard for the 2026-07-24 inverted-compatibility bug', () => {
    // A request for O- must not match donors of every blood type, and a donor must not
    // be shown their own "donates to" list under a "Receives from" label. The two
    // functions must stay genuinely different computations.
    it('donate-to and receive-from are genuinely different matrices for a mixed type', () => {
        expect(getCompatibleDonorTypes('A+')).not.toEqual(getCompatibleBloodTypes('A+'));
    });

    it('the modal\'s "Donates to" grid must not equal its "Receives from" grid for the same type', () => {
        for (const type of ['A+', 'O+', 'B-', 'AB-']) {
            expect(getCompatibleDonorTypes(type).slice().sort()).not.toEqual(getCompatibleBloodTypes(type).slice().sort());
        }
    });
});

describe('findMatchingDonors', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('queries donors by role, compatible blood types, availability, and exact city match', async () => {
        getDocs.mockResolvedValueOnce(fakeSnapshot([
            { id: 'donor1', data: { bloodType: 'O-', city: 'Yaounde' } },
        ]));

        const result = await findMatchingDonors('A+', 'Yaounde');

        expect(where).toHaveBeenCalledWith('role', '==', 'donor');
        expect(where).toHaveBeenCalledWith('bloodType', 'in', getCompatibleDonorTypes('A+'));
        expect(where).toHaveBeenCalledWith('isAvailable', '==', true);
        expect(where).toHaveBeenCalledWith('city', '==', 'Yaounde');
        expect(result).toEqual([{ id: 'donor1', bloodType: 'O-', city: 'Yaounde' }]);
    });

    it('has no effect from radiusKm — matching is exact-city-string only, not a geographic radius', async () => {
        // The Master Plan describes "radius matching"; the real app has never implemented a geo
        // radius (PHASE0_AUDIT.md §6 / Plan Tracker Part 3.1) — radiusKm is accepted for API
        // compatibility but never read. Documented here so a future radius implementation is a
        // deliberate change, not a silent regression either way.
        getDocs.mockResolvedValueOnce(fakeSnapshot([]));
        await findMatchingDonors('A+', 'Yaounde', 5);
        getDocs.mockResolvedValueOnce(fakeSnapshot([]));
        await findMatchingDonors('A+', 'Yaounde', 5000);

        const cityCalls = where.mock.calls.filter(([field]) => field === 'city');
        expect(cityCalls.length).toBe(2);
        expect(cityCalls.every(([, , value]) => value === 'Yaounde')).toBe(true);
    });
});

describe('autoMatchDonors', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns [] and skips the query entirely when bloodType or city is missing', async () => {
        const result = await autoMatchDonors('req1', { bloodType: 'A+' /* no city */ });
        expect(result).toEqual([]);
        expect(getDocs).not.toHaveBeenCalled();
    });

    it('skips suspended donors — they are not returned, notified, or counted', async () => {
        getDocs.mockResolvedValueOnce(fakeSnapshot([
            { id: 'suspended-donor', data: { bloodType: 'O-', city: 'Douala', isSuspended: true, phone: '000' } },
            { id: 'active-donor', data: { bloodType: 'O-', city: 'Douala', isSuspended: false, phone: '111' } },
        ]));

        const result = await autoMatchDonors('req1', { bloodType: 'A+', city: 'Douala', hospital: 'Central' });

        expect(result.map((d) => d.id)).toEqual(['active-donor']);
    });

    it('stamps matchingDonorsNotified/matchingDonorsCount on the request when donors match', async () => {
        getDocs.mockResolvedValueOnce(fakeSnapshot([
            { id: 'donor1', data: { bloodType: 'O-', city: 'Douala' } },
            { id: 'donor2', data: { bloodType: 'O-', city: 'Douala' } },
        ]));

        await autoMatchDonors('req1', { bloodType: 'A+', city: 'Douala' });

        expect(updateDoc).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                matchingDonorsNotified: ['donor1', 'donor2'],
                matchingDonorsCount: 2,
            })
        );
    });

    it('does not touch the request document when zero donors match', async () => {
        getDocs.mockResolvedValueOnce(fakeSnapshot([]));
        await autoMatchDonors('req1', { bloodType: 'A+', city: 'Douala' });
        expect(updateDoc).not.toHaveBeenCalled();
    });
});

describe('fetchMatchedRequestsForDonor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('queries Open requests, filters compatible blood types client-side, and applies the donor city filter', async () => {
        // Compatibility cannot be a Firestore `in` query here because it depends on the
        // component each request needs (plasma compatibility is reversed), so it's computed
        // per-request client-side. The location param IS applied — as an exact city match
        // plus National/Central Command broadcasts (see db.js fetchMatchedRequestsForDonor).
        getDocs.mockResolvedValueOnce(fakeSnapshot([
            { id: 'req1', data: { bloodType: 'A+', status: 'Open', city: 'Douala', requestedAt: '2026-01-01T00:00:00.000Z', patientName: 'PHI', diagnosis: 'PHI' } },
            { id: 'req2', data: { bloodType: 'O-', status: 'Open', city: 'Douala', requestedAt: '2026-01-02T00:00:00.000Z' } },
            { id: 'req3', data: { type: 'AB+', status: 'Open', city: 'National', requestedAt: '2026-01-03T00:00:00.000Z' } },
            { id: 'req4', data: { bloodType: 'A+', status: 'Open', city: 'Yaounde', requestedAt: '2026-01-04T00:00:00.000Z' } },
        ]));

        const result = await fetchMatchedRequestsForDonor('A+', 'Douala');

        expect(where).toHaveBeenCalledWith('status', '==', 'Open');
        expect(where).not.toHaveBeenCalledWith('bloodType', expect.anything(), expect.anything());
        // A+ donor can fulfill requests needing A+ or AB+; O- and other-city requests are
        // excluded. Urgent-first, then most-recent (req3 posted later than req1).
        expect(result.map((r) => r.id)).toEqual(['req3', 'req1']);
        // Medical Privacy Enforcement: patient fields are stripped from the donor-facing payload.
        expect(result[0]).not.toHaveProperty('patientName');
        expect(result[0]).not.toHaveProperty('diagnosis');
    });
});

describe('Scoped Check-In Tokens & Token Expiration', () => {
    it('generateScopedCheckInToken generates VP-[PREFIX]-[RANDOM] format', async () => {
        const { generateScopedCheckInToken } = await import('./db.js');
        const token = generateScopedCheckInToken('req-abc1234');
        expect(token).toMatch(/^VP-1234-[A-Z0-9]{4}$/);
    });

    it('findRequestByCheckInToken rejects expired check-in tokens', async () => {
        const { findRequestByCheckInToken } = await import('./db.js');
        const expiredDate = new Date(Date.now() - 3600000).toISOString();
        getDocs.mockResolvedValueOnce(fakeSnapshot([
            { id: 'r1', data: { hospital: 'Buea Regional', checkInToken: 'VP-1234-ABCD', checkInTokenExpiresAt: expiredDate } }
        ]));

        await expect(findRequestByCheckInToken('VP-1234-ABCD', 'Buea Regional')).rejects.toThrow(/pass code has expired/);
    });

    it('findRequestByCheckInToken will not return another hospital\'s donor', async () => {
        // A front desk must never be able to check in a donor who is expected at
        // a different facility. Scoping used to be the caller's job and only
        // covered the `requests` collection.
        const { findRequestByCheckInToken } = await import('./db.js');
        getDocs
            .mockResolvedValueOnce(fakeSnapshot([
                { id: 'r1', data: { hospital: 'Douala General', checkInToken: 'VP-1234-ABCD', status: 'Donor En Route' } }
            ]))
            .mockResolvedValueOnce(fakeSnapshot([]))
            .mockResolvedValueOnce(fakeSnapshot([]));

        await expect(findRequestByCheckInToken('VP-1234-ABCD', 'Buea Regional')).resolves.toBeNull();
    });

    it('findRequestByCheckInToken resolves a SCHEDULED booking and reports its collection', async () => {
        // Regression guard: bookings carry a 7-day pass code but reception had no
        // way to accept one — the lookup only searched `requests`/`public_requests`
        // and demanded a status a booking never reaches.
        const { findRequestByCheckInToken } = await import('./db.js');
        getDocs
            .mockResolvedValueOnce(fakeSnapshot([]))
            .mockResolvedValueOnce(fakeSnapshot([]))
            .mockResolvedValueOnce(fakeSnapshot([
                { id: 'b1', data: { hospital: 'Buea Regional', checkInToken: 'VP-1234-ABCD', status: 'approved', donorId: 'd1' } }
            ]));

        const match = await findRequestByCheckInToken('VP-1234-ABCD', 'Buea Regional');
        expect(match).toMatchObject({ id: 'b1', sourceCollection: 'donation_requests', status: 'approved' });
    });
});

describe('donorMarkArrived (check-in handshake, donor half)', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('signals arrival without advancing the journey to Checked In', async () => {
        // The donor announces they are at the desk; only hospital staff may set
        // 'Checked In', after verifying the pass code and CNI in person.
        const { donorMarkArrived } = await import('./db.js');
        const update = vi.fn();
        runTransaction.mockImplementationOnce(async (_db, fn) => fn({
            get: async () => ({
                exists: () => true,
                data: () => ({ status: 'Donor En Route', matchedDonor: 'd1', hospital: 'Buea Regional' }),
            }),
            update,
        }));
        getDocs.mockResolvedValue(fakeSnapshot([]));

        await donorMarkArrived('r1', 'd1', false);

        const [, payload] = update.mock.calls[0];
        expect(payload).toMatchObject({ receptionStatus: 'Awaiting Verification' });
        expect(payload).not.toHaveProperty('status');
    });

    it('refuses to signal arrival on an expired pass code', async () => {
        const { donorMarkArrived } = await import('./db.js');
        runTransaction.mockImplementationOnce(async (_db, fn) => fn({
            get: async () => ({
                exists: () => true,
                data: () => ({
                    status: 'Donor En Route',
                    matchedDonor: 'd1',
                    checkInTokenExpiresAt: new Date(Date.now() - 3600000).toISOString(),
                }),
            }),
            update: vi.fn(),
        }));

        await expect(donorMarkArrived('r1', 'd1', false)).rejects.toThrow(/expired/);
    });

    it('refuses to signal arrival for a donor who is not the assigned one', async () => {
        const { donorMarkArrived } = await import('./db.js');
        runTransaction.mockImplementationOnce(async (_db, fn) => fn({
            get: async () => ({
                exists: () => true,
                data: () => ({ status: 'Donor En Route', matchedDonor: 'someone-else' }),
            }),
            update: vi.fn(),
        }));

        await expect(donorMarkArrived('r1', 'd1', false)).rejects.toThrow(/not the assigned donor/);
    });
});

describe('suspendDonor/reactivateDonor (Phase 3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('suspendDonor calls the suspendUser Cloud Function and never writes the users doc directly', async () => {
        const { suspendDonor } = await import('./db.js');
        await suspendDonor('donor-1', 'Jean');

        expect(functionsMocks.callables.suspendUser).toHaveBeenCalledWith(
            expect.objectContaining({ targetUid: 'donor-1', suspend: true })
        );
        expect(functionsMocks.callables.reactivateUser).not.toHaveBeenCalled();
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('reactivateDonor calls the reactivateUser Cloud Function and never writes the users doc directly', async () => {
        const { reactivateDonor } = await import('./db.js');
        await reactivateDonor('donor-1', 'Jean');

        expect(functionsMocks.callables.reactivateUser).toHaveBeenCalledWith(
            expect.objectContaining({ targetUid: 'donor-1', suspend: false })
        );
        expect(updateDoc).not.toHaveBeenCalled();
    });
});

describe('deactivateHospital/reactivateHospital (Phase 3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('deactivateHospital calls the Cloud Function and never writes the users doc directly', async () => {
        const { deactivateHospital } = await import('./db.js');
        await deactivateHospital('H1', 'Central Hospital');

        expect(functionsMocks.callables.deactivateHospital).toHaveBeenCalledWith(
            expect.objectContaining({ hospitalId: 'H1', active: false })
        );
        expect(functionsMocks.callables.reactivateHospital).not.toHaveBeenCalled();
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('reactivateHospital calls the Cloud Function and never writes the users doc directly', async () => {
        const { reactivateHospital } = await import('./db.js');
        await reactivateHospital('H1', 'Central Hospital');

        expect(functionsMocks.callables.reactivateHospital).toHaveBeenCalledWith(
            expect.objectContaining({ hospitalId: 'H1', active: true })
        );
        expect(updateDoc).not.toHaveBeenCalled();
    });
});

describe('Inventory Cloud Functions (Phase 3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('updateInventoryStock(add) calls addInventoryStock and never writes Firestore directly', async () => {
        const { updateInventoryStock } = await import('./db.js');
        functionsMocks.callables.addInventoryStock.mockResolvedValueOnce({ data: { unitsAvailable: 12 } });

        const result = await updateInventoryStock('O+', 5, 'add', 'General Hospital', { componentType: 'Plasma', expiresAt: '2026-09-01' });

        expect(functionsMocks.callables.addInventoryStock).toHaveBeenCalledWith({
            bloodType: 'O+',
            units: 5,
            componentType: 'Plasma',
            expiresAt: '2026-09-01',
        });
        expect(result).toEqual({ bloodType: 'O+', unitsAvailable: 12 });
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('updateInventoryStock(add) omits optional fields entirely rather than sending null', async () => {
        const { updateInventoryStock } = await import('./db.js');
        functionsMocks.callables.addInventoryStock.mockResolvedValueOnce({ data: { unitsAvailable: 1 } });

        await updateInventoryStock('O+', 1, 'add', 'General Hospital', {});

        expect(functionsMocks.callables.addInventoryStock).toHaveBeenCalledWith({
            bloodType: 'O+',
            units: 1,
            componentType: 'Whole Blood',
        });
    });

    it('updateInventoryStock(remove) calls deductInventoryStock, not addInventoryStock', async () => {
        const { updateInventoryStock } = await import('./db.js');
        functionsMocks.callables.deductInventoryStock.mockResolvedValueOnce({ data: { unitsAvailable: 3, deducted: 2 } });

        const result = await updateInventoryStock('O+', 2, 'remove', 'General Hospital');

        expect(functionsMocks.callables.deductInventoryStock).toHaveBeenCalledWith({ bloodType: 'O+', units: 2 });
        expect(functionsMocks.callables.addInventoryStock).not.toHaveBeenCalled();
        expect(result).toEqual({ bloodType: 'O+', unitsAvailable: 3 });
    });

    it('deductInventoryStock calls the Cloud Function and never runs a client transaction', async () => {
        const { deductInventoryStock } = await import('./db.js');
        functionsMocks.callables.deductInventoryStock.mockResolvedValueOnce({ data: { unitsAvailable: 6, deducted: 4 } });

        const result = await deductInventoryStock('O+', 4, 'spoilage', 'General Hospital');

        expect(functionsMocks.callables.deductInventoryStock).toHaveBeenCalledWith({
            bloodType: 'O+',
            units: 4,
            reason: 'spoilage',
        });
        expect(result).toEqual({ bloodType: 'O+', unitsAvailable: 6, deducted: 4 });
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('deductInventoryStock rejects a non-positive unit count without ever calling the Cloud Function', async () => {
        const { deductInventoryStock } = await import('./db.js');
        await expect(deductInventoryStock('O+', 0, 'spoilage', 'General Hospital')).rejects.toThrow();
        expect(functionsMocks.callables.deductInventoryStock).not.toHaveBeenCalled();
    });

    it('resolveLabTest calls the Cloud Function with only the supplied optional fields and notifies from the response', async () => {
        const { resolveLabTest } = await import('./db.js');
        getDocs.mockResolvedValue(fakeSnapshot([]));
        functionsMocks.callables.resolveLabTest.mockResolvedValueOnce({
            data: { batch: { id: 'b1', units: 3, componentType: 'Whole Blood', sourceDonationId: null } },
        });

        const result = await resolveLabTest('General Hospital', 'O+', 'b1', 'Cleared', null, { labTechName: 'T. Nkeng' });

        expect(functionsMocks.callables.resolveLabTest).toHaveBeenCalledWith({
            bloodType: 'O+',
            batchId: 'b1',
            result: 'Cleared',
            labTechName: 'T. Nkeng',
        });
        expect(result).toEqual({ id: 'b1', units: 3, componentType: 'Whole Blood', sourceDonationId: null });
        expect(updateDoc).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'inventory' }), expect.anything());
    });

    it('resolveLabTest rejects an invalid result value without ever calling the Cloud Function', async () => {
        const { resolveLabTest } = await import('./db.js');
        await expect(resolveLabTest('General Hospital', 'O+', 'b1', 'Probably Fine')).rejects.toThrow();
        expect(functionsMocks.callables.resolveLabTest).not.toHaveBeenCalled();
    });

    it('setInventoryThreshold calls the Cloud Function and never reads/writes the inventory doc directly', async () => {
        const { setInventoryThreshold } = await import('./db.js');

        await setInventoryThreshold('O+', 10, 'General Hospital');

        expect(functionsMocks.callables.setInventoryThreshold).toHaveBeenCalledWith({ bloodType: 'O+', threshold: 10 });
        expect(updateDoc).not.toHaveBeenCalled();
    });
});

describe('issueBloodToPatient (Phase 3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getDocs.mockResolvedValue(fakeSnapshot([]));
    });

    it('calls the issueBloodToPatient Cloud Function and never writes inventory/issuance_log directly', async () => {
        const { issueBloodToPatient } = await import('./db.js');
        functionsMocks.callables.issueBloodToPatient.mockResolvedValueOnce({
            data: { unitsAvailable: 4, issuanceLogId: 'ISSUE1', deductedBatches: [] },
        });

        const result = await issueBloodToPatient('O+', 2, {
            hospital: 'General Hospital',
            patientName: 'Jane Doe',
            crossmatchConfirmed: true,
            crossmatchResult: 'Compatible',
            ward: 'ICU',
            diagnosis: 'Trauma',
        });

        expect(functionsMocks.callables.issueBloodToPatient).toHaveBeenCalledWith({
            bloodType: 'O+',
            units: 2,
            patientName: 'Jane Doe',
            requestingPhysicianName: 'Dr. Unspecified',
            crossmatchConfirmed: true,
            crossmatchResult: 'Compatible',
            ward: 'ICU',
            diagnosis: 'Trauma',
        });
        expect(result).toEqual({ bloodType: 'O+', unitsAvailable: 4 });
        expect(addDoc).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'issuance_log' }), expect.anything());
        expect(updateDoc).not.toHaveBeenCalled();
    });

    it('HOSTILE: rejects locally, without calling the Cloud Function, if the crossmatch is not confirmed compatible', async () => {
        const { issueBloodToPatient } = await import('./db.js');
        await expect(issueBloodToPatient('O+', 2, {
            hospital: 'General Hospital',
            patientName: 'Jane Doe',
            crossmatchConfirmed: false,
            crossmatchResult: 'Compatible',
        })).rejects.toThrow(/CRITICAL MEDICAL SAFETY GATE/);
        expect(functionsMocks.callables.issueBloodToPatient).not.toHaveBeenCalled();
    });

    it('HOSTILE: rejects locally if crossmatchResult is anything other than "Compatible"', async () => {
        const { issueBloodToPatient } = await import('./db.js');
        await expect(issueBloodToPatient('O+', 2, {
            hospital: 'General Hospital',
            patientName: 'Jane Doe',
            crossmatchConfirmed: true,
            crossmatchResult: 'Incompatible',
        })).rejects.toThrow(/CRITICAL MEDICAL SAFETY GATE/);
        expect(functionsMocks.callables.issueBloodToPatient).not.toHaveBeenCalled();
    });

    it('omits optional patient fields entirely rather than sending them as empty strings/null', async () => {
        const { issueBloodToPatient } = await import('./db.js');
        functionsMocks.callables.issueBloodToPatient.mockResolvedValueOnce({
            data: { unitsAvailable: 1, issuanceLogId: 'ISSUE2', deductedBatches: [] },
        });

        await issueBloodToPatient('O+', 1, {
            hospital: 'General Hospital',
            patientName: 'Jane Doe',
            crossmatchConfirmed: true,
            crossmatchResult: 'Compatible',
        });

        expect(functionsMocks.callables.issueBloodToPatient).toHaveBeenCalledWith({
            bloodType: 'O+',
            units: 1,
            patientName: 'Jane Doe',
            requestingPhysicianName: 'Dr. Unspecified',
            crossmatchConfirmed: true,
            crossmatchResult: 'Compatible',
        });
    });

    it('links each deducted batch\'s source donation request to "Issued" and notifies the donor, using the server-returned batches', async () => {
        const { issueBloodToPatient } = await import('./db.js');
        functionsMocks.callables.issueBloodToPatient.mockResolvedValueOnce({
            data: {
                unitsAvailable: 4,
                issuanceLogId: 'ISSUE3',
                deductedBatches: [{ id: 'b1', units: 2, sourceDonationId: 'D1' }],
            },
        });
        getDoc.mockResolvedValueOnce({ exists: () => true, data: () => ({ donorId: 'donor-1' }) });

        await issueBloodToPatient('O+', 2, {
            hospital: 'General Hospital',
            patientName: 'Jane Doe',
            crossmatchConfirmed: true,
            crossmatchResult: 'Compatible',
        });

        expect(updateDoc).toHaveBeenCalledWith(
            expect.objectContaining({ path: 'donation_requests' }),
            expect.objectContaining({ status: 'Issued' }),
        );
    });
});

describe('authenticateStaffDirectLoginCall (server-only staff auth)', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('throws error when email or pin is missing', async () => {
        const { authenticateStaffDirectLoginCall } = await import('./db.js');
        await expect(authenticateStaffDirectLoginCall({})).rejects.toThrow('Email and 4-digit PIN are required.');
    });

    it('delegates to the Cloud Function and never reads a PIN hash client-side', async () => {
        // PERMANENT GUARANTEE. This used to run entirely in the browser: it read
        // a staff record (including its PIN hash) out of a world-readable
        // `staff_accounts` collection or a localStorage registry, compared the
        // hash itself, and let auth.js derive the Firebase password from the PIN.
        // The client must now have no credential-verification path at all.
        const callable = vi.fn().mockResolvedValue({
            data: { success: true, token: 'CUSTOM_TOKEN', name: 'Patricia Ngu', roles: ['nurse', 'lab_tech'], hospitalId: 'hosp_buea' },
        });
        httpsCallable.mockReturnValueOnce(callable);

        const { authenticateStaffDirectLoginCall } = await import('./db.js');
        const res = await authenticateStaffDirectLoginCall({ email: 'Patricia@Buea.CM', pin: '1234' });

        expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'authenticateStaffDirectLogin');
        expect(callable).toHaveBeenCalledWith({ email: 'patricia@buea.cm', pin: '1234' });
        expect(res).toMatchObject({ success: true, token: 'CUSTOM_TOKEN' });
        // No Firestore lookup of any staff/credential document.
        expect(getDoc).not.toHaveBeenCalled();
        expect(getDocs).not.toHaveBeenCalled();
    });
});

describe('staff credential handling — permanent guarantees', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('db.js exports no PIN-hashing or password-derivation helper', async () => {
        // The removed `formatStaffAuthPassword` turned a 4-digit PIN into the
        // account's actual Firebase Auth password ('VP_PIN_1234'), so recovering a
        // PIN was account takeover. `hashPinFallback` let the browser verify PINs.
        // Neither may come back.
        const dbModule = await import('./db.js');
        expect(dbModule.formatStaffAuthPassword).toBeUndefined();
        expect(dbModule.hashPinFallback).toBeUndefined();
        expect(dbModule.tryAutoHealStaffAccount).toBeUndefined();
    });

    it('createStaffAccountCall has no client-side fallback that skips custom claims', async () => {
        // The old fallback wrote the staff record straight from the browser when
        // the Cloud Function failed. It could not set custom claims, so it
        // produced accounts that every rule and every Function later denied —
        // while masking the fact that Functions were not deployed.
        const callable = vi.fn().mockRejectedValue(new Error('internal'));
        httpsCallable.mockReturnValueOnce(callable);

        const { createStaffAccountCall } = await import('./db.js');
        await expect(createStaffAccountCall({ name: 'X', email: 'x@h.cm', roles: ['nurse'] })).rejects.toThrow();
        expect(setDoc).not.toHaveBeenCalled();
    });

    it('fetchHospitalStaff is a pure read and strips credential material', async () => {
        // It used to call createUserWithEmailAndPassword for every staff member on
        // every render (the identitytoolkit 400 spam) and re-publish every PIN
        // hash to the public staff_accounts collection.
        getDocs.mockResolvedValueOnce(fakeSnapshot([
            { id: 's1', data: { uid: 's1', name: 'Patricia', roles: ['nurse'], pinHash: 'SECRET', pinSalt: 'SALT', pinAlgo: 'scrypt' } },
        ]));

        const { fetchHospitalStaff } = await import('./db.js');
        const list = await fetchHospitalStaff('hosp_buea');

        expect(list[0]).toMatchObject({ id: 's1', name: 'Patricia' });
        expect(list[0]).not.toHaveProperty('pinHash');
        expect(list[0]).not.toHaveProperty('pinSalt');
        expect(setDoc).not.toHaveBeenCalled();
        expect(addDoc).not.toHaveBeenCalled();
    });
});
