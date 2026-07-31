import {
    collection,
    addDoc,
    getDocs,
    doc,
    getDoc,
    updateDoc,
    setDoc,
    deleteDoc,
query,
where,
orderBy,
limit,
startAfter,
onSnapshot,
runTransaction
} from "firebase/firestore";
import { db } from './firebase';
import { getCurrentUser } from './auth';

// Input sanitization — strips HTML tags and trims whitespace for string fields
// stored in Firestore. Prevents stored XSS from user-supplied text.
export function sanitizeString(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/<[^>]*>/g, '').trim();
}

export function sanitizeFields(obj, ...fields) {
    const clean = { ...obj };
    for (const f of fields) {
        if (typeof clean[f] === 'string') clean[f] = sanitizeString(clean[f]);
    }
    return clean;
}

// Admin Activity Logging
export async function logActivity(title, description, type, actor = null) {
    try {
        await addDoc(collection(db, 'activity_logs'), {
            title,
            description,
            type,
            actor, // admin name/email who performed the action
            timestamp: new Date().toISOString()
        });
    } catch(e) {
        console.error("Failed to log activity", e);
    }
}

// Immutable Audit Trail (`audit_logs`)
export async function logAuditTrail(eventType, details, metadata = {}) {
    try {
        const currentUser = getCurrentUser();
        await addDoc(collection(db, 'audit_logs'), {
            eventType,
            details,
            actorId: currentUser?.uid || 'system',
            actorName: currentUser?.name || currentUser?.email || 'System Engine',
            actorRole: currentUser?.role || 'system',
            hospital: metadata.hospital || currentUser?.name || null,
            targetId: metadata.targetId || null,
            previousState: metadata.previousState || null,
            newState: metadata.newState || null,
            timestamp: new Date().toISOString(),
            immutable: true
        });
    } catch (e) {
        console.error("[logAuditTrail] Failed to record audit entry:", e);
    }
}

export async function fetchAuditLogs(hospitalName = null, limitCount = 50) {
    try {
        const q = query(
            collection(db, 'audit_logs'),
            orderBy('timestamp', 'desc'),
            limit(limitCount)
        );
        const snapshot = await getDocs(q);
        let logs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        if (hospitalName) {
            logs = logs.filter(l => l.hospital === hospitalName || l.details?.includes(hospitalName));
        }
        return logs;
    } catch (e) {
        console.error("[fetchAuditLogs] Error:", e);
        return [];
    }
}

// Pass hospitalName to scope results to that hospital's own entries (matched by
// description, since log docs don't carry a structured hospital field). Admin
// callers should omit hospitalName to see the full system-wide feed.
export async function fetchRecentLogs(limitCount = 5, hospitalName = null) {
    try {
        const q = query(
            collection(db, 'activity_logs'),
            orderBy('timestamp', 'desc'),
            limit(hospitalName ? 200 : limitCount)
        );
        const snapshot = await getDocs(q);
        let logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (hospitalName) {
            logs = logs.filter(log => log.description?.includes(hospitalName)).slice(0, limitCount);
        }
        return logs;
    } catch (e) {
        console.error('fetchRecentLogs failed:', e);
        return [];
    }
}

export async function clearAllActivityLogs() {
    const snapshot = await getDocs(collection(db, 'activity_logs'));
    const deletions = snapshot.docs.map(d => deleteDoc(doc(db, 'activity_logs', d.id)));
    await Promise.all(deletions);
}

// Hospital-scoped clear: only deletes log entries that mention this hospital,
// so a hospital account can't wipe the entire system's audit trail.
export async function clearHospitalActivityLogs(hospitalName) {
    const snapshot = await getDocs(collection(db, 'activity_logs'));
    const deletions = snapshot.docs
        .filter(d => d.data().description?.includes(hospitalName))
        .map(d => deleteDoc(doc(db, 'activity_logs', d.id)));
    await Promise.all(deletions);
}

export async function deleteActivityLog(logId) {
    await deleteDoc(doc(db, 'activity_logs', logId));
}

// Blood Requests
// Canonical lifecycle statuses for a 'requests' doc — every status this collection can hold
// belongs to exactly one set, so admin stats always reconcile (Total = Active + Closed).
// ACTIVE = in-flight lifecycle (Open through blood being issued to the patient).
// CLOSED = terminal: resolved, cancelled, or failed at the lab.
// Must stay in sync with every updateDoc/transaction.update on this collection's status field.
export const REQUEST_ACTIVE_STATUSES = ['Open', 'Matching', 'Donor Assigned', 'Donor En Route', 'Checked In', 'Donation Complete', 'Lab Cleared', 'Issued'];
export const REQUEST_CLOSED_STATUSES = ['Resolved', 'Cancelled', 'Lab Rejected'];

export async function fetchActiveRequests() {
    const q = query(
        collection(db, 'requests'),
        where('status', 'in', REQUEST_ACTIVE_STATUSES)
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return results.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
}

export async function createEmergencyRequest(requestData) {
    const docRef = await addDoc(collection(db, 'requests'), {
        ...requestData,
        status: 'Open',
        isEmergency: true,
        requestedAt: new Date().toISOString()
    });

    const result = { id: docRef.id, ...requestData };

    // Auto-match: find eligible donors and notify them
    const settings = await fetchSystemSettings().catch(() => ({ autoMatchDonors: true }));
    if (settings.autoMatchDonors !== false) {
        autoMatchDonors(docRef.id, requestData).catch(err =>
            console.warn('Auto-match failed (non-blocking):', err)
        );
    }

    await logActivity(
        'Emergency Request Created',
        `Emergency: ${requestData.bloodType || requestData.type || '?'} needed at ${requestData.hospital || 'Unknown'} (${requestData.city || 'Unknown city'})`,
        'error'
    );

    return result;
}

export async function fetchMatchedRequestsForDonor(bloodType, location) {
    // Read cap so one donor's dashboard can never pull an unbounded number of Open requests
    // no matter how large the deployment gets. Compatibility + city are computed/filtered
    // client-side below (blood-type compatibility isn't a simple equality query), so we take a
    // generous-but-bounded window of the newest Open requests and refine it here.
    const q = query(
        collection(db, 'requests'),
        where('status', '==', 'Open'),
        limit(200)
    );
    const snapshot = await getDocs(q);
    let results = snapshot.docs.map(doc => {
        const data = doc.data();
        // Medical Privacy Enforcement: Strip internal patient fields from donor view payload
        const { patientName, patientId, ward, diagnosis, requestingDoctor, ...sanitized } = data;
        return { id: doc.id, ...sanitized };
    });
    // Compatibility depends on which component a request needs (plasma compatibility is
    // reversed from whole blood), so this has to be checked per-request rather than with one
    // static compatible-types list for every request.
    results = results.filter(r => {
        const needed = r.bloodType || r.type;
        if (!needed) return false;
        return getCompatibleDonorTypes(needed, r.componentType || 'Whole Blood').includes(bloodType);
    });
    if (location) {
        // Show requests in the donor's own city, plus system-wide/national broadcasts
        results = results.filter(r =>
            r.city === location || r.city === 'National' || r.hospital === 'Central Command'
        );
    }
    // Most-urgent-first, then most-recent — so a donor waking up to a full feed sees the
    // requests that matter most at the top. Display pagination (5 at a time) happens in the UI.
    const urgencyRank = (r) => {
        const u = (r.urgency || '').toLowerCase();
        return u === 'critical' ? 0 : u === 'urgent' ? 1 : 2;
    };
    return results
        .sort((a, b) => (urgencyRank(a) - urgencyRank(b)) || (new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0)))
        .slice(0, 50);
}

export async function acceptRequest(requestId, donorId, screeningData = {}) {
    const reqDoc = doc(db, 'requests', requestId);

    // Lock check: check if donor has any other request currently assigned or en route
    const activeReqsQuery = query(
        collection(db, 'requests'),
        where('matchedDonor', '==', donorId),
        where('status', 'in', ['Donor Assigned', 'Donor En Route'])
    );
    const activeSnap = await getDocs(activeReqsQuery);
    const activePublicQuery = query(
        collection(db, 'public_requests'),
        where('matchedDonor', '==', donorId),
        where('status', 'in', ['Donor Assigned', 'Donor En Route'])
    );
    const activePublicSnap = await getDocs(activePublicQuery);
    if (!activeSnap.empty || !activePublicSnap.empty) {
        throw new Error('You already have an active donation request in progress. Please complete or cancel your current commitment before accepting another.');
    }

    // 56-Day Medical Deferral Lock: prevent accepting requests before the mandatory wait period
    try {
        const donorRef = doc(db, 'users', donorId);
        const donorSnap = await getDoc(donorRef);
        if (donorSnap.exists()) {
            const donorData = donorSnap.data();
            const lastDate = donorData.lastDonationDate || donorData.lastDonatedAt;
            if (lastDate) {
                const daysAgo = (new Date().getTime() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24);
                if (daysAgo < 56) {
                    throw new Error(`WHO medical deferral: You last donated ${Math.round(daysAgo)} days ago. A minimum of 56 days is required between whole blood donations for your safety.`);
                }
            }
        }
    } catch (e) {
        if (e.message?.includes('WHO medical deferral')) throw e;
    }

    const checkInToken = 'VP-' + Math.floor(1000 + Math.random() * 9000);

    // Transaction guards against two donors accepting the same request at once —
    // without it, the second write silently overwrites the first donor's match.
    const reqData = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(reqDoc);
        if (!snapshot.exists()) throw new Error('Request not found');
        const data = snapshot.data();
        if (data.status !== 'Open') {
            throw new Error('This request has already been accepted by another donor.');
        }
        transaction.update(reqDoc, {
            status: 'Donor Assigned',
            matchedDonor: donorId,
            matchedAt: new Date().toISOString(),
            checkInToken,
            donorScreeningPassed: screeningData.screeningPassed !== false
        });
        return data;
    });

    await logActivity(
        'Donor Assigned',
        `Donor assigned to request #${requestId.slice(0, 8)} — ${reqData.bloodType || reqData.type || '?'} needed at ${reqData.hospital || 'Unknown'} (Token: ${checkInToken})`,
        'success'
    );

    await logAuditTrail(
        'DONOR_ASSIGNED',
        `Donor ${donorId} accepted request #${requestId.slice(0, 8)} at ${reqData.hospital}. Check-in token: ${checkInToken}`,
        { hospital: reqData.hospital, targetId: requestId, previousState: 'Open', newState: 'Donor Assigned' }
    );

    // Notify the hospital
    const hospitalName = reqData.hospital || '';
    if (hospitalName) {
        const hospitalsQuery = query(
            collection(db, 'users'),
            where('name', '==', hospitalName),
            where('role', '==', 'hospital'),
            limit(5)
        );
        const hospitalSnap = await getDocs(hospitalsQuery);
        for (const hDoc of hospitalSnap.docs) {
            const hospital = hDoc.data();
            const msg = `[VitalPulse] A donor has accepted your ${reqData.bloodType || reqData.type || 'blood'} request (#${requestId.slice(0, 8).toUpperCase()}). They are on their way.`;
            if (hospital.phone && shouldNotifyByType(hospital, 'donor')) {
                // Respect the hospital's own SMS/WhatsApp toggles (Settings) — SMS defaults on,
                // WhatsApp defaults off, matching the checked state of those toggles in the UI.
                if (hospital.notifSms !== false) await sendSmsNotification(hospital.phone, msg).catch(() => {});
                if (hospital.notifWhatsapp === true) await sendWhatsAppNotification(hospital.phone, msg).catch(() => {});
            }
            await addHospitalNotification(hDoc.id, 'Donor Assigned', msg, 'success', 'requests');
        }
    }
}

export async function donorSetEnRoute(requestId, donorId) {
    let reqDoc = doc(db, 'requests', requestId);
    let sourceCollection = 'requests';

    const result = await runTransaction(db, async (transaction) => {
        let snapshot = await transaction.get(reqDoc);

        if (!snapshot.exists()) {
            reqDoc = doc(db, 'public_requests', requestId);
            sourceCollection = 'public_requests';
            snapshot = await transaction.get(reqDoc);
        }

        if (!snapshot.exists()) throw new Error('Request not found');
        const reqData = snapshot.data();

        if (reqData.status !== 'Donor Assigned') {
            throw new Error('Request is not in the correct status for this action.');
        }

        if (reqData.matchedDonor && reqData.matchedDonor !== donorId) {
            throw new Error('You are not the assigned donor for this request.');
        }

        await transaction.update(reqDoc, {
            status: 'Donor En Route',
            enRouteAt: new Date().toISOString()
        });

        return reqData;
    });

    await logActivity(
        'Donor En Route',
        `Donor heading to hospital for request #${requestId.slice(0, 8)} — ${result.bloodType || result.type || '?'}`,
        'success'
    );

    // Notify the hospital
    const hospitalName = result.hospital || result.hospitalName || '';
    if (hospitalName) {
        const hospitalsQuery = query(
            collection(db, 'users'),
            where('name', '==', hospitalName),
            where('role', '==', 'hospital'),
            limit(5)
        );
        const hospitalSnap = await getDocs(hospitalsQuery);
        for (const hDoc of hospitalSnap.docs) {
            const hospital = hDoc.data();
            const msg = `[VitalPulse] 🚑 A donor is en route to your facility for request #${requestId.slice(0, 8).toUpperCase()} (${result.bloodType || result.type || '?'}). Expected arrival shortly.`;
            if (hospital.phone && shouldNotifyByType(hospital, 'donor')) {
                if (hospital.notifSms !== false) await sendSmsNotification(hospital.phone, msg).catch(() => {});
                if (hospital.notifWhatsapp === true) await sendWhatsAppNotification(hospital.phone, msg).catch(() => {});
            }
            await addHospitalNotification(hDoc.id, 'Donor En Route', msg, 'info', 'requests');
        }
    }
}

// Live position updates while a donor is "Donor En Route" — written directly onto the
// request doc itself (not the donor's own profile), so a hospital watching one request
// never has to cross-reference the donor's general lat/lng. `isPublic` tells us which
// collection to write to; the caller already knows this from the request it's tracking,
// so this never needs to guess/read first the way donorSetEnRoute does.
export async function updateDonorLiveLocation(requestId, isPublic, lat, lng) {
    try {
        const reqRef = doc(db, isPublic ? 'public_requests' : 'requests', requestId);
        await updateDoc(reqRef, {
            donorLat: lat,
            donorLng: lng,
            donorLocationUpdatedAt: new Date().toISOString()
        });
    } catch (e) {
        console.warn('Failed to update donor live location:', e);
    }
}

export async function donorCancelAssignedRequest(requestId, donorId) {
    let reqDoc = doc(db, 'requests', requestId);
    let snapshot = await getDoc(reqDoc);
    let sourceCollection = 'requests';

    if (!snapshot.exists()) {
        reqDoc = doc(db, 'public_requests', requestId);
        snapshot = await getDoc(reqDoc);
        sourceCollection = 'public_requests';
    }

    if (!snapshot.exists()) throw new Error('Request not found');
    const reqData = snapshot.data();

    // Identity verification: only the assigned donor can cancel
    if (reqData.matchedDonor && reqData.matchedDonor !== donorId) {
        throw new Error('You are not the assigned donor for this request.');
    }

    const resetStatus = sourceCollection === 'public_requests' ? 'Broadcasting' : 'Open';
    await updateDoc(reqDoc, {
        status: resetStatus,
        matchedDonor: null,
        matchedAt: null,
        checkInToken: null,
        enRouteAt: null,
        donorScreeningPassed: null
    });

    await logActivity(
        'Donor Withdrew',
        `Donor withdrew from request #${requestId.slice(0, 8)} (${reqData.bloodType || reqData.type || '?'}) at ${reqData.hospital || reqData.hospitalName || 'Unknown'}`,
        'warning'
    );

    // Notify the hospital
    const hospitalName = reqData.hospital || reqData.hospitalName || '';
    if (hospitalName) {
        const hospitalsQuery = query(
            collection(db, 'users'),
            where('name', '==', hospitalName),
            where('role', '==', 'hospital'),
            limit(5)
        );
        const hospitalSnap = await getDocs(hospitalsQuery);
        for (const hDoc of hospitalSnap.docs) {
            await addHospitalNotification(hDoc.id, 'Donor Withdrew', `The assigned donor for request #${requestId.slice(0, 8).toUpperCase()} (${reqData.bloodType || reqData.type || '?'}) has withdrawn. The request is now open again.`, 'warning', 'requests');
        }
    }
}

// ============================================
// DONOR NOTIFICATION SYSTEM (in-app)
// ============================================

export async function addDonorNotification(donorId, title, message, type = 'info') {
    try {
        await addDoc(collection(db, 'donor_notifications'), {
            donorId,
            title,
            message,
            type,
            read: false,
            createdAt: new Date().toISOString()
        });
    } catch (e) {
        console.warn('Failed to add donor notification:', e);
    }
}

export async function fetchDonorNotifications(donorId, max = 20) {
    // Sorted/limited client-side to avoid requiring a composite index for donorId + createdAt.
    const q = query(
        collection(db, 'donor_notifications'),
        where('donorId', '==', donorId)
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return results.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, max);
}

export async function fetchUnreadNotificationCount(donorId) {
    const q = query(
        collection(db, 'donor_notifications'),
        where('donorId', '==', donorId),
        where('read', '==', false)
    );
    const snapshot = await getDocs(q);
    return snapshot.size;
}

export async function markNotificationRead(notifId) {
    const notifDoc = doc(db, 'donor_notifications', notifId);
    await updateDoc(notifDoc, { read: true });
}

export async function markAllNotificationsRead(donorId) {
    const q = query(
        collection(db, 'donor_notifications'),
        where('donorId', '==', donorId),
        where('read', '==', false)
    );
    const snapshot = await getDocs(q);
    const updates = snapshot.docs.map(d => updateDoc(doc(db, 'donor_notifications', d.id), { read: true }));
    await Promise.all(updates);
}

// ============================================
// HOSPITAL NOTIFICATION SYSTEM
// ============================================

export async function addHospitalNotification(hospitalId, title, message, type = 'info', view = null) {
    try {
        await addDoc(collection(db, 'hospital_notifications'), {
            hospitalId,
            title,
            message,
            type,
            view: view || null,
            read: false,
            createdAt: new Date().toISOString()
        });
    } catch (e) {
        console.warn('Failed to add hospital notification:', e);
    }
}

export async function fetchHospitalNotifications(hospitalId, max = 20) {
    // Sorted/limited client-side to avoid requiring a composite index for hospitalId + createdAt.
    const q = query(
        collection(db, 'hospital_notifications'),
        where('hospitalId', '==', hospitalId)
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return results.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, max);
}

