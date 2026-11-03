import { describe, it, expect, vi } from 'vitest';

vi.mock('./firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn() }));

import { buildPublicSnapshot, BLOOD_TYPES } from './publicStats';

const NOW = new Date('2026-11-03T12:00:00Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

describe('buildPublicSnapshot', () => {
    it('never leaks PHI or private request fields', () => {
        const snap = buildPublicSnapshot({
            now: NOW,
            activeRequests: [{
                status: 'Open', bloodType: 'O-', units: 2, hospital: 'Hôpital Test', city: 'Douala',
                requestedAt: hoursAgo(1), patientName: 'Jane Doe', diagnosis: 'PPH',
                checkInToken: 'SECRET', contactPhone: '+237600000000', notes: 'bed 4',
            }],
        });
        const json = JSON.stringify(snap);
        ['Jane Doe', 'PPH', 'SECRET', '+237600000000', 'bed 4'].forEach(s => expect(json).not.toContain(s));
        expect(snap.activeNeeds[0]).toEqual({
            bloodType: 'O-', units: 2, component: 'Whole Blood', hospital: 'Hôpital Test',
            city: 'Douala', urgency: 'routine', requestedAt: hoursAgo(1),
        });
    });

    it('counts only verified, active hospitals and non-suspended donors', () => {
        const snap = buildPublicSnapshot({
            now: NOW,
            hospitals: [
                { name: 'A', city: 'Douala', isVerified: true },
                { name: 'B', city: 'douala', isVerified: true },
                { name: 'C', city: 'Buea', isVerified: true, isActive: false },
                { name: 'D', city: 'Yaoundé', isVerified: false },
            ],
            donors: [{}, {}, { isSuspended: true }],
        });
        expect(snap.hospitalCount).toBe(2);
        expect(snap.cityCount).toBe(1);
        expect(snap.donorCount).toBe(2);
        expect(snap.hospitals.map(h => h.name)).toEqual(['A', 'B']);
    });

    it('shows only fresh, still-seeking needs and aggregates demand by blood type', () => {
        const snap = buildPublicSnapshot({
            now: NOW,
            activeRequests: [
                { status: 'Open', bloodType: 'A+', units: 3, requestedAt: hoursAgo(2), urgency: 'Critical' },
                { status: 'Matching', type: 'A+', units: 1, requestedAt: hoursAgo(5) },
                { status: 'Donor Assigned', bloodType: 'B-', units: 1, requestedAt: hoursAgo(1) },
                { status: 'Open', bloodType: 'O+', units: 1, requestedAt: hoursAgo(100) },
            ],
        });
        expect(snap.openNeedCount).toBe(2);
        expect(snap.inFlightCount).toBe(4);
        expect(snap.demandByType['A+']).toBe(4);
        expect(snap.demandByType['B-']).toBe(0);
        expect(snap.activeNeeds[0].urgency).toBe('critical');
        expect(Object.keys(snap.demandByType)).toEqual(BLOOD_TYPES);
    });

    it('publishes only active/planned campaigns and contains no undefined values', () => {
        const snap = buildPublicSnapshot({
            now: NOW,
            campaigns: [
                { id: 'c1', title: 'Campus Drive', status: 'active', startDate: '2026-11-10', participants: [{}, {}] },
                { id: 'c2', title: 'Old', status: 'completed' },
                { id: 'c3', title: '<b>Faith</b> Drive', status: 'planning', startDate: '2026-11-05' },
            ],
            resolvedRequests: [{ status: 'Resolved' }, { status: 'Cancelled' }],
        });
        expect(snap.campaigns.map(c => c.id)).toEqual(['c3', 'c1']);
        expect(snap.campaigns[0].title).toBe('Faith Drive');
        expect(snap.campaigns[1].partnerCount).toBe(2);
        expect(snap.fulfilledCount).toBe(1);
        expect(JSON.stringify(snap)).not.toContain('undefined');
        const hasUndefined = (o) => Object.values(o).some(v => v === undefined || (v && typeof v === 'object' && hasUndefined(v)));
        expect(hasUndefined(snap)).toBe(false);
    });
});

