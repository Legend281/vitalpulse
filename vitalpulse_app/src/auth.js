import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    updateProfile,
    sendEmailVerification,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence
} from "firebase/auth";
import { doc, setDoc, getDoc, updateDoc, addDoc, collection, query, where, getDocs } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { auth, db } from './firebase';
import { authenticateStaffDirectLoginCall, formatStaffAuthPassword, tryAutoHealStaffAccount } from './db';

const checkDuplicateCniFn = httpsCallable(getFunctions(), 'checkDuplicateCni');

// Sign In (C1): resolves a "phone or email" identifier to the real email
// signInWithEmailAndPassword needs, via the unauthenticated resolveSignInIdentifier
// Cloud Function (an unauthenticated client can't query `users` directly — see
// functions/src/resolveSignInIdentifier.ts for why this has to be server-side).
const resolveSignInIdentifierFn = httpsCallable(getFunctions(), 'resolveSignInIdentifier');

export async function resolveSignInEmail(identifier) {
    const result = await resolveSignInIdentifierFn({ identifier });
    return result.data?.email || null;
}

// Sign Up (C2.8): bootstraps a freshly-created donor account's custom claims +
// donors/{uid} KYC record. See the call site in registerUser() below for why this has
// to be invoked from here rather than firing automatically.
const onDonorSignUpFn = httpsCallable(getFunctions(), 'onDonorSignUp');

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
        // Account is created FIRST because the duplicate-CNI check below is a
        // Cloud Function that requires the caller to be authenticated — the old
        // ordering queried the users collection before account creation, i.e.
        // unauthenticated, which deny-by-default rules reject outright
        // ("Missing or insufficient permissions" broke every donor registration
        // with a national ID). If the hash is a duplicate, the function rolls
        // the just-created account back server-side.
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        await updateProfile(user, { displayName: additionalData.name });

        let cniHash = null;
        let cniLast4 = null;
        if (role === 'donor' && additionalData.nationalId) {
            cniHash = await hashNationalId(additionalData.nationalId);
            if (cniHash) {
                const dupRes = await checkDuplicateCniFn({ cniHash });
                if (dupRes.data.duplicate) {
                    throw new Error('A donor account with this National ID Number (CNI) is already registered.');
                }
            }
            const cleanId = additionalData.nationalId.trim().replace(/[\s-]/g, '');
            cniLast4 = cleanId.length >= 4 ? cleanId.slice(-4) : cleanId;
        }

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

        // Stream C2.8: bootstrap the donor's custom claims + donors/{uid} KYC record
        // right after account creation. This is the client-side half of the B4 deviation
        // (onDonorSignUp is a callable, not a real Auth trigger — see functions/src/kyc.ts's
        // header comment) — it must be called from here, the one place that knows this is
        // really a donor signup, not just "any new Firebase Auth user."
        // Non-fatal by design: the Auth account and Firestore profile already exist by this
        // point, so a transient failure here shouldn't be reported as "signup failed" — it's
        // surfaced via the return value instead so the caller can decide how to handle it.
        let kycBootstrapFailed = false;
        if (role === 'donor') {
            try {
                await onDonorSignUpFn();
                // Claims were just set server-side; force-refresh so this session's token
                // reflects them immediately rather than waiting out its ~1h natural expiry.
                await user.getIdToken(true);
            } catch (bootstrapError) {
                console.warn('onDonorSignUp bootstrap failed (account still created):', bootstrapError);
                kycBootstrapFailed = true;
            }
        }

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

        const newUser = { uid: user.uid, email, role, kycBootstrapFailed, ...additionalData };
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
// Custom Cloud Function pipeline (functions/src/passwordReset.ts), not Firebase Auth's
// built-in sendPasswordResetEmail/confirmPasswordReset — Security Lead instruction
// (2026-08-04): the link needs a real, enforced 30-minute expiry and a custom "Vital Pulse
// Team" sender identity, neither of which Firebase's built-in oobCode flow supports.