export async function fetchUnreadHospitalNotificationCount(hospitalId) {
    const q = query(
        collection(db, 'hospital_notifications'),
        where('hospitalId', '==', hospitalId),
        where('read', '==', false)
    );
    const snapshot = await getDocs(q);
    return snapshot.size;
}

export async function markHospitalNotificationRead(notifId) {
    const notifDoc = doc(db, 'hospital_notifications', notifId);
    await updateDoc(notifDoc, { read: true });
}

export async function markAllHospitalNotificationsRead(hospitalId) {
    const q = query(
        collection(db, 'hospital_notifications'),
        where('hospitalId', '==', hospitalId),
        where('read', '==', false)
    );
    const snapshot = await getDocs(q);
    const updates = snapshot.docs.map(d => updateDoc(doc(db, 'hospital_notifications', d.id), { read: true }));
    await Promise.all(updates);
}

export function subscribeToHospitalNotifications(hospitalId, callback) {
    const q = query(
        collection(db, 'hospital_notifications'),
        where('hospitalId', '==', hospitalId)
    );
    return onSnapshot(q, (snapshot) => {
        const notifications = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        notifications.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        callback(notifications);
    }, (error) => {
        console.warn('Hospital notification subscription error:', error);
    });
}

export async function clearAllHospitalNotifications(hospitalId) {
    const q = query(
        collection(db, 'hospital_notifications'),
        where('hospitalId', '==', hospitalId)
    );
    const snapshot = await getDocs(q);
    const deletes = snapshot.docs.map(d => deleteDoc(doc(db, 'hospital_notifications', d.id)));
    await Promise.all(deletes);
}

// ============================================
// ADMIN NOTIFICATION SYSTEM
// ============================================

export async function createAdminNotification(title, message, type = 'info', metadata = null, view = null) {
    try {
        await addDoc(collection(db, 'admin_notifications'), {
            title,
            message,
            type,
            metadata,
            view: view || null,
            read: false,
            createdAt: new Date().toISOString()
        });
    } catch (e) {
        console.warn('Failed to create admin notification:', e);
    }
}

export function subscribeToAdminNotifications(callback) {
    const q = query(
        collection(db, 'admin_notifications'),
        orderBy('createdAt', 'desc'),
        limit(50)
    );
    return onSnapshot(q, (snapshot) => {
        const notifications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        callback(notifications);
    }, (error) => {
        console.warn('Admin notification subscription error:', error);
    });
}

export async function markAdminNotificationRead(notifId) {
    try {
        await updateDoc(doc(db, 'admin_notifications', notifId), { read: true });
    } catch (e) {
        console.warn('Failed to mark admin notification read:', e);
    }
}

export async function markAllAdminNotificationsRead() {
    try {
        const q = query(
            collection(db, 'admin_notifications'),
            where('read', '==', false)
        );
        const snapshot = await getDocs(q);
        const updates = snapshot.docs.map(d => updateDoc(doc(db, 'admin_notifications', d.id), { read: true }));
        await Promise.all(updates);
    } catch (e) {
        console.warn('Failed to mark all admin notifications read:', e);
    }
}

export async function clearAllAdminNotifications() {
    try {
        const snapshot = await getDocs(collection(db, 'admin_notifications'));
        const deletions = snapshot.docs.map(d => deleteDoc(doc(db, 'admin_notifications', d.id)));
        await Promise.all(deletions);
    } catch (e) {
        console.warn('Failed to clear admin notifications:', e);
    }
}

export async function deleteAdminNotification(notifId) {
    try {
        await deleteDoc(doc(db, 'admin_notifications', notifId));
    } catch (e) {
        console.warn('Failed to delete admin notification:', e);
    }
}

export async function getUnreadAdminNotificationCount() {
    try {
        const q = query(
            collection(db, 'admin_notifications'),
            where('read', '==', false)
        );
        const snapshot = await getDocs(q);
        return snapshot.size;
    } catch (e) {
        console.warn('Failed to get unread admin notification count:', e);
        return 0;
    }
}

// ============================================
// AUTO-MATCHING ENGINE
// ============================================

// CITY COORDINATES FALLBACK TABLE (Cameroon & Regional Hubs)
export const CITY_COORDINATES = {
    'yaounde': { lat: 3.8480, lon: 11.5021 },
    'yaoundé': { lat: 3.8480, lon: 11.5021 },
    'douala': { lat: 4.0511, lon: 9.7679 },
    'bamenda': { lat: 5.9631, lon: 10.1591 },
    'buea': { lat: 4.1560, lon: 9.2435 },
    'limbe': { lat: 4.0167, lon: 9.2167 },
    'bafoussam': { lat: 5.4778, lon: 10.4178 },
    'garoua': { lat: 9.3012, lon: 13.3970 },
    'maroua': { lat: 10.5913, lon: 14.3159 },
    'kribi': { lat: 2.9372, lon: 9.9077 },
    'bertoua': { lat: 4.5772, lon: 13.6847 },
    'ngaoundere': { lat: 7.3167, lon: 13.5833 },
    'ebolowa': { lat: 2.9167, lon: 11.1500 }
};

export function getCoordinatesForLocation(locName, lat, lon) {
    if (lat && lon) {
        const la = parseFloat(lat), lo = parseFloat(lon);
        if (isNaN(la) || isNaN(lo)) return null;
        if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
        return { lat: la, lon: lo };
    }
    if (!locName) return null;
    const cleanName = locName.trim().toLowerCase();
    return CITY_COORDINATES[cleanName] || null;
}

export function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return null;
    if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return null;
    if (Math.abs(lat1) > 90 || Math.abs(lon1) > 180 || Math.abs(lat2) > 90 || Math.abs(lon2) > 180) return null;
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10;
}

export async function autoMatchDonors(requestId, requestData) {
    const bloodTypeNeeded = requestData.bloodType || requestData.type;
    const location = requestData.city || requestData.hospitalCity;
    const isSystemWide = location === 'National' || requestData.hospital === 'Central Command' || requestData.systemWide === true;

    if (!bloodTypeNeeded) {
        console.warn('Auto-match: missing bloodType, skipping');
        return [];
    }

    if (isSystemWide) {
        const settings = await fetchSystemSettings().catch(() => ({ emergencyBroadcastEnabled: true }));
        if (settings.emergencyBroadcastEnabled === false) {
            await logActivity(
                'Broadcast Blocked',
                `System-wide broadcast for request #${requestId.slice(0, 8)} (${bloodTypeNeeded}) skipped — Emergency Broadcast is disabled in system settings.`,
                'warning'
            );
            return [];
        }
    }

    const componentType = requestData.componentType || 'Whole Blood';
    const compatibleTypes = getCompatibleDonorTypes(bloodTypeNeeded, componentType);
    const maxRadiusKm = (requestData.urgency === 'critical' || requestData.isEmergency) ? 50 : 25;

    // Resolve hospital coordinates (or fallback to city coords)
    const hospCoords = getCoordinatesForLocation(location, requestData.lat, requestData.lon);

    // Fetch candidate compatible available donors
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'donor'),
        where('bloodType', 'in', compatibleTypes),
        where('isAvailable', '==', true),
        limit(100)
    );

    const snapshot = await getDocs(q);
    const displayLocation = isSystemWide ? 'System-wide' : location;
    let matchingDonors = [];

    for (const docSnap of snapshot.docs) {
        const donor = { id: docSnap.id, ...docSnap.data() };
        if (donor.isSuspended) continue;

        // Geo-Radius matching: check Haversine distance
        // Donor GPS coords are stored as lat/lng (see donor-dashboard.js's
        // enableLiveGpsLocation), not lat/lon — pass donor.lng here, not donor.lon,
        // or this always falls through to the city-centroid fallback.
        const donorCoords = getCoordinatesForLocation(donor.city, donor.lat, donor.lng);
        let dist = null;
        if (hospCoords && donorCoords) {
            dist = calculateDistanceKm(hospCoords.lat, hospCoords.lon, donorCoords.lat, donorCoords.lon);
        }

        const isExactCity = location && donor.city && donor.city.trim().toLowerCase() === location.trim().toLowerCase();
        const isWithinRadius = dist !== null && dist <= maxRadiusKm;

        // Include donor if system-wide, exact city match, OR within geographic radius (25km/50km)
        if (isSystemWide || isExactCity || isWithinRadius) {
            donor.matchedDistanceKm = dist;
            matchingDonors.push(donor);
        }
    }

    // Trusted, proven donors are notified first — donationCount is refreshed on the user doc
    // after every completed donation (see recordDonationIntake), so this is just a cheap sort
    // over fields already fetched above, not an extra query per candidate.
    matchingDonors.sort((a, b) => (b.donationCount || 0) - (a.donationCount || 0));

    for (const donor of matchingDonors) {
        const dist = donor.matchedDistanceKm;
        const distanceLabel = dist !== null ? ` (~${dist} km away)` : '';
        const msg = `[VitalPulse] 🆘 Emergency blood request! ${bloodTypeNeeded} (${componentType}) needed${displayLocation ? ' at ' + displayLocation : ''}${distanceLabel}. Your compatibility matches. Please respond in app.`;
        if (donor.phone) {
            if (donor.notifSms !== false) await sendSmsNotification(donor.phone, msg).catch(() => {});
            if (donor.notifWhatsapp === true) await sendWhatsAppNotification(donor.phone, msg).catch(() => {});
        }
        await addDonorNotification(
            donor.id,
            'Emergency Blood Request',
            `🆘 ${bloodTypeNeeded} (${componentType}) needed urgently${displayLocation ? ' at ' + displayLocation : ''}${distanceLabel}. ${requestData.urgency ? 'Urgency: ' + requestData.urgency : ''}`,
            'error'
        );
    }

    if (matchingDonors.length > 0) {
        await updateDoc(doc(db, 'requests', requestId), {
            matchingDonorsNotified: matchingDonors.map(d => d.id),
            matchingDonorsCount: matchingDonors.length,
            notifiedAt: new Date().toISOString()
        });

        await logActivity(
            'Donors Notified',
            `${matchingDonors.length} compatible donor(s) alerted in-app (SMS/WhatsApp queued as tap-to-send links) for request #${requestId.slice(0, 8)} (${bloodTypeNeeded})${displayLocation ? ' — ' + displayLocation : ''}`,
            'info'
        );
    }

    return matchingDonors;
}

// Smart Matching Engine
//
// Whole blood / red cells: donor -> the recipient types they can safely give to.
const WHOLE_BLOOD_DONOR_TO_RECIPIENT = {
    'O-':  ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
    'O+':  ['O+', 'A+', 'B+', 'AB+'],
    'A-':  ['A-', 'A+', 'AB-', 'AB+'],
    'A+':  ['A+', 'AB+'],
    'B-':  ['B-', 'B+', 'AB-', 'AB+'],
    'B+':  ['B+', 'AB+'],
    'AB-': ['AB-', 'AB+'],
    'AB+': ['AB+']
};

// Plasma/FFP compatibility is the reverse of whole blood: AB is the universal plasma donor
// (AB plasma carries no anti-A/anti-B antibodies, safe for everyone), O is the universal
// plasma recipient (can accept plasma from any ABO group). Rh doesn't restrict plasma the way
// it does red cells, so +/- donors of the same ABO letter are treated the same here.
const ABO_GROUP = (t) => (t || '').replace(/[+-]$/, '');
const PLASMA_RECIPIENTS_BY_GROUP = {
    'AB': ['AB+', 'AB-', 'A+', 'A-', 'B+', 'B-', 'O+', 'O-'],
    'A':  ['A+', 'A-', 'O+', 'O-'],
    'B':  ['B+', 'B-', 'O+', 'O-'],
    'O':  ['O+', 'O-']
};
const ALL_BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
const PLASMA_DONOR_TO_RECIPIENT = {};
ALL_BLOOD_TYPES.forEach(t => { PLASMA_DONOR_TO_RECIPIENT[t] = PLASMA_RECIPIENTS_BY_GROUP[ABO_GROUP(t)]; });

function isPlasmaComponent(componentType) {
    return componentType === 'Plasma' || componentType === 'FFP';
}

// Inverts a donor->recipients table into recipient->donors, so "who can fulfill a request for
// type X" can be answered directly instead of by re-deriving it from the donor-facing table.
function invertCompatibilityTable(donorToRecipients) {
    const inverse = {};
    ALL_BLOOD_TYPES.forEach(t => { inverse[t] = []; });
    Object.entries(donorToRecipients).forEach(([donorType, recipients]) => {
        recipients.forEach(recipientType => {
            if (!inverse[recipientType]) inverse[recipientType] = [];
            inverse[recipientType].push(donorType);
        });
    });
    return inverse;
}
const WHOLE_BLOOD_RECIPIENT_TO_DONORS = invertCompatibilityTable(WHOLE_BLOOD_DONOR_TO_RECIPIENT);
const PLASMA_RECIPIENT_TO_DONORS = invertCompatibilityTable(PLASMA_DONOR_TO_RECIPIENT);

// Returns blood types a donor with `bloodType` can donate to, for the given component.
// Use this when you have a DONOR and want to know which requests they can fulfill.
export function getCompatibleBloodTypes(bloodType, componentType = 'Whole Blood') {
    const table = isPlasmaComponent(componentType) ? PLASMA_DONOR_TO_RECIPIENT : WHOLE_BLOOD_DONOR_TO_RECIPIENT;
    return table[bloodType] || [bloodType];
}

// Returns the donor blood types that can safely supply a PATIENT who needs `bloodTypeNeeded`.
// This is the correct direction for "who can fulfill this request" — matching engines that
// start from a request's needed type (autoMatchDonors, findMatchingDonors) must use this, not
// getCompatibleBloodTypes, or the direction is backwards (e.g. a request for O- — the most
// restrictive recipient type — would wrongly match donors of every blood type).
export function getCompatibleDonorTypes(bloodTypeNeeded, componentType = 'Whole Blood') {
    const table = isPlasmaComponent(componentType) ? PLASMA_RECIPIENT_TO_DONORS : WHOLE_BLOOD_RECIPIENT_TO_DONORS;
    return table[bloodTypeNeeded] || [bloodTypeNeeded];
}

// Whole Blood 35d, PRBC 42d, Platelets 5d (short-lived), Plasma/FFP frozen ~1yr,
// Cryoprecipitate ~1yr frozen. Used to auto-suggest an expiry date; hospitals can override.
export function getDefaultShelfLifeDays(componentType) {
    const days = {
        'Whole Blood': 35,
        'PRBC': 42,
        'Packed Red Blood Cells': 42,
        'Platelets': 5,
        'Platelet Concentrates': 5,
        'Plasma': 365,
        'FFP': 365,
        'Fresh Frozen Plasma': 365,
        'Cryoprecipitate': 365
    };
    return days[componentType] || 35;
}

export async function findMatchingDonors(bloodTypeNeeded, location, componentType = 'Whole Blood') {
    const compatibleTypes = getCompatibleDonorTypes(bloodTypeNeeded, componentType);
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'donor'),
        where('bloodType', 'in', compatibleTypes),
        where('isAvailable', '==', true),
        where('city', '==', location),
        limit(50)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Hospital verification
export async function fetchPendingHospitals() {
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'hospital'),
        where('isVerified', '==', false)
    );
    const snapshot = await getDocs(q);
    // Filter out rejected ones locally to bypass firestore missing field index
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(h => !h.rejected);
}

export async function fetchAllHospitals() {
    // Safety cap, not a real pagination boundary — well beyond current realistic scale, but
    // keeps one admin page load from ever pulling an unbounded number of documents.
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'hospital'),
        limit(1000)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function fetchHospitalById(hospitalId) {
    const docRef = doc(db, 'users', hospitalId);
    const snapshot = await getDoc(docRef);
    if (snapshot.exists()) {
        return { id: snapshot.id, ...snapshot.data() };
    }
    return null;
}

