import { 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    updateProfile,
    sendPasswordResetEmail,
    sendEmailVerification
} from "firebase/auth";
import { doc, setDoc, getDoc, updateDoc, addDoc, collection, query, where, getDocs } from "firebase/firestore";
import { auth, db } from './firebase';

let currentUser = null;
export async function hashNationalId(nationalIdText) {
    if (!nationalIdText) return null;
    const clean = nationalIdText.trim().replace(/[\s-]/g, '').toUpperCase() + '_VITALPULSE_SALT_2026';
    if (!clean) return null;
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(clean);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return fallbackHash(clean);
    }
}

/** Simple consistent hash fallback when crypto.subtle is unavailable (insecure context). */
function fallbackHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    const seed = Math.abs(hash) || 1;
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += ((seed * (i + 1) * 1103515245 + 12345) >>> 0).toString(16).slice(-1);
    }
    return result;
}

export async function registerUser(email, password, role, additionalData) {
    try {
        let cniHash = null;
        let cniLast4 = null;
        if (role === 'donor' && additionalData.nationalId) {
            cniHash = await hashNationalId(additionalData.nationalId);
            if (cniHash) {
                const dupQuery = query(collection(db, 'users'), where('cniHash', '==', cniHash));
                const dupSnap = await getDocs(dupQuery);
                if (!dupSnap.empty) {
                    throw new Error('A donor account with this National ID Number (CNI) is already registered.');
                }
            }
            const cleanId = additionalData.nationalId.trim().replace(/[\s-]/g, '');
            cniLast4 = cleanId.length >= 4 ? cleanId.slice(-4) : cleanId;
        }

        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        await updateProfile(user, { displayName: additionalData.name });

        // Admin's "Hospital Registration Approval" setting controls whether a new hospital
        // needs manual review (the historical, default behavior) or is auto-verified. Read
        // after auth so this is an authenticated request per firestore.rules. Defaults to
        // requiring approval if the setting has never been saved.
        let requireHospitalApproval = true;
        try {
            const settingsSnap = await getDoc(doc(db, 'system_settings', 'config'));
            if (settingsSnap.exists()) {
                requireHospitalApproval = settingsSnap.data().registrationApprovalRequired !== false;
            }
        } catch (e) {
            console.warn('Failed to read registration-approval setting, defaulting to requiring approval:', e);
        }

        await setDoc(doc(db, 'users', user.uid), {
            email,
            role,
            name: additionalData.name,
            bloodType: additionalData.bloodType || null,
            // Donors type in their own blood type at signup with no lab check behind it.
            // Hospitals can upgrade this to 'lab-verified' during donation intake once they've
            // actually tested the donor's blood — see recordDonationIntake() in db.js.
            bloodTypeSource: role === 'donor' ? 'self-reported' : null,
            cniHash: cniHash || null,
            cniLast4: cniLast4 || null,
            isCniVerified: Boolean(cniHash),
            city: additionalData.city || null,
            phone: additionalData.phone || null,
            licenseUrl: additionalData.licenseUrl || null,
            licenseFileName: additionalData.licenseFileName || null,
            isVerified: role === 'donor' ? true : (role === 'hospital' ? !requireHospitalApproval : false),
            emailVerified: false,
            createdAt: new Date().toISOString(),
            registeredAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString()
        });

        // Notify admin about new hospital registration
        if (role === 'hospital' && requireHospitalApproval) {
            addDoc(collection(db, 'admin_notifications'), {
                title: 'New Hospital Registration',
                message: `${additionalData.name} has registered and needs verification.`,
                type: 'info',
                read: false,
                createdAt: new Date().toISOString()
            }).catch(err => console.warn('Failed to notify admin about new hospital:', err));
        }

        // Notify admin about new donor registrations, gated by the "Donor Request Alerts"
        // setting — off by default behavior matches the setting's own unchecked default.
        if (role === 'donor') {
            try {
                const settingsSnap = await getDoc(doc(db, 'system_settings', 'config'));
                const donorAlertsEnabled = settingsSnap.exists() && settingsSnap.data().donorAlerts === true;
                if (donorAlertsEnabled) {
                    addDoc(collection(db, 'admin_notifications'), {
                        title: 'New Donor Registration',
                        message: `${additionalData.name} registered as a donor${additionalData.city ? ' in ' + additionalData.city : ''}.`,
                        type: 'info',
                        read: false,
                        createdAt: new Date().toISOString()
                    }).catch(err => console.warn('Failed to notify admin about new donor:', err));
                }
            } catch (e) {
                console.warn('Failed to read donor-alerts setting:', e);
            }
        }

        // Send verification email (non-blocking)
        sendVerificationEmailToUser(user).catch(err =>
            console.warn('Failed to send verification email:', err)
        );
        
        const newUser = { uid: user.uid, email, role, ...additionalData };
        // Strip sensitive PII from localStorage — phone, city, raw CNI never stored client-side
        delete newUser.phone;
        delete newUser.city;
        delete newUser.nationalId;
        localStorage.setItem('vitalpulse_user', JSON.stringify(newUser));
        return newUser;
    } catch (error) {
        console.error("Registration error:", error);
        throw error;
    }
}

