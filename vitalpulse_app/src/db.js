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
    onSnapshot
} from "firebase/firestore";
import { db } from './firebase';
import { getCurrentUser } from './auth';

// Admin Activity Logging
export async function logActivity(title, description, type) {
    try {
        await addDoc(collection(db, 'activity_logs'), {
            title,
            description,
            type, // e.g. 'success', 'warning', 'info', 'error'
            timestamp: new Date().toISOString()
        });
    } catch(e) {
        console.error("Failed to log activity", e);
    }
}

export async function fetchRecentLogs(limitCount = 5) {
    const q = query(
        collection(db, 'activity_logs'),
        orderBy('timestamp', 'desc'),
        limit(limitCount)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Blood Requests
export async function fetchActiveRequests() {
    const q = query(
        collection(db, 'requests'),
        where('status', 'in', ['Open', 'Matching', 'Donor Assigned', 'Donor En Route'])
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return results.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
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
    const compatibleTypes = getCompatibleBloodTypes(bloodType);
    const q = query(
        collection(db, 'requests'),
        where('bloodType', 'in', compatibleTypes),
        where('status', '==', 'Open')
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return results.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt)).slice(0, 20);
}

export async function acceptRequest(requestId, donorId) {
    const reqDoc = doc(db, 'requests', requestId);
    const snapshot = await getDoc(reqDoc);
    const reqData = snapshot.exists() ? snapshot.data() : {};

    await updateDoc(reqDoc, {
        status: 'Donor Assigned',
        matchedDonor: donorId,
        matchedAt: new Date().toISOString()
    });

    await logActivity(
        'Donor Assigned',
        `Donor assigned to request #${requestId.slice(0, 8)} — ${reqData.bloodType || reqData.type || '?'} needed at ${reqData.hospital || 'Unknown'}`,
        'success'
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
            if (hospital.phone) {
                await sendSmsNotification(hospital.phone, msg).catch(() => {});
                await sendWhatsAppNotification(hospital.phone, msg).catch(() => {});
            }
            await addHospitalNotification(hDoc.id, 'Donor Assigned', msg, 'success');
        }
    }
}

export async function donorSetEnRoute(requestId, donorId) {
    const reqDoc = doc(db, 'requests', requestId);
    const snapshot = await getDoc(reqDoc);
    const reqData = snapshot.exists() ? snapshot.data() : {};

    await updateDoc(reqDoc, {
        status: 'Donor En Route',
        enRouteAt: new Date().toISOString()
    });

    await logActivity(
        'Donor En Route',
        `Donor heading to hospital for request #${requestId.slice(0, 8)} — ${reqData.bloodType || reqData.type || '?'}`,
        'success'
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
            const msg = `[VitalPulse] 🚑 A donor is en route to your facility for request #${requestId.slice(0, 8).toUpperCase()} (${reqData.bloodType || reqData.type || '?'}). Expected arrival shortly.`;
            if (hospital.phone) {
                await sendSmsNotification(hospital.phone, msg).catch(() => {});
                await sendWhatsAppNotification(hospital.phone, msg).catch(() => {});
            }
            await addHospitalNotification(hDoc.id, 'Donor En Route', msg, 'info');
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
    const q = query(
        collection(db, 'donor_notifications'),
        where('donorId', '==', donorId),
        orderBy('createdAt', 'desc'),
        limit(max)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

export async function addHospitalNotification(hospitalId, title, message, type = 'info') {
    try {
        await addDoc(collection(db, 'hospital_notifications'), {
            hospitalId,
            title,
            message,
            type,
            read: false,
            createdAt: new Date().toISOString()
        });
    } catch (e) {
        console.warn('Failed to add hospital notification:', e);
    }
}

export async function fetchHospitalNotifications(hospitalId, max = 20) {
    const q = query(
        collection(db, 'hospital_notifications'),
        where('hospitalId', '==', hospitalId),
        orderBy('createdAt', 'desc'),
        limit(max)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

// ============================================
// AUTO-MATCHING ENGINE
// ============================================

export async function autoMatchDonors(requestId, requestData) {
    const bloodTypeNeeded = requestData.bloodType || requestData.type;
    const location = requestData.city || requestData.hospitalCity;
    if (!bloodTypeNeeded || !location) {
        console.warn('Auto-match: missing bloodType or city, skipping');
        return [];
    }

    const compatibleTypes = getCompatibleBloodTypes(bloodTypeNeeded);
    const matchingDonors = [];

    // Query donors in same city with compatible blood type
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'donor'),
        where('bloodType', 'in', compatibleTypes),
        where('isAvailable', '==', true),
        where('city', '==', location),
        limit(30)
    );

    const snapshot = await getDocs(q);
    for (const docSnap of snapshot.docs) {
        const donor = { id: docSnap.id, ...docSnap.data() };
        if (donor.isSuspended) continue;

        matchingDonors.push(donor);

        const msg = `[VitalPulse] 🆘 Emergency blood request! ${bloodTypeNeeded} needed at ${requestData.hospital || 'a hospital near you'} (${location}). Your compatibility matches. Please respond ASAP. Reply in app to accept.`;
        if (donor.phone) {
            await sendSmsNotification(donor.phone, msg).catch(() => {});
            await sendWhatsAppNotification(donor.phone, msg).catch(() => {});
        }
        await addDonorNotification(
            donor.id,
            'Emergency Blood Request',
            `🆘 ${bloodTypeNeeded} needed urgently at ${requestData.hospital || 'a nearby hospital'} (${location}). ${requestData.urgency ? 'Urgency: ' + requestData.urgency : ''} ${requestData.notes ? 'Notes: ' + requestData.notes : ''}`,
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
            `${matchingDonors.length} compatible donor(s) notified for request #${requestId.slice(0, 8)} (${bloodTypeNeeded})`,
            'info'
        );
    }

    return matchingDonors;
}

// Smart Matching Engine
export function getCompatibleBloodTypes(bloodType) {
    const compatibility = {
        'O-': ['O-'],
        'O+': ['O-', 'O+'],
        'A-': ['A-', 'O-'],
        'A+': ['A-', 'A+', 'O-', 'O+'],
        'B-': ['B-', 'O-'],
        'B+': ['B-', 'B+', 'O-', 'O+'],
        'AB-': ['A-', 'B-', 'AB-', 'O-'],
        'AB+': ['A-', 'A+', 'B-', 'B+', 'AB-', 'AB+', 'O-', 'O+']
    };
    return compatibility[bloodType] || [bloodType];
}

export async function findMatchingDonors(bloodTypeNeeded, location, radiusKm = 50) {
    const compatibleTypes = getCompatibleBloodTypes(bloodTypeNeeded);
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
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'hospital')
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
    const q = query(collection(db, 'requests'), orderBy("timestamp", "desc"), limit(200));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Donor Management
export async function fetchAllDonors() {
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'donor')
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
        isAvailable: false, // Force them out of matching pool immediately
        statusChangedAt: new Date().toISOString()
    });
    await logActivity('User Suspended', `Donor ${userName} was suspended from the network.`, 'error');
}

export async function reactivateDonor(userId, userName) {
    const userDoc = doc(db, 'users', userId);
    await updateDoc(userDoc, {
        isSuspended: false,
        isAvailable: true,
        statusChangedAt: new Date().toISOString()
    });
    await logActivity('User Reactivated', `Donor ${userName} was restored to active standing.`, 'success');
}

export async function verifyHospital(hospitalId, hospitalName, verified = true) {
    const userDoc = doc(db, 'users', hospitalId);
    await updateDoc(userDoc, {
        isVerified: verified,
        verifiedAt: new Date().toISOString()
    });
    
    // Log Activity
    const action = verified ? 'Approved' : 'Rejected';
    const type = verified ? 'success' : 'warning';
    await logActivity(`Hospital ${action}`, `${hospitalName} was ${action.toLowerCase()} for blood distribution.`, type);
}

export async function rejectHospital(hospitalId, hospitalName) {
    // For now, rejection could just delete the user or mark them rejected
    const userDocRef = doc(db, 'users', hospitalId);
    await updateDoc(userDocRef, {
        isVerified: false,
        rejected: true,
        verifiedAt: new Date().toISOString()
    });
    await logActivity(`Hospital Rejected`, `${hospitalName}'s verification request was declined.`, 'error');
}

export async function fetchClinicsOnlineCount() {
    const q = query(
        collection(db, 'users'),
        where('role', '==', 'hospital'),
        where('isVerified', '==', true)
    );
    const snapshot = await getDocs(q);
    return snapshot.size;
}

// Listen to real-time updates
export function subscribeToRequests(callback) {
    const q = query(
        collection(db, 'requests'),
        where('status', 'in', ['Open', 'Matching', 'Donor Assigned', 'Donor En Route'])
    );
    return onSnapshot(q, (snapshot) => {
        let requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        requests = requests.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
        callback(requests);
    });
}

// ============================================
// BLOOD INVENTORY MANAGEMENT
// ============================================

function invDocId(hospital, type) {
    return `${hospital.replace(/\s+/g, '_')}_${type}`;
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
    return {
        ...data,
        batches,
        componentTotals: data.componentTotals || {},
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
    const snapshot = await getDoc(inventoryRef);

    const existing = snapshot.exists() ? snapshot.data() : {};
    let batches = existing.batches || [];
    let currentUnits = existing.unitsAvailable || 0;

    if (operation === 'add') {
        const units = parseInt(unitsToAdd, 10);
        const componentType = options.componentType || 'Whole Blood';
        const expiresAt = options.expiresAt || null;
        const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        batches.push({
            id: batchId,
            units,
            componentType,
            expiresAt,
            addedAt: new Date().toISOString()
        });
        currentUnits += units;
    } else {
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
        currentUnits = Math.max(0, currentUnits - units);
    }

    const componentTotals = {};
    batches.forEach(b => {
        componentTotals[b.componentType] = (componentTotals[b.componentType] || 0) + b.units;
    });

    await setDoc(inventoryRef, {
        bloodType,
        hospital: hospitalName,
        unitsAvailable: currentUnits,
        unitsReserved: 0,
        batches,
        componentTotals,
        minimumThreshold: existing.minimumThreshold || 5,
        lastUpdated: new Date().toISOString(),
        expiresAt: options.expiresAt || null
    }, { merge: true });

    const action = operation === 'add' ? 'Added' : 'Removed';
    await logActivity(
        'Inventory Update',
        `${action} ${unitsToAdd} units of ${bloodType} at ${hospitalName}. New total: ${currentUnits}`,
        operation === 'add' ? 'success' : 'warning'
    );

    return { bloodType, unitsAvailable: currentUnits };
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
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    
    await logActivity(
        'Donation Request Submitted',
        `${donationData.donorName} requested to donate ${donationData.units || 1} unit(s) of ${donationData.bloodType}`,
        'info'
    );
    
    return { id: docRef.id, ...donationData };
}

export async function fetchDonationRequestsForDonor(donorId) {
    const q = query(
        collection(db, 'donation_requests'),
        where('donorId', '==', donorId),
        orderBy('createdAt', 'desc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

export async function approveDonationRequest(requestId, requestData) {
    const reqDoc = doc(db, 'donation_requests', requestId);
    await updateDoc(reqDoc, {
        status: 'approved',
        approvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    
    await updateInventoryStock(requestData.bloodType, requestData.units || 1, 'add');
    
    await logActivity(
        'Donation Approved',
        `Donation request for ${requestData.bloodType} (${requestData.units || 1} unit) approved`,
        'success'
    );
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

export async function completeDonationRequest(requestId, requestData) {
    const reqDoc = doc(db, 'donation_requests', requestId);
    await updateDoc(reqDoc, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    
    await logActivity(
        'Donation Completed',
        `Donation of ${requestData.bloodType} successfully collected`,
        'success'
    );
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
    const docRef = await addDoc(collection(db, 'campaigns'), {
        ...campaignData,
        status: 'planning',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    
    await logActivity(
        'Campaign Created',
        `New campaign "${campaignData.title}" created`,
        'info'
    );
    
    return { id: docRef.id, ...campaignData };
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

export async function completeDonorArrival(requestId) {
    const reqDoc = doc(db, 'requests', requestId);
    const snapshot = await getDoc(reqDoc);
    const reqData = snapshot.exists() ? snapshot.data() : {};

    await updateDoc(reqDoc, {
        status: 'Resolved',
        resolvedAt: new Date().toISOString()
    });

    await logActivity('Donor Arrived', `Donor arrived at hospital and donation completed for request #${requestId.slice(0, 8)} — ${reqData.bloodType || reqData.type || '?'}`, 'success');

    // Notify the matched donor of completion
    const donorId = reqData.matchedDonor;
    if (donorId) {
        const msg = `[VitalPulse] ✅ Thank you! Your donation at ${reqData.hospital || 'the hospital'} has been marked complete. You've earned points and are one step closer to your next badge!`;
        await addDonorNotification(donorId, 'Donation Complete', msg, 'success');
        const donorSnap = await getDoc(doc(db, 'users', donorId));
        if (donorSnap.exists()) {
            const donor = donorSnap.data();
            if (donor.phone) {
                await sendSmsNotification(donor.phone, msg).catch(() => {});
                await sendWhatsAppNotification(donor.phone, msg).catch(() => {});
            }
        }
    }
}

export async function fetchIncomingDonors(hospitalName) {
    const q = query(
        collection(db, 'requests'),
        where('hospital', '==', hospitalName)
    );
    const snapshot = await getDocs(q);
    const matching = snapshot.docs.filter(doc => ['Donor Assigned', 'Donor En Route'].includes(doc.data().status));
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
    return results.sort((a, b) => new Date(b.matchedAt || 0) - new Date(a.matchedAt || 0));
}

// ============================================
// BLOOD ISSUANCE & USAGE TRACKING
// ============================================

export async function issueBloodToPatient(bloodType, units, patientData) {
    const hospitalName = patientData.hospital;
    if (!hospitalName) throw new Error('patientData.hospital is required');
    const docId = invDocId(hospitalName, bloodType);
    const inventoryRef = doc(db, 'inventory', docId);
    const snapshot = await getDoc(inventoryRef);
    const data = snapshot.exists() ? snapshot.data() : {};
    const currentUnits = data.unitsAvailable || 0;
    const newUnits = Math.max(0, currentUnits - parseInt(units, 10));

    let batches = data.batches || [];
    let toDeduct = parseInt(units, 10);
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

    await setDoc(inventoryRef, {
        bloodType,
        hospital: hospitalName,
        unitsAvailable: newUnits,
        unitsReserved: snapshot.exists() ? (data.unitsReserved || 0) : 0,
        minimumThreshold: data.minimumThreshold || 5,
        lastUpdated: new Date().toISOString(),
        batches,
        componentTotals
    }, { merge: true });

    await addDoc(collection(db, 'issuance_log'), {
        bloodType,
        units: parseInt(units, 10),
        patientName: patientData.patientName,
        patientId: patientData.patientId || '',
        ward: patientData.ward || '',
        requestingDoctor: patientData.requestingDoctor || '',
        diagnosis: patientData.diagnosis || '',
        hospital: hospitalName,
        issuedAt: new Date().toISOString()
    });

    await logActivity(
        'Blood Issued',
        `${units} unit(s) of ${bloodType} issued to ${patientData.patientName} at ${patientData.ward || 'Unknown Ward'} — ${patientData.diagnosis || 'No diagnosis'} — Dr. ${patientData.requestingDoctor || 'N/A'} — ${hospitalName}`,
        'warning'
    );

    return { bloodType, unitsAvailable: newUnits };
}

export async function deductInventoryStock(bloodType, units, reason = 'adjustment', hospitalName) {
    if (!hospitalName) throw new Error('hospitalName is required');
    const docId = invDocId(hospitalName, bloodType);
    const inventoryRef = doc(db, 'inventory', docId);
    const snapshot = await getDoc(inventoryRef);

    if (!snapshot.exists()) throw new Error(`No inventory found for ${bloodType} at ${hospitalName}`);
    const data = snapshot.data();
    const currentUnits = data.unitsAvailable || 0;
    const newUnits = Math.max(0, currentUnits - parseInt(units, 10));
    const deducted = currentUnits - newUnits;

    let batches = data.batches || [];
    let toDeduct = parseInt(units, 10);
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

    await updateDoc(inventoryRef, {
        unitsAvailable: newUnits,
        batches,
        componentTotals,
        lastUpdated: new Date().toISOString()
    });

    if (['Open', 'Matching', 'Donor Assigned', 'Donor En Route', 'Resolved', 'resolved'].includes(data.status)) {
        timeline.push({
            status: 'Open',
            timestamp: data.requestedAt || data.timestamp || data.createdAt,
            description: 'Searching for compatible donors',
            icon: 'search',
            color: 'text-blue-500'
        });
    }

    if (data.matchedAt) {
        timeline.push({
            status: 'Donor Assigned',
            timestamp: data.matchedAt,
            description: `Donor assigned — ${data.donorName || 'Waiting for donor'}`,
            icon: 'person_pin',
            color: 'text-amber-500'
        });
    }

    if (data.enRouteAt) {
        timeline.push({
            status: 'Donor En Route',
            timestamp: data.enRouteAt,
            description: 'Donor is traveling to the hospital',
            icon: 'directions_car',
            color: 'text-indigo-500'
        });
    }

    if (data.status === 'Resolved' || data.status === 'resolved') {
        const completionTime = data.resolvedAt || data.updatedAt;
        timeline.push({
            status: 'Completed',
            timestamp: completionTime,
            description: 'Request fulfilled — donation completed',
            icon: 'check_circle',
            color: 'text-emerald-500'
        });
    }

    return timeline.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
}

// ============================================
// INVENTORY MOVEMENT HISTORY (Hospital-level)
// ============================================

export async function fetchInventoryMovements(hospitalName, max = 30) {
    const [activityLogs, issuanceLogs] = await Promise.all([
        fetchHospitalActivityLogs(hospitalName, 30),
        fetchIssuanceLogs(hospitalName, 20)
    ]);

    const movements = [];

    activityLogs.forEach(log => {
        if (log.title?.includes('Inventory') || log.title?.includes('Stock') || log.description?.includes('Added') || log.description?.includes('Removed')) {
            movements.push({
                id: log.id,
                type: log.description?.includes('Added') ? 'addition' : log.description?.includes('Removed') ? 'removal' : 'other',
                bloodType: extractBloodType(log.description),
                units: extractUnits(log.description),
                description: log.description,
                timestamp: log.timestamp,
                source: log.title
            });
        }
    });

    issuanceLogs.forEach(log => {
        movements.push({
            id: log.id,
            type: 'issuance',
            bloodType: log.bloodType,
            units: log.units,
            description: `Issued to ${log.patientName} — ${log.ward || ''} — Dr. ${log.requestingDoctor || 'N/A'}`,
            timestamp: log.issuedAt,
            source: 'Patient Issuance'
        });
    });

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

    const donationsQ = query(
        collection(db, 'donation_requests'),
        where('donorId', '==', donorId)
    );
    const donationsSnapshot = await getDocs(donationsQ);
    const donations = donationsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    const completedDonations = donations.filter(d => d.status === 'completed' || d.status === 'approved');

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
    await addDoc(collection(db, 'notification_log'), {
        channel: 'sms',
        recipient: phone,
        message,
        link,
        status: 'pending',
        sentAt: new Date().toISOString()
    });
    await logActivity('SMS Ready', `SMS to ${phone}: ${message.slice(0, 60)}...`, 'info');
    return { channel: 'sms', phone, message, link };
}

export async function sendWhatsAppNotification(phone, message) {
    const link = waLink(phone, message);
    await addDoc(collection(db, 'notification_log'), {
        channel: 'whatsapp',
        recipient: phone,
        message,
        link,
        status: 'pending',
        sentAt: new Date().toISOString()
    });
    await logActivity('WhatsApp Ready', `WhatsApp to ${phone}: ${message.slice(0, 60)}...`, 'info');
    return { channel: 'whatsapp', phone, message, link };
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
    const snapshot = await getDoc(campaignDoc);
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

    await updateDoc(campaignDoc, {
        participants,
        participantCount: participants.length,
        updatedAt: new Date().toISOString()
    });

    await logActivity('Campaign Joined', `${hospitalName} joined campaign "${campaign.title}"`, 'info');
    return { campaignId, hospitalName };
}

export async function leaveCampaign(campaignId, hospitalName) {
    const campaignDoc = doc(db, 'campaigns', campaignId);
    const snapshot = await getDoc(campaignDoc);
    if (!snapshot.exists()) throw new Error('Campaign not found');

    const campaign = snapshot.data();
    const participants = (campaign.participants || []).filter(p => p.hospitalName !== hospitalName);

    await updateDoc(campaignDoc, {
        participants,
        participantCount: participants.length,
        updatedAt: new Date().toISOString()
    });

    await logActivity('Campaign Left', `${hospitalName} left campaign "${campaign.title}"`, 'warning');
    return { campaignId, hospitalName };
}

export async function fetchHospitalCampaigns(hospitalName) {
    const campaigns = await fetchAllCampaigns();
    return campaigns.map(c => {
        const participants = c.participants || [];
        const hasJoined = participants.some(p => p.hospitalName === hospitalName);
        return { ...c, hasJoined, participantCount: participants.length };
    });
}