// Global Operations Audit
export async function fetchAllSystemRequests() {
    const q = query(collection(db, 'requests'), orderBy("requestedAt", "desc"), limit(200));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Every closed request, paginated past the 200-doc cap of fetchAllSystemRequests so the
// admin avg-response stat samples the full history instead of only the newest window.
// No where() clause so it reuses the existing (requestedAt desc) index; closed filtering
// happens client-side against REQUEST_CLOSED_STATUSES.
export async function fetchAllResolvedRequests() {
    const results = [];
    let lastDoc = null;
    while (results.length < 5000) {
        let q = query(collection(db, 'requests'), orderBy("requestedAt", "desc"), limit(500));
        if (lastDoc) q = query(q, startAfter(lastDoc));
        const snap = await getDocs(q);
        if (snap.empty) break;
        const batch = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        results.push(...batch);
        lastDoc = snap.docs[snap.docs.length - 1];
        if (batch.length < 500) break;
    }
    return results.filter(r =>
        REQUEST_CLOSED_STATUSES.includes(r.status) ||
        REQUEST_CLOSED_STATUSES.some(s => s.toLowerCase() === (r.status || '').toLowerCase())
    );
}

// Manual admin override for a request that's stuck (e.g. the matched donor never showed up,
// or it was actually handled outside the app) — there was previously no way to close this out
// short of editing Firestore directly.
export async function adminResolveRequest(requestId, reason, adminName) {
    const reqDoc = doc(db, 'requests', requestId);
    const snapshot = await getDoc(reqDoc);
    if (!snapshot.exists()) throw new Error('Request not found');
    const reqData = snapshot.data();

    await updateDoc(reqDoc, {
        status: 'Resolved',
        resolvedAt: new Date().toISOString(),
        resolvedBy: adminName || 'Admin',
        adminResolutionNote: reason || null
    });

    await logActivity(
        'Request Manually Resolved',
        `Admin marked request #${requestId.slice(0, 8)} (${reqData.bloodType || reqData.type || '?'}) as resolved${reason ? ' — ' + reason : ''}`,
        'warning',
        adminName
    );
    return true;
}

export async function adminCancelRequest(requestId, reason, adminName) {
    const reqDoc = doc(db, 'requests', requestId);
    const snapshot = await getDoc(reqDoc);
    if (!snapshot.exists()) throw new Error('Request not found');
    const reqData = snapshot.data();

    await updateDoc(reqDoc, {
        status: 'Cancelled',
        cancelledAt: new Date().toISOString(),
        cancelledBy: adminName || 'Admin',
        adminCancellationReason: reason || null
    });

    await logActivity(
        'Request Cancelled by Admin',
        `Admin cancelled request #${requestId.slice(0, 8)} (${reqData.bloodType || reqData.type || '?'})${reason ? ' — ' + reason : ''}`,
        'error',
        adminName
    );
    return true;
}

// Donor Management
export async function fetchAllDonors() {
    // Safety cap, not a real pagination boundary — same reasoning as fetchAllHospitals.
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'donor'),
        limit(1000)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function fetchDonorById(donorId) {
    const userDoc = doc(db, 'users', donorId);
    const snapshot = await getDoc(userDoc);
    if (!snapshot.exists()) return null;
    
    const donor = { id: snapshot.id, ...snapshot.data() };
    
    const donationsQ = query(
        collection(db, 'donation_requests'),
        where('donorId', '==', donorId)
    );
    const donationsSnapshot = await getDocs(donationsQ);
    let donations = donationsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    donations = donations.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    donor.donations = donations;
    
    return donor;
}

export async function suspendDonor(userId, userName) {
    const userDoc = doc(db, 'users', userId);
    await updateDoc(userDoc, {
        isSuspended: true,
        isAvailable: false,
        statusChangedAt: new Date().toISOString()
    });
    await logActivity('Donor Suspended', `Donor ${userName || userId} was suspended by an administrator`, 'error', getCurrentUser()?.name || 'Admin');
    logAuditTrail('donor.suspended', `Donor ${userName || userId} suspended by admin`, {
        targetId: userId,
        newState: { isSuspended: true, isAvailable: false }
    });
}

export async function reactivateDonor(userId, userName) {
    const userDoc = doc(db, 'users', userId);
    await updateDoc(userDoc, {
        isSuspended: false,
        isAvailable: true,
        statusChangedAt: new Date().toISOString()
    });
    await logActivity('Donor Reactivated', `Donor ${userName || userId} was reactivated by an administrator`, 'success', getCurrentUser()?.name || 'Admin');
    logAuditTrail('donor.reactivated', `Donor ${userName || userId} reactivated by admin`, {
        targetId: userId,
        newState: { isSuspended: false, isAvailable: true }
    });
}

export async function verifyHospital(hospitalId, hospitalName, verified = true) {
    const userDoc = doc(db, 'users', hospitalId);
    await updateDoc(userDoc, {
        isVerified: verified,
        rejected: verified ? false : undefined,
        verifiedAt: new Date().toISOString()
    });
    await logActivity(
        verified ? 'Hospital Approved' : 'Hospital Verification Revoked',
        `Hospital ${hospitalName || hospitalId} was ${verified ? 'approved by an administrator' : 'removed from the verified network by an administrator'}`,
        verified ? 'success' : 'warning',
        getCurrentUser()?.name || 'Admin'
    );
    logAuditTrail(verified ? 'hospital.approved' : 'hospital.verification_revoked', `Hospital ${hospitalName || hospitalId} ${verified ? 'approved' : 'verification revoked'} by admin`, {
        targetId: hospitalId,
        newState: { isVerified: verified }
    });
}

export async function rejectHospital(hospitalId, hospitalName) {
    const userDocRef = doc(db, 'users', hospitalId);
    await updateDoc(userDocRef, {
        isVerified: false,
        rejected: true,
        rejectedAt: new Date().toISOString()
    });
    await logActivity('Hospital Rejected', `Hospital ${hospitalName || hospitalId} was rejected by an administrator`, 'error', getCurrentUser()?.name || 'Admin');
    logAuditTrail('hospital.rejected', `Hospital ${hospitalName || hospitalId} rejected by admin`, {
        targetId: hospitalId,
        newState: { isVerified: false, rejected: true }
    });
}

export async function deactivateHospital(hospitalId, hospitalName) {
    const userDoc = doc(db, 'users', hospitalId);
    await updateDoc(userDoc, {
        isActive: false,
        statusChangedAt: new Date().toISOString()
    });
}

export async function reactivateHospital(hospitalId, hospitalName) {
    const userDoc = doc(db, 'users', hospitalId);
    await updateDoc(userDoc, {
        isActive: true,
        statusChangedAt: new Date().toISOString()
    });
}

export async function fetchClinicsOnlineCount() {
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'hospital'),
        where('isVerified', '==', true)
    );
    const snapshot = await getDocs(q);
    const active = snapshot.docs.filter(d => d.data().isActive !== false);
    return active.length;
}

// Listen to real-time updates
export function subscribeToRequests(callback) {
    const q = query(
        collection(db, 'requests'),
        where('status', 'in', ['Open', 'Matching', 'Donor Assigned', 'Donor En Route'])
    );
    return onSnapshot(q, (snapshot) => {
        let requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        requests = requests.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
        callback(requests);
    });
}

// Live feed of the donor's OWN active journeys — both hospital requests and public requests
// they've been matched to. Watches both collections so any status change (theirs OR the
// hospital's: blood drawn, lab cleared, issued…) reflects on the donor's screen instantly,
// without a manual refresh. Returns a single unsubscribe that tears down both listeners.
export function subscribeToDonorJourneys(donorId, callback) {
    const cache = { requests: [], public: [] };
    const emit = () => {
        const merged = [...cache.requests, ...cache.public]
            .sort((a, b) => new Date(b.requestedAt || b.createdAt || 0) - new Date(a.requestedAt || a.createdAt || 0));
        callback(merged);
    };
    const unsubs = [
        onSnapshot(
            query(collection(db, 'requests'), where('matchedDonor', '==', donorId)),
            (snap) => { cache.requests = snap.docs.map(d => ({ id: d.id, ...d.data() })); emit(); },
            (err) => console.warn('donor journeys (requests) listener error:', err.message)
        ),
        onSnapshot(
            query(collection(db, 'public_requests'), where('matchedDonor', '==', donorId)),
            (snap) => { cache.public = snap.docs.map(d => ({ id: d.id, ...d.data(), hospital: d.data().hospitalName, isPublicRequest: true })); emit(); },
            (err) => console.warn('donor journeys (public) listener error:', err.message)
        ),
    ];
    return () => unsubs.forEach(u => { try { u(); } catch (e) {} });
}

// ============================================
// BLOOD INVENTORY MANAGEMENT
// ============================================

function invDocId(hospital, type) {
    // Firestore document IDs can't contain '/', so escape anything other than
    // letters/numbers/hyphen/underscore rather than just whitespace.
    return `${hospital.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${type}`;
}

export async function fetchInventory(hospitalName) {
    const q = query(
        collection(db, 'inventory'),
        where('hospital', '==', hospitalName)
    );
    const snapshot = await getDocs(q);
    const inventory = {};
    snapshot.docs.forEach(doc => {
        const data = doc.data();
        inventory[data.bloodType] = enrichInventoryType(data);
    });

    const allTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
    allTypes.forEach(type => {
        if (!inventory[type]) {
            inventory[type] = emptyInventoryType(type, hospitalName);
        }
    });

    return inventory;
}

// Flattens every batch across a hospital's inventory that's still awaiting a lab result, for
// the hospital's "Lab Testing Queue" view — the only place cleared/rejected decisions get made.
export async function fetchPendingLabTests(hospitalName) {
    const inventory = await fetchInventory(hospitalName);
    const pending = [];
    Object.values(inventory).forEach(inv => {
        (inv.batches || []).forEach(b => {
            if ((b.testStatus || 'Cleared') === 'Waiting for Lab Test') {
                pending.push({ ...b, bloodType: inv.bloodType, hospital: hospitalName });
            }
        });
    });
    return pending.sort((a, b) => new Date(a.addedAt || 0) - new Date(b.addedAt || 0));
}

// Every batch carries its own lab-testing status. Older batches written before this field
// existed have no testStatus at all — they're treated as 'Cleared' so pre-existing hospital
// stock keeps behaving exactly as it did before (no regression for data written pre-feature).
// This is the single source of truth for what counts as "available" — recomputed from the
// batches themselves rather than trusted from a possibly-stale stored counter.
function computeInventoryAggregates(batches) {
    let unitsAvailable = 0, unitsPendingTest = 0, unitsRejected = 0;
    const componentTotals = {}; // available (Cleared) stock only, broken down by component
    (batches || []).forEach(b => {
        const status = b.testStatus || 'Cleared';
        if (status === 'Cleared') {
            unitsAvailable += b.units;
            componentTotals[b.componentType] = (componentTotals[b.componentType] || 0) + b.units;
        } else if (status === 'Rejected, Not Safe') {
            unitsRejected += b.units;
        } else {
            unitsPendingTest += b.units;
        }
    });
    return { unitsAvailable, unitsPendingTest, unitsRejected, componentTotals };
}

function enrichInventoryType(data) {
    const batches = data.batches || [];
    const now = new Date();
    let expiringSoon = 0;
    let expiredUnits = 0;
    batches.forEach(b => {
        if (b.expiresAt) {
            const daysLeft = (new Date(b.expiresAt) - now) / (1000 * 60 * 60 * 24);
            if (daysLeft < 0) expiredUnits += b.units;
            else if (daysLeft <= 30) expiringSoon += b.units;
        }
    });
    const aggregates = computeInventoryAggregates(batches);
    return {
        ...data,
        batches,
        unitsAvailable: aggregates.unitsAvailable,
        unitsPendingTest: aggregates.unitsPendingTest,
        unitsRejected: aggregates.unitsRejected,
        componentTotals: aggregates.componentTotals,
        expiringSoon,
        expiredUnits,
        batchCount: batches.length
    };
}

function emptyInventoryType(bloodType, hospitalName) {
    return {
        bloodType,
        hospital: hospitalName,
        unitsAvailable: 0,
        unitsReserved: 0,
        unitsPendingTest: 0,
        unitsRejected: 0,
        minimumThreshold: 5,
        lastUpdated: null,
        expiresAt: null,
        batches: [],
        componentTotals: {},
        expiringSoon: 0,
        expiredUnits: 0,
        batchCount: 0
    };
}

export function getDaysUntilExpiry(expiresAt) {
    if (!expiresAt) return null;
    const diff = (new Date(expiresAt) - new Date()) / (1000 * 60 * 60 * 24);
    return Math.ceil(diff);
}

export async function fetchGlobalInventory() {
    const q = query(collection(db, 'inventory'));
    const snapshot = await getDocs(q);
    const inventory = {};
    snapshot.docs.forEach(doc => {
        const data = doc.data();
        const key = data.bloodType + (data.hospital ? '_' + data.hospital : '');
        inventory[key] = enrichInventoryType(data);
    });
    return inventory;
}

export async function updateInventoryStock(bloodType, unitsToAdd, operation = 'add', hospitalName, options = {}) {
    if (!hospitalName) throw new Error('hospitalName is required for inventory operations');
    const docId = invDocId(hospitalName, bloodType);
    const inventoryRef = doc(db, 'inventory', docId);

    // Transaction guards against two concurrent stock changes (e.g. an add and an
    // issue happening at once) silently clobbering each other's read-then-write.
    const currentUnits = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(inventoryRef);
        const existing = snapshot.exists() ? snapshot.data() : {};
        let batches = existing.batches || [];

        if (operation === 'add') {
            const units = parseInt(unitsToAdd, 10);
            const componentType = options.componentType || 'Whole Blood';
            const expiresAt = options.expiresAt || null;
            // Donated/collected blood must be tested before it can be issued — callers pass
            // testStatus: 'Waiting for Lab Test' for anything sourced from a donor (the default
            // here), or 'Cleared' when the hospital is logging stock it has already verified.
            const testStatus = options.testStatus || 'Waiting for Lab Test';
            const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            batches.push({
                id: batchId,
                units,
                componentType,
                expiresAt,
                testStatus,
                rejectionReason: null,
                sourceDonationId: options.sourceDonationId || null,
                addedAt: new Date().toISOString()
            });
        } else {
            // Manual stock removal (spoilage/waste/correction) — deduct oldest batches first,
            // regardless of test status, same as before. Untested/rejected stock was never part
            // of unitsAvailable anyway, so this can't accidentally "free up" available units.
            const units = parseInt(unitsToAdd, 10);
            let toDeduct = units;
            batches = batches.filter(b => {
                if (toDeduct <= 0) return true;
                if (b.units <= toDeduct) {
                    toDeduct -= b.units;
                    return false;
                }
                b.units -= toDeduct;
                toDeduct = 0;
                return true;
            });
        }

        const aggregates = computeInventoryAggregates(batches);

        transaction.set(inventoryRef, {
            bloodType,
            hospital: hospitalName,
            unitsAvailable: aggregates.unitsAvailable,
            unitsPendingTest: aggregates.unitsPendingTest,
            unitsRejected: aggregates.unitsRejected,
            unitsReserved: 0,
            batches,
            componentTotals: aggregates.componentTotals,
            minimumThreshold: existing.minimumThreshold || 5,
            lastUpdated: new Date().toISOString(),
            expiresAt: options.expiresAt || null
        }, { merge: true });

        return aggregates.unitsAvailable;
    });

    const action = operation === 'add' ? 'Added' : 'Removed';
    await logActivity(
        'Inventory Update',
        `${action} ${unitsToAdd} units of ${bloodType} at ${hospitalName}. New total: ${currentUnits}`,
        operation === 'add' ? 'success' : 'warning'
    );

    return { bloodType, unitsAvailable: currentUnits };
}

// Moves one pending batch out of "Waiting for Lab Test": 'Cleared' makes its units available
// to issue to a patient for the first time; 'Rejected, Not Safe' excludes them permanently.
// This is the only path by which donated blood ever becomes issuable — see issueBloodToPatient,
// which refuses to deduct from any batch that isn't already 'Cleared'.
export async function resolveLabTest(hospitalName, bloodType, batchId, result, rejectionReason = null, extraDetails = {}) {
    if (result !== 'Cleared' && result !== 'Rejected, Not Safe') {
        throw new Error("result must be 'Cleared' or 'Rejected, Not Safe'");
    }
    const docId = invDocId(hospitalName, bloodType);
    const inventoryRef = doc(db, 'inventory', docId);

    const resolvedBatch = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(inventoryRef);
        if (!snapshot.exists()) throw new Error('Inventory record not found');
        const data = snapshot.data();
        const batches = data.batches || [];
        const target = batches.find(b => b.id === batchId);
        if (!target) throw new Error('Batch not found');
        if ((target.testStatus || 'Cleared') !== 'Waiting for Lab Test') {
            throw new Error('This batch has already been resolved.');
        }

        target.testStatus = result;
        target.rejectionReason = result === 'Rejected, Not Safe' ? (rejectionReason || 'Not specified') : null;
        target.resolvedAt = new Date().toISOString();
        if (extraDetails.labTechName) target.labTechName = extraDetails.labTechName;
        if (extraDetails.screeningResults) target.screeningResults = extraDetails.screeningResults;
        if (extraDetails.componentType) target.componentType = extraDetails.componentType;
        if (extraDetails.expiryDate) target.expiryDate = extraDetails.expiryDate;

        const aggregates = computeInventoryAggregates(batches);
        transaction.set(inventoryRef, {
            ...data,
            batches,
            unitsAvailable: aggregates.unitsAvailable,
            unitsPendingTest: aggregates.unitsPendingTest,
            unitsRejected: aggregates.unitsRejected,
            componentTotals: aggregates.componentTotals,
            lastUpdated: new Date().toISOString()
        }, { merge: true });

        return { ...target };
    });

    await logActivity(
        result === 'Cleared' ? 'Blood Cleared for Use' : 'Blood Rejected',
        result === 'Cleared'
            ? `${resolvedBatch.units} unit(s) of ${bloodType} (${resolvedBatch.componentType}) at ${hospitalName} passed lab testing and are now available.`
            : `${resolvedBatch.units} unit(s) of ${bloodType} (${resolvedBatch.componentType}) at ${hospitalName} REJECTED after lab testing — ${resolvedBatch.rejectionReason}`,
        result === 'Cleared' ? 'success' : 'error'
    );

    // Update request lifecycle & notify donor
    if (resolvedBatch.sourceDonationId) {
        try {
            const donReqRef = doc(db, 'donation_requests', resolvedBatch.sourceDonationId);
            const donSnap = await getDoc(donReqRef);
            if (donSnap.exists()) {
                const donData = donSnap.data();
                const newStatus = result === 'Cleared' ? 'Lab Cleared' : 'Lab Rejected';
                await updateDoc(donReqRef, { status: newStatus, labResolvedAt: new Date().toISOString() });

                // Also update the matching requests/public_requests doc if linked
                if (donData.sourceRequestId) {
                    await updateSourceRequestStatus(donData.sourceRequestId, { status: newStatus, labResolvedAt: new Date().toISOString() }).catch(() => {});
                }

                if (donData.donorId) {
                    const msg = result === 'Cleared'
                        ? `[VitalPulse] 🔬 Great news! Your donated blood passed all 5-panel TTI safety screening tests and is now ready in active inventory.`
                        : `[VitalPulse] ⚠️ Health Notice: Your recent donation required lab deferral (${resolvedBatch.rejectionReason}). Please consult medical staff for details.`;
                    await addDonorNotification(donData.donorId, result === 'Cleared' ? 'Lab Screening Passed' : 'Lab Deferral Notice', msg, result === 'Cleared' ? 'success' : 'warning').catch(() => {});
                }
            }
        } catch (e) {
            console.warn('Could not update source donation request on lab resolve:', e);
        }
    }

    // Notify the hospital about the lab result
    const labHospQ = query(collection(db, 'users'), where('name', '==', hospitalName), where('role', '==', 'hospital'));
    const labHSnap = await getDocs(labHospQ);
    const labNotifType = result === 'Cleared' ? 'success' : 'error';
    const labNotifTitle = result === 'Cleared' ? 'Lab Test Passed' : 'Lab Test Rejected';
    const labNotifMsg = result === 'Cleared'
        ? `${resolvedBatch.units} unit(s) of ${bloodType} (${resolvedBatch.componentType}) passed all TTI screening and are now available for issue.`
        : `${resolvedBatch.units} unit(s) of ${bloodType} (${resolvedBatch.componentType}) rejected — ${resolvedBatch.rejectionReason}.`;
    for (const hDoc of labHSnap.docs) {
        await addHospitalNotification(hDoc.id, labNotifTitle, labNotifMsg, labNotifType, 'inventory').catch(() => {});
    }

    return resolvedBatch;
}

export async function setInventoryThreshold(bloodType, threshold, hospitalName) {
    if (!hospitalName) throw new Error('hospitalName is required');
    const docId = invDocId(hospitalName, bloodType);
    const inventoryRef = doc(db, 'inventory', docId);
    const snapshot = await getDoc(inventoryRef);
    
    if (snapshot.exists()) {
        await updateDoc(inventoryRef, { minimumThreshold: parseInt(threshold, 10) });
    } else {
        await setDoc(inventoryRef, {
            bloodType,
            hospital: hospitalName,
            unitsAvailable: 0,
            unitsReserved: 0,
            minimumThreshold: parseInt(threshold, 10),
            lastUpdated: new Date().toISOString()
        });
    }
    
    await logActivity(
        'Threshold Updated',
        `Minimum stock threshold for ${bloodType} at ${hospitalName} set to ${threshold} units`,
        'info'
    );
}