// ============================================
// EMAIL VERIFICATION
// ============================================

async function sendVerificationEmailToUser(user) {
    await sendEmailVerification(user);
}

export async function sendEmailVerificationLink() {
    const user = auth.currentUser;
    if (!user) throw new Error('No authenticated user');
    await sendVerificationEmailToUser(user);
}

export async function isEmailVerified() {
    const user = auth.currentUser;
    if (!user) return false;
    try {
        await user.reload();
    } catch (e) {
        console.warn('Failed to reload user:', e);
    }
    return user.emailVerified;
}

// ============================================
// PASSWORD RESET
// ============================================

export async function sendPasswordReset(email) {
    await sendPasswordResetEmail(auth, email);
}

export async function loginUser(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        
        let role = 'donor';
        let userData = {};
        
        // Gracefully handle Firestore permission errors
        try {
            const userDocRef = doc(db, 'users', user.uid);
            const userDoc = await getDoc(userDocRef);
            
            if (userDoc.exists()) {
                userData = userDoc.data();
                role = userData.role || role;
            }
        } catch (firestoreError) {
            console.warn("Firestore read failed (rules may be locked), defaulting to donor role:", firestoreError);
        }
        
        const fullUser = {
            uid: user.uid,
            email: user.email,
            name: user.displayName || email.split('@')[0],
            role,
            ...userData
        };
        // Strip sensitive PII from localStorage
        delete fullUser.phone;
        delete fullUser.city;
        delete fullUser.nationalId;
        delete fullUser.cniHash;
        localStorage.setItem('vitalpulse_user', JSON.stringify(fullUser));
        // Stamp last activity on the user doc (fire-and-forget so a failed write never
        // blocks the login itself).
        try {
            await updateDoc(doc(db, 'users', user.uid), { lastActiveAt: new Date().toISOString() });
        } catch (e) {
            console.warn('Failed to stamp lastActiveAt:', e);
        }
        return fullUser;
    } catch (error) {
        console.error("Login error:", error);
        throw error;
    }
}

export async function logoutUser() {
    try {
        await signOut(auth);
    } catch (error) {
        console.error("Logout error:", error);
    }
    localStorage.removeItem('vitalpulse_user');
    window.location.href = 'login.html';
}

export function onAuthChange(callback) {
    return onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            const userData = userDoc.exists() ? userDoc.data() : { role: 'donor' };
            currentUser = { uid: user.uid, email: user.email, ...userData };
            localStorage.setItem('vitalpulse_user', JSON.stringify(currentUser));
            callback(currentUser);
        } else {
            currentUser = null;
            localStorage.removeItem('vitalpulse_user');
            callback(null);
        }
    });
}

export function getCurrentUser() {
    const stored = localStorage.getItem('vitalpulse_user');
    return stored ? JSON.parse(stored) : null;
}

// Resolves with the actual signed-in Firebase user (or null), straight from the
// SDK's own auth state — not the cached localStorage blob. Firebase Auth sessions
// are shared across every tab of the same browser, so if a different account logs
// in on another tab, `vitalpulse_user` in localStorage gets overwritten there too;
// pages need this to detect that and re-verify who is really logged in.
export function waitForAuthUser() {
    return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            unsubscribe();
            resolve(user);
        });
    });
}

// Looks up the real role for a live Firebase user by uid, applying the same
// admin-email override used at login. Used to verify a dashboard page matches
// the account that's actually signed in right now.
export async function fetchVerifiedUser(firebaseUser) {
    let role = 'donor';
    let userData = {};
    try {
        const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        if (userDoc.exists()) {
            userData = userDoc.data();
            role = userData.role || role;
        }
    } catch (e) {
        console.warn('Failed to verify user role from Firestore:', e);
    }
    return {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        name: firebaseUser.displayName || userData.name || firebaseUser.email?.split('@')[0],
        role,
        ...userData
    };
}