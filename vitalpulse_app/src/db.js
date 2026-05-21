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
        where('status', 'in', ['Open', 'Matching'])
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return results.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
}

export async function createEmergencyRequest(requestData) {
    const docRef = await addDoc(collection(db, 'requests'), {
        ...requestData,
        status: 'Open',
        requestedAt: new Date().toISOString()
    });
    return { id: docRef.id, ...requestData };
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
    await updateDoc(reqDoc, {
        status: 'Matching',
        matchedDonor: donorId,
        matchedAt: new Date().toISOString()
    });
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
        where('status', 'in', ['Open', 'Matching'])
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

export async function fetchInventory() {
    const q = query(collection(db, 'inventory'));
    const snapshot = await getDocs(q);
    const inventory = {};
    snapshot.docs.forEach(doc => {
        inventory[doc.id] = doc.data();
    });
    
    const allTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
    allTypes.forEach(type => {
        if (!inventory[type]) {
            inventory[type] = {
                bloodType: type,
                unitsAvailable: 0,
                unitsReserved: 0,
                minimumThreshold: 5,
                lastUpdated: null,
                expiresAt: null
            };
        }
    });
    
    return inventory;
}

export async function updateInventoryStock(bloodType, unitsToAdd, operation = 'add') {
    const inventoryRef = doc(db, 'inventory', bloodType);
    const snapshot = await getDoc(inventoryRef);
    
    let currentUnits = 0;
    if (snapshot.exists()) {
        currentUnits = snapshot.data().unitsAvailable || 0;
    }
    
    const newUnits = operation === 'add' 
        ? currentUnits + parseInt(unitsToAdd, 10)
        : Math.max(0, currentUnits - parseInt(unitsToAdd, 10));
    
    await setDoc(inventoryRef, {
        bloodType,
        unitsAvailable: newUnits,
        unitsReserved: 0,
        minimumThreshold: snapshot.exists() ? (snapshot.data().minimumThreshold || 5) : 5,
        lastUpdated: new Date().toISOString(),
        expiresAt: null
    }, { merge: true });
    
    const action = operation === 'add' ? 'Added' : 'Removed';
    await logActivity(
        'Inventory Update',
        `${action} ${unitsToAdd} units of ${bloodType}. New total: ${newUnits}`,
        operation === 'add' ? 'success' : 'warning'
    );
    
    return { bloodType, unitsAvailable: newUnits };
}

export async function setInventoryThreshold(bloodType, threshold) {
    const inventoryRef = doc(db, 'inventory', bloodType);
    const snapshot = await getDoc(inventoryRef);
    
    if (snapshot.exists()) {
        await updateDoc(inventoryRef, { minimumThreshold: parseInt(threshold, 10) });
    } else {
        await setDoc(inventoryRef, {
            bloodType,
            unitsAvailable: 0,
            unitsReserved: 0,
            minimumThreshold: parseInt(threshold, 10),
            lastUpdated: new Date().toISOString()
        });
    }
    
    await logActivity(
        'Threshold Updated',
        `Minimum stock threshold for ${bloodType} set to ${threshold} units`,
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
    await updateDoc(reqDoc, {
        status: 'resolved',
        resolvedAt: new Date().toISOString()
    });
    await logActivity('Donor Arrived', `Donor arrived at hospital and donation completed for request #${requestId.slice(0, 8)}`, 'success');
}

export async function fetchIncomingDonors(hospitalName) {
    const q = query(
        collection(db, 'requests'),
        where('hospital', '==', hospitalName)
    );
    const snapshot = await getDocs(q);
    const matching = snapshot.docs.filter(doc => doc.data().status === 'Matching');
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
    const inventoryRef = doc(db, 'inventory', bloodType);
    const snapshot = await getDoc(inventoryRef);
    const currentUnits = snapshot.exists() ? (snapshot.data().unitsAvailable || 0) : 0;
    const newUnits = Math.max(0, currentUnits - parseInt(units, 10));

    await setDoc(inventoryRef, {
        bloodType,
        unitsAvailable: newUnits,
        unitsReserved: snapshot.exists() ? (snapshot.data().unitsReserved || 0) : 0,
        minimumThreshold: snapshot.exists() ? (snapshot.data().minimumThreshold || 5) : 5,
        lastUpdated: new Date().toISOString()
    }, { merge: true });

    await addDoc(collection(db, 'issuance_log'), {
        bloodType,
        units: parseInt(units, 10),
        patientName: patientData.patientName,
        patientId: patientData.patientId || '',
        ward: patientData.ward || '',
        requestingDoctor: patientData.requestingDoctor || '',
        diagnosis: patientData.diagnosis || '',
        hospital: patientData.hospital || '',
        issuedAt: new Date().toISOString()
    });

    await logActivity(
        'Blood Issued',
        `${units} unit(s) of ${bloodType} issued to ${patientData.patientName} at ${patientData.ward || 'Unknown Ward'} — ${patientData.diagnosis || 'No diagnosis'} — Dr. ${patientData.requestingDoctor || 'N/A'} — ${patientData.hospital || ''}`,
        'warning'
    );

    return { bloodType, unitsAvailable: newUnits };
}

export async function deductInventoryStock(bloodType, units, reason = 'adjustment') {
    const inventoryRef = doc(db, 'inventory', bloodType);
    const snapshot = await getDoc(inventoryRef);
    const currentUnits = snapshot.exists() ? (snapshot.data().unitsAvailable || 0) : 0;
    const newUnits = Math.max(0, currentUnits - parseInt(units, 10));

    await setDoc(inventoryRef, {
        bloodType,
        unitsAvailable: newUnits,
        unitsReserved: snapshot.exists() ? (snapshot.data().unitsReserved || 0) : 0,
        minimumThreshold: snapshot.exists() ? (snapshot.data().minimumThreshold || 5) : 5,
        lastUpdated: new Date().toISOString()
    }, { merge: true });

    await logActivity(
        'Stock Deducted',
        `${units} unit(s) of ${bloodType} removed — Reason: ${reason}`,
        'warning'
    );

    return { bloodType, unitsAvailable: newUnits };
}

// ============================================
// HOSPITAL-SPECIFIC ACTIVITY LOG
// ============================================

export async function fetchHospitalActivityLogs(hospitalName, limitCount = 15) {
    const q = query(
        collection(db, 'activity_logs'),
        orderBy('timestamp', 'desc'),
        limit(50)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(log =>
            log.description?.toLowerCase().includes(hospitalName.toLowerCase()) ||
            log.title?.toLowerCase().includes(hospitalName.toLowerCase())
        )
        .slice(0, limitCount);
}

export async function fetchIssuanceLogs(hospitalName, max = 20) {
    const q = query(
        collection(db, 'issuance_log'),
        orderBy('issuedAt', 'desc'),
        limit(50)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(log => log.hospital === hospitalName)
        .slice(0, max);
}

// ============================================
// REQUEST TIMELINE
// ============================================

export async function fetchRequestTimeline(requestId) {
    const docRef = doc(db, 'requests', requestId);
    const snapshot = await getDoc(docRef);
    if (!snapshot.exists()) return [];

    const data = { id: snapshot.id, ...snapshot.data() };
    const timeline = [];

    timeline.push({
        status: 'Created',
        timestamp: data.requestedAt || data.timestamp || data.createdAt,
        description: 'Request created',
        icon: 'add_circle',
        color: 'text-slate-500'
    });

    if (data.status === 'Open' || data.status === 'Matching' || data.status === 'resolved') {
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
            status: 'Matched',
            timestamp: data.matchedAt,
            description: `Donor assigned — ${data.donorName || 'Donor en route'}`,
            icon: 'person_pin',
            color: 'text-amber-500'
        });
    }

    if (data.status === 'resolved' && data.resolvedAt) {
        timeline.push({
            status: 'Completed',
            timestamp: data.resolvedAt,
            description: 'Request fulfilled',
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
// SMS / WHATSAPP SIMULATED NOTIFICATIONS
// ============================================

export async function sendSmsNotification(phone, message) {
    await addDoc(collection(db, 'notification_log'), {
        channel: 'sms',
        recipient: phone,
        message,
        status: 'sent',
        sentAt: new Date().toISOString()
    });
    await logActivity('SMS Sent', `SMS to ${phone}: ${message.slice(0, 60)}...`, 'info');
    return { channel: 'sms', phone, message };
}

export async function sendWhatsAppNotification(phone, message) {
    await addDoc(collection(db, 'notification_log'), {
        channel: 'whatsapp',
        recipient: phone,
        message,
        status: 'sent',
        sentAt: new Date().toISOString()
    });
    await logActivity('WhatsApp Sent', `WhatsApp to ${phone}: ${message.slice(0, 60)}...`, 'info');
    return { channel: 'whatsapp', phone, message };
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