const requestPasswordResetFn = httpsCallable(getFunctions(), 'requestPasswordReset');
const checkPasswordResetTokenFn = httpsCallable(getFunctions(), 'checkPasswordResetToken');
const confirmPasswordResetFn = httpsCallable(getFunctions(), 'confirmPasswordReset');

export async function sendPasswordReset(email) {
    await requestPasswordResetFn({ email });
}

// Set New Password (Stream C4.2): the `uid`+`token` come from the link Vital Pulse Team
// emailed — verify it's still valid BEFORE ever showing the form (C4.4, expired/invalid-link
// state), then use it once to actually change the password.
export async function verifyResetCode(uid, token) {
    await checkPasswordResetTokenFn({ uid, token });
}

export async function confirmReset(uid, token, newPassword) {
    await confirmPasswordResetFn({ uid, token, newPassword });
}

// Sign In (C1.4, "Remember me"): must be called BEFORE loginUser() — Firebase Auth
// persistence is set on the auth instance ahead of the actual sign-in call, not after.
// browserSessionPersistence (the un-checked default) clears on tab close; browserLocalPersistence
// survives browser restarts.
export async function setLoginPersistence(remember) {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
}

export async function loginUser(email, password) {
    const cleanEmail = (email || '').trim().toLowerCase();
    console.log('[Auth Debug] Starting loginUser for:', cleanEmail);
    let userCredential;

    // Attempt 1: Raw password
    try {
        console.log('[Auth Debug] Attempt 1: signInWithEmailAndPassword (raw password)');
        userCredential = await signInWithEmailAndPassword(auth, cleanEmail, password);
        console.log('[Auth Debug] Attempt 1 SUCCESS');
    } catch (primaryErr) {
        console.warn('[Auth Debug] Attempt 1 failed:', primaryErr?.code || primaryErr?.message);

        // Attempt 2: Padded staff PIN password ('VP_PIN_' + password)
        try {
            const padded = formatStaffAuthPassword(password);
            console.log('[Auth Debug] Attempt 2: signInWithEmailAndPassword with padded PIN:', padded);
            userCredential = await signInWithEmailAndPassword(auth, cleanEmail, padded);
            console.log('[Auth Debug] Attempt 2 SUCCESS');
        } catch (secondaryErr) {
            console.warn('[Auth Debug] Attempt 2 failed:', secondaryErr?.code || secondaryErr?.message);

            // Attempt 3: Auto-heal staff account from local registry
            console.log('[Auth Debug] Attempt 3: Invoking tryAutoHealStaffAccount...');
            let healed = false;
            try {
                healed = await tryAutoHealStaffAccount(cleanEmail, password);
                console.log('[Auth Debug] tryAutoHealStaffAccount returned:', healed);
            } catch (healErr) {
                console.warn('[Auth Debug] tryAutoHealStaffAccount error:', healErr?.message || healErr);
            }

            if (healed) {
                try {
                    const padded = formatStaffAuthPassword(password);
                    console.log('[Auth Debug] Attempt 4 (post-heal): signInWithEmailAndPassword with:', padded);
                    userCredential = await signInWithEmailAndPassword(auth, cleanEmail, padded);
                    console.log('[Auth Debug] Attempt 4 SUCCESS');
                } catch (retryErr) {
                    console.error('[Auth Debug] Attempt 4 failed after heal:', retryErr);
                    throw primaryErr;
                }
            } else {
                console.error('[Auth Debug] All login attempts failed. Re-throwing primary error:', primaryErr);
                throw primaryErr;
            }
        }
    }
    try {
        const user = userCredential.user;

        let role = 'donor';
        let userData = {};

        // Gracefully handle Firestore permission errors & self-provision staff user docs
        try {
            const userDocRef = doc(db, 'users', user.uid);
            const userDoc = await getDoc(userDocRef);

            if (userDoc.exists()) {
                userData = userDoc.data();
                role = userData.role || role;
            } else {
                // User doc does not exist — check if this authenticated user matches a staff account
                const staffRegRaw = localStorage.getItem('vitalpulse_staff_registry');
                let staffRecord = null;
                if (staffRegRaw) {
                    try {
                        const reg = JSON.parse(staffRegRaw);
                        staffRecord = reg[cleanEmail];
                    } catch (e) { /* ignore */ }
                }

                if (staffRecord) {
                    console.log('[Auth Debug] Resolving staff user profile for:', cleanEmail, staffRecord);
                    userData = {
                        uid: user.uid,
                        email: cleanEmail,
                        name: staffRecord.name || cleanEmail.split('@')[0],
                        role: staffRecord.roles ? staffRecord.roles[0] : (staffRecord.role || 'reception'),
                        roles: staffRecord.roles || [staffRecord.role || 'reception'],
                        hospitalId: staffRecord.hospitalId,
                        isStaffAccount: true,
                        createdAt: new Date().toISOString()
                    };
                    role = userData.role;
                    // Self-provision users/{uid} document now that client is authenticated as user.uid
                    try {
                        await setDoc(userDocRef, userData);
                        console.log('[Auth Debug] Successfully self-provisioned users/' + user.uid + ' profile doc');
                    } catch (writeErr) {
                        console.warn('[Auth Debug] Failed to self-provision users doc:', writeErr);
                    }
                }
            }
        } catch (firestoreError) {
            console.warn("Firestore read failed (rules may be locked), defaulting to donor role:", firestoreError);
        }

        // Custom claims (role/kycStatus/suspended) are the REAL authority — the Firestore
        // `role` field above is cosmetic routing only (see firestore.rules' header comment).
        // Force a refresh so a claim change since the last cached token (suspension, KYC
        // review) is reflected immediately rather than up to ~1h later.
        let claims = {};
        try {
            const tokenResult = await user.getIdTokenResult(true);
            claims = tokenResult.claims || {};
        } catch (claimsError) {
            console.warn('Failed to read ID token claims:', claimsError);
        }

        const fullUser = {
            uid: user.uid,
            email: user.email,
            name: user.displayName || userData.name || cleanEmail.split('@')[0],
            ...userData,
            // Deliberately placed AFTER the ...userData spread so the token claim always
            // wins if a field ever collides — role here overrides userData.role.
            role: claims.role || userData.role || role,
            // Multi-role array from custom claims (set by grantRole/createStaffAccount).
            // Frontend roleGating.js reads this for hasAnyRole evaluation.
            roles: Array.isArray(claims.roles) ? claims.roles : (Array.isArray(userData.roles) ? userData.roles : undefined),
            kycStatus: claims.kycStatus || null,
            suspended: claims.suspended === true,
        };

        if (userData.isStaffAccount || userData.hospitalId || ['nurse', 'reception', 'receptionist', 'lab_tech'].includes(fullUser.role)) {
            const staffRoles = fullUser.roles || [fullUser.role || 'reception'];
            fullUser.isStaffDirectLogin = true;
            try {
                sessionStorage.setItem('vitalpulse_active_staff', JSON.stringify({
                    uid: user.uid,
                    name: fullUser.name,
                    roles: staffRoles,
                    switchedAt: new Date().toISOString(),
                    isDirectLogin: true,
                }));
            } catch (e) { /* ignore */ }
        }
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
        try {
            const staffRes = await authenticateStaffDirectLoginCall({ email, pin: password });
            if (staffRes && staffRes.success) {
                const staffUser = {
                    uid: staffRes.staffUid,
                    email: staffRes.email,
                    name: staffRes.name,
                    role: staffRes.roles[0],
                    roles: staffRes.roles,
                    hospitalId: staffRes.hospitalId,
                    isStaffDirectLogin: true,
                };
                localStorage.setItem('vitalpulse_user', JSON.stringify(staffUser));
                sessionStorage.setItem('vitalpulse_active_staff', JSON.stringify({
                    uid: staffRes.staffUid,
                    name: staffRes.name,
                    roles: staffRes.roles,
                    switchedAt: new Date().toISOString(),
                    isDirectLogin: true,
                }));
                return staffUser;
            }
        } catch (staffErr) {
            console.warn('Staff login attempt result:', staffErr?.message);
            if (staffErr?.message && !staffErr.message.includes('No staff account found')) {
                throw staffErr;
            }
        }
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