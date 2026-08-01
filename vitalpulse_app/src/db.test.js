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

import { getDocs, updateDoc, where } from 'firebase/firestore';
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
