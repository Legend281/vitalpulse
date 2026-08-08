import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInWithCustomToken,
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
import { authenticateStaffDirectLoginCall } from './db';

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
        //
        // BUG FIX 2026-08-07 (Security Lead report): a bare, non-retried failure here used
        // to be able to leave an account permanently exempt from KYC — see the ordering fix
        // in functions/src/kyc.ts's bootstrapDonorAccountHandler for the full mechanism. That
        // server-side fix makes this call safely retryable now, so retry once on a transient
        // failure (network blip, cold start, dev environment's Functions emulator not being
        // up yet) before giving up and surfacing kycBootstrapFailed.
        let kycBootstrapFailed = false;
        if (role === 'donor') {
            try {
                await onDonorSignUpFn();
            } catch (firstError) {
                console.warn('onDonorSignUp bootstrap failed, retrying once:', firstError);
                try {
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    await onDonorSignUpFn();
                } catch (retryError) {
                    console.warn('onDonorSignUp bootstrap failed after retry (account still created):', retryError);
                    kycBootstrapFailed = true;
                }
            }
            if (!kycBootstrapFailed) {
                // Claims were just set server-side; force-refresh so this session's token
                // reflects them immediately rather than waiting out its ~1h natural expiry.
                await user.getIdToken(true);
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
        // Strip sensitive PII from localStorage — phone and raw CNI never stored
        // client-side. `city` is intentionally kept: see the equivalent comment in
        // loginUser() — stripping it stamped every emergency request with
        // `city: 'Cameroon'` and silently disabled donor matching entirely.
        delete newUser.phone;
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

/**
 * Resolves the hospital a user belongs to, as BOTH keys the app needs:
 *   - hospitalId   — the hospital account's uid, used by claims-scoped rules
 *   - hospitalName — the hospital's display name, used by every hospital-scoped
 *                    Firestore query (inventory/requests/incoming donors are all
 *                    keyed on the name, not the id)
 *
 * For a hospital account these are its own uid/name. For a staff sub-account
 * they come from the hospital it is scoped to — NOT from the staff member, whose
 * own name is a person's name. Getting this wrong is what made every staff
 * dashboard render empty: `where('hospital','==','Patricia')` matches nothing.
 */
async function resolveHospitalIdentity(uid, userData, claims) {
    const hospitalId = claims?.hospitalId || userData?.hospitalId || null;

    // Not hospital-scoped at all (donor/admin) — nothing to resolve.
    if (!hospitalId && !isHospitalAccount(userData, claims)) {
        return { hospitalId: null, hospitalName: null, hospitalCity: null };
    }

    // The account IS the hospital.
    if (!hospitalId) {
        return { hospitalId: uid, hospitalName: userData?.name || null, hospitalCity: userData?.city || null };
    }

    if (userData?.hospitalName && userData?.hospitalCity) {
        return { hospitalId, hospitalName: userData.hospitalName, hospitalCity: userData.hospitalCity };
    }

    try {
        const snap = await getDoc(doc(db, 'users', hospitalId));
        if (snap.exists()) {
            const h = snap.data();
            return {
                hospitalId,
                hospitalName: userData?.hospitalName || h.name || null,
                // The hospital's city, NOT the staff member's. Emergency requests
                // are stamped with this and matched on it — a nurse's personal city
                // (usually absent) would break matching for the whole facility.
                hospitalCity: h.city || null,
            };
        }
    } catch (e) {
        console.warn('Could not resolve hospital identity for', hospitalId, e?.message || e);
    }
    return { hospitalId, hospitalName: userData?.hospitalName || null, hospitalCity: null };
}

function isHospitalAccount(userData, claims) {
    if (userData?.role === 'hospital') return true;
    const roles = Array.isArray(claims?.roles) ? claims.roles : [];
    return roles.includes('hospital_admin') || claims?.role === 'hospital_admin';
}

const STAFF_PIN_PATTERN = /^\d{4}$/;

export async function loginUser(email, password) {
    const cleanEmail = (email || '').trim().toLowerCase();
    let userCredential;

    try {
        userCredential = await signInWithEmailAndPassword(auth, cleanEmail, password);
    } catch (primaryErr) {
        // Staff sub-accounts sign in with a 4-digit PIN, not a password. The PIN is
        // verified SERVER-SIDE (functions/src/staffManagement.ts) against a salted
        // scrypt hash, rate-limited, and exchanged for a Firebase custom token.
        //
        // The old flow instead derived an Auth password from the PIN ('VP_PIN_1234')
        // and tried it here, then fell back to a client-side "auto-heal" that read a
        // seeded credential out of the bundle. Both are gone: recovering a PIN no
        // longer grants account access, because the PIN is no longer a password.
        if (!STAFF_PIN_PATTERN.test(String(password || '').trim())) {
            throw primaryErr;
        }
        try {
            const staffRes = await authenticateStaffDirectLoginCall({ email: cleanEmail, pin: password });
            if (!staffRes?.token) throw primaryErr;
            userCredential = await signInWithCustomToken(auth, staffRes.token);
        } catch (staffErr) {
            // Surface the server's message for real staff failures (locked out,
            // deactivated); otherwise keep the original password error so a
            // mistyped donor password doesn't read as a staff problem.
            const isStaffSignal = staffErr?.message
                && !/incorrect email or 4-digit pin/i.test(staffErr.message)
                && staffErr !== primaryErr;
            throw isStaffSignal ? staffErr : primaryErr;
        }
    }

    try {
        const user = userCredential.user;

        let role = 'donor';
        let userData = {};

        try {
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            if (userDoc.exists()) {
                userData = userDoc.data();
                role = userData.role || role;
            }
        } catch (firestoreError) {
            console.warn("Firestore read failed (rules may be locked), defaulting to donor role:", firestoreError);
        }

        // Custom claims (role/roles/hospitalId/kycStatus/suspended) are the REAL
        // authority — the Firestore `role` field is cosmetic routing only. Force a
        // refresh so a claim change since the last cached token (suspension, KYC
        // review, a just-granted staff role) is reflected immediately.
        let claims = {};
        try {
            const tokenResult = await user.getIdTokenResult(true);
            claims = tokenResult.claims || {};
        } catch (claimsError) {
            console.warn('Failed to read ID token claims:', claimsError);
        }

        const { hospitalId, hospitalName, hospitalCity } = await resolveHospitalIdentity(user.uid, userData, claims);

        const fullUser = {
            uid: user.uid,
            email: user.email,
            name: user.displayName || userData.name || cleanEmail.split('@')[0],
            ...userData,
            // After the ...userData spread so a token claim always wins on collision.
            role: claims.role || userData.role || role,
            roles: Array.isArray(claims.roles) ? claims.roles : (Array.isArray(userData.roles) ? userData.roles : undefined),
            hospitalId,
            hospitalName,
            hospitalCity,
            kycStatus: claims.kycStatus || null,
            suspended: claims.suspended === true,
        };

        const staffRoles = Array.isArray(fullUser.roles) ? fullUser.roles : [];
        const isStaff = userData.isStaffAccount === true
            || (!!claims.hospitalId && !!claims.staffUid)
            || staffRoles.some(r => ['reception', 'nurse', 'lab_tech', 'hospital_staff'].includes(r));

        if (isStaff) {
            fullUser.isStaffDirectLogin = true;
            try {
                sessionStorage.setItem('vitalpulse_active_staff', JSON.stringify({
                    uid: user.uid,
                    name: fullUser.name,
                    roles: staffRoles.length > 0 ? staffRoles : [fullUser.role],
                    switchedAt: new Date().toISOString(),
                    isDirectLogin: true,
                }));
            } catch (e) { /* sessionStorage unavailable — role gating falls back to claims */ }
        }

        // PII hygiene: phone/nationalId/cniHash never enter localStorage — callers
        // that genuinely need a phone number read it from Firestore at the point of
        // use (see fetchOwnContactPhone).
        //
        // `city` is deliberately KEPT. Stripping it silently broke the matching
        // engine: every emergency request was stamped `city: 'Cameroon'` (the
        // `currentUser.city || 'Cameroon'` fallback), which matches no donor and no
        // entry in CITY_COORDINATES, so autoMatchDonors returned an empty candidate
        // set for every request ever created — no SMS, no in-app alert, nobody
        // notified. A city name is not PHI; it is already public on every request.
        delete fullUser.phone;
        delete fullUser.nationalId;
        delete fullUser.cniHash;
        localStorage.setItem('vitalpulse_user', JSON.stringify(fullUser));

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

// REMOVED 2026-08-08: onAuthChange(). It was exported but never called anywhere,
// and it wrote a DIFFERENT session shape than loginUser() — no claims, no
// resolved hospital identity, and it re-introduced the PII that loginUser
// strips. Had anything ever wired it up, it would have silently downgraded every
// session. Use waitForAuthUser() + fetchVerifiedUser() below instead.

export function getCurrentUser() {
    const stored = localStorage.getItem('vitalpulse_user');
    return stored ? JSON.parse(stored) : null;
}

/**
 * The hospital NAME to scope Firestore queries by (inventory, requests, incoming
 * donors and issuance are all keyed on the hospital's display name).
 *
 * For a staff sub-account this is the HOSPITAL's name, resolved at login and
 * cached on the session as `hospitalName`. It deliberately no longer falls back
 * to `user.name`: for a receptionist that is the person's own name, and the
 * silent fallback is what made every staff-facing view query for a nonexistent
 * hospital and render empty. When the identity is genuinely unresolved we return
 * null so callers can show an error instead of querying for a wrong hospital.
 */
export function getEffectiveHospitalName(user) {
    if (!user) return null;
    if (user.hospitalName) return user.hospitalName;
    // A hospital's own account: its display name IS the hospital name. Staff
    // accounts always carry hospitalId, so this branch can't catch them.
    if (!user.hospitalId && user.role === 'hospital') return user.name || null;
    return null;
}

/** The hospital's uid — what claims-scoped Firestore rules compare against. */
export function getEffectiveHospitalId(user) {
    if (!user) return null;
    if (user.hospitalId) return user.hospitalId;
    if (user.role === 'hospital') return user.uid || null;
    return null;
}

/**
 * The hospital's city — used to stamp and match emergency requests.
 *
 * Never falls back to a hardcoded city. `city: currentUser.city || 'Cameroon'`
 * was the old pattern, and because `city` was stripped from the session it
 * stamped EVERY emergency request with 'Cameroon' — a value that matches no
 * donor and no entry in CITY_COORDINATES, so autoMatchDonors returned an empty
 * candidate list for every request ever created and no donor was ever alerted.
 * Returning null here forces the caller to handle "unknown city" honestly.
 */
export function getEffectiveHospitalCity(user) {
    if (!user) return null;
    if (user.hospitalCity) return user.hospitalCity;
    if (!user.hospitalId && user.role === 'hospital') return user.city || null;
    return null;
}

/**
 * Reads the signed-in user's own phone number from Firestore on demand.
 * `phone` is deliberately not cached in localStorage (PII), so the handful of
 * call sites that genuinely need it — outbound SMS confirmations — fetch it
 * here rather than silently reading `undefined` and skipping the send.
 */
export async function fetchOwnContactPhone() {
    const current = getCurrentUser();
    if (!current?.uid) return null;
    try {
        const snap = await getDoc(doc(db, 'users', current.uid));
        return snap.exists() ? (snap.data().phone || null) : null;
    } catch (e) {
        console.warn('Could not read own contact phone:', e?.message || e);
        return null;
    }
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