export function getBloodTypeDisplayInfo(bloodType) {
    const rarity = {
        'AB+': { label: 'Universal Recipient', color: '#8B5CF6', rarity: 1 },
        'AB-': { label: 'Rare', color: '#A78BFA', rarity: 2 },
        'A+': { label: 'Common', color: '#EF4444', rarity: 5 },
        'A-': { label: 'Uncommon', color: '#F97316', rarity: 4 },
        'B+': { label: 'Common', color: '#EAB308', rarity: 5 },
        'B-': { label: 'Uncommon', color: '#84CC16', rarity: 4 },
        'O+': { label: 'Most Common', color: '#22C55E', rarity: 7 },
        'O-': { label: 'Universal Donor', color: '#14B8A6', rarity: 3 }
    };
    return rarity[bloodType] || { label: 'Unknown', color: '#6B7280', rarity: 0 };
}

// ============================================
// DONATION REQUEST MANAGEMENT
// ============================================

export async function submitDonationRequest(donorId, donationData) {
    // 56-Day Medical Deferral Lock (defense-in-depth before a scheduled donation is created)
    if (donorId) {
        try {
            const donorRef = doc(db, 'users', donorId);
            const donorSnap = await getDoc(donorRef);
            if (donorSnap.exists()) {
                const donorData = donorSnap.data();
                const lastDate = donorData.lastDonationDate || donorData.lastDonatedAt;
                if (lastDate) {
                    const daysAgo = (new Date().getTime() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24);
                    if (daysAgo < 56) {
                        throw new Error(`WHO medical deferral: You last donated ${Math.round(daysAgo)} days ago. A minimum of 56 days is required between whole blood donations for your safety.`);
                    }
                }
            }
        } catch (e) {
            if (e.message?.includes('WHO medical deferral')) throw e;
            console.warn('Deferral check warning in submitDonationRequest:', e);
        }
    }

    const docRef = await addDoc(collection(db, 'donation_requests'), {
        donorId,
        donorName: donationData.donorName,
        donorEmail: donationData.donorEmail,
        donorPhone: donationData.donorPhone || null,
        bloodType: donationData.bloodType,
        units: donationData.units || 1,
        preferredDate: donationData.preferredDate,
        preferredLocation: donationData.preferredLocation,
        notes: donationData.notes || '',
        componentType: donationData.componentType || 'Whole Blood',
        screeningAnswers: donationData.screeningAnswers || null,
        screeningFlags: donationData.screeningFlags || [],
        screeningPassed: donationData.screeningPassed !== false,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    await logActivity(
        'Donation Request Submitted',
        `${donationData.donorName} requested to donate ${donationData.units || 1} unit(s) of ${donationData.bloodType}`
            + (donationData.screeningFlags?.length ? ` — screening flags: ${donationData.screeningFlags.join(', ')}` : ''),
        donationData.screeningFlags?.length ? 'warning' : 'info'
    );
    
    return { id: docRef.id, ...donationData };
}

export async function fetchDonationRequestsForDonor(donorId) {
    // Sorted client-side (not via Firestore orderBy) to avoid requiring a
    // composite index for donorId + createdAt.
    const q = query(
        collection(db, 'donation_requests'),
        where('donorId', '==', donorId)
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return results.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export async function fetchAllDonationRequests(status = 'all') {
    let q;
    if (status === 'all') {
        q = query(collection(db, 'donation_requests'), orderBy('createdAt', 'desc'));
    } else {
        q = query(
            collection(db, 'donation_requests'),
            where('status', '==', status),
            orderBy('createdAt', 'desc')
        );
    }
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function fetchPendingDonationRequests() {
    return fetchAllDonationRequests('pending');
}

// A donor picks the hospital when self-scheduling a walk-in donation (preferredLocation) —
// that hospital is who should approve/manage the booking, not admin. This previously had no
// caller anywhere: the only UI that ever approved/completed a donation_requests booking was
// the admin Donations tab, which itself referenced admin.html elements that no longer exist.
export async function fetchDonationRequestsForHospital(hospitalName) {
    const q = query(
        collection(db, 'donation_requests'),
        where('preferredLocation', '==', hospitalName)
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return results.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export async function approveDonationRequest(requestId, requestData) {
    const reqDoc = doc(db, 'donation_requests', requestId);
    await updateDoc(reqDoc, {
        status: 'approved',
        approvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    // Approving just confirms the booking date — the donor hasn't actually given blood yet,
    // so inventory is only ever added once the donation is completed (recordDonationIntake,
    // called from completeDonationRequest), not at approval time.
    await logActivity(
        'Donation Booking Approved',
        `${requestData.donorName || 'Donor'}'s request to donate ${requestData.bloodType} was approved`,
        'success'
    );

    if (requestData.donorId) {
        await addDonorNotification(
            requestData.donorId,
            'Donation Booking Confirmed',
            `Your donation booking for ${requestData.bloodType} at ${requestData.preferredLocation || requestData.hospital || 'the hospital'} has been confirmed. Thank you for choosing to donate!`,
            'success'
        ).catch(() => {});
    }
}

// The single place a real donation gets recorded. Called both when a hospital completes an
// emergency-request donor's arrival (completeDonorArrival) and when a self-scheduled donation
// booking is completed (completeDonationRequest). Together this closes three of the critical
// safety gaps at once: it captures the donor's pre-donation health-screening answers, it always
// creates the resulting blood unit as 'Waiting for Lab Test' rather than immediately available
// (see updateInventoryStock), and it records whatever blood type the hospital actually observed
// at intake alongside the donor's self-reported one so a mismatch is visible rather than silently
// trusted.
// Cryptographic SHA-256 Hashing helper for National ID (CNI) deduplication
export async function sha256Hash(text) {
    if (!text) return null;
    const cleanText = text.toString().trim().replace(/[\s-]/g, '').toUpperCase() + '_VITALPULSE_SALT_2026';
    const encoder = new TextEncoder();
    const data = encoder.encode(cleanText);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function recordDonationIntake(donationData) {
    const {
        donationRequestId = null,   // existing donation_requests doc to update, if any
        donorId,
        donorName,
        donorEmail = null,
        donorPhone = null,
        cniNumber = null,
        hospital,
        bloodType,                  // donor's self-reported blood type at time of intake
        labConfirmedBloodType = null,
        componentType = 'Whole Blood',
        units = 1,
        expiresAt = null,
        screeningAnswers = null,
        screeningFlags = [],
        screeningPassed = true,
        sourceRequestId = null,     // links back to the emergency `requests` doc, if applicable
        notes = ''
    } = donationData;

    if (!donorId || !hospital || !bloodType) {
        throw new Error('recordDonationIntake requires donorId, hospital, and bloodType');
    }

    // 56-Day Medical Deferral Lock: Protect donor health and prevent premature repeat donations
    if (donorId) {
        try {
            const donorRef = doc(db, 'users', donorId);
            const donorSnap = await getDoc(donorRef);
            if (donorSnap.exists()) {
                const donorData = donorSnap.data();
                const lastDate = donorData.lastDonationDate || donorData.lastDonatedAt;
                if (lastDate) {
                    const daysAgo = (new Date().getTime() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24);
                    if (daysAgo < 56) {
                        throw new Error(`MEDICAL SAFETY DEFERRAL LOCK: Donor last donated ${Math.round(daysAgo)} days ago. Mandatory WHO medical deferral requires at least 56 days between whole blood donations for donor health safety.`);
                    }
                }
            }
        } catch (e) {
            if (e.message?.includes('MEDICAL SAFETY DEFERRAL')) throw e;
            console.warn('Deferral check warning:', e);
        }
    }

    let cniHash = cniNumber ? await sha256Hash(cniNumber) : null;
    if (!cniHash && donorId) {
        try {
            const donorSnap = await getDoc(doc(db, 'users', donorId));
            if (donorSnap.exists() && donorSnap.data().cniHash) {
                cniHash = donorSnap.data().cniHash;
            }
        } catch (e) {
            console.warn('Could not fetch donor cniHash for donation record:', e);
        }
    }
    const bloodTypeMismatch = !!(labConfirmedBloodType && labConfirmedBloodType !== bloodType);
    const now = new Date().toISOString();
    const donationPayload = {
        donorId,
        donorName: donorName || null,
        donorEmail,
        donorPhone,
        cniHash,
        hospital,
        bloodType,
        labConfirmedBloodType,
        bloodTypeMismatch,
        componentType,
        units,
        screeningAnswers,
        screeningFlags,
        screeningPassed,
        sourceRequestId,
        notes,
        status: 'completed',
        completedAt: now,
        updatedAt: now
    };

    let donationId = donationRequestId;
    if (donationRequestId) {
        await updateDoc(doc(db, 'donation_requests', donationRequestId), donationPayload);
    } else {
        const docRef = await addDoc(collection(db, 'donation_requests'), { ...donationPayload, createdAt: now });
        donationId = docRef.id;
    }

    // Blood collected from a donor always starts untested — it only becomes issuable stock
    // once a hospital records a lab result via resolveLabTest().
    const intakeType = labConfirmedBloodType || bloodType;
    await updateInventoryStock(intakeType, units, 'add', hospital, {
        componentType,
        expiresAt: expiresAt || null,
        testStatus: 'Waiting for Lab Test',
        sourceDonationId: donationId
    });

    if (bloodTypeMismatch) {
        await logActivity(
            'Blood Type Mismatch at Intake',
            `Donor ${donorName || donorId} is on file as ${bloodType} but was lab-confirmed as ${labConfirmedBloodType} at ${hospital}.`,
            'warning'
        );
    }

    // Update donor user document with lastDonationDate for 56-day deferral tracking
    if (donorId) {
        try {
            const donorRef = doc(db, 'users', donorId);
            const userUpdates = { lastDonationDate: now };
            if (cniHash) userUpdates.cniHash = cniHash;
            await updateDoc(donorRef, userUpdates);
        } catch (err) {
            console.warn('Could not update donor lastDonationDate:', err);
        }
    }

    await logActivity(
        'Donation Intake Recorded',
        `${units} unit(s) of ${intakeType} (${componentType}) collected from ${donorName || 'a donor'} at ${hospital} — awaiting lab testing.${screeningFlags.length ? ' Screening flags: ' + screeningFlags.join(', ') : ''}`,
        screeningFlags.length ? 'warning' : 'success'
    );

    // Seed post-donation care reminders for the donor. Lives here (not in the two UI call
    // sites) so it fires the same way whether a hospital records a walk-in donor or an admin
    // completes a scheduled donation request — both paths converge on this function.
    try {
        await createCareReminders({
            donorId,
            donorName,
            donationId,
            hospitalName: hospital,
            bloodType: intakeType,
            donationDate: now
        });
    } catch (err) {
        console.warn('Could not seed care reminders:', err);
    }

    // Refresh the donor's tier/points/badges now that this donation counts toward them.
    // Keeping this a cheap field on the user doc (rather than recomputing on every match)
    // is what lets autoMatchDonors sort by tier without an extra query per candidate.
    if (donorId) {
        try {
            const engagement = await computeDonorEngagement(donorId);
            if (engagement) await saveDonorEngagement(donorId, engagement);
        } catch (err) {
            console.warn('Could not refresh donor engagement tier:', err);
        }
    }

    return { id: donationId, ...donationPayload };
}

export async function rejectDonationRequest(requestId, requestData, reason) {
    const reqDoc = doc(db, 'donation_requests', requestId);
    await updateDoc(reqDoc, {
        status: 'rejected',
        rejectionReason: reason || 'Not specified',
        rejectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    
    await logActivity(
        'Donation Rejected',
        `Donation request for ${requestData.bloodType} rejected: ${reason || 'Not specified'}`,
        'warning'
    );
}

export async function completeDonationRequest(requestId, requestData, intakeData = {}) {
    await recordDonationIntake({
        donationRequestId: requestId,
        donorId: requestData.donorId,
        donorName: requestData.donorName,
        donorEmail: requestData.donorEmail,
        donorPhone: requestData.donorPhone,
        hospital: intakeData.hospital || requestData.preferredLocation || requestData.hospital || 'Central Inventory',
        bloodType: requestData.bloodType,
        labConfirmedBloodType: intakeData.labConfirmedBloodType || null,
        componentType: intakeData.componentType || requestData.componentType || 'Whole Blood',
        units: intakeData.units || requestData.units || 1,
        expiresAt: intakeData.expiresAt || null,
        screeningAnswers: requestData.screeningAnswers || null,
        screeningFlags: requestData.screeningFlags || [],
        screeningPassed: requestData.screeningPassed !== false,
        notes: intakeData.notes || ''
    });
}

export async function cancelDonationRequest(requestId, requestData) {
    const reqDoc = doc(db, 'donation_requests', requestId);
    await updateDoc(reqDoc, {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    
    await logActivity(
        'Donation Cancelled',
        `Donation request for ${requestData.bloodType} was cancelled by donor`,
        'info'
    );
}

export async function hospitalCancelBooking(requestId, requestData) {
    const reqDoc = doc(db, 'donation_requests', requestId);
    await updateDoc(reqDoc, {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cancellationNote: 'Cancelled by hospital'
    });

    await logActivity(
        'Booking Cancelled by Hospital',
        `Scheduled booking for ${requestData.bloodType} (${requestData.donorName || 'Unknown donor'}) was cancelled by the hospital`,
        'warning'
    );

    if (requestData.donorId) {
        await addDonorNotification(
            requestData.donorId,
            'Donation Booking Cancelled',
            `Your scheduled donation at ${requestData.preferredLocation || 'the hospital'} has been cancelled. Please contact the hospital for more information.`,
            'warning'
        ).catch(() => {});
    }
}

export async function cancelHospitalRequest(requestId, hospitalName, reason = '') {
    const reqDoc = doc(db, 'requests', requestId);
    const snapshot = await getDoc(reqDoc);
    if (!snapshot.exists()) throw new Error('Request not found');
    const reqData = snapshot.data();

    await updateDoc(reqDoc, {
        status: 'Cancelled',
        cancelledAt: new Date().toISOString(),
        cancelledBy: hospitalName || 'Hospital',
        cancellationReason: reason || null
    });

    await logActivity(
        'Request Cancelled by Hospital',
        `Hospital cancelled request #${requestId.slice(0, 8)} (${reqData.bloodType || reqData.type || '?'})${reason ? ' — ' + reason : ''}`,
        'error',
        hospitalName
    );
    return true;
}

export async function removeIncomingDonor(requestId, hospitalName, isPublicRequest = false) {
    const collectionName = isPublicRequest ? 'public_requests' : 'requests';
    const reqDoc = doc(db, collectionName, requestId);
    const snapshot = await getDoc(reqDoc);
    if (!snapshot.exists()) throw new Error('Request not found');
    const reqData = snapshot.data();

    const updateData = {
        status: 'Open',
        matchedDonor: null,
        matchedAt: null,
        checkInToken: null,
        unmatchedAt: new Date().toISOString(),
    };

    await updateDoc(reqDoc, updateData);

    const donorId = reqData.matchedDonor;
    if (donorId) {
        await addDonorNotification(
            donorId,
            'Hospital Removed Your Assignment',
            `The hospital has released you from request #${requestId.slice(0, 8)}. You are no longer expected at this location.`,
            'warning'
        ).catch(() => {});
    }

    await logActivity(
        'Donor Removed from Request',
        `${hospitalName} removed donor from request #${requestId.slice(0, 8)}${isPublicRequest ? ' (public)' : ''}`,
        'warning',
        hospitalName
    );
    return true;
}

// ============================================
// SYSTEM SETTINGS
// ============================================

export async function fetchSystemSettings() {
    const docRef = doc(db, 'system_settings', 'config');
    const snapshot = await getDoc(docRef);
    if (snapshot.exists()) {
        return snapshot.data();
    }
    return {
        criticalSupplySms: true,
        hospitalDigest: false,
        donorAlerts: true,
        autoMatchDonors: true,
        lowStockThreshold: 5,
        emergencyBroadcastEnabled: true,
        registrationApprovalRequired: false
    };
}

export async function updateSystemSettings(settings) {
    const docRef = doc(db, 'system_settings', 'config');
    await setDoc(docRef, {
        ...settings,
        updatedAt: new Date().toISOString()
    }, { merge: true });
    
    await logActivity(
        'Settings Updated',
        'System configuration was updated',
        'info'
    );
}

export async function updateUserProfile(userId, updates) {
    const userDoc = doc(db, 'users', userId);
    await updateDoc(userDoc, updates);
}

// ============================================
// CAMPAIGN MANAGEMENT
// ============================================

export async function fetchAllCampaigns() {
    const q = query(collection(db, 'campaigns'), orderBy('createdAt', 'desc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function createCampaign(campaignData) {
    const clean = sanitizeFields(campaignData, 'title', 'description', 'location', 'targetGroup');
    const docRef = await addDoc(collection(db, 'campaigns'), {
        ...clean,
        status: clean.status || 'planning',
        unitsCollected: clean.unitsCollected || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    
    await logActivity(
        'Campaign Created',
        `New campaign "${clean.title}" created`,
        'info'
    );
    
    return { id: docRef.id, ...clean };
}

export async function updateCampaign(campaignId, updates) {
    const campaignDoc = doc(db, 'campaigns', campaignId);
    await updateDoc(campaignDoc, {
        ...updates,
        updatedAt: new Date().toISOString()
    });
}

export async function deleteCampaign(campaignId) {
    await deleteDoc(doc(db, 'campaigns', campaignId));
    
    await logActivity(
        'Campaign Deleted',
        'A campaign has been removed',
        'warning'
    );
}

// ============================================
// HOSPITAL-SPECIFIC HELPERS
// ============================================

export async function fetchHospitalRequests(hospitalName) {
    const q = query(
        collection(db, 'requests'),
        where('hospital', '==', hospitalName)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
}

// Front-desk / admin manual check-in only ever has the pass code the donor shows at reception —
// not the underlying request id — so this is the lookup both the hospital's "Enter Donor
// Check-in Code" box and admin's shadow-hospital intake box need before they can act.
export async function findRequestByCheckInToken(checkInToken, collectionName) {
    const normalized = (checkInToken || '').replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
    if (!normalized) return null;
    const q = query(collection(db, collectionName), where('checkInToken', '==', normalized));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;
    const docSnap = snapshot.docs[0];
    return { id: docSnap.id, ...docSnap.data() };
}

// intakeData carries what the hospital captured at the physical intake step: units actually
// collected, component type, expiry, an optional lab-confirmed blood type, and screening
// answers gathered from the donor before accepting the request. This is what makes the
// emergency-request donation path — the app's main real-world donation flow — actually create
// a real, testable blood unit instead of just closing the request with no record at all.
export async function checkInDonor(requestId) {
    let reqDoc = doc(db, 'requests', requestId);
    let sourceCollection = 'requests';
    let reqData;

    await runTransaction(db, async (transaction) => {
        let snapshot = await transaction.get(reqDoc);

        if (!snapshot.exists()) {
            reqDoc = doc(db, 'public_requests', requestId);
            sourceCollection = 'public_requests';
            snapshot = await transaction.get(reqDoc);
        }

        if (!snapshot.exists()) throw new Error('Request not found');
        reqData = snapshot.data();

        if (reqData.status !== 'Donor En Route') {
            throw new Error('Request must be in "Donor En Route" status before check-in.');
        }

        const now = new Date().toISOString();
        await transaction.update(reqDoc, {
            status: 'Checked In',
            checkedInAt: now
        });
    });

    await logActivity('Donor Checked In', `Donor checked in at reception for request #${requestId.slice(0, 8)} at ${reqData.hospital || reqData.hospitalName || 'Unknown'}`, 'info');

    const donorId = reqData.matchedDonor;
    if (donorId) {
        const msg = `[VitalPulse] 🏥 Reception Check-In Verified! You have checked in at ${reqData.hospital || reqData.hospitalName || 'the hospital'}. Please proceed to the donation room for vitals & blood draw.`;
        await addDonorNotification(donorId, 'Reception Check-In Confirmed', msg, 'info').catch(() => {});
    }
    return reqData;
}

// Several post-acceptance steps (lab clearance, issuance) need to update the original request
// doc by ID without knowing in advance whether it lives in 'requests' (hospital-initiated) or
// 'public_requests' (community/shadow-hospital-initiated) — same fallback donorSetEnRoute and
// checkInDonor already use for the earlier steps of the same journey.
async function updateSourceRequestStatus(sourceRequestId, updates) {
    if (!sourceRequestId) return;
    const reqRef = doc(db, 'requests', sourceRequestId);
    const snap = await getDoc(reqRef);
    if (snap.exists()) {
        await updateDoc(reqRef, updates);
        return;
    }
    const publicRef = doc(db, 'public_requests', sourceRequestId);
    const publicSnap = await getDoc(publicRef);
    if (publicSnap.exists()) {
        await updateDoc(publicRef, updates);
    }
}

export async function completeDonorArrival(requestId, intakeData = {}) {
    // Falls back to public_requests just like donorSetEnRoute/checkInDonor already do — a
    // donor who came through a community/public plea must be able to reach this step too,
    // not just donors matched via a hospital-initiated emergency request.
    let reqDoc = doc(db, 'requests', requestId);
    let snapshot = await getDoc(reqDoc);
    if (!snapshot.exists()) {
        reqDoc = doc(db, 'public_requests', requestId);
        snapshot = await getDoc(reqDoc);
    }
    const reqData = snapshot.exists() ? snapshot.data() : {};
    const hospitalName = reqData.hospital || reqData.hospitalName || 'Unknown Hospital';

    const now = new Date().toISOString();
    if (snapshot.exists()) {
        await updateDoc(reqDoc, {
            status: 'Donation Complete',
            donationCompletedAt: now
        });
    }

    const donorId = reqData.matchedDonor;
    let donor = {};
    if (donorId) {
        const donorSnap = await getDoc(doc(db, 'users', donorId));
        if (donorSnap.exists()) donor = donorSnap.data();
    }

    let intakeResult = null;
    if (donorId) {
        intakeResult = await recordDonationIntake({
            donorId,
            donorName: donor.name || reqData.donorName || 'Donor',
            donorEmail: donor.email || null,
            donorPhone: donor.phone || null,
            hospital: hospitalName,
            bloodType: donor.bloodType || reqData.bloodType || reqData.type,
            labConfirmedBloodType: intakeData.labConfirmedBloodType || null,
            componentType: intakeData.componentType || reqData.componentType || 'Whole Blood',
            units: intakeData.units || reqData.units || 1,
            expiresAt: intakeData.expiresAt || null,
            screeningAnswers: intakeData.screeningAnswers || null,
            screeningFlags: intakeData.screeningFlags || (reqData.donorScreeningPassed === false ? ['flagged_at_accept'] : []),
            screeningPassed: intakeData.screeningPassed !== undefined ? intakeData.screeningPassed !== false : reqData.donorScreeningPassed !== false,
            sourceRequestId: requestId,
            notes: intakeData.notes || ''
        });
    }

    await logActivity('Donation Intake Recorded', `Blood collected from donor for request #${requestId.slice(0, 8)} — placed in lab quarantine for TTI testing`, 'success');

    // Notify the hospital that a donation has been completed and is in lab quarantine
    // (a no-op query for shadow/unregistered hospitals — no user account exists to notify).
    if (hospitalName) {
        const hospitalsQ = query(collection(db, 'users'), where('name', '==', hospitalName), where('role', '==', 'hospital'));
        const hSnap = await getDocs(hospitalsQ);
        for (const hDoc of hSnap.docs) {
            await addHospitalNotification(hDoc.id, 'Donation Completed', `A donor has completed their blood donation for request #${requestId.slice(0, 8).toUpperCase()}. Blood is now in lab quarantine for TTI screening.`, 'success', 'lab').catch(() => {});
        }
    }

    if (donorId) {
        const msg = `[VitalPulse] 🩸 Blood Draw Complete! Your donation at ${hospitalName} is now in the lab for mandatory 5-panel TTI safety screening.`;
        await addDonorNotification(donorId, 'Donation Collected', msg, 'success').catch(() => {});
        if (donor.phone) {
            if (donor.notifSms !== false) await sendSmsNotification(donor.phone, msg).catch(() => {});
            if (donor.notifWhatsapp === true) await sendWhatsAppNotification(donor.phone, msg).catch(() => {});
        }
    }
    return intakeResult;
}

// Incoming statuses only — this is the queue a hospital acts on (see who's coming, check
// them in, mark blood drawn). 'Checked In' MUST be included: it's the exact status a hospital
// needs to see in order to click "Complete" and record the blood draw. Leaving it out (as this
// used to) meant a donor vanished from the hospital's own view the moment they checked in,
// with no button left anywhere to advance them.
const INCOMING_DONOR_STATUSES = ['Donor Assigned', 'Donor En Route', 'Checked In'];

export async function fetchIncomingDonors(hospitalName) {
    const q = query(
        collection(db, 'requests'),
        where('hospital', '==', hospitalName)
    );
    const snapshot = await getDocs(q);
    const matching = snapshot.docs.filter(doc => INCOMING_DONOR_STATUSES.includes(doc.data().status));
    const results = [];
    for (const docSnap of matching) {
        const data = { id: docSnap.id, ...docSnap.data() };
        if (data.matchedDonor) {
            try {
                const donorSnap = await getDoc(doc(db, 'users', data.matchedDonor));
                if (donorSnap.exists()) {
                    data.donorInfo = donorSnap.data();
                }
            } catch (e) {
                console.warn('Failed to fetch donor info for', data.matchedDonor, e);
            }
        }
        results.push(data);
    }

    // A registered hospital previously had zero visibility into community/public requests
    // naming it — donors who accepted a public plea would travel, check in, and never appear
    // anywhere on the hospital's own dashboard. Merge those in here too, tagged so the caller
    // can route their status updates to the right collection.
    try {
        const publicQ = query(
            collection(db, 'public_requests'),
            where('hospitalName', '==', hospitalName)
        );
        const publicSnap = await getDocs(publicQ);
        const publicMatching = publicSnap.docs.filter(doc => INCOMING_DONOR_STATUSES.includes(doc.data().status));
        for (const docSnap of publicMatching) {
            const data = { id: docSnap.id, ...docSnap.data(), isPublicRequest: true };
            if (data.matchedDonor) {
                try {
                    const donorSnap = await getDoc(doc(db, 'users', data.matchedDonor));
                    if (donorSnap.exists()) data.donorInfo = donorSnap.data();
                } catch (e) {
                    console.warn('Failed to fetch donor info for', data.matchedDonor, e);
                }
            }
            results.push(data);
        }
    } catch (e) {
        console.warn('Failed to fetch incoming public-request donors:', e);
    }

    return results.sort((a, b) => new Date(b.matchedAt || 0) - new Date(a.matchedAt || 0));
}

// ============================================
// BLOOD ISSUANCE & USAGE TRACKING
// ============================================

export async function issueBloodToPatient(bloodType, units, patientData) {
    const hospitalName = patientData.hospital;
    if (!hospitalName) throw new Error('patientData.hospital is required');

    // Mandatory Medical Gate: Serological Crossmatch Confirmation
    if (patientData.crossmatchConfirmed !== true || patientData.crossmatchResult !== 'Compatible') {
        throw new Error(`CRITICAL MEDICAL SAFETY GATE: Cannot issue blood unit. Serological Crossmatch (Major & Minor) for patient "${patientData.patientName || 'Unknown'}" must be confirmed COMPATIBLE prior to release.`);
    }

    const docId = invDocId(hospitalName, bloodType);
    const inventoryRef = doc(db, 'inventory', docId);

    // Wrap inventory read + deduction + write in a transaction to prevent double-issuance
    // from concurrent requests for the same blood type.
    const { batches, deductedBatches, data, aggregates } = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(inventoryRef);
        const data = snapshot.exists() ? snapshot.data() : {};

        let batches = data.batches || [];
        let toDeduct = parseInt(units, 10);

        const clearedAvailable = batches
            .filter(b => (b.testStatus || 'Cleared') === 'Cleared')
            .reduce((sum, b) => sum + b.units, 0);
        if (toDeduct > clearedAvailable) {
            throw new Error(`Only ${clearedAvailable} tested and cleared unit(s) of ${bloodType} are available to issue.`);
        }

        const deductedBatches = [];
        batches = batches.map(b => ({ ...b })).filter(b => {
            if (toDeduct <= 0) return true;
            if ((b.testStatus || 'Cleared') !== 'Cleared') return true;
            if (b.units <= toDeduct) {
                toDeduct -= b.units;
                deductedBatches.push(b);
                return false;
            }
            b.units -= toDeduct;
            deductedBatches.push({ ...b, units: toDeduct });
            toDeduct = 0;
            return true;
        });

        const aggregates = computeInventoryAggregates(batches);

        transaction.set(inventoryRef, {
            bloodType,
            hospital: hospitalName,
            unitsAvailable: aggregates.unitsAvailable,
            unitsPendingTest: aggregates.unitsPendingTest,
            unitsRejected: aggregates.unitsRejected,
            unitsReserved: snapshot.exists() ? (data.unitsReserved || 0) : 0,
            minimumThreshold: data.minimumThreshold || 5,
            lastUpdated: new Date().toISOString(),
            batches,
            componentTotals: aggregates.componentTotals
        }, { merge: true });

        return { batches, deductedBatches, data, aggregates };
    });

    await addDoc(collection(db, 'issuance_log'), {
        bloodType,
        units: parseInt(units, 10),
        patientName: patientData.patientName,
        patientId: patientData.patientId || '',
        patientBloodType: patientData.patientBloodType || bloodType,
        ward: patientData.ward || '',
        requestingDoctor: patientData.requestingDoctor || '',
        diagnosis: patientData.diagnosis || '',
        crossmatchConfirmed: true,
        crossmatchResult: 'Compatible',
        crossmatchTechnician: patientData.crossmatchTechnician || 'Staff Tech',
        hospital: hospitalName,
        issuedAt: new Date().toISOString()
    });

    await logAuditTrail(
        'UNIT_ISSUED',
        `${units} unit(s) of ${bloodType} issued to patient ${patientData.patientName || 'Unknown'} at ${hospitalName} following confirmed compatible crossmatch.`,
        { hospital: hospitalName, targetId: patientData.patientId || null }
    );

    await logActivity(
        'Blood Issued',
        `${units} unit(s) of ${bloodType} issued to ${patientData.patientName} at ${patientData.ward || 'Unknown Ward'} — ${patientData.diagnosis || 'No diagnosis'} — Dr. ${patientData.requestingDoctor || 'N/A'} — ${hospitalName}`,
        'warning'
    );

    // Notify donors whose blood units were issued to save a patient's life!
    // Also check if this issuance dropped stock below threshold
    await _checkLowStockAndNotify(hospitalName, bloodType, aggregates.unitsAvailable);
    for (const dB of deductedBatches) {
        if (dB.sourceDonationId) {
            try {
                const donReqRef = doc(db, 'donation_requests', dB.sourceDonationId);
                const donSnap = await getDoc(donReqRef);
                if (donSnap.exists()) {
                    const donData = donSnap.data();
                    await updateDoc(donReqRef, { status: 'Issued', issuedAt: new Date().toISOString() });
                    if (donData.sourceRequestId) {
                        await updateSourceRequestStatus(donData.sourceRequestId, { status: 'Issued', issuedAt: new Date().toISOString() }).catch(() => {});
                    }

                    if (donData.donorId) {
                        const msg = `[VitalPulse] 🎉 HERO ALERT! Your donated blood was just issued to a patient in need at ${hospitalName}. You officially saved a life today!`;
                        await addDonorNotification(donData.donorId, '🎉 Life Saved!', msg, 'success').catch(() => {});
                    }
                }
            } catch (e) {
                console.warn('Could not update source request status on issuance:', e);
            }
        }
    }

    return { bloodType, unitsAvailable: aggregates.unitsAvailable };
}

// Check if a blood type is low stock after issuance and notify the hospital
async function _checkLowStockAndNotify(hospitalName, bloodType, unitsAvailable) {
    try {
        const threshold = 5;
        if (unitsAvailable <= threshold) {
            const q = query(collection(db, 'users'), where('name', '==', hospitalName), where('role', '==', 'hospital'));
            const snap = await getDocs(q);
            for (const d of snap.docs) {
                await addHospitalNotification(d.id, 'Low Stock Alert', `⚠️ ${bloodType} stock at ${hospitalName} is critically low — only ${unitsAvailable} unit(s) remaining.`, unitsAvailable === 0 ? 'error' : 'warning', 'inventory').catch(() => {});
            }
        }
    } catch (e) { /* non-critical */ }
}

export async function deductInventoryStock(bloodType, units, reason = 'adjustment', hospitalName) {
    if (!hospitalName) throw new Error('hospitalName is required');
    const parsedUnits = parseInt(units, 10);
    if (!parsedUnits || parsedUnits <= 0) throw new Error('Units must be a positive integer');
    const docId = invDocId(hospitalName, bloodType);
    const inventoryRef = doc(db, 'inventory', docId);

    const result = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(inventoryRef);

        if (!snapshot.exists()) throw new Error(`No inventory found for ${bloodType} at ${hospitalName}`);
        const data = snapshot.data();
        const currentUnits = data.unitsAvailable || 0;
        if (currentUnits < parsedUnits) throw new Error(`Insufficient stock: ${currentUnits} units available, ${parsedUnits} requested`);
        const newUnits = currentUnits - parsedUnits;

        let batches = data.batches || [];
        let toDeduct = parsedUnits;
        batches = batches.filter(b => {
            if (toDeduct <= 0) return true;
            if (b.units <= toDeduct) {
                toDeduct -= b.units;
                return false;
            }
            b.units -= toDeduct;
            toDeduct = 0;
            return true;
        });

        const componentTotals = {};
        batches.forEach(b => {
            componentTotals[b.componentType] = (componentTotals[b.componentType] || 0) + b.units;
        });

        await transaction.update(inventoryRef, {
            unitsAvailable: newUnits,
            batches,
            componentTotals,
            lastUpdated: new Date().toISOString()
        });

        return { bloodType, unitsAvailable: newUnits, deducted: parsedUnits };
    });

    // Non-blocking low stock check after deduction completes
    _postDeductLowStockCheck(hospitalName, bloodType, result.unitsAvailable).catch(() => {});
    return result;
}

// After deduction, check for low stock and notify hospital
async function _postDeductLowStockCheck(hospitalName, bloodType, newUnits) {
    try {
        const threshold = 5;
        if (newUnits <= threshold) {
            const q = query(collection(db, 'users'), where('name', '==', hospitalName), where('role', '==', 'hospital'));
            const snap = await getDocs(q);
            for (const d of snap.docs) {
                await addHospitalNotification(d.id, 'Low Stock Alert', `⚠️ ${bloodType} stock at ${hospitalName} is critically low — only ${newUnits} unit(s) remaining.`, newUnits === 0 ? 'error' : 'warning', 'inventory').catch(() => {});
            }
        }
    } catch (e) { /* non-critical */ }
}

// ============================================
// INVENTORY MOVEMENT HISTORY (Hospital-level)
// ============================================

// Source of truth is activity_logs (the only collection anything actually writes
// movement events to — a parallel `inventory_movements` collection existed here
// before but nothing ever wrote to it, so it's been removed). Titles match what
// updateInventoryStock/deductInventoryStock/issueBloodToPatient actually log.
// Sorted client-side rather than via Firestore orderBy to avoid requiring a
// composite index for the title-in + timestamp combination.
// Every activity-log title that represents something happening to a blood unit, from
// collection through to transfusion/transfer — not just plain stock add/remove. Maps each
// title to a movement `type` used for the icon/color in the UI. ('Stock Removed' was never
// actually logged anywhere — 'Inventory Update' covers both add and remove, distinguished by
// description text below — so it's been dropped from the filter.)
const INVENTORY_MOVEMENT_TITLES = {
    'Inventory Update': null, // addition/removal decided from description text below
    'Blood Issued': 'issuance',
    'Blood Cleared for Use': 'cleared',
    'Blood Rejected': 'rejected',
    'Blood Type Mismatch at Intake': 'mismatch',
    'Donation Intake Recorded': 'intake',
    'Admin Proxy Intake': 'intake',
    'Blood Transfer Requested': 'transfer_requested',
    'Blood Transfer Dispatched': 'transfer_dispatched',
    'Blood Transfer Completed': 'transfer_completed',
    'Blood Transfer Cancelled': 'transfer_cancelled',
};

export async function fetchInventoryMovements(hospitalName, max = 30) {
    const movements = [];

    try {
        const logsQuery = query(
            collection(db, 'activity_logs'),
            where('title', 'in', Object.keys(INVENTORY_MOVEMENT_TITLES))
        );
        const logSnap = await getDocs(logsQuery);
        logSnap.docs.forEach(doc => {
            const log = doc.data();
            if (log.description?.includes(hospitalName)) {
                const mappedType = INVENTORY_MOVEMENT_TITLES[log.title];
                movements.push({
                    id: doc.id,
                    type: mappedType || (log.description?.includes('Added') ? 'addition' : 'removal'),
                    bloodType: extractBloodType(log.description),
                    units: extractUnits(log.description),
                    description: log.description,
                    timestamp: log.timestamp,
                    source: log.title
                });
            }
        });
    } catch (e) {
        console.warn('Failed to fetch inventory movements from logs:', e);
    }

    return movements.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, max);
}

function extractBloodType(text) {
    const match = text?.match(/\b(A\+|A-|B\+|B-|O\+|O-|AB\+|AB-)\b/);
    return match ? match[0] : '—';
}

function extractUnits(text) {
    const match = text?.match(/(\d+)\s*unit/);
    return match ? parseInt(match[1], 10) : null;
}

// ============================================
// DONOR ENGAGEMENT — Points, Badges, Tiers
// ============================================

export async function computeDonorEngagement(donorId) {
    const userDoc = doc(db, 'users', donorId);
    const snapshot = await getDoc(userDoc);
    if (!snapshot.exists()) return null;

    const donor = { id: snapshot.id, ...snapshot.data() };

    // Query by donorId AND by cniHash so donation history follows the person across accounts
    const donationsMap = new Map();

    const byDonorQ = query(
        collection(db, 'donation_requests'),
        where('donorId', '==', donorId)
    );
    const byDonorSnap = await getDocs(byDonorQ);
    for (const d of byDonorSnap.docs) {
        donationsMap.set(d.id, { id: d.id, ...d.data() });
    }

    if (donor.cniHash) {
        try {
            const byCniQ = query(
                collection(db, 'donation_requests'),
                where('cniHash', '==', donor.cniHash)
            );
            const byCniSnap = await getDocs(byCniQ);
            for (const d of byCniSnap.docs) {
                if (!donationsMap.has(d.id)) {
                    donationsMap.set(d.id, { id: d.id, ...d.data() });
                }
            }
        } catch (e) {
            console.warn('Could not fetch donations by cniHash:', e);
        }
    }

    const donations = Array.from(donationsMap.values());
    const completedDonations = donations.filter(d => d.status === 'completed');

    const donationCount = completedDonations.length;
    const totalUnits = completedDonations.reduce((sum, d) => sum + (d.units || 1), 0);
    const points = donationCount * 10 + totalUnits * 5;

    let tier = 'Bronze';
    let tierIcon = 'shield';
    let tierColor = '#CD7F32';
    let nextTier = 'Silver';
    let nextTierProgress = Math.min(100, (donationCount / 5) * 100);
    if (donationCount >= 20) { tier = 'Platinum'; tierIcon = 'diamond'; tierColor = '#94A3B8'; nextTier = null; nextTierProgress = 100; }
    else if (donationCount >= 10) { tier = 'Gold'; tierIcon = 'stars'; tierColor = '#FFD700'; nextTier = 'Platinum'; nextTierProgress = ((donationCount - 10) / 10) * 100; }
    else if (donationCount >= 5) { tier = 'Silver'; tierIcon = 'workspace_premium'; tierColor = '#C0C0C0'; nextTier = 'Gold'; nextTierProgress = ((donationCount - 5) / 5) * 100; }

    const badges = [];
    if (donationCount >= 1) badges.push({ name: 'First Donation', icon: 'favorite', color: '#EF4444' });
    if (donationCount >= 5) badges.push({ name: 'Regular Donor', icon: 'repeat', color: '#8B5CF6' });
    if (donationCount >= 10) badges.push({ name: 'Life Saver', icon: 'favorite', color: '#FFD700' });
    if (donationCount >= 20) badges.push({ name: 'Guardian Angel', icon: 'shield', color: '#14B8A6' });
    if (totalUnits >= 15) badges.push({ name: 'Generous Heart', icon: 'volunteer_activism', color: '#F97316' });
    if (donor.bloodType === 'O-' && donationCount >= 3) badges.push({ name: 'Universal Donor', icon: 'public', color: '#22C55E' });

    return {
        donationCount,
        totalUnits,
        points,
        tier,
        tierIcon,
        tierColor,
        nextTier,
        nextTierProgress,
        badges,
        donations
    };
}

export async function saveDonorEngagement(donorId, engagement) {
    const userDoc = doc(db, 'users', donorId);
    await updateDoc(userDoc, {
        points: engagement.points,
        tier: engagement.tier,
        donationCount: engagement.donationCount,
        badges: engagement.badges,
        updatedAt: new Date().toISOString()
    });
}

// ============================================
// SMS / WHATSAPP NOTIFICATIONS
// ============================================

function formatPhone(phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.startsWith('237')) return digits;
    if (digits.startsWith('0')) return '237' + digits.slice(1);
    return '237' + digits;
}

function smsLink(phone, message) {
    return `sms:+${formatPhone(phone)}?&body=${encodeURIComponent(message)}`;
}

function waLink(phone, message) {
    return `https://wa.me/${formatPhone(phone)}?text=${encodeURIComponent(message)}`;
}

window.smsLink = smsLink;
window.waLink = waLink;

export async function sendSmsNotification(phone, message) {
    const link = smsLink(phone, message);
    const docRef = await addDoc(collection(db, 'notification_log'), {
        channel: 'sms',
        recipient: phone,
        message,
        link,
        status: 'sent',
        attempts: 1,
        sentAt: new Date().toISOString()
    });
    await logActivity('SMS Sent', `SMS to ${phone}: ${message.slice(0, 60)}...`, 'info');
    return { channel: 'sms', phone, message, link, id: docRef.id, status: 'sent' };
}

export async function sendWhatsAppNotification(phone, message) {
    const link = waLink(phone, message);
    const docRef = await addDoc(collection(db, 'notification_log'), {
        channel: 'whatsapp',
        recipient: phone,
        message,
        link,
        status: 'sent',
        attempts: 1,
        sentAt: new Date().toISOString()
    });
    await logActivity('WhatsApp Sent', `WhatsApp to ${phone}: ${message.slice(0, 60)}...`, 'info');
    return { channel: 'whatsapp', phone, message, link, id: docRef.id, status: 'sent' };
}

export async function retryNotification(logId, maxRetries = 2) {
    const logRef = doc(db, 'notification_log', logId);
    const snap = await getDoc(logRef);
    if (!snap.exists()) throw new Error('Notification log not found');
    const log = snap.data();
    if (log.status === 'sent') return log;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (log.channel === 'sms') await sendSmsNotification(log.recipient, log.message);
            else if (log.channel === 'whatsapp') await sendWhatsAppNotification(log.recipient, log.message);
            await updateDoc(logRef, { status: 'sent', attempts: attempt + 1, retriedAt: new Date().toISOString() });
            return { ...log, status: 'sent', attempts: attempt + 1 };
        } catch (e) {
            if (attempt === maxRetries) {
                await updateDoc(logRef, { status: 'failed', attempts: attempt + 1, lastError: e.message, failedAt: new Date().toISOString() });
                return { ...log, status: 'failed', attempts: attempt + 1 };
            }
        }
    }
}

// ============================================
// CENTRALIZED NOTIFICATION DISPATCH
// Checks user preferences (notifSms, notifWhatsapp) before sending.
// Also supports notificationPrefs type gates (urgent/donor/stock) for hospitals.
// ============================================

export function shouldNotify(user, channel) {
    if (!user) return false;
    if (channel === 'sms') return user.notifSms !== false;
    if (channel === 'whatsapp') return user.notifWhatsapp === true;
    return false;
}

export function shouldNotifyByType(user, type) {
    if (!user) return false;
    const prefs = user.notificationPrefs || {};
    if (type === 'urgent' && prefs.urgent === false) return false;
    if (type === 'donor' && prefs.donor === false) return false;
    if (type === 'stock' && prefs.stock === false) return false;
    return true;
}

export async function notifyUser(user, message, { type = null, channels = ['sms', 'whatsapp'] } = {}) {
    if (!user || !user.phone) return;
    if (type && !shouldNotifyByType(user, type)) return;

    const results = [];
    if (channels.includes('sms') && shouldNotify(user, 'sms')) {
        results.push(sendSmsNotification(user.phone, message).catch(e => {
            console.warn('SMS delivery failed:', e);
            return { channel: 'sms', status: 'failed', error: e.message };
        }));
    }
    if (channels.includes('whatsapp') && shouldNotify(user, 'whatsapp')) {
        results.push(sendWhatsAppNotification(user.phone, message).catch(e => {
            console.warn('WhatsApp delivery failed:', e);
            return { channel: 'whatsapp', status: 'failed', error: e.message };
        }));
    }
    return Promise.all(results);
}

export async function fetchNotificationLog(hospitalName, max = 20) {
    const q = query(
        collection(db, 'notification_log'),
        orderBy('sentAt', 'desc'),
        limit(50)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(log => !hospitalName || log.message?.toLowerCase().includes(hospitalName.toLowerCase()))
        .slice(0, max);
}

// ============================================
// CAMPAIGN PARTICIPATION
// ============================================

export async function joinCampaign(campaignId, hospitalName, hospitalCity) {
    const campaignDoc = doc(db, 'campaigns', campaignId);

    // Transaction guards against two hospitals joining at the same moment — without
    // it, both reads see the same participants array and the second write drops the first join.
    const campaignTitle = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(campaignDoc);
        if (!snapshot.exists()) throw new Error('Campaign not found');

        const campaign = snapshot.data();
        const participants = campaign.participants || [];

        if (participants.some(p => p.hospitalName === hospitalName)) {
            throw new Error('Already joined this campaign');
        }

        participants.push({
            hospitalName,
            hospitalCity: hospitalCity || '',
            joinedAt: new Date().toISOString()
        });

        transaction.update(campaignDoc, {
            participants,
            participantCount: participants.length,
            updatedAt: new Date().toISOString()
        });

        return campaign.title;
    });

    await logActivity('Campaign Joined', `${hospitalName} joined campaign "${campaignTitle}"`, 'info');
    return { campaignId, hospitalName };
}

export async function leaveCampaign(campaignId, hospitalName) {
    const campaignDoc = doc(db, 'campaigns', campaignId);

    const campaignTitle = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(campaignDoc);
        if (!snapshot.exists()) throw new Error('Campaign not found');

        const campaign = snapshot.data();
        const participants = (campaign.participants || []).filter(p => p.hospitalName !== hospitalName);

        transaction.update(campaignDoc, {
            participants,
            participantCount: participants.length,
            updatedAt: new Date().toISOString()
        });

        return campaign.title;
    });

    await logActivity('Campaign Left', `${hospitalName} left campaign "${campaignTitle}"`, 'warning');
    return { campaignId, hospitalName };
}

// A donor registering interest in a campaign is a separate concept from a hospital joining as
// an organizing participant (joinCampaign/leaveCampaign above, which write to the campaign doc
// itself, keyed by hospitalName). Donors don't have write access to the `campaigns` collection
// (Firestore rules restrict campaign updates to hospital/admin roles), so donor interest is
// recorded as its own record in `donor_engagement` instead — a collection donors can already
// write to — rather than mutating the campaign document.
export async function donorJoinCampaign(campaignId, donorId, donorName, campaignTitle = '') {
    const existing = await fetchDonorCampaignInterest(donorId);
    if (existing.some(e => e.campaignId === campaignId)) {
        throw new Error('Already registered interest in this campaign');
    }

    await addDoc(collection(db, 'donor_engagement'), {
        type: 'campaign_interest',
        campaignId,
        donorId,
        donorName,
        campaignTitle,
        createdAt: new Date().toISOString()
    });

    await logActivity('Donor Interested in Campaign', `${donorName} registered interest in campaign "${campaignTitle}"`, 'info');
    return { campaignId, donorId };
}

export async function donorLeaveCampaign(campaignId, donorId) {
    const q = query(
        collection(db, 'donor_engagement'),
        where('type', '==', 'campaign_interest'),
        where('donorId', '==', donorId)
    );
    const snapshot = await getDocs(q);
    const deletions = snapshot.docs
        .filter(d => d.data().campaignId === campaignId)
        .map(d => deleteDoc(doc(db, 'donor_engagement', d.id)));
    await Promise.all(deletions);
    return { campaignId, donorId };
}

// Every campaign_interest record for one donor — used both to check "am I interested in this
// campaign" and to render their interest state without a composite index (campaignId is
// filtered client-side, donorId is the only server-side equality filter needed).
export async function fetchDonorCampaignInterest(donorId) {
    const q = query(
        collection(db, 'donor_engagement'),
        where('type', '==', 'campaign_interest'),
        where('donorId', '==', donorId)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

// The other direction — every donor interested in one campaign, for admin's campaign
// participants view. Same client-side-filter approach to avoid a composite index.
export async function fetchCampaignInterestedDonors(campaignId) {
    const q = query(
        collection(db, 'donor_engagement'),
        where('type', '==', 'campaign_interest')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => d.campaignId === campaignId);
}

export async function fetchHospitalCampaigns(hospitalName) {
    const campaigns = await fetchAllCampaigns();
    return campaigns.map(c => {
        const participants = c.participants || [];
        const hasJoined = participants.some(p => p.hospitalName === hospitalName);
        return { ...c, hasJoined, participantCount: participants.length };
    });
}

// ============================================
// PHASE 1: PUBLIC EMERGENCY REQUESTS
// ============================================

// Phone Trust Score — determines if a public submitter is Standard, Downgraded
// (forced Track B), or Blocked (rejected outright). First-time submitters are
// implicitly Standard since no record exists for their number.
export async function getPhoneTrustScore(phone) {
    const q = query(collection(db, 'phone_trust'), where('phone', '==', phone));
    const snap = await getDocs(q);
    if (snap.empty) return { trustLevel: 'standard', flagCount: 0 };
    const data = snap.docs[0].data();
    return { trustLevel: data.trustLevel || 'standard', flagCount: data.flagCount || 0, id: snap.docs[0].id };
}

export async function downgradePhoneTrust(phone, reason, level = 'downgraded') {
    const existing = await getPhoneTrustScore(phone);
    if (existing.id) {
        await updateDoc(doc(db, 'phone_trust', existing.id), {
            trustLevel: level,
            reason,
            flagCount: (existing.flagCount || 0) + 1,
            updatedAt: new Date().toISOString()
        });
    } else {
        await addDoc(collection(db, 'phone_trust'), {
            phone,
            trustLevel: level,
            reason,
            flagCount: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }
    await logActivity('Phone Trust Downgraded', `Phone ${phone.slice(0, 6)}*** downgraded to "${level}" — ${reason}`, 'warning');
}

// Shadow Hospital — auto-created when a family names a hospital that isn't on
// VitalPulse yet. Aggregates demand so admins can target outreach.
export async function ensureShadowHospital(hospitalName, city) {
    const allShadows = await getDocs(collection(db, 'shadow_hospitals'));
    const nameLower = hospitalName.trim().toLowerCase();
    const match = allShadows.docs.find(d => (d.data().name || '').trim().toLowerCase() === nameLower);

    if (match) {
        await updateDoc(doc(db, 'shadow_hospitals', match.id), {
            requestCount: (match.data().requestCount || 0) + 1,
            lastRequestAt: new Date().toISOString()
        });
        return match.id;
    }

    const ref = await addDoc(collection(db, 'shadow_hospitals'), {
        name: hospitalName.trim(),
        city: city || 'Unknown',
        requestCount: 1,
        status: 'unclaimed',
        contactPhone: null,
        contactEmail: null,
        inviteSentAt: null,
        inviteCount: 0,
        createdAt: new Date().toISOString(),
        lastRequestAt: new Date().toISOString()
    });
    return ref.id;
}

export async function fetchShadowHospitals() {
    const snap = await getDocs(collection(db, 'shadow_hospitals'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.requestCount || 0) - (a.requestCount || 0));
}

export async function updateShadowHospitalContact(shadowId, contactPhone, contactEmail) {
    await updateDoc(doc(db, 'shadow_hospitals', shadowId), {
        contactPhone: contactPhone || null,
        contactEmail: contactEmail || null,
        updatedAt: new Date().toISOString()
    });
}

export async function sendPartnerInvitation(shadowId) {
    const snap = await getDoc(doc(db, 'shadow_hospitals', shadowId));
    if (!snap.exists()) throw new Error('Shadow hospital not found');
    const data = snap.data();
    if (!data.contactPhone && !data.contactEmail) {
        throw new Error('No contact info available. Add a phone or email first.');
    }

    const msg = `[VitalPulse] ${data.requestCount} patients at ${data.name} have requested blood through VitalPulse! Register your hospital for free to get faster donor matching & direct inventory access: vitalpulse.org/claim?id=${shadowId.slice(0, 8)}`;
    if (data.contactPhone) {
        await sendSmsNotification(data.contactPhone, msg).catch(() => {});
    }

    await updateDoc(doc(db, 'shadow_hospitals', shadowId), {
        inviteSentAt: new Date().toISOString(),
        inviteCount: (data.inviteCount || 0) + 1,
        status: 'invite_sent'
    });

    await logActivity('Partner Invite Sent', `Invitation sent to ${data.name} (${data.city}) — ${data.requestCount} patient requests on record`, 'info');
}

// The main public request submission — the two-track dispatch engine.
// Track A = instant broadcast (critical/maternal + trusted phone).
// Track B = admin review first (routine requests or downgraded phones).
export async function submitPublicRequest(requestData) {
    const phone = requestData.contactPhone;
    const trust = await getPhoneTrustScore(phone);

    if (trust.trustLevel === 'blocked') {
        throw new Error('This phone number has been restricted from submitting public requests due to previous abuse. Contact VitalPulse support if you believe this is an error.');
    }

    const isCriticalCategory = ['Maternal Hemorrhage', 'Trauma'].includes(requestData.category);
    const isCriticalUrgency = requestData.urgency === 'Critical';
    const isPhoneTrusted = trust.trustLevel !== 'downgraded';

    // Track A: immediate broadcast for critical categories + trusted phones
    // Track B: everything else (routine categories, or downgraded phones)
    const track = (isCriticalCategory && isCriticalUrgency && isPhoneTrusted) ? 'A' : 'B';
    const status = track === 'A' ? 'Broadcasting' : 'Pending Review';

    // Check if the named hospital is a registered partner
    const registeredCheck = await getDocs(query(
        collection(db, 'users'),
        where('name', '==', requestData.hospitalName),
        where('role', '==', 'hospital')
    ));
    const isRegisteredHospital = !registeredCheck.empty;

    // Create/update shadow hospital if not registered
    let shadowHospitalId = null;
    if (!isRegisteredHospital) {
        shadowHospitalId = await ensureShadowHospital(requestData.hospitalName, requestData.city);
    }

    const cityCoords = CITY_COORDINATES[requestData.city] || null;

    // A public request can never be blocked on proof, but donors and admin should still be
    // able to tell at a glance how much soft evidence backs it. Hospital-Confirmed beats
    // Document Attached beats Unverified, matching the tiers donors are shown.
    const verificationLevel = isRegisteredHospital
        ? 'Hospital-Confirmed'
        : requestData.documentUrl ? 'Document Attached' : 'Unverified';

    const docRef = await addDoc(collection(db, 'public_requests'), {
        hospitalName: requestData.hospitalName,
        ward: requestData.ward || null,
        city: requestData.city,
        cityLat: cityCoords?.lat || null,
        cityLng: cityCoords?.lon || null,
        submitterLat: requestData.submitterLat || null,
        submitterLng: requestData.submitterLng || null,
        locationSource: requestData.locationSource || 'none',
        bloodType: requestData.bloodType,
        componentType: requestData.componentType || 'Whole Blood',
        units: requestData.units || 1,
        urgency: requestData.urgency,
        category: requestData.category,
        contactPhone: phone,
        relationship: requestData.relationship,
        submitterName: requestData.submitterName || 'Anonymous',
        documentUrl: requestData.documentUrl || null,
        pickupInstructions: requestData.pickupInstructions || '',
        // Patient name stored for internal admin/hospital reference ONLY.
        // NEVER included in donor-facing broadcasts (privacy).
        patientName: requestData.patientName || null,
        internalOnly: true,
        verificationLevel,
        track,
        status,
        phoneTrust: trust.trustLevel,
        isRegisteredHospital,
        shadowHospitalId,
        escalationLevel: 0,
        escalationRadiusKm: 25,
        needsHumanIntervention: false,
        createdAt: new Date().toISOString(),
        resolvedAt: null
    });

    const adminMsg = track === 'A'
        ? `🚨 PUBLIC EMERGENCY (Track A — Broadcasting): ${requestData.category} at ${requestData.hospitalName} (${requestData.city}) — ${requestData.bloodType} ${requestData.componentType} ×${requestData.units}. Phone trust: ${trust.trustLevel}.`
        : `📋 Public Request (Track B — Awaiting Review): ${requestData.category} at ${requestData.hospitalName} (${requestData.city}) — ${requestData.bloodType}. Verify before broadcasting.`;

    await createAdminNotification(
        track === 'A' ? 'Public Emergency Alert' : 'Public Request Awaiting Review',
        adminMsg,
        track === 'A' ? 'warning' : 'info',
        null,
        'public-triage'
    );

    await logActivity(
        'Public Request Submitted',
        `${requestData.category} at ${requestData.hospitalName} (${requestData.city}) — Track ${track}`,
        track === 'A' ? 'warning' : 'info'
    );

    // Track A: actively push the request to nearby compatible donors
    if (track === 'A') {
        const bloodTypeNeeded = requestData.bloodType;
        const componentType = requestData.componentType || 'Whole Blood';
        const compatibleTypes = getCompatibleDonorTypes(bloodTypeNeeded, componentType);
        const maxRadiusKm = requestData.urgency === 'Critical' ? 50 : 25;
        const hospCoords = getCoordinatesForLocation(requestData.city, cityCoords?.lat, cityCoords?.lon);

        const donorsQuery = query(
            collection(db, 'users'),
            where('role', '==', 'donor'),
            where('bloodType', 'in', compatibleTypes),
            where('isAvailable', '==', true),
            limit(100)
        );

        const donorSnap = await getDocs(donorsQuery);
        let matchingDonors = [];

        for (const donorDoc of donorSnap.docs) {
            const donor = { id: donorDoc.id, ...donorDoc.data() };
            if (donor.isSuspended) continue;

            // Donor GPS coords are stored as lat/lng (see donor-dashboard.js's
            // enableLiveGpsLocation), not lat/lon — pass donor.lng here, not donor.lon,
            // or this always falls through to the city-centroid fallback.
            const donorCoords = getCoordinatesForLocation(donor.city, donor.lat, donor.lng);
            let dist = null;
            if (hospCoords && donorCoords) {
                dist = calculateDistanceKm(hospCoords.lat, hospCoords.lon, donorCoords.lat, donorCoords.lon);
            }

            const isExactCity = requestData.city && donor.city && donor.city.trim().toLowerCase() === requestData.city.trim().toLowerCase();
            const isWithinRadius = dist !== null && dist <= maxRadiusKm;

            if (isExactCity || isWithinRadius) {
                donor.matchedDistanceKm = dist;
                matchingDonors.push(donor);
            }
        }

        // Trusted, proven donors are notified first — same reasoning as autoMatchDonors.
        matchingDonors.sort((a, b) => (b.donationCount || 0) - (a.donationCount || 0));

        for (const donor of matchingDonors) {
            const dist = donor.matchedDistanceKm;
            const distanceLabel = dist !== null ? ` (~${dist} km away)` : '';
            const msg = `[VitalPulse] 🆘 Public emergency blood request! ${bloodTypeNeeded} (${componentType}) needed at ${requestData.hospitalName}${distanceLabel}. Your compatibility matches. Please respond in app.`;
            if (donor.phone) {
                if (donor.notifSms !== false) await sendSmsNotification(donor.phone, msg).catch(() => {});
                if (donor.notifWhatsapp === true) await sendWhatsAppNotification(donor.phone, msg).catch(() => {});
            }
            await addDonorNotification(
                donor.id,
                'Emergency Blood Request',
                `🆘 ${bloodTypeNeeded} (${componentType}) needed urgently at ${requestData.hospitalName}${distanceLabel}. Urgency: ${requestData.urgency}`,
                'error'
            );
        }

        if (matchingDonors.length > 0) {
            await updateDoc(docRef, {
                matchingDonorsNotified: matchingDonors.map(d => d.id),
                matchingDonorsCount: matchingDonors.length,
                notifiedAt: new Date().toISOString()
            });

            await logActivity(
                'Donors Notified',
                `${matchingDonors.length} compatible donor(s) alerted for public request #${docRef.id.slice(0, 8)} (${bloodTypeNeeded}) — ${requestData.hospitalName}`,
                'info'
            );
        }
    }

    return { id: docRef.id, track, status };
}

export async function fetchPublicRequests(statusFilter = null) {
    const snap = await getDocs(collection(db, 'public_requests'));
    let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (statusFilter) {
        results = results.filter(r => r.status === statusFilter);
    }
    return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function approvePublicRequest(requestId) {
    const reqDoc = doc(db, 'public_requests', requestId);
    await updateDoc(reqDoc, {
        status: 'Broadcasting',
        track: 'A',
        approvedAt: new Date().toISOString()
    });
    await logActivity('Public Request Approved', `Admin approved public request #${requestId.slice(0, 8)} — now broadcasting to donors`, 'success');
}

export async function flagPublicRequest(requestId, reason) {
    const reqDoc = doc(db, 'public_requests', requestId);
    const snap = await getDoc(reqDoc);
    const data = snap.exists() ? snap.data() : {};

    await updateDoc(reqDoc, {
        status: 'Flagged',
        flagReason: reason,
        flaggedAt: new Date().toISOString()
    });

    // Downgrade the submitter's phone trust
    if (data.contactPhone) {
        await downgradePhoneTrust(data.contactPhone, `Flagged request #${requestId.slice(0, 8)}: ${reason}`);
    }

    await logActivity('Public Request Flagged', `Request #${requestId.slice(0, 8)} flagged as suspicious: ${reason}`, 'error');
}

export async function resolvePublicRequest(requestId) {
    await updateDoc(doc(db, 'public_requests', requestId), {
        status: 'Resolved',
        resolvedAt: new Date().toISOString()
    });
    await logActivity('Public Request Resolved', `Public request #${requestId.slice(0, 8)} resolved`, 'success');
}

// Timed escalation — called by the client-side escalation timer when a critical
// public request goes unanswered. Expands search radius and, at Level 3, triggers
// the human-in-the-loop floor (persistent admin alert + family hotline).
export async function escalatePublicRequest(requestId, newLevel) {
    const radiusMap = { 1: 50, 2: 999, 3: 999 };
    const update = {
        escalationLevel: newLevel,
        escalationRadiusKm: radiusMap[newLevel] || 25,
        [`escalatedToLevel${newLevel}At`]: new Date().toISOString()
    };

    if (newLevel >= 3) {
        update.needsHumanIntervention = true;
    }

    await updateDoc(doc(db, 'public_requests', requestId), update);

    const levelLabels = { 1: 'Regional (50km)', 2: 'National Scope', 3: '🚨 HUMAN FLOOR — Admin Call Required' };
    const label = levelLabels[newLevel] || `Level ${newLevel}`;

    if (newLevel >= 3) {
        await createAdminNotification(
            '🚨 UNANSWERED EMERGENCY — Human Intervention Required',
            `Public request #${requestId.slice(0, 8)} has been unanswered for 15+ minutes after national broadcast. CALL the regional blood bank command immediately.`,
            'error',
            null,
            'public-triage'
        );
    }

    await logActivity('Emergency Escalated', `Public request #${requestId.slice(0, 8)} escalated to ${label}`, 'warning');
}

// Donor-facing query: fetch broadcasting public requests within the donor's radius,
// filtered by blood type compatibility. STRIPS all patient PII before returning.
export async function fetchPublicRequestsForDonor(donorLat, donorLng, donorBloodType) {
    const snap = await getDocs(query(
        collection(db, 'public_requests'),
        where('status', '==', 'Broadcasting')
    ));

    const compatible = getCompatibleDonorTypes(null); // fallback
    const donorCanDonate = (requestedType) => {
        // Simple compatibility: exact match or O- universal donor
        return requestedType === donorBloodType || donorBloodType === 'O-';
    };

    return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(r => {
            if (!donorCanDonate(r.bloodType)) return false;
            if (!r.cityLat || !r.cityLng || !donorLat || !donorLng) return true; // no coords = show anyway
            const dist = calculateDistanceKm(donorLat, donorLng, r.cityLat, r.cityLng);
            return dist <= (r.escalationRadiusKm || 25);
        })
        .map(r => {
            const dist = (r.cityLat && r.cityLng && donorLat && donorLng)
                ? Math.round(calculateDistanceKm(donorLat, donorLng, r.cityLat, r.cityLng))
                : null;
            // PRIVACY: strip patient name, internal fields, and the submitter's exact
            // personal GPS coordinates (donors only need city-level distance, not a family
            // member's precise device location).
            const { patientName, internalOnly, contactPhone, submitterLat, submitterLng, ...safe } = r;
            return { ...safe, distanceKm: dist };
        })
        .sort((a, b) => {
            const urgencyRank = { 'Critical': 0, 'Urgent': 1, 'Standard': 2 };
            const ua = urgencyRank[a.urgency] ?? 9;
            const ub = urgencyRank[b.urgency] ?? 9;
            if (ua !== ub) return ua - ub;
            return (a.distanceKm || 999) - (b.distanceKm || 999);
        });
}

export async function acceptPublicRequest(requestId, donorId, screeningData = {}) {
    const reqDoc = doc(db, 'public_requests', requestId);

    // Lock check: check if donor has any other request currently assigned or en route
    const activeReqsQuery = query(
        collection(db, 'requests'),
        where('matchedDonor', '==', donorId),
        where('status', 'in', ['Donor Assigned', 'Donor En Route'])
    );
    const activeSnap = await getDocs(activeReqsQuery);

    const activePublicQuery = query(
        collection(db, 'public_requests'),
        where('matchedDonor', '==', donorId),
        where('status', 'in', ['Donor Assigned', 'Donor En Route'])
    );
    const activePublicSnap = await getDocs(activePublicQuery);

    if (!activeSnap.empty || !activePublicSnap.empty) {
        throw new Error('You already have an active donation request in progress. Please complete or cancel your current commitment before accepting another.');
    }

    // 56-Day Medical Deferral Lock: prevent accepting requests before the mandatory wait period
    try {
        const donorRef = doc(db, 'users', donorId);
        const donorSnap = await getDoc(donorRef);
        if (donorSnap.exists()) {
            const donorData = donorSnap.data();
            const lastDate = donorData.lastDonationDate || donorData.lastDonatedAt;
            if (lastDate) {
                const daysAgo = (new Date().getTime() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24);
                if (daysAgo < 56) {
                    throw new Error(`WHO medical deferral: You last donated ${Math.round(daysAgo)} days ago. A minimum of 56 days is required between whole blood donations for your safety.`);
                }
            }
        }
    } catch (e) {
        if (e.message?.includes('WHO medical deferral')) throw e;
    }

    const checkInToken = 'VP-' + Math.floor(1000 + Math.random() * 9000);

    const reqData = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(reqDoc);
        if (!snapshot.exists()) throw new Error('Request not found');
        const data = snapshot.data();
        if (data.status !== 'Broadcasting') {
            throw new Error('This request has already been accepted by another donor.');
        }
        transaction.update(reqDoc, {
            status: 'Donor Assigned',
            matchedDonor: donorId,
            matchedAt: new Date().toISOString(),
            checkInToken,
            donorScreeningPassed: screeningData.screeningPassed !== false
        });
        return data;
    });

    await logActivity(
        'Public Request Accepted',
        `Donor accepted public request #${requestId.slice(0, 8)} — ${reqData.bloodType} needed at ${reqData.hospitalName} (Token: ${checkInToken})`,
        'success'
    );

    // Notify the hospital (if registered) that a donor has accepted
    const hospitalName = reqData.hospitalName || '';
    if (hospitalName && reqData.isRegisteredHospital) {
        const hospitalsQuery = query(
            collection(db, 'users'),
            where('name', '==', hospitalName),
            where('role', '==', 'hospital'),
            limit(5)
        );
        const hospitalSnap = await getDocs(hospitalsQuery);
        for (const hDoc of hospitalSnap.docs) {
            const hospital = hDoc.data();
            const msg = `[VitalPulse] A donor has accepted your public ${reqData.bloodType || 'blood'} request (#${requestId.slice(0, 8).toUpperCase()}). They are on their way. Pass Code: ${checkInToken}`;
            if (hospital.phone && shouldNotifyByType(hospital, 'donor')) {
                if (hospital.notifSms !== false) await sendSmsNotification(hospital.phone, msg).catch(() => {});
                if (hospital.notifWhatsapp === true) await sendWhatsAppNotification(hospital.phone, msg).catch(() => {});
            }
            await addHospitalNotification(hDoc.id, 'Donor Assigned (Public)', msg, 'success', 'requests');
        }
    }

    return { checkInToken, hospitalName: reqData.hospitalName };
}

export async function adminProxyCheckInDonor(requestId, checkInToken, labConfirmedType = null) {
    const reqDoc = doc(db, 'public_requests', requestId);
    const snap = await getDoc(reqDoc);
    if (!snap.exists()) throw new Error('Public request not found');
    const data = snap.data();

    // Normalize: strip all non-alphanumeric chars (except dash) and uppercase for comparison
    const normalize = (s) => (s || '').replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
    if (normalize(data.checkInToken) !== normalize(checkInToken)) {
        throw new Error(`Invalid Pass Code. Expected: ${data.checkInToken || 'unknown'}, got: ${checkInToken}`);
    }

    await updateDoc(reqDoc, {
        status: 'Completed',
        checkedInAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        labConfirmedBloodType: labConfirmedType || data.bloodType,
        verifiedByAdminProxy: true
    });

    // Record the donation so blood actually enters inventory
    if (data.matchedDonor) {
        try {
            await recordDonationIntake({
                donorId: data.matchedDonor,
                donorName: data.donorName || 'Donor',
                hospital: data.hospitalName,
                bloodType: data.bloodType,
                labConfirmedBloodType: labConfirmedType || null,
                componentType: data.componentType || 'Whole Blood',
                units: data.units || 1,
                sourceRequestId: requestId,
                notes: `Admin proxy check-in (shadow hospital)`
            });
        } catch (e) {
            console.warn('[adminProxyCheckInDonor] recordDonationIntake failed:', e);
        }
    }

    await logActivity(
        'Admin Proxy Intake',
        `Admin verified donor intake for shadow hospital ${data.hospitalName} (Pass Code ${checkInToken})`,
        'success'
    );
}

// ============================================
// PHASE 2: MULTI-HOSPITAL INVENTORY CHECK
// ============================================

export async function checkNetworkInventory(bloodType, componentType = null, requestingHospitalName = '') {
    try {
        const snapshot = await getDocs(collection(db, 'inventory'));
        const matches = [];

        snapshot.docs.forEach(docSnap => {
            const data = docSnap.data();
            const hospitalName = data.hospitalName || data.hospital;

            // Exclude requesting hospital
            if (requestingHospitalName && hospitalName && hospitalName.toLowerCase().trim() === requestingHospitalName.toLowerCase().trim()) {
                return;
            }

            // Filter for blood type match and cleared/available status
            if (data.bloodType === bloodType) {
                const isCleared = (data.testStatus === 'Cleared' || data.status === 'Cleared' || !data.testStatus);
                const quantity = parseInt(data.quantity || data.units || 0, 10);

                if (isCleared && quantity > 0) {
                    if (componentType && data.componentType && data.componentType !== componentType) {
                        return; // Component mismatch
                    }

                    matches.push({
                        inventoryId: docSnap.id,
                        hospitalName: hospitalName || 'Partner Hospital',
                        city: data.city || 'Regional Center',
                        bloodType: data.bloodType,
                        componentType: data.componentType || 'Whole Blood',
                        unitsAvailable: quantity,
                        expiryDate: data.expiryDate || 'N/A'
                    });
                }
            }
        });

        return matches.sort((a, b) => b.unitsAvailable - a.unitsAvailable);
    } catch (e) {
        console.error('Failed to check network inventory:', e);
        return [];
    }
}

// ============================================
// PHASE 2: INTER-HOSPITAL BLOOD TRANSFERS
// ============================================

export async function createBloodTransferRequest(transferData) {
    const newDoc = doc(collection(db, 'blood_transfers'));
    const payload = {
        id: newDoc.id,
        requestingHospital: transferData.requestingHospital,
        targetHospital: transferData.targetHospital,
        bloodType: transferData.bloodType,
        componentType: transferData.componentType || 'Whole Blood',
        units: parseInt(transferData.units || 1, 10),
        urgency: transferData.urgency || 'Standard',
        notes: transferData.notes || '',
        status: 'Requested', // Requested -> In Transit -> Completed / Cancelled
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    await setDoc(newDoc, payload);

    await logActivity(
        'Blood Transfer Requested',
        `${transferData.requestingHospital} requested ${payload.units} unit(s) of ${payload.bloodType} from ${transferData.targetHospital}`,
        'warning',
        transferData.requestingHospital
    );

    return payload;
}

export async function dispatchBloodTransfer(transferId) {
    const ref = doc(db, 'blood_transfers', transferId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('Transfer request not found');

    const data = snap.data();
    await updateDoc(ref, {
        status: 'In Transit',
        dispatchedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    await logActivity(
        'Blood Transfer Dispatched',
        `${data.targetHospital} dispatched ${data.units} unit(s) of ${data.bloodType} to ${data.requestingHospital}`,
        'info',
        data.targetHospital
    );
}

export async function receiveBloodTransfer(transferId) {
    const ref = doc(db, 'blood_transfers', transferId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('Transfer request not found');

    const data = snap.data();
    if (data.status === 'Completed') throw new Error('Transfer already completed');

    // 1. Deduct stock from target/source hospital
    const targetQuery = query(
        collection(db, 'inventory'),
        where('hospitalName', '==', data.targetHospital),
        where('bloodType', '==', data.bloodType)
    );
    const targetSnap = await getDocs(targetQuery);
    if (!targetSnap.empty) {
        const stockDoc = targetSnap.docs[0];
        const currentQty = stockDoc.data().quantity || 0;
        const newQty = Math.max(0, currentQty - data.units);
        await updateDoc(doc(db, 'inventory', stockDoc.id), {
            quantity: newQty,
            units: newQty
        });
    }

    // 2. Add stock to requesting hospital as cleared inventory
    const reqQuery = query(
        collection(db, 'inventory'),
        where('hospitalName', '==', data.requestingHospital),
        where('bloodType', '==', data.bloodType)
    );
    const reqSnap = await getDocs(reqQuery);
    if (!reqSnap.empty) {
        const stockDoc = reqSnap.docs[0];
        const currentQty = stockDoc.data().quantity || 0;
        await updateDoc(doc(db, 'inventory', stockDoc.id), {
            quantity: currentQty + data.units,
            units: currentQty + data.units
        });
    } else {
        // Create inventory record
        const newInvDoc = doc(collection(db, 'inventory'));
        await setDoc(newInvDoc, {
            hospitalName: data.requestingHospital,
            bloodType: data.bloodType,
            componentType: data.componentType || 'Whole Blood',
            quantity: data.units,
            units: data.units,
            testStatus: 'Cleared',
            status: 'Cleared',
            source: `Transfer from ${data.targetHospital}`,
            createdAt: new Date().toISOString()
        });
    }

    // 3. Mark transfer as Completed
    await updateDoc(ref, {
        status: 'Completed',
        receivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    await logActivity(
        'Blood Transfer Completed',
        `${data.requestingHospital} received and logged ${data.units} unit(s) of ${data.bloodType} from ${data.targetHospital}`,
        'success',
        data.requestingHospital
    );
}

export async function cancelBloodTransfer(transferId, reason = '') {
    const ref = doc(db, 'blood_transfers', transferId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data();

    await updateDoc(ref, {
        status: 'Cancelled',
        cancelReason: reason,
        cancelledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    await logActivity(
        'Blood Transfer Cancelled',
        `Transfer of ${data.units} unit(s) of ${data.bloodType} between ${data.requestingHospital} and ${data.targetHospital} was cancelled`,
        'warning',
        data.requestingHospital
    );
}

export async function fetchHospitalTransfers(hospitalName) {
    try {
        const qReq = query(collection(db, 'blood_transfers'), where('requestingHospital', '==', hospitalName));
        const qTgt = query(collection(db, 'blood_transfers'), where('targetHospital', '==', hospitalName));

        const [snapReq, snapTgt] = await Promise.all([getDocs(qReq), getDocs(qTgt)]);
        const list = [];
        snapReq.docs.forEach(d => list.push({ ...d.data(), id: d.id, direction: 'outgoing_request' }));
        snapTgt.docs.forEach(d => list.push({ ...d.data(), id: d.id, direction: 'incoming_request' }));

        return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (e) {
        console.error('Failed to fetch hospital transfers:', e);
        return [];
    }
}

// ============================================
// PHASE 2: SICKLE CELL & CHRONIC PATIENTS
// ============================================

export async function saveChronicPatient(patientData) {
    const newDoc = patientData.id ? doc(db, 'chronic_patients', patientData.id) : doc(collection(db, 'chronic_patients'));
    const payload = {
        id: newDoc.id,
        hospitalName: patientData.hospitalName,
        patientName: patientData.patientName,
        patientIdNumber: patientData.patientIdNumber || '',
        bloodType: patientData.bloodType,
        condition: patientData.condition || 'Sickle Cell Disease (SS)',
        phenotypeNotes: patientData.phenotypeNotes || '',
        recurrenceWeeks: parseInt(patientData.recurrenceWeeks || 3, 10),
        contactPhone: patientData.contactPhone || '',
        lastTransfusionDate: patientData.lastTransfusionDate || new Date().toISOString().split('T')[0],
        nextDueDate: patientData.nextDueDate || '',
        createdAt: patientData.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    await setDoc(newDoc, payload);

    await logActivity(
        'Chronic Patient Profile Saved',
        `Registered chronic patient ${payload.patientName} (${payload.condition}, ${payload.bloodType}) for hospital ${payload.hospitalName}`,
        'success',
        payload.hospitalName
    );

    return payload;
}

export async function fetchChronicPatients(hospitalName) {
    try {
        const q = query(
            collection(db, 'chronic_patients'),
            where('hospitalName', '==', hospitalName)
        );
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
    } catch (e) {
        console.error('Failed to fetch chronic patients:', e);
        return [];
    }
}

export async function deleteChronicPatient(patientId) {
    await deleteDoc(doc(db, 'chronic_patients', patientId));
}

// ============================================
// PHASE 3: HEMOVIGILANCE
// ============================================

/**
 * Submit an adverse reaction (hemovigilance) report.
 * @param {Object} reportData - { bloodType, batchId, reactionType, severity, description, patientInitials, reactionDate, reportedBy }
 * @returns {string} The new document ID
 */
export async function submitHemovigilanceReport(reportData) {
    const clean = sanitizeFields(reportData, 'reactionType', 'description', 'bloodType', 'severity', 'patientOutcome');
    const report = {
        ...clean,
        hospitalName: clean.hospitalName || getCurrentUser()?.hospitalName || 'Unknown',
        status: 'pending_review',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const docRef = await addDoc(collection(db, 'hemovigilance_reports'), report);
    await logActivity(
        'Hemovigilance Report Submitted',
        'Adverse reaction reported: ' + report.reactionType + ' (' + report.severity + ') for ' + report.bloodType,
        'hemovigilance',
        reportData.reportedBy || null
    );
    return docRef.id;
}

/**
 * Fetch hemovigilance reports for a specific hospital.
 * @param {string} hospitalName
 * @param {number} maxResults
 */
export async function fetchHemovigilanceReports(hospitalName, maxResults = 50) {
    try {
        const q = query(
            collection(db, 'hemovigilance_reports'),
            where('hospitalName', '==', hospitalName),
            orderBy('createdAt', 'desc'),
            limit(maxResults)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch hemovigilance reports:', e);
        return [];
    }
}

/**
 * Update hemovigilance report status (review, resolve, dismiss).
 */
export async function updateHemovigilanceReport(reportId, updates) {
    await updateDoc(doc(db, 'hemovigilance_reports', reportId), {
        ...updates,
        updatedAt: new Date().toISOString(),
    });
}

/**
 * Admin-only: hemovigilance reports across every hospital, not just one.
 */
export async function fetchAllHemovigilanceReports(maxResults = 200) {
    try {
        const q = query(collection(db, 'hemovigilance_reports'), orderBy('createdAt', 'desc'), limit(maxResults));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch all hemovigilance reports:', e);
        return [];
    }
}


// ============================================
// DONOR REACTION LOG
// Distinct from hemovigilance: this tracks a DONOR feeling unwell after giving blood
// (fainting, dizziness, bruising), not a PATIENT reacting to a transfusion.
// ============================================

/**
 * Submit a donor post-donation reaction report.
 * @param {Object} reactionData - { donorName, bloodType, reactionType, severity, description, actionTaken, hospitalName, reportedBy, donationId }
 */
export async function submitDonorReaction(reactionData) {
    const clean = sanitizeFields(reactionData, 'donorName', 'reactionType', 'description', 'actionTaken', 'bloodType', 'severity');
    const report = {
        ...clean,
        hospitalName: clean.hospitalName || getCurrentUser()?.hospitalName || 'Unknown',
        status: 'reported',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const docRef = await addDoc(collection(db, 'donor_reactions'), report);
    await logActivity(
        'Donor Reaction Reported',
        `${report.reactionType} (${report.severity}) reported for donor ${report.donorName || 'Unknown'} at ${report.hospitalName}`,
        'donor-safety',
        reactionData.reportedBy || null
    );
    return docRef.id;
}

/**
 * Fetch donor reactions reported by a specific hospital.
 */
export async function fetchDonorReactions(hospitalName, maxResults = 50) {
    try {
        const q = query(
            collection(db, 'donor_reactions'),
            where('hospitalName', '==', hospitalName),
            orderBy('createdAt', 'desc'),
            limit(maxResults)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch donor reactions:', e);
        return [];
    }
}

/**
 * Update donor reaction status (e.g. mark resolved once the donor has recovered / been followed up with).
 */
export async function updateDonorReaction(reactionId, updates) {
    await updateDoc(doc(db, 'donor_reactions', reactionId), {
        ...updates,
        updatedAt: new Date().toISOString(),
    });
}

/**
 * Admin-only: donor reactions across every hospital, not just one.
 */
export async function fetchAllDonorReactions(maxResults = 200) {
    try {
        const q = query(collection(db, 'donor_reactions'), orderBy('createdAt', 'desc'), limit(maxResults));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch all donor reactions:', e);
        return [];
    }
}


// ============================================
// PHASE 3: DEMAND FORECASTING
// ============================================

/**
 * Generate or update a demand forecast for a hospital.
 * @param {Object} forecastData - { hospitalName, forecasts: [{bloodType, predictedUnits, confidence, period}], algorithm, notes }
 */
export async function saveDemandForecast(forecastData) {
    const forecast = {
        ...forecastData,
        hospitalName: forecastData.hospitalName || getCurrentUser()?.hospitalName || 'Unknown',
        generatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
    };
    const docRef = await addDoc(collection(db, 'demand_forecasts'), forecast);
    await logActivity(
        'Demand Forecast Generated',
        'Forecast generated for ' + forecast.hospitalName + ' covering ' + (forecast.forecasts || []).length + ' blood types',
        'forecasting',
        null
    );
    return docRef.id;
}

/**
 * Fetch demand forecasts for a hospital.
 * @param {string} hospitalName
 * @param {number} maxResults
 */
export async function fetchDemandForecasts(hospitalName, maxResults = 12) {
    try {
        const q = query(
            collection(db, 'demand_forecasts'),
            where('hospitalName', '==', hospitalName),
            orderBy('createdAt', 'desc'),
            limit(maxResults)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch demand forecasts:', e);
        return [];
    }
}

/**
 * Compute a simple demand forecast from inventory history and active requests.
 * Returns an array of { bloodType, currentStock, activeDemand, predictedDemand, trend }
 */
export async function computeDemandForecast(hospitalName) {
    try {
        const [inventoryData, requestsData] = await Promise.all([
            fetchInventory(hospitalName),
            fetchHospitalRequests(hospitalName),
        ]);

        const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
        const activeByType = {};
        (requestsData || []).forEach(r => {
            if (r.status !== 'Completed' && r.status !== 'Resolved') {
                const bt = r.bloodType || r.type;
                activeByType[bt] = (activeByType[bt] || 0) + (r.units || 1);
            }
        });

        return bloodTypes.map(bt => {
            const inv = (inventoryData || []).find(i => i.bloodType === bt);
            const stock = inv?.units || 0;
            const demand = activeByType[bt] || 0;
            const ratio = stock > 0 ? demand / stock : demand > 0 ? 999 : 0;
            let trend = 'stable';
            if (ratio > 0.8) trend = 'critical';
            else if (ratio > 0.5) trend = 'increasing';
            else if (demand === 0 && stock > 0) trend = 'decreasing';

            const predicted = Math.max(0, Math.round(demand * 1.15 + (stock * 0.05)));
            // Confidence reflects how much real signal the prediction is based on — more active
            // requests observed for this blood type means less extrapolation from a thin sample,
            // not a random number. Capped at 95 (never claim certainty) and floored at 50
            // (a pure stock-only extrapolation with zero demand signal is still a real estimate).
            const requestSampleSize = (requestsData || []).filter(r => (r.bloodType || r.type) === bt).length;
            const confidence = Math.min(95, 50 + requestSampleSize * 5);
            return {
                bloodType: bt,
                currentStock: stock,
                activeDemand: demand,
                predictedDemand: predicted,
                confidence,
                trend,
            };
        });
    } catch (e) {
        console.error('Failed to compute demand forecast:', e);
        return [];
    }
}


// ============================================
// PHASE 3: DONOR MYTH-BUSTING HUB
// ============================================

/**
 * Fetch myth-busting articles.
 * @param {number} maxResults
 */
export async function fetchMythArticles(maxResults = 30) {
    try {
        const q = query(
            collection(db, 'myth_articles'),
            orderBy('createdAt', 'desc'),
            limit(maxResults)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch myth articles:', e);
        return [];
    }
}

/**
 * Create a myth-busting article (hospital/admin only).
 * @param {Object} articleData - { title, myth, fact, category, icon, authorName }
 */
export async function createMythArticle(articleData) {
    const clean = sanitizeFields(articleData, 'title', 'myth', 'fact', 'source');
    const article = {
        ...clean,
        authorName: clean.authorName || getCurrentUser()?.name || 'VitalPulse Team',
        likes: 0,
        createdAt: new Date().toISOString(),
    };
    const docRef = await addDoc(collection(db, 'myth_articles'), article);
    await logActivity(
        'Myth-Busting Article Published',
        'New article: ' + article.title + ' (Myth vs Fact)',
        'mythbusting',
        null
    );
    return docRef.id;
}

/**
 * Like / unlike a myth article.
 */
export async function likeMythArticle(articleId, increment = true) {
    const ref = doc(db, 'myth_articles', articleId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const currentLikes = snap.data().likes || 0;
    await updateDoc(ref, {
        likes: increment ? currentLikes + 1 : Math.max(0, currentLikes - 1),
    });
}


// ============================================
// PHASE 3: CARE REMINDERS
// ============================================

/**
 * Fetch care reminders for a donor.
 * @param {string} donorId
 */
export async function fetchCareReminders(donorId) {
    try {
        const q = query(
            collection(db, 'care_reminders'),
            where('donorId', '==', donorId),
            orderBy('createdAt', 'desc'),
            limit(20)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch care reminders:', e);
        return [];
    }
}

/**
 * Create care reminders for a donor after a donation.
 * @param {Object} reminderData - { donorId, donorName, donationId, hospitalName, bloodType, donationDate }
 */
export async function createCareReminders(reminderData) {
    const donorId = reminderData.donorId;
    const donationDate = new Date(reminderData.donationDate || new Date());
    const reminders = [
        {
            donorId,
            donorName: reminderData.donorName || '',
            donationId: reminderData.donationId || '',
            hospitalName: reminderData.hospitalName || '',
            bloodType: reminderData.bloodType || '',
            title: 'Rest & Hydrate',
            message: 'Drink at least 4 extra glasses of water today and avoid strenuous exercise for the next 12 hours.',
            category: 'immediate',
            dueDate: donationDate.toISOString(),
            dismissed: false,
            icon: 'water_drop',
            createdAt: new Date().toISOString(),
        },
        {
            donorId,
            donorName: reminderData.donorName || '',
            donationId: reminderData.donationId || '',
            hospitalName: reminderData.hospitalName || '',
            bloodType: reminderData.bloodType || '',
            title: 'Eat Iron-Rich Foods',
            message: 'Include iron-rich foods (spinach, red meat, lentils, beans) in your meals for the next 3 days to help replenish iron stores.',
            category: 'nutrition',
            dueDate: new Date(donationDate.getTime() + 86400000).toISOString(),
            dismissed: false,
            icon: 'restaurant',
            createdAt: new Date().toISOString(),
        },
        {
            donorId,
            donorName: reminderData.donorName || '',
            donationId: reminderData.donationId || '',
            hospitalName: reminderData.hospitalName || '',
            bloodType: reminderData.bloodType || '',
            title: 'Arm Care',
            message: 'Keep the bandage on for at least 4-5 hours. Avoid heavy lifting with the donation arm for 24 hours.',
            category: 'aftercare',
            dueDate: donationDate.toISOString(),
            dismissed: false,
            icon: 'healing',
            createdAt: new Date().toISOString(),
        },
        {
            donorId,
            donorName: reminderData.donorName || '',
            donationId: reminderData.donationId || '',
            hospitalName: reminderData.hospitalName || '',
            bloodType: reminderData.bloodType || '',
            title: 'Eligibility Rest Period',
            message: 'Your next donation eligibility begins after the 56-day rest period. We will remind you when you are eligible again!',
            category: 'schedule',
            dueDate: new Date(donationDate.getTime() + 56 * 86400000).toISOString(),
            dismissed: false,
            icon: 'event_available',
            createdAt: new Date().toISOString(),
        },
    ];

    const createdIds = [];
    for (const r of reminders) {
        const ref = await addDoc(collection(db, 'care_reminders'), r);
        createdIds.push(ref.id);
    }
    return createdIds;
}

/**
 * Dismiss (mark as read/acknowledged) a care reminder.
 */
export async function dismissCareReminder(reminderId) {
    await updateDoc(doc(db, 'care_reminders', reminderId), {
        dismissed: true,
        dismissedAt: new Date().toISOString(),
    });
}


// ============================================
// PHASE 3: LIFE SAVER CERTIFICATES
// ============================================

/**
 * Generate a life saver certificate for a donor.
 * @param {Object} certData - { donorId, donorName, hospitalName, bloodType, donationCount, unitsDonated, issuedBy }
 * @returns {string} Certificate ID
 */
export async function generateLifeSaverCertificate(certData) {
    const certNumber = 'VP-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const certificate = {
        ...certData,
        certificateNumber: certNumber,
        issuedDate: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: 'active',
    };
    const docRef = await addDoc(collection(db, 'life_saver_certificates'), certificate);
    await logActivity(
        'Life Saver Certificate Issued',
        'Certificate ' + certNumber + ' issued to ' + certData.donorName + ' for ' + certData.donationCount + ' donations',
        'certificates',
        certData.issuedBy || null
    );
    return docRef.id;
}

/**
 * Fetch certificates for a donor.
 * @param {string} donorId
 */
export async function fetchLifeSaverCertificates(donorId) {
    try {
        const q = query(
            collection(db, 'life_saver_certificates'),
            where('donorId', '==', donorId),
            orderBy('issuedDate', 'desc'),
            limit(20)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch life saver certificates:', e);
        return [];
    }
}

/**
 * Fetch certificates issued by a hospital.
 * @param {string} hospitalName
 */
export async function fetchHospitalIssuedCertificates(hospitalName, maxResults = 50) {
    try {
        const q = query(
            collection(db, 'life_saver_certificates'),
            where('hospitalName', '==', hospitalName),
            orderBy('issuedDate', 'desc'),
            limit(maxResults)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.error('Failed to fetch hospital certificates:', e);
        return [];
    }
}
