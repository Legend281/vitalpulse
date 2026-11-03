// ============================================================================
// PUBLIC NETWORK SNAPSHOT (public_stats/overview)
//
// The public homepage is visited by anonymous users, and every collection that holds
// the real numbers (users, requests, campaigns) is — correctly — locked to signed-in,
// role-provisioned callers. Opening those collections to the public would leak PHI
// (requests carry patientName / diagnosis / checkInToken) and the whole user directory.
//
// Instead, a privileged session (system admin) publishes ONE aggregate document that
// contains only whitelisted, non-identifying fields. The homepage reads that single
// document (1 read per visit). Firestore rules make it world-readable and admin-writable.
//
// Every field below is explicitly whitelisted — never spread a source document in here.
// ============================================================================

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

export const PUBLIC_STATS_COLLECTION = 'public_stats';
export const PUBLIC_STATS_DOC_ID = 'overview';

export const BLOOD_TYPES = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

// Requests still waiting for a donor — what the public "needed now" board shows.
const SEEKING_STATUSES = ['Open', 'Matching'];
// Statuses that mean the request is still being worked on (seeking or in progress).
const IN_FLIGHT_STATUSES = ['Open', 'Matching', 'Donor Assigned', 'Donor En Route', 'Checked In', 'Donation Complete', 'Lab Cleared', 'Issued'];
// A blood need older than this is not shown as "needed now" on a public page, even if the
// hospital never closed it — stale emergencies erode trust faster than an empty board.
const NEED_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const PUBLIC_CAMPAIGN_STATUSES = ['active', 'planning'];

function str(value, max = 120) {
    if (typeof value !== 'string') return null;
    const clean = value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value?.toDate === 'function') return value.toDate().getTime();
    if (typeof value === 'object' && typeof value.seconds === 'number') return value.seconds * 1000;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
}

function normalizeBloodType(value) {
    if (typeof value !== 'string') return null;
    const t = value.trim().toUpperCase().replace('−', '-');
    return BLOOD_TYPES.includes(t) ? t : null;
}

function normalizeUrgency(r) {
    const u = String(r.urgency || '').toLowerCase();
    if (u.includes('critical') || u.includes('immediate') || u.includes('emergency')) return 'critical';
    if (u.includes('urgent') || r.isEmergency === true) return 'urgent';
    return 'routine';
}

function isPublicHospital(h) {
    return h && h.isVerified === true && h.isActive !== false && h.rejected !== true && h.isSuspended !== true;
}

/**
 * Pure: turns raw admin-visible collections into the public, PHI-free snapshot.
 * Exported separately from the Firestore write so it can be unit-tested.
 */
export function buildPublicSnapshot({
    hospitals = [],
    donors = [],
    activeRequests = [],
    resolvedRequests = [],
    campaigns = [],
    now = Date.now(),
} = {}) {
    const verified = hospitals.filter(isPublicHospital);
    const hospitalDirectory = verified
        .map(h => ({ name: str(h.name, 80), city: str(h.city, 40) }))
        .filter(h => h.name)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 24);

    const cities = new Set(
        verified.map(h => str(h.city, 40)).filter(Boolean).map(c => c.toLowerCase())
    );

    const activeDonors = donors.filter(d => d && d.isSuspended !== true && d.isActive !== false);

    const inFlight = activeRequests.filter(r => r && IN_FLIGHT_STATUSES.includes(r.status));
    const seeking = inFlight
        .filter(r => SEEKING_STATUSES.includes(r.status))
        .filter(r => {
            const t = toMillis(r.requestedAt || r.timestamp);
            return t > 0 && now - t <= NEED_MAX_AGE_MS;
        })
        .sort((a, b) => toMillis(b.requestedAt || b.timestamp) - toMillis(a.requestedAt || a.timestamp));

    const demandByType = Object.fromEntries(BLOOD_TYPES.map(t => [t, 0]));
    seeking.forEach(r => {
        const t = normalizeBloodType(r.bloodType || r.type);
        if (t) demandByType[t] += Math.max(1, num(r.units, 1));
    });

    const activeNeeds = seeking
        .map(r => ({
            bloodType: normalizeBloodType(r.bloodType || r.type),
            units: Math.max(1, num(r.units, 1)),
            component: str(r.componentType, 40) || 'Whole Blood',
            hospital: str(r.hospital || r.hospitalName, 80),
            city: str(r.city || r.hospitalCity, 40),
            urgency: normalizeUrgency(r),
            requestedAt: new Date(toMillis(r.requestedAt || r.timestamp)).toISOString(),
        }))
        .filter(n => n.bloodType)
        .slice(0, 8);

    const fulfilled = resolvedRequests.filter(r => r && r.status === 'Resolved');

    const publicCampaigns = campaigns
        .filter(c => c && PUBLIC_CAMPAIGN_STATUSES.includes(c.status))
        .filter(c => {
            // Hide drives whose date has clearly passed (allow the whole start day).
            const start = toMillis(c.startDate);
            return !start || start >= now - 24 * 60 * 60 * 1000 || c.status === 'active';
        })
        .sort((a, b) => (toMillis(a.startDate) || Infinity) - (toMillis(b.startDate) || Infinity))
        .slice(0, 6)
        .map(c => ({
            id: str(c.id, 64),
            title: str(c.title, 90) || 'Community blood drive',
            location: str(c.location, 80),
            description: str(c.description, 180),
            startDate: str(c.startDate, 32),
            status: c.status,
            targetUnits: num(c.targetUnits),
            unitsCollected: num(c.unitsCollected),
            partnerCount: num(c.participantCount ?? (Array.isArray(c.participants) ? c.participants.length : 0)),
        }));

    return {
        version: 1,
        donorCount: activeDonors.length,
        hospitalCount: verified.length,
        cityCount: cities.size,
        openNeedCount: seeking.length,
        inFlightCount: inFlight.length,
        fulfilledCount: fulfilled.length,
        campaignCount: publicCampaigns.length,
        demandByType,
        activeNeeds,
        hospitals: hospitalDirectory,
        campaigns: publicCampaigns,
        updatedAt: new Date(now).toISOString(),
    };
}

/** Admin-only write (enforced by Firestore rules). Never throws — the dashboard must not break. */
export async function publishPublicSnapshot(sources) {
    try {
        const snapshot = buildPublicSnapshot(sources);
        await setDoc(doc(db, PUBLIC_STATS_COLLECTION, PUBLIC_STATS_DOC_ID), snapshot);
        return snapshot;
    } catch (e) {
        console.warn('[publicStats] Could not publish public snapshot:', e?.message || e);
        return null;
    }
}

/** World-readable. Returns null when missing / unreadable so the page can fall back honestly. */
export async function fetchPublicSnapshot() {
    try {
        const snap = await getDoc(doc(db, PUBLIC_STATS_COLLECTION, PUBLIC_STATS_DOC_ID));
        return snap.exists() ? snap.data() : null;
    } catch (e) {
        console.warn('[publicStats] Public snapshot unavailable:', e?.message || e);
        return null;
    }
}

