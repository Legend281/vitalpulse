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

import { getDocs, updateDoc, where } from 'firebase/firestore';
import {
    getCompatibleBloodTypes,
    findMatchingDonors,
    autoMatchDonors,
    fetchMatchedRequestsForDonor,
} from './db.js';

function fakeSnapshot(items) {
    return { docs: items.map((item) => ({ id: item.id, data: () => item.data })) };
}

const ALL_TYPES = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

describe('getCompatibleBloodTypes — "receives from" compatibility matrix', () => {
    it('O- (universal donor) can only receive from O-', () => {
        expect(getCompatibleBloodTypes('O-')).toEqual(['O-']);
    });

    it('AB+ (universal recipient) can receive from every type', () => {
        expect(getCompatibleBloodTypes('AB+').slice().sort()).toEqual([...ALL_TYPES].sort());
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
            expect(getCompatibleBloodTypes(type).slice().sort()).toEqual(expected[type].slice().sort());
        }
    });

    it('falls back to [bloodType] for an unrecognized type', () => {
        expect(getCompatibleBloodTypes('X+')).toEqual(['X+']);
    });
});

describe('"donates to" direction — regression guard for the 2026-07-24 inverted-compatibility bug', () => {
    // getCompatibleBloodTypes(X) answers "who can X receive from", not "who does X donate to".
    // main.js's compatibility modal used to call getCompatibleBloodTypes(type) directly for its
    // "Donates to" grid, which is backwards — fixed by inverting the matrix instead. These tests
    // pin the correct derivation so that bug class can't silently come back.
    function donatesTo(type) {
        return ALL_TYPES.filter((t) => getCompatibleBloodTypes(t).includes(type));
    }

    it('O- (universal donor) donates to all 8 types', () => {
        expect(donatesTo('O-').slice().sort()).toEqual([...ALL_TYPES].sort());
    });

    it('AB+ can only donate to AB+', () => {
        expect(donatesTo('AB+')).toEqual(['AB+']);
    });

    it('donate-to and receive-from are genuinely different computations for a mixed type', () => {
        expect(donatesTo('A+')).not.toEqual(getCompatibleBloodTypes('A+'));
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
        expect(where).toHaveBeenCalledWith('bloodType', 'in', getCompatibleBloodTypes('A+'));
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

    it('filters open requests by compatible blood type only — location is accepted but not applied', async () => {
        // Known gap, not changed here: this function takes a `location` parameter but never uses
        // it to filter the query (Plan Tracker Part 3.1) — a donor's "matched requests" feed
        // today shows every compatible open request nationwide, not just their own city.
        // Documented via this test rather than silently "fixed", since it's unclear whether
        // that's an oversight or an intentional browse-all-compatible-requests view.
        getDocs.mockResolvedValueOnce(fakeSnapshot([
            { id: 'req1', data: { bloodType: 'A+', status: 'Open', requestedAt: '2026-01-01T00:00:00.000Z' } },
        ]));

        await fetchMatchedRequestsForDonor('A+', 'SomeCityThatIsNeverQueried');

        expect(where).toHaveBeenCalledWith('bloodType', 'in', getCompatibleBloodTypes('A+'));
        expect(where).toHaveBeenCalledWith('status', '==', 'Open');
        expect(where).not.toHaveBeenCalledWith('city', '==', expect.anything());
    });
});
