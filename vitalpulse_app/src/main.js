import './style.css'
import { registerUser, loginUser, getCurrentUser, logoutUser, sendPasswordReset, sendEmailVerificationLink, isEmailVerified, waitForAuthUser, resolveSignInEmail, setLoginPersistence, verifyResetCode, confirmReset } from './auth';
import { readLoginFailureState, recordLoginFailure, clearLoginFailures, isLockedOut, shouldShowAttemptsWarning, lockoutSecondsRemaining, recordAttemptedIdentifier, hasAttemptedIdentifier } from './loginAttempts';
import { evaluatePasswordCriteria, passwordStrengthScore, isPasswordValid, suggestStrongPassword } from './passwordPolicy';
import { normalizeCameroonPhone, formatCameroonNationalNumber } from './phone';
import { passwordsMatch, isSignupFormValid } from './signupValidation';
import { doc, getDoc, updateDoc, onSnapshot, collection } from "firebase/firestore";
import { db } from './firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { REQUEST_ACTIVE_STATUSES, REQUEST_CLOSED_STATUSES, fetchActiveRequests, fetchPendingHospitals, fetchPendingKycReviews, fetchKycDocumentUrl, verifyHospital, rejectHospital, fetchClinicsOnlineCount, fetchRecentLogs, createEmergencyRequest, logActivity, fetchAllHospitals, fetchHospitalById, fetchAllDonors, fetchDonorById, suspendDonor, reactivateDonor, deactivateHospital, reactivateHospital, fetchAllSystemRequests, fetchInventory, fetchGlobalInventory, updateInventoryStock, setInventoryThreshold, getBloodTypeDisplayInfo, getCompatibleBloodTypes, getCompatibleDonorTypes, fetchDonationRequestsForDonor, fetchAllDonationRequests, approveDonationRequest, rejectDonationRequest, completeDonationRequest, cancelDonationRequest, hospitalCancelBooking, cancelHospitalRequest, removeIncomingDonor, fetchSystemSettings, updateSystemSettings, updateUserProfile, fetchAllCampaigns, createCampaign, updateCampaign, deleteCampaign, fetchHospitalRequests, fetchIncomingDonors, completeDonorArrival, subscribeToRequests, issueBloodToPatient, deductInventoryStock, fetchInventoryMovements, computeDonorEngagement, sendSmsNotification, sendWhatsAppNotification, fetchNotificationLog, joinCampaign, leaveCampaign, fetchHospitalCampaigns, acceptRequest as acceptRequestDb, fetchHospitalNotifications, fetchUnreadHospitalNotificationCount, markHospitalNotificationRead, markAllHospitalNotificationsRead, submitHemovigilanceReport, fetchHemovigilanceReports, updateHemovigilanceReport, saveDemandForecast, fetchDemandForecasts, computeDemandForecast, fetchMythArticles, createMythArticle, likeMythArticle, generateLifeSaverCertificate, fetchHospitalIssuedCertificates, saveChronicPatient, fetchChronicPatients, deleteChronicPatient, checkNetworkInventory, createBloodTransferRequest, dispatchBloodTransfer, receiveBloodTransfer, cancelBloodTransfer, fetchHospitalTransfers, fetchPublicRequests, approvePublicRequest, flagPublicRequest, resolvePublicRequest, fetchShadowHospitals, updateShadowHospitalContact, sendPartnerInvitation, submitDonorReaction, fetchDonorReactions, updateDonorReaction, fetchAllDonorReactions, fetchAllHemovigilanceReports, getCoordinatesForLocation, calculateDistanceKm, resolveLabTest, fetchPendingLabTests, fetchDonationRequestsForHospital, fetchCampaignInterestedDonors, adminProxyCheckInDonor, clearAllActivityLogs, findRequestByCheckInToken, checkInDonor, clearHospitalActivityLogs, subscribeToAdminNotifications, markAdminNotificationRead, markAllAdminNotificationsRead, clearAllAdminNotifications, fetchAllResolvedRequests, fetchHospitalStaff, createStaffAccountCall, verifyStaffPinCall } from './db';
import { initDonorNavigation, initDonorDonationFlow, loadDonorDashboard, switchDonorView, loadDonorDonations, esc } from './donor-dashboard.js';
import { injectLangToggle, getLang } from './i18n';
import { shouldShowOnboarding, startOnboarding, markOnboardingComplete } from './onboarding';
import Chart from 'chart.js/auto';
import { hasAnyRole, isLegacyAccount, getActiveRoles, canAccessView, setActiveStaffSession } from './roleGating';

// Only http(s) URLs may go into href/src attributes. Firebase Storage download URLs are
// https, so this rejects javascript:/data: and other dangerous schemes without breaking
// legitimate license documents / proof uploads. Returns '' when the value isn't a safe URL.
function safeUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url, window.location.origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
    } catch {
        return '';
    }
}

// ============================================
// THEME (light / dark) — DONOR PAGE ONLY
// Dark mode is intentionally scoped to the donor portal: the hospital/admin/login/etc. pages
// aren't dark-themed, so a donor's saved preference must never bleed into them. On any page
// that isn't donor.html we force the `.dark` class off, regardless of what's stored.
// The CSS defines every token twice (light default + `.dark` override in style.css); a tiny
// inline script in donor.html's <head> applies the class before first paint to avoid a flash.
// ============================================
const THEME_KEY = 'vitalpulse_theme';
const IS_DONOR_PAGE = window.location.pathname.replace(/\/+$/, '').endsWith('/donor') ||
                      window.location.pathname.endsWith('donor.html');
function getStoredTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
    // Only the donor page may go dark; everywhere else stays light no matter the stored value.
    const dark = IS_DONOR_PAGE && theme === 'dark';
    document.documentElement.classList.toggle('dark', dark);
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
        const icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = dark ? 'light_mode' : 'dark_mode';
        const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
        const txt = btn.querySelector('[data-theme-label]');
        if (txt) txt.textContent = dark ? 'Light mode' : 'Dark mode';
    });
}
window.toggleVitalPulseTheme = () => {
    if (!IS_DONOR_PAGE) return; // toggle is a no-op off the donor page
    const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
};
function initThemeToggle() {
    applyTheme(getStoredTheme());
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
        if (btn.dataset.themeBound) return;
        btn.dataset.themeBound = '1';
        btn.addEventListener('click', () => window.toggleVitalPulseTheme());
    });
    // Keep tabs/windows in sync when the preference changes elsewhere (donor page only).
    window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) applyTheme(getStoredTheme()); });
}
// Apply immediately (idempotent; forces light on non-donor pages even if `.dark` was left on)
applyTheme(getStoredTheme());
document.addEventListener('DOMContentLoaded', initThemeToggle);

document.addEventListener('DOMContentLoaded', () => {
    const loader = document.getElementById('global-loader');
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 400); // Wait for transition
    }
});

// ============================================
// OFFLINE-FIRST: connection status banner
// Firestore itself queues writes made while offline and syncs them automatically once the
// connection returns (see the persistent cache set up in firebase.js) — this banner just
// tells the user that's happening, so a dropped connection doesn't look like a lost action.
// ============================================
function initOfflineBanner() {
    if (document.getElementById('offline-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;background:#b45309;color:#fff;text-align:center;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:9px 16px;transform:translateY(-100%);transition:transform 0.3s ease;box-shadow:0 2px 8px rgba(0,0,0,0.15);';
    banner.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;"><span class="material-symbols-outlined" style="font-size:15px;">cloud_off</span>You’re offline — changes are saved on this device and will sync automatically once you’re back online</span>';
    document.body.appendChild(banner);

    const updateBannerState = () => {
        banner.style.transform = navigator.onLine ? 'translateY(-100%)' : 'translateY(0)';
    };
    window.addEventListener('online', updateBannerState);
    window.addEventListener('offline', updateBannerState);
    updateBannerState();
}
document.addEventListener('DOMContentLoaded', initOfflineBanner);

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, checking page...');
    
    // Check if we are on a page that requires auth
    const path = window.location.pathname;
    console.log('Current path:', path);
    const isDashboard = path.includes('donor.html') || path.includes('hospital.html') || path.includes('admin.html');
    const currentUser = getCurrentUser();

    // Protective Routing
    if (isDashboard && !currentUser) {
        window.location.href = '/login.html';
        return;
    }

    // Admin console is admin-only. Fast path using the cached profile (the admin branch
    // below re-verifies the role against Firestore, since localStorage can be stale).
    if (path.includes('admin.html') && currentUser && currentUser.role !== 'admin') {
        window.location.href = currentUser.role === 'hospital' ? '/hospital.html' : '/donor.html';
        return;
    }

    // Handle Login Form (Stream C1 — Sign In, donor UI/VitalPulse_Plan_Tracker.md)
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        const identifierInput = document.getElementById('loginIdentifier');
        const passwordInput = document.getElementById('loginPassword');
        const errorBanner = document.getElementById('loginErrorBanner');
        const errorText = document.getElementById('loginErrorText');
        const attemptsWarning = document.getElementById('loginAttemptsWarning');
        const rememberCheckbox = document.getElementById('loginRememberMe');
        const submitBtn = document.getElementById('btnLoginSubmit');
        const toggleBtn = document.getElementById('btnToggleLoginPassword');

        // C1.1: show/hide password.
        if (toggleBtn && passwordInput) {
            toggleBtn.addEventListener('click', () => {
                const showing = passwordInput.type === 'text';
                passwordInput.type = showing ? 'password' : 'text';
                const icon = toggleBtn.querySelector('.material-symbols-outlined');
                if (icon) icon.textContent = showing ? 'visibility' : 'visibility_off';
                toggleBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
            });
        }

        const showError = (message) => {
            if (errorText) errorText.textContent = message;
            errorBanner?.classList.remove('hidden');
            identifierInput?.classList.add('border-error');
            passwordInput?.classList.add('border-error');
        };
        const hideError = () => {
            errorBanner?.classList.add('hidden');
            identifierInput?.classList.remove('border-error');
            passwordInput?.classList.remove('border-error');
        };

        // Submit button stays disabled (same "blurred until ready" treatment as Sign Up)
        // until both fields actually have something in them — separate from, and layered
        // under, the lockout state below (lockout always wins).
        const updateLoginSubmitEnabled = () => {
            const hasIdentifier = Boolean(identifierInput?.value.trim());
            const hasPassword = Boolean(passwordInput?.value);
            submitBtn.disabled = !(hasIdentifier && hasPassword);
        };
        identifierInput?.addEventListener('input', updateLoginSubmitEnabled);
        passwordInput?.addEventListener('input', updateLoginSubmitEnabled);

        // C1.2: reflect any lockout already in effect from a previous page load.
        const refreshAttemptsUI = () => {
            const state = readLoginFailureState();
            attemptsWarning?.classList.toggle('hidden', !shouldShowAttemptsWarning(state));
            if (isLockedOut(state)) {
                submitBtn.disabled = true;
                submitBtn.textContent = `Too many attempts — try again in ${lockoutSecondsRemaining(state)}s`;
                setTimeout(refreshAttemptsUI, 1000);
            } else {
                submitBtn.textContent = 'Sign In';
                updateLoginSubmitEnabled();
            }
        };
        refreshAttemptsUI();

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideError();

            const state = readLoginFailureState();
            if (isLockedOut(state)) { refreshAttemptsUI(); return; }

            const identifier = identifierInput.value.trim();
            const password = passwordInput.value;
            const GENERIC_ERROR = 'Incorrect email/phone or password. Please try again.';

            // Forgot Password gate (see loginAttempts.js): record that this identifier was
            // actually used to attempt a sign-in, regardless of outcome — Forgot Password
            // checks this before it'll do anything.
            recordAttemptedIdentifier(identifier);

            try {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Signing in…';

                // C1.4 "Remember me" — must be set before the actual sign-in call.
                await setLoginPersistence(Boolean(rememberCheckbox?.checked));

                // C1's mockup accepts "Phone or Email"; signInWithEmailAndPassword only
                // accepts an email. Emails pass straight through; phone numbers are
                // resolved server-side (see auth.js / functions/src/resolveSignInIdentifier.ts).
                const email = identifier.includes('@') ? identifier : await resolveSignInEmail(identifier);
                if (!email) {
                    // Same generic message as a wrong-password failure — this codepath must
                    // never reveal "that phone/email isn't registered" (C1.2, anti-enumeration).
                    throw new Error('no-matching-account');
                }

                const user = await loginUser(email, password);

                if (user.suspended) {
                    // C1.3: suspended -> block entirely, do not route anywhere.
                    await logoutUser();
                    showError('Your account has been suspended. Please contact support for assistance.');
                    return;
                }

                clearLoginFailures();

                // C1.3: route by role. "Pending Dashboard" vs full dashboard for donors
                // (kycStatus pending/verified) is Stream D's in-page banner/blur logic —
                // not built yet, so both land on donor.html for now; Stream D reads the
                // same kycStatus claim live once it exists.
                if (user.role === 'system_admin' || user.role === 'admin' || user.role === 'nbtp_viewer') window.location.href = '/admin.html';
                else if ((user.role && user.role.startsWith('hospital')) || user.role === 'lab_tech') window.location.href = '/hospital.html';
                else window.location.href = '/donor.html';

            } catch (error) {
                console.error('Login error:', error);
                recordLoginFailure();
                showError(GENERIC_ERROR);
                refreshAttemptsUI();
            } finally {
                if (!isLockedOut(readLoginFailureState())) {
                    submitBtn.textContent = 'Sign In';
                    updateLoginSubmitEnabled();
                }
            }
        });
    }

    // Handle Signup Form (Stream C2 — Sign Up, donor UI/VitalPulse_Plan_Tracker.md)
    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        const passwordInput = document.getElementById('password');
        const confirmInput = document.getElementById('confirmPassword');
        const confirmFeedback = document.getElementById('confirmPasswordFeedback');
        const phoneNationalInput = document.getElementById('phoneNational');
        const phoneError = document.getElementById('phoneError');
        const toggleBtn = document.getElementById('btnToggleSignupPassword');
        const suggestBtn = document.getElementById('btnSuggestPassword');

        // C2.1: show/hide password.
        if (toggleBtn && passwordInput) {
            toggleBtn.addEventListener('click', () => {
                const showing = passwordInput.type === 'text';
                passwordInput.type = showing ? 'password' : 'text';
                const icon = toggleBtn.querySelector('.material-symbols-outlined');
                if (icon) icon.textContent = showing ? 'visibility' : 'visibility_off';
            });
        }

        // C2.2/C2.3: live strength bar + criteria checklist as the donor types. Never
        // shown before the first keystroke (starts empty, so an untouched field shows
        // nothing to judge).
        if (passwordInput) {
            passwordInput.addEventListener('input', () => {
                const criteria = evaluatePasswordCriteria(passwordInput.value);
                const score = passwordStrengthScore(passwordInput.value);
                const segColors = ['bg-outline-variant/30', 'bg-error', 'bg-warning', 'bg-tertiary', 'bg-success'];
                document.querySelectorAll('.pw-seg').forEach((seg, i) => {
                    seg.className = `pw-seg h-1 rounded-full ${i < score ? segColors[score] : 'bg-outline-variant/30'}`;
                });
                document.querySelectorAll('.pw-criterion').forEach((el) => {
                    const met = criteria[el.dataset.criterion];
                    const icon = el.querySelector('.material-symbols-outlined');
                    el.classList.toggle('text-success', met);
                    el.classList.toggle('text-on-surface-variant', !met);
                    if (icon) {
                        icon.textContent = met ? 'check_circle' : 'radio_button_unchecked';
                        icon.style.fontVariationSettings = met ? "'FILL' 1" : "'FILL' 0";
                    }
                });
            });
        }

        // C2.4: Confirm Password validates onBlur only, never on keystroke.
        const validateConfirmOnBlur = () => {
            if (!confirmInput.value) { confirmFeedback.classList.add('hidden'); return; }
            const matches = passwordsMatch(passwordInput.value, confirmInput.value);
            confirmFeedback.textContent = matches ? 'Passwords match ✓' : 'Passwords do not match ✗';
            confirmFeedback.className = `mt-1.5 text-xs font-semibold ${matches ? 'text-success' : 'text-error'}`;
            confirmFeedback.classList.remove('hidden');
        };
        confirmInput?.addEventListener('blur', validateConfirmOnBlur);

        // C2.5: "Suggest strong password" — fills both fields, autocomplete="new-password"
        // already set in the markup so browser password managers offer to save it too.
        suggestBtn?.addEventListener('click', () => {
            const suggested = suggestStrongPassword();
            passwordInput.value = suggested;
            confirmInput.value = suggested;
            passwordInput.dispatchEvent(new Event('input'));
            passwordInput.type = 'text';
            confirmInput.type = 'text';
            const icon = toggleBtn?.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = 'visibility_off';
            validateConfirmOnBlur();
        });

        // Phone: format as-you-type, normalize + validate on blur.
        phoneNationalInput?.addEventListener('input', () => {
            phoneNationalInput.value = formatCameroonNationalNumber(phoneNationalInput.value);
        });
        phoneNationalInput?.addEventListener('blur', () => {
            const valid = !phoneNationalInput.value || normalizeCameroonPhone(phoneNationalInput.value);
            phoneError?.classList.toggle('hidden', Boolean(valid));
        });

        // Submit button stays disabled (visibly "blurred" via the existing disabled:opacity-60
        // style) until every field the current role actually requires is filled in — so
        // there's nothing to be tempted to click prematurely. Exposed on window because
        // signup.html's own inline toggleRoleFields() (donor <-> hospital) needs to
        // re-check it too, since that changes which fields are required.
        const submitBtnEl = signupForm.querySelector('button[type="submit"]');
        window.updateSignupSubmitEnabled = () => {
            const role = document.querySelector('input[name="role"]:checked')?.value;
            const allValid = isSignupFormValid({
                role,
                fullName: document.getElementById('fullName')?.value,
                email: document.getElementById('email')?.value,
                city: document.getElementById('city')?.value,
                termsChecked: document.getElementById('terms')?.checked,
                phone: phoneNationalInput?.value,
                password: passwordInput?.value,
                confirmPassword: confirmInput?.value,
                bloodType: document.getElementById('bloodType')?.value,
            });
            if (submitBtnEl) submitBtnEl.disabled = !allValid;
        };
        ['fullName', 'email', 'city'].forEach((id) => {
            document.getElementById(id)?.addEventListener('input', () => window.updateSignupSubmitEnabled());
        });
        document.getElementById('terms')?.addEventListener('change', () => window.updateSignupSubmitEnabled());
        document.getElementById('bloodType')?.addEventListener('change', () => window.updateSignupSubmitEnabled());
        phoneNationalInput?.addEventListener('input', () => window.updateSignupSubmitEnabled());
        passwordInput?.addEventListener('input', () => window.updateSignupSubmitEnabled());
        confirmInput?.addEventListener('input', () => window.updateSignupSubmitEnabled());
        window.updateSignupSubmitEnabled();

        // C2.6: a field's own inline error clears as soon as it's edited — errors from a
        // previous submit attempt shouldn't linger once the donor starts fixing them.
        [['fullName', 'input', 'fullNameError'], ['email', 'input', 'emailError'], ['city', 'input', 'cityError'],
         ['bloodType', 'change', 'bloodTypeError'], ['terms', 'change', 'termsError']].forEach(([id, evt, errId]) => {
            document.getElementById(id)?.addEventListener(evt, () => document.getElementById(errId)?.classList.add('hidden'));
        });
        phoneNationalInput?.addEventListener('input', () => phoneError?.classList.add('hidden'));
        passwordInput?.addEventListener('input', () => document.getElementById('passwordError')?.classList.add('hidden'));

        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fullName = document.getElementById('fullName').value.trim();
            const email = document.getElementById('email').value.trim();
            const role = document.querySelector('input[name="role"]:checked').value;
            const city = document.getElementById('city').value.trim();
            const password = passwordInput.value;
            const confirmPassword = confirmInput.value;
            const errorMsg = document.getElementById('errorMessage');
            const submitBtn = signupForm.querySelector('button[type="submit"]');
            const btnLabel = document.getElementById('btnSignupLabel');
            const resetBtn = (label) => { submitBtn.disabled = false; if (btnLabel) btnLabel.textContent = label; };

            // C2.6: submit guard — every field validated before any Firebase call, each
            // field gets its OWN inline error (not one generic banner), all shown together
            // rather than one-at-a-time, and nothing typed is ever cleared.
            const fullNameError = document.getElementById('fullNameError');
            const emailError = document.getElementById('emailError');
            const cityError = document.getElementById('cityError');
            const passwordError = document.getElementById('passwordError');
            const bloodTypeErrorEl = document.getElementById('bloodTypeError');
            const termsErrorEl = document.getElementById('termsError');
            [fullNameError, emailError, cityError, phoneError, passwordError, bloodTypeErrorEl, termsErrorEl]
                .forEach((el) => el?.classList.add('hidden'));
            confirmFeedback?.classList.add('hidden');
            errorMsg.classList.add('hidden');

            const showFieldError = (el, message) => { if (el) { el.textContent = message; el.classList.remove('hidden'); } };
            let firstInvalidEl = null;
            const invalidate = (inputEl) => { if (!firstInvalidEl) firstInvalidEl = inputEl; };

            if (!fullName) {
                showFieldError(fullNameError, role === 'hospital' ? 'Please enter your hospital name.' : 'Please enter your full name.');
                invalidate(document.getElementById('fullName'));
            }
            if (!email) {
                showFieldError(emailError, 'Please enter your email address.');
                invalidate(document.getElementById('email'));
            } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                showFieldError(emailError, 'Please enter a valid email address.');
                invalidate(document.getElementById('email'));
            }
            if (!city) {
                showFieldError(cityError, 'Please enter your city.');
                invalidate(document.getElementById('city'));
            }

            const normalizedPhone = normalizeCameroonPhone(phoneNationalInput.value);
            if (!normalizedPhone) {
                showFieldError(phoneError, 'Enter a valid Cameroon mobile number (starts with 6, 9 digits).');
                invalidate(phoneNationalInput);
            }

            if (!isPasswordValid(password)) {
                showFieldError(passwordError, 'Password must be at least 8 characters.');
                invalidate(passwordInput);
            }

            if (!confirmPassword) {
                confirmFeedback.textContent = 'Please confirm your password.';
                confirmFeedback.className = 'mt-1.5 text-xs font-semibold text-error';
                confirmFeedback.classList.remove('hidden');
                invalidate(confirmInput);
            } else if (confirmPassword !== password) {
                confirmFeedback.textContent = 'Passwords do not match ✗';
                confirmFeedback.className = 'mt-1.5 text-xs font-semibold text-error';
                confirmFeedback.classList.remove('hidden');
                invalidate(confirmInput);
            }

            if (!document.getElementById('terms').checked) {
                showFieldError(termsErrorEl, 'Please accept the Terms of Service and Privacy Policy to continue.');
                invalidate(document.getElementById('terms'));
            }

            const extraData = { name: fullName, city, phone: normalizedPhone };

            if (role === 'donor') {
                const bt = document.getElementById('bloodType');
                if (!bt || !bt.value) {
                    showFieldError(bloodTypeErrorEl, 'Please select your blood group, or tell us you don\'t know it.');
                    invalidate(bt);
                } else {
                    extraData.bloodType = bt.value;
                }
                // National ID (CNI) is collected on the KYC step (donor.html#kyc), not here —
                // see "National ID / CNI" comment in donor-dashboard.js's KYC submit handler.
            } else if (role === 'hospital') {
                extraData.isVerified = false;
                // License document upload moved out of Sign Up — hospital verification now
                // happens on a KYC-style step after account creation, same as donor's C3
                // (donor.html#kyc), not built yet for hospitals. See tracker note.
            }

            if (firstInvalidEl) {
                errorMsg.textContent = 'Please fix the highlighted fields below.';
                errorMsg.classList.remove('hidden');
                firstInvalidEl.focus();
                return;
            }

            try {
                submitBtn.disabled = true;
                if (btnLabel) btnLabel.textContent = 'Creating Account…';

                const user = await registerUser(email, password, role, extraData);

                if (role === 'donor') {
                    // C2.8: on to Step 2 (Identity) — the KYC view lives inside donor.html,
                    // not a separate signup.html step (see "Identity Verification (KYC).png",
                    // which renders inside the full donor-portal shell, not a standalone page).
                    showToast(user.kycBootstrapFailed
                        ? 'Account created! Verification setup is still finishing — you can complete identity verification from your profile shortly.'
                        : 'Account created! Let\'s verify your identity.');
                    setTimeout(() => { window.location.href = '/donor.html#kyc'; }, 1200);
                } else {
                    showToast('Account created! A verification email has been sent.');
                    setTimeout(() => {
                        window.location.href = user.role === 'admin' ? '/admin.html' : '/hospital.html';
                    }, 1500);
                }

            } catch (error) {
                const msg = error.code === 'auth/email-already-in-use' ? 'This email is already registered. Try logging in instead.'
                    : error.code === 'auth/weak-password' ? 'Password is too weak. Please choose a stronger one.'
                    : error.code === 'auth/invalid-email' ? 'Invalid email address.'
                    : error.code === 'auth/operation-not-allowed' ? 'Email/password sign-up is currently disabled.'
                    : error.message || 'Registration failed. Try again.';
                errorMsg.textContent = msg;
                errorMsg.classList.remove('hidden');
                if (error.code === 'auth/email-already-in-use') showFieldError(emailError, msg);
                resetBtn(role === 'donor' ? 'Continue to Verification' : 'Create Account');
            }
        });
    }

    // Handle Forgot Password — Request Link (Stream C4.1, forgot-password.html)
    const forgotPasswordForm = document.getElementById('forgotPasswordForm');
    if (forgotPasswordForm) {
        const identifierInput = document.getElementById('resetIdentifier');
        const gateMessage = document.getElementById('resetGateMessage');
        const errorMessage = document.getElementById('resetErrorMessage');
        const submitBtn = document.getElementById('btnSendResetLink');
        const requestStep = document.getElementById('requestLinkStep');
        const sentStep = document.getElementById('linkSentStep');

        // Security Lead's gate: nudges toward trying Sign In first for an identifier that
        // hasn't been attempted (see loginAttempts.js for the full rationale and caveats —
        // this is a UX nudge, not the real anti-enumeration protection). Softened
        // 2026-08-01 to a warning rather than a hard block — same convention as the
        // failed-login-attempts warning elsewhere in this app (warns early, only ever a
        // brief cooldown, never a permanent lock) — a permanent disabled button surprised
        // even the person who asked for the gate.
        const updateGateState = () => {
            const val = identifierInput.value.trim();
            errorMessage.classList.add('hidden');
            if (!val) {
                gateMessage.classList.add('hidden');
                submitBtn.disabled = true;
                return;
            }
            gateMessage.classList.toggle('hidden', hasAttemptedIdentifier(val));
            submitBtn.disabled = false;
        };
        identifierInput?.addEventListener('input', updateGateState);
        updateGateState();

        forgotPasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const identifier = identifierInput.value.trim();
            if (!identifier) { updateGateState(); return; }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Sending…';
            try {
                const email = identifier.includes('@') ? identifier : await resolveSignInEmail(identifier);
                if (email) {
                    await sendPasswordReset(email).catch((err) => {
                        // Never let "no such account" distinguish from success client-side —
                        // the same generic screen shows either way (anti-enumeration).
                        if (err?.code !== 'auth/user-not-found') throw err;
                    });
                }
                requestStep?.classList.add('hidden');
                sentStep?.classList.remove('hidden');
            } catch (err) {
                console.error('Password reset request failed:', err);
                errorMessage.textContent = 'Something went wrong. Please try again in a moment.';
                errorMessage.classList.remove('hidden');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Send Reset Link';
            }
        });
    }

    // Handle Set New Password (Stream C4.2-C4.4, reset-password.html)
    const resetCheckingStep = document.getElementById('resetCheckingStep');
    if (resetCheckingStep) {
        const resetFormStep = document.getElementById('resetFormStep');
        const resetSuccessStep = document.getElementById('resetSuccessStep');
        const resetInvalidStep = document.getElementById('resetInvalidStep');
        const resetPasswordForm = document.getElementById('resetPasswordForm');
        // Custom 30-minute token pipeline (functions/src/passwordReset.ts), not Firebase's
        // oobCode — the reset link carries its own uid+token pair instead.
        const resetParams = new URLSearchParams(window.location.search);
        const resetUid = resetParams.get('uid');
        const resetToken = resetParams.get('token');

        // C4.4: never show the form until the link is confirmed valid.
        (async () => {
            if (!resetUid || !resetToken) {
                resetCheckingStep.classList.add('hidden');
                resetInvalidStep?.classList.remove('hidden');
                return;
            }
            try {
                await verifyResetCode(resetUid, resetToken);
                resetCheckingStep.classList.add('hidden');
                resetFormStep?.classList.remove('hidden');
            } catch (err) {
                console.error('Reset link invalid or expired:', err);
                resetCheckingStep.classList.add('hidden');
                resetInvalidStep?.classList.remove('hidden');
            }
        })();

        const newPasswordInput = document.getElementById('newPassword');
        const confirmNewPasswordInput = document.getElementById('confirmNewPassword');
        const confirmNewPasswordFeedback = document.getElementById('confirmNewPasswordFeedback');
        const toggleNewPasswordBtn = document.getElementById('btnToggleNewPassword');
        const submitResetBtn = document.getElementById('btnResetPassword');
        const resetPasswordError = document.getElementById('resetPasswordError');

        toggleNewPasswordBtn?.addEventListener('click', () => {
            const showing = newPasswordInput.type === 'text';
            newPasswordInput.type = showing ? 'password' : 'text';
            const icon = toggleNewPasswordBtn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = showing ? 'visibility' : 'visibility_off';
        });

        const updateResetSubmitEnabled = () => {
            const valid = isPasswordValid(newPasswordInput?.value || '')
                && Boolean(confirmNewPasswordInput?.value)
                && confirmNewPasswordInput.value === newPasswordInput?.value;
            if (submitResetBtn) submitResetBtn.disabled = !valid;
        };

        newPasswordInput?.addEventListener('input', () => {
            const criteria = evaluatePasswordCriteria(newPasswordInput.value);
            const score = passwordStrengthScore(newPasswordInput.value);
            const segColors = ['bg-outline-variant/30', 'bg-error', 'bg-warning', 'bg-tertiary', 'bg-success'];
            document.querySelectorAll('#resetPasswordForm .pw-seg').forEach((seg, i) => {
                seg.className = `pw-seg h-1 rounded-full ${i < score ? segColors[score] : 'bg-outline-variant/30'}`;
            });
            document.querySelectorAll('#resetPasswordForm .pw-criterion').forEach((el) => {
                const met = criteria[el.dataset.criterion];
                const icon = el.querySelector('.material-symbols-outlined');
                el.classList.toggle('text-success', met);
                el.classList.toggle('text-on-surface-variant', !met);
                if (icon) {
                    icon.textContent = met ? 'check_circle' : 'radio_button_unchecked';
                    icon.style.fontVariationSettings = met ? "'FILL' 1" : "'FILL' 0";
                }
            });
            updateResetSubmitEnabled();
        });

        const validateConfirmNewPasswordOnBlur = () => {
            if (!confirmNewPasswordInput.value) { confirmNewPasswordFeedback.classList.add('hidden'); return; }
            const matches = confirmNewPasswordInput.value === newPasswordInput.value;
            confirmNewPasswordFeedback.textContent = matches ? 'Passwords match ✓' : 'Passwords do not match ✗';
            confirmNewPasswordFeedback.className = `mt-1.5 text-xs font-semibold ${matches ? 'text-success' : 'text-error'}`;
            confirmNewPasswordFeedback.classList.remove('hidden');
        };
        confirmNewPasswordInput?.addEventListener('blur', validateConfirmNewPasswordOnBlur);
        confirmNewPasswordInput?.addEventListener('input', updateResetSubmitEnabled);

        resetPasswordForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            resetPasswordError?.classList.add('hidden');
            if (!resetUid || !resetToken || !isPasswordValid(newPasswordInput.value) || newPasswordInput.value !== confirmNewPasswordInput.value) return;

            submitResetBtn.disabled = true;
            submitResetBtn.textContent = 'Resetting…';
            try {
                await confirmReset(resetUid, resetToken, newPasswordInput.value);
                resetFormStep?.classList.add('hidden');
                resetSuccessStep?.classList.remove('hidden');
            } catch (err) {
                console.error('Password reset failed:', err);
                if (resetPasswordError) {
                    resetPasswordError.textContent =
                        err.code === 'functions/failed-precondition' ? 'This link just expired. Please request a new one.'
                        : err.code === 'functions/invalid-argument' ? 'Password is too weak. Please choose a stronger one.'
                        : 'Something went wrong. Please try again.';
                    resetPasswordError.classList.remove('hidden');
                }
                submitResetBtn.disabled = false;
                submitResetBtn.textContent = 'Reset Password';
            }
        });
    }

    // Handle Logouts (Assuming there might be a logout button added to dashboards later)
    const logoutBtns = document.querySelectorAll('.logout-btn');
    logoutBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            logoutUser();
        });
    });

    // Handle Profile/Dashboard hydration based on currentUser
    if (isDashboard && currentUser) {
        if (path.includes('donor.html')) {
            const welcomeEl = document.getElementById('donorWelcomeMsg');
            if (welcomeEl) {
                const firstName = (currentUser.name || currentUser.email?.split('@')[0] || 'Donor').split(' ')[0];
                welcomeEl.textContent = `Welcome back, ${firstName} 👋`;
            }
            // blood type is rendered by donor-dashboard.js hero section
        } else if (path.includes('hospital.html')) {
            const hName = document.getElementById('hospitalName');
            const hLoc = document.getElementById('hospitalLocation');
            if (hName) hName.textContent = currentUser.name || 'General Hospital';
            if (hLoc) hLoc.innerHTML = `<span class="material-symbols-outlined text-sm" data-icon="location_on">location_on</span> ${currentUser.city || 'Yaoundé'} Network`;
        } else if (path.includes('admin.html')) {
            const adminName = document.getElementById('adminName');
            if (adminName) adminName.textContent = currentUser.name || 'Super Admin';
            const sidebarName = document.getElementById('sidebarAdminName');
            if (sidebarName) sidebarName.textContent = currentUser.name || 'Super Admin';
            const sidebarAvatar = document.getElementById('sidebarAvatar');
            if (sidebarAvatar) sidebarAvatar.textContent = (currentUser.name || 'A').charAt(0).toUpperCase();
            const adminRole = document.getElementById('adminRole');
            if (adminRole) adminRole.textContent = 'Super Administrator';
        }
        
        // Data hydration logic
        try {
            if (path.includes('donor.html')) {
                // Email verification check (async: reloads user from Firebase first)
                window.sendEmailVerificationLink = sendEmailVerificationLink;
                (async () => {
                    try {
                        const verified = await isEmailVerified();
                        if (verified) return;
                        const alertsHost = document.getElementById('dashboardAlerts');
                        if (!alertsHost || document.getElementById('emailVerifyBanner')) return;
                        async function handleVerifyResend() {
                            try {
                                const nowVerified = await isEmailVerified();
                                if (nowVerified) {
                                    const b = document.getElementById('emailVerifyBanner');
                                    if (b) b.remove();
                                    showToast('Email verified!');
                                    return;
                                }
                                await sendEmailVerificationLink();
                                showToast('Verification email sent — check your inbox.');
                            } catch (e) {
                                showToast('Failed to send verification email.', 'error');
                            }
                        }
                        window.handleVerifyResend = handleVerifyResend;
                        // Professional, token-based, dismissible top banner (dark-mode safe).
                        const banner = document.createElement('div');
                        banner.id = 'emailVerifyBanner';
                        banner.className = 'flex items-start gap-3 bg-amber-100 border border-amber-300/60 rounded-2xl px-4 py-3.5 shadow-sm';
                        banner.innerHTML = `
                          <span class="w-9 h-9 rounded-xl bg-amber-200/70 text-amber-800 flex items-center justify-center shrink-0"><span class="material-symbols-outlined">mark_email_unread</span></span>
                          <div class="flex-1 min-w-0">
                            <p class="text-sm font-bold text-amber-900">Verify your email address</p>
                            <p class="text-xs text-amber-800/80 mt-0.5">Please check your inbox to confirm your registration and unlock full access.</p>
                          </div>
                          <div class="flex items-center gap-2 shrink-0">
                            <button onclick="handleVerifyResend()" class="press-scale text-xs font-bold text-on-primary bg-primary hover:opacity-90 px-3.5 py-2 rounded-xl transition-opacity cursor-pointer">Verify</button>
                            <button onclick="document.getElementById('emailVerifyBanner')?.remove()" aria-label="Dismiss" class="press-scale w-8 h-8 rounded-lg text-on-surface-variant hover:bg-surface-container-low flex items-center justify-center cursor-pointer"><span class="material-symbols-outlined text-lg">close</span></button>
                          </div>`;
                        alertsHost.appendChild(banner);
                    } catch (e) {
                        console.warn('Email verification check failed:', e);
                    }
                })();
                initDonorNavigation();
                loadDonorDashboard();
                initDonorDonationFlow();
                window.switchDonorView = switchDonorView;
                window.loadDonorDonations = loadDonorDonations;
                window.markOnboardingComplete = markOnboardingComplete;
            } else if (path.includes('hospital.html')) {
                initHospitalNavigation();
                loadHospitalDashboard();
                initHospitalNotifications();
                window.markOnboardingComplete = markOnboardingComplete;
                if (shouldShowOnboarding()) startOnboarding('hospital');
            } else if (path.includes('admin.html')) {
                // Authoritative admin guard: localStorage can be stale or tampered with, so
                // verify the role straight from the users collection before loading anything.
                (async () => {
                    try {
                        const fbUser = await waitForAuthUser();
                        if (!fbUser) {
                            window.location.href = '/login.html';
                            return;
                        }
                        const snap = await getDoc(doc(db, 'users', fbUser.uid));
                        const role = snap.exists() ? snap.data().role : null;
                        if (role !== 'admin') {
                            window.location.href = role === 'hospital' ? '/hospital.html' : '/donor.html';
                            return;
                        }
                        loadAdminDashboard();
                    } catch (guardError) {
                        console.error('Admin access check failed:', guardError);
                        showFallbackError();
                    }
                })();
            }
            // After auth check, run onboarding for donor. Language toggle for donor.html is
            // now a header-anchored pill (initDonorLangToggle() in donor-dashboard.js, wired
            // from initDonorNavigation()) instead of the floating injectLangToggle() pill —
            // avoids mounting two separate toggles on the same page.
            if (path.includes('donor.html')) {
                if (shouldShowOnboarding()) startOnboarding('donor');
            }

            // Inject lang toggle for hospital too
            if (path.includes('hospital.html')) {
                injectLangToggle();
            }
        } catch (initError) {
            console.error('Dashboard init failed:', initError);
            showFallbackError();
        }
    }

});

// Fallback for donor dashboard if initialization fails
function showFallbackError() {
  const path = window.location.pathname;
  if (!path.includes('donor.html')) return;

  const spinners = [
    'donorTierProgress', 'donorEligibilityBar', 'requestsFeed',
    'donorBadgesSummary', 'donorCampaigns', 'donationCentersList',
    'donorRecentActivity', 'donorRequestsList', 'badgesFullView',
  ];
  spinners.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.querySelector('.animate-spin')) {
      el.innerHTML = '<div class="flex items-center justify-center py-4 text-on-surface-variant"><span class="text-sm">Could not load data.</span></div>';
    }
  });

  // Wire buttons with basic implementations as safety net
  document.querySelectorAll('[onclick*="switchDonorView"]').forEach(el => {
    const match = el.getAttribute('onclick')?.match(/switchDonorView\('(\w+)'\)/);
    if (match) {
      el.removeAttribute('onclick');
      el.addEventListener('click', () => {
        document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden'));
        const target = document.getElementById('view-' + match[1]);
        if (target) { target.classList.remove('hidden'); target.classList.add('block'); }
      });
    }
  });

  // Fallback: open donation modal for FAB and schedule buttons
  const showDonationModal = () => {
    const m = document.getElementById('donationModal');
    if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
  };
  document.getElementById('btnDonateFAB')?.addEventListener('click', showDonationModal);
  document.getElementById('btnScheduleDonationDesktop')?.addEventListener('click', showDonationModal);
  document.getElementById('btnCancelDonation')?.addEventListener('click', () => {
    const m = document.getElementById('donationModal');
    if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
  });
  document.getElementById('donationBackdrop')?.addEventListener('click', () => {
    const m = document.getElementById('donationModal');
    if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
  });
}

// Safety timeout: if loading spinners are still visible after 20s, clear them
setTimeout(() => showFallbackError(), 20000);

// ============================================
// DONOR DASHBOARD (moved to donor-dashboard.js)
// ============================================

// ============================================
// HOSPITAL DASHBOARD
// ============================================




// ============================================
// HOSPITAL DASHBOARD
// ============================================

let hospitalNavigationInitialized = false;

const HOSPITAL_VIEW_PERMISSIONS = {
    staff: ['hospital_admin'],
    settings: ['hospital_admin'],
    campaigns: ['hospital_admin'],
    forecasting: ['hospital_admin'],
    mythbusting: ['hospital_admin'],
    certificates: ['hospital_admin'],
    // Phase 3 Moderate Pages
    lab: ['lab_tech', 'hospital_admin'],
    requests: ['nurse', 'hospital_admin'],
    hemovigilance: ['nurse', 'lab_tech', 'hospital_admin'],
    donors: ['reception', 'nurse', 'hospital_admin'],
};

export function updateHospitalNavVisibility() {
    const user = getCurrentUser();
    const navIds = ['dashboard', 'lab', 'requests', 'inventory', 'donors', 'campaigns', 'settings', 'staff', 'hemovigilance', 'forecasting', 'mythbusting', 'certificates'];
    navIds.forEach(id => {
        const canAccess = canAccessView(user, id, HOSPITAL_VIEW_PERMISSIONS);
        const nav = document.getElementById('nav-' + id);
        if (nav) {
            if (canAccess) {
                nav.classList.remove('hidden');
            } else {
                nav.classList.add('hidden');
            }
        }
        const mobileBtn = document.querySelector(`.mobile-drawer-btn[data-nav="${id}"]`);
        if (mobileBtn) {
            if (canAccess) {
                mobileBtn.classList.remove('hidden');
            } else {
                mobileBtn.classList.add('hidden');
            }
        }
    });

    // Urgent Request Buttons (nurse & hospital_admin only)
    const canRequestEmergency = isLegacyAccount(user) || hasAnyRole(user, ['nurse', 'hospital_admin']);
    ['btnUrgentRequest', 'mobileDrawerUrgent', 'dashUrgentBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            if (canRequestEmergency) {
                btn.classList.remove('hidden');
            } else {
                btn.classList.add('hidden');
            }
        }
    });
}

function initHospitalNavigation() {
    if (hospitalNavigationInitialized) return;

    const navIds = ['dashboard', 'lab', 'requests', 'inventory', 'donors', 'campaigns', 'settings', 'staff', 'hemovigilance', 'forecasting', 'mythbusting', 'certificates'];
    const viewIds = ['dashboard', 'lab', 'requests', 'inventory', 'donors', 'campaigns', 'settings', 'staff', 'hemovigilance', 'forecasting', 'mythbusting', 'certificates'];

    const globalTitle = document.getElementById('globalHeaderTitle');
    const globalSubtitle = document.getElementById('globalHeaderSubtitle');

    const titles = {
        dashboard: { title: 'Dashboard', sub: 'Hospital Control Center' },
        lab: { title: 'Lab & Testing', sub: 'Blood Testing Queue' },
        requests: { title: 'My Requests', sub: 'Blood Request Management' },
        inventory: { title: 'Inventory', sub: 'Blood Stock Management' },
        donors: { title: 'Incoming Donors', sub: 'Donor Coordination' },
        settings: { title: 'Settings', sub: 'Hospital Profile & Preferences' },
        staff: { title: 'Staff Roster', sub: 'Individual Staff Logins, Roles & PIN Access' },
        campaigns: { title: 'Campaigns', sub: 'Donation Drives' },
        hemovigilance: { title: 'Hemovigilance', sub: 'Adverse Transfusion Reaction Tracking' },
        forecasting: { title: 'Forecasting', sub: 'Blood Demand Forecasting' },
        mythbusting: { title: 'Myth-Busting', sub: 'Donor Education Articles' },
        certificates: { title: 'Certificates', sub: 'Life Saver Recognition' }
    };

    const activeClass = 'bg-red-50 text-red-700 font-bold shadow-sm';
    const inactiveClass = 'text-slate-500 hover:bg-red-50 hover:text-red-700';

    updateHospitalNavVisibility();

    const switchView = (target) => {
        const currentUser = getCurrentUser();
        if (!canAccessView(currentUser, target, HOSPITAL_VIEW_PERMISSIONS)) {
            console.warn(`[Route Guard] Access denied to view '${target}' for active session.`);
            target = 'dashboard';
        }

        viewIds.forEach(id => {
            const el = document.getElementById('view-' + id);
            if (el) {
                el.classList.add('hidden');
                el.classList.remove('block');
            }
        });
        navIds.forEach(id => {
            const nav = document.getElementById('nav-' + id);
            if (nav) {
                nav.className = `flex items-center gap-3 px-4 py-2.5 rounded-xl ${inactiveClass} transition-all duration-200 cursor-pointer`;
            }
        });

        const activeView = document.getElementById('view-' + target);
        if (activeView) {
            activeView.classList.remove('hidden');
            activeView.classList.add('block');
        }
        const activeNav = document.getElementById('nav-' + target);
        if (activeNav) {
            activeNav.className = `flex items-center gap-3 px-4 py-2.5 rounded-xl ${activeClass} transition-all duration-200 cursor-pointer`;
        }

        // Sync mobile drawer active state
        document.querySelectorAll('.mobile-drawer-btn').forEach(b => {
            const isActive = b.dataset.nav === target;
            b.classList.remove('text-red-600', 'bg-red-50', 'font-semibold');
            b.classList.add('text-slate-500', 'font-medium');
            const icon = b.querySelector('.material-symbols-outlined');
            if (icon) icon.style.fontVariationSettings = "'FILL' 0";
            if (isActive) {
                b.classList.remove('text-slate-500', 'font-medium');
                b.classList.add('text-red-600', 'bg-red-50', 'font-semibold');
                if (icon) icon.style.fontVariationSettings = "'FILL' 1";
            }
        });

        if (globalTitle) globalTitle.textContent = titles[target].title;
        if (globalSubtitle) globalSubtitle.textContent = titles[target].sub;

        // Lazy load data
        switch (target) {
            case 'dashboard': loadHospitalDashboard(); break;
            case 'lab': loadLabPipeline(); break;
            case 'requests': loadHospitalRequests(); break;
            case 'inventory': loadHospitalInventoryData(); break;
            case 'donors': loadHospitalDonors(); break;
            case 'settings': loadHospitalSettings(); break;
            case 'staff': loadHospitalStaffView(); break;
            case 'campaigns': loadHospitalCampaignsView(); break;
            case 'hemovigilance': loadHemovigilanceView(); break;
            case 'forecasting': loadForecastingView(); break;
            case 'mythbusting': loadMythBustingView(); break;
            case 'certificates': loadCertificatesView(); break;
        }
        history.replaceState(null, '', '#' + target);
    };

    navIds.forEach(id => {
        const nav = document.getElementById('nav-' + id);
        if (nav) {
            nav.addEventListener('click', (e) => {
                e.preventDefault();
                switchView(id);
            });
        }
    });

    // Wire up refresh button
    const refreshBtn = document.getElementById('btnRefresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            const activeView = viewIds.find(id => !document.getElementById('view-' + id)?.classList.contains('hidden'));
            if (activeView) switchView(activeView);
        });
    }

    // Wire up new request modal
    initNewRequestModal();
    initUrgentRequestModal();
    initHospitalAddStockModal();
    initIssueBloodModal();
    initCompatibilityGuideModal();
    initThresholdModal();

    // Wire mobile hamburger → drawer
    const hamburger = document.getElementById('mobileHamburger');
    const drawer = document.getElementById('mobileDrawer');
    const overlay = document.getElementById('mobileDrawerOverlay');
    const closeBtn = document.getElementById('mobileDrawerClose');

    function openDrawer() {
        drawer.classList.remove('-translate-x-full');
        overlay.classList.remove('hidden');
        requestAnimationFrame(() => overlay.classList.remove('opacity-0'));
    }
    function closeDrawer() {
        drawer.classList.add('-translate-x-full');
        overlay.classList.add('opacity-0');
        setTimeout(() => overlay.classList.add('hidden'), 300);
    }

    if (hamburger) hamburger.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (overlay) overlay.addEventListener('click', closeDrawer);

    // Wire mobile drawer nav buttons
    document.querySelectorAll('.mobile-drawer-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.nav;
            document.querySelectorAll('.mobile-drawer-btn').forEach(b => {
                b.classList.remove('text-red-600', 'bg-red-50', 'font-semibold');
                b.classList.add('text-slate-500', 'font-medium');
                const icon = b.querySelector('.material-symbols-outlined');
                if (icon) icon.style.fontVariationSettings = "'FILL' 0";
            });
            btn.classList.remove('text-slate-500', 'font-medium');
            btn.classList.add('text-red-600', 'bg-red-50', 'font-semibold');
            const icon = btn.querySelector('.material-symbols-outlined');
            if (icon) icon.style.fontVariationSettings = "'FILL' 1";
            switchView(target);
            closeDrawer();
        });
    });

    // Wire drawer urgent request button
    const drawerUrgent = document.getElementById('mobileDrawerUrgent');
    if (drawerUrgent) {
        drawerUrgent.addEventListener('click', () => {
            closeDrawer();
            const modal = document.getElementById('urgentRequestModal');
            if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
        });
    }

    // Init new features
    initTimelineModal();
    initRemoveStockModal();
    initHemovigilanceModal();
    initMythArticleModal();
    initIssueCertModal();
    initChronicPatientModal();
    initTransferModal();
    initDonorReactionModal();
    initLabPipelineControls();
    initLabTestModal();
    initLabCertModal();
    initDonationIntakeModal();
    initScheduledBookingsControls();
    initDonorCheckInTokenLookup();
    initHospitalActivityLogModal();
    initInventoryMovementsRefresh();

    // Wire compatibility guide button
    const compatBtn = document.getElementById('btnOpenCompatGuide');
    if (compatBtn) {
        compatBtn.addEventListener('click', () => {
            const modal = document.getElementById('compatModal');
            if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
        });
    }

    // Wire dashboard 'Go to Inventory' button
    const dashInvBtn = document.getElementById('dashInventoryBtn');
    if (dashInvBtn) {
        dashInvBtn.addEventListener('click', () => switchView('inventory'));
    }

    // Restore view from URL hash on reload
    const hospHash = window.location.hash.replace('#', '');
    if (hospHash && navIds.includes(hospHash)) switchView(hospHash);

    window.addEventListener('hashchange', () => {
        const v = window.location.hash.replace('#', '');
        if (v && navIds.includes(v)) switchView(v);
    });

    hospitalNavigationInitialized = true;
}

async function loadHospitalDashboard() {
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    const greetingEl = document.getElementById('dashHospitalGreeting');
    if (greetingEl) greetingEl.textContent = hospitalName;
    const dateEl = document.getElementById('dashDate');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    try {
        const [allRequests, inventory, recentLogs] = await Promise.all([
            fetchActiveRequests(),
            fetchInventory(hospitalName),
            fetchRecentLogs(5)
        ]);

        const myRequests = allRequests.filter(r => r.hospital === hospitalName);
        const totalUnits = Object.values(inventory).reduce((s, i) => s + (i.unitsAvailable || 0), 0);
        const lowStockTypes = Object.values(inventory).filter(i => (i.unitsAvailable || 0) <= (i.minimumThreshold || 5));

        document.getElementById('dashActiveRequests').textContent = myRequests.length;
        document.getElementById('dashLowStock').textContent = lowStockTypes.length;
        document.getElementById('dashIncomingDonors').textContent = myRequests.filter(r => ['Donor Assigned', 'Donor En Route'].includes(r.status)).length;
        document.getElementById('dashTotalUnits').textContent = totalUnits;

        // Requests feed — show only this hospital's requests
        const feedEl = document.getElementById('dashRequestsFeed');
        if (feedEl) {
            const myActiveRequests = allRequests.filter(r => r.hospital === hospitalName);
            if (myActiveRequests.length === 0) {
                feedEl.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">check_circle</span><p class="text-sm">No active requests from your hospital</p></div>';
            } else {
                feedEl.innerHTML = myActiveRequests.slice(0, 8).map(req => {
                    const isMine = true;
                    const statusColor = req.status === 'Donor Assigned' || req.status === 'Donor En Route' ? 'bg-amber-500' : 'bg-blue-500';
                    const statusLabel = ['Donor Assigned', 'Donor En Route'].includes(req.status) ? req.status : 'Open';
                    return `
                    <div class="flex items-center justify-between p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors ${isMine ? 'ring-2 ring-red-200' : ''}">
                        <div class="flex items-center gap-3 min-w-0">
                            <span class="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm shrink-0">${req.type || req.bloodType || '?'}</span>
                            <div class="min-w-0">
                                <p class="text-sm font-bold text-on-surface truncate">${req.hospital}</p>
                                <p class="text-xs text-slate-500">${req.units || 1} unit${(req.units || 1) > 1 ? 's' : ''} needed</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <span class="w-2 h-2 rounded-full ${statusColor} ${['Donor Assigned', 'Donor En Route'].includes(req.status) ? 'animate-pulse' : ''}"></span>
                            <span class="text-[10px] font-bold text-slate-500 uppercase">${statusLabel}</span>
                        </div>
                    </div>
                    `;
                }).join('');
            }
        }

        // Activity feed
        const activityEl = document.getElementById('dashActivityFeed');
        if (activityEl) {
            if (recentLogs.length === 0) {
                activityEl.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">No recent activity</p></div>';
            } else {
                activityEl.innerHTML = recentLogs.map(log => {
                    const icon = log.type === 'success' ? 'check_circle' : log.type === 'warning' ? 'warning' : log.type === 'error' ? 'error' : 'info';
                    const color = log.type === 'success' ? 'text-emerald-600' : log.type === 'warning' ? 'text-amber-600' : log.type === 'error' ? 'text-red-600' : 'text-slate-600';
                    return `
                    <div class="flex items-start gap-3">
                        <span class="material-symbols-outlined text-sm ${color} mt-0.5">${icon}</span>
                        <div class="min-w-0">
                            <p class="text-sm font-bold text-on-surface truncate">${log.title}</p>
                            <p class="text-xs text-slate-500 truncate">${log.description}</p>
                            <p class="text-[10px] text-slate-400 mt-0.5">${new Date(log.timestamp).toLocaleString()}</p>
                        </div>
                    </div>
                    `;
                }).join('');
            }
        }
    } catch (e) {
        console.error('Failed to load hospital dashboard:', e);
    }

    // Load dashboard chart (Feature 9)
    loadDashboardChart();

    // Wire quick action button
    const dashUrgentBtn = document.getElementById('dashUrgentBtn');
    if (dashUrgentBtn) {
        dashUrgentBtn.onclick = () => {
            const modal = document.getElementById('urgentModal');
            if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
        };
    }
}

async function loadHospitalRequests() {
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';
    const tableBody = document.getElementById('requestsTableBody');
    if (!tableBody) return;

    try {
        const requests = await fetchHospitalRequests(hospitalName);

        document.getElementById('reqTotal').textContent = requests.length;
        document.getElementById('reqPending').textContent = requests.filter(r => ['Open', 'Matching', 'Donor Assigned', 'Donor En Route'].includes(r.status)).length;
        document.getElementById('reqResolved').textContent = requests.filter(r => r.status === 'Resolved').length;

        if (requests.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="px-6 py-12 text-center text-slate-400"><span class="material-symbols-outlined block text-3xl mb-2">assignment</span><p class="text-sm">No requests yet. Click "New Request" to create one.</p></td></tr>';
            return;
        }

        tableBody.innerHTML = requests.map(req => {
            const statusColors = {
                'Open': { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
                'Matching': { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
                'Donor Assigned': { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
                'Donor En Route': { bg: 'bg-indigo-100', text: 'text-indigo-700', dot: 'bg-indigo-500' },
                'Resolved': { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' }
            };
            const sc = statusColors[req.status] || { bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-500' };
            const urgencyColor = req.urgency === 'critical' ? 'text-red-600 bg-red-50' : req.urgency === 'urgent' ? 'text-amber-600 bg-amber-50' : 'text-slate-600 bg-slate-50';
            return `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="px-6 py-4"><span class="text-xs font-mono font-bold text-slate-700">#${req.id.slice(0, 8).toUpperCase()}</span></td>
                <td class="px-6 py-4"><span class="font-black text-red-700 bg-red-50 px-2 py-1 rounded text-xs">${req.type || req.bloodType || '?'}</span></td>
                <td class="px-6 py-4 text-sm font-semibold">${req.units || 1}</td>
                <td class="px-6 py-4"><span class="text-[10px] font-bold uppercase ${urgencyColor} px-2 py-1 rounded-lg">${req.urgency || 'standard'}</span></td>
                <td class="px-6 py-4">
                    <div class="flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full ${sc.dot} ${['Donor Assigned', 'Donor En Route'].includes(req.status) ? 'animate-pulse' : ''}"></span>
                        <span class="text-xs font-bold ${sc.text} ${sc.bg} px-2 py-1 rounded-md">${req.status}</span>
                    </div>
                </td>
                <td class="px-6 py-4 text-xs text-slate-500">${new Date(req.requestedAt || req.createdAt).toLocaleDateString()}</td>
                <td class="px-6 py-4 text-right">
                    <div class="flex items-center justify-end gap-1">
                        <button onclick="window.openRequestTimeline('${req.id}')" class="text-[9px] font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors" title="View Timeline">
                            <span class="material-symbols-outlined text-xs">timeline</span>
                        </button>
                        <button onclick="window.printRequestSlip('${req.id}')" class="text-[9px] font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors" title="Print Slip">
                            <span class="material-symbols-outlined text-xs">print</span>
                        </button>
                        ${['Open', 'Matching'].includes(req.status) ? `<button onclick="window.cancelHospitalRequestAction('${req.id}')" class="text-[9px] font-bold text-red-600 bg-red-50 hover:bg-red-100 px-2 py-1 rounded-lg transition-colors" title="Cancel Request">
                            <span class="material-symbols-outlined text-xs">cancel</span>
                        </button>` : ''}
                        ${req.status === 'Resolved' ? '<span class="text-xs text-emerald-600 font-medium ml-1">Done</span>' : req.status === 'Donor En Route' ? '<span class="text-xs text-indigo-600 font-medium ml-1 animate-pulse">🔄 En Route</span>' : req.status === 'Cancelled' ? '<span class="text-xs text-red-600 font-medium ml-1">Cancelled</span>' : '<span class="text-xs text-slate-400 ml-1">Open</span>'}
                    </div>
                </td>
            </tr>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load hospital requests:', e);
        tableBody.innerHTML = '<tr><td colspan="7" class="text-center text-error py-8">Failed to load requests.</td></tr>';
    }

    loadChronicPatients();
}

// ============================================
// PHASE 2: CHRONIC / RECURRING PATIENT REGISTRY
// Hospital-scoped only — each hospital manages its own recurring patients.
// ============================================

let chronicPatientsCache = [];

async function loadChronicPatients() {
    const gridEl = document.getElementById('chronicPatientsGrid');
    if (!gridEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        chronicPatientsCache = await fetchChronicPatients(hospitalName);

        if (chronicPatientsCache.length === 0) {
            gridEl.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">medical_services</span><p class="text-sm">No chronic patients registered yet.</p></div>';
            return;
        }

        const today = new Date();
        gridEl.innerHTML = chronicPatientsCache.map(p => {
            const nextDue = p.nextDueDate ? new Date(p.nextDueDate) : null;
            const isOverdue = nextDue && nextDue < today;
            return `
            <div class="bg-slate-50/70 rounded-2xl border ${isOverdue ? 'border-red-200' : 'border-slate-200/50'} p-4">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="w-9 h-9 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center font-black text-xs shrink-0">${p.bloodType}</span>
                        <div class="min-w-0">
                            <p class="text-sm font-bold text-on-surface truncate">${p.patientName}</p>
                            <p class="text-[10px] text-slate-500 truncate">${p.condition}</p>
                        </div>
                    </div>
                    ${isOverdue ? '<span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full text-red-600 bg-red-100 shrink-0">Overdue</span>' : ''}
                </div>
                <p class="text-[10px] text-slate-500 mb-3">Every ${p.recurrenceWeeks} week${p.recurrenceWeeks > 1 ? 's' : ''} · Last: ${p.lastTransfusionDate ? new Date(p.lastTransfusionDate).toLocaleDateString() : '—'}</p>
                <div class="grid grid-cols-2 gap-1.5">
                    <button onclick="window.requestChronicPatientTransfusion('${p.id}')" class="text-[10px] font-bold text-purple-700 bg-purple-50 hover:bg-purple-100 py-1.5 rounded-lg transition-colors">Request Now</button>
                    <button onclick="window.deleteChronicPatientAction('${p.id}', '${p.patientName.replace(/'/g, "\\'")}')" class="text-[10px] font-bold text-red-600 bg-red-50 hover:bg-red-100 py-1.5 rounded-lg transition-colors">Remove</button>
                </div>
            </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load chronic patients:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load chronic patient registry.</div>';
    }
}

function initChronicPatientModal() {
    const openBtn = document.getElementById('btnAddChronicPatient');
    const modal = document.getElementById('addChronicPatientModal');
    const backdrop = document.getElementById('addChronicPatientBackdrop');
    const closeBtn = document.getElementById('btnCloseAddChronicPatient');
    const form = document.getElementById('addChronicPatientForm');

    const open = () => { if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); } };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };

    if (openBtn) openBtn.addEventListener('click', open);
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            const btn = form.querySelector('button[type="submit"]');
            btn.disabled = true;
            try {
                const recurrenceWeeks = parseInt(document.getElementById('cpRecurrenceWeeks').value, 10);
                const lastTransfusionDate = new Date().toISOString().split('T')[0];
                const nextDue = new Date();
                nextDue.setDate(nextDue.getDate() + recurrenceWeeks * 7);

                await saveChronicPatient({
                    hospitalName: currentUser?.name || 'General Hospital',
                    patientName: document.getElementById('cpPatientName').value,
                    patientIdNumber: document.getElementById('cpPatientIdNumber').value,
                    bloodType: document.getElementById('cpBloodType').value,
                    condition: document.getElementById('cpCondition').value,
                    recurrenceWeeks,
                    phenotypeNotes: document.getElementById('cpPhenotypeNotes').value,
                    contactPhone: document.getElementById('cpContactPhone').value,
                    lastTransfusionDate,
                    nextDueDate: nextDue.toISOString().split('T')[0]
                });
                close();
                showToast('Chronic patient profile saved');
                loadChronicPatients();
            } catch (err) {
                console.error('Failed to save chronic patient:', err);
                alert('Failed to save patient profile. Please try again.');
            } finally {
                btn.disabled = false;
            }
        };
    }
}

window.deleteChronicPatientAction = async (patientId, patientName) => {
    if (!confirm(`Remove ${patientName} from the chronic patient registry?`)) return;
    try {
        await deleteChronicPatient(patientId);
        showToast('Patient profile removed');
        loadChronicPatients();
    } catch (err) {
        console.error('Failed to delete chronic patient:', err);
        alert('Failed to remove patient profile.');
    }
};

// Pre-fills the existing "New Blood Request" form from a saved chronic patient profile,
// so a recurring request only needs a units/date check instead of re-typing everything.
window.requestChronicPatientTransfusion = (patientId) => {
    const patient = chronicPatientsCache.find(p => p.id === patientId);
    if (!patient) return;

    const modal = document.getElementById('newRequestModal');
    if (!modal) return;

    const typeBtns = document.querySelectorAll('#requestBloodTypeGroup button');
    typeBtns.forEach(b => {
        const isMatch = b.dataset.type === patient.bloodType;
        b.className = isMatch
            ? 'px-3 py-1.5 rounded-lg border-2 border-red-500 bg-red-50 text-red-700 text-xs font-bold transition-all cursor-pointer'
            : 'px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 text-xs font-bold hover:border-red-300 hover:text-red-700 hover:bg-red-50 transition-all cursor-pointer';
    });
    const selectedInput = document.getElementById('requestSelectedType');
    if (selectedInput) selectedInput.value = patient.bloodType;

    const componentSelect = document.getElementById('reqComponent');
    if (componentSelect) componentSelect.value = 'PRBC';
    const notes = document.getElementById('requestNotes');
    if (notes) notes.value = `Recurring transfusion for chronic patient: ${patient.patientName} (${patient.condition}). Cycle: every ${patient.recurrenceWeeks} week(s).`;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

async function loadHospitalInventoryData() {
    const gridEl = document.getElementById('inventoryGrid');
    if (!gridEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const inventory = await fetchInventory(hospitalName);
        const allTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

        let totalUnits = 0;
        let lowStockCount = 0;
        let healthyCount = 0;

        let totalExpiring = 0;

        gridEl.innerHTML = allTypes.map(type => {
            const inv = inventory[type] || { unitsAvailable: 0, minimumThreshold: 5, batches: [], componentTotals: {}, expiringSoon: 0, expiredUnits: 0 };
            const info = getBloodTypeDisplayInfo(type);
            totalUnits += inv.unitsAvailable || 0;
            totalExpiring += inv.expiringSoon || 0;
            const isLow = (inv.unitsAvailable || 0) <= (inv.minimumThreshold || 5);
            if (isLow) lowStockCount++; else healthyCount++;

            const pct = Math.min(100, Math.round(((inv.unitsAvailable || 0) / Math.max(inv.minimumThreshold || 5, 1)) * 100));
            const borderColor = isLow ? 'border-red-200' : 'border-slate-100';
            const bgCard = isLow ? 'bg-red-50' : 'bg-white';
            const barColor = isLow ? 'bg-red-500' : pct > 75 ? 'bg-emerald-500' : 'bg-amber-500';

            let badge = '';
            const expCount = inv.unitsExpired || inv.expiredUnits || 0;
            const expSoonCount = inv.expiringSoonUnits || inv.expiringSoon || 0;
            if (expCount > 0) badge = '<span class="text-[9px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full uppercase tracking-wider">Action Required: Expired</span>';
            else if (expSoonCount > 0) badge = '<span class="text-[9px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full uppercase tracking-wider">Expiring Soon</span>';
            else if (isLow) badge = '<span class="text-[9px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full uppercase tracking-wider">Low Stock</span>';
            else badge = '<span class="text-[9px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full uppercase tracking-wider">In Stock</span>';

            const comps = inv.componentTotals && Object.keys(inv.componentTotals).length > 0
                ? Object.entries(inv.componentTotals).filter(([_, u]) => u > 0).map(([comp, u]) =>
                    `<span class="text-[9px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">${comp.slice(0, 6)} ${u}u</span>`
                  ).join('')
                : '';

            return `
            <div class="${bgCard} rounded-2xl p-5 shadow-sm border ${borderColor} hover:shadow-md transition-all group">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl flex items-center justify-center font-black text-lg" style="background-color: ${info.color}15; color: ${info.color}">${type}</div>
                        <div>
                            <p class="text-2xl font-black text-on-surface">${inv.unitsAvailable || 0}</p>
                            <p class="text-[10px] text-slate-500 font-medium">units available</p>
                        </div>
                    </div>
                    ${badge}
                </div>
                ${comps ? `<div class="flex flex-wrap gap-1 mb-2">${comps}</div>` : ''}
                <div class="space-y-2">
                    <div class="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                        <div class="${barColor} h-full rounded-full" style="width: ${pct}%"></div>
                    </div>
                    <div class="flex justify-between text-[10px] text-slate-500">
                        <span>Threshold: ${inv.minimumThreshold || 5}</span>
                        <span class="font-bold">${pct}%</span>
                    </div>
                </div>
                ${expSoonCount > 0 ? `<div class="mt-2 text-[9px] font-bold text-amber-600 flex items-center gap-1"><span class="material-symbols-outlined text-xs">schedule</span>${expSoonCount} unit(s) expiring in < 5 days</div>` : ''}
                ${expCount > 0 ? `<div class="mt-2 text-[9px] font-bold text-red-600 flex items-center gap-1"><span class="material-symbols-outlined text-xs">dangerous</span>${expCount} unit(s) EXPIRED — action required</div>` : ''}
                <div class="mt-3 pt-3 border-t border-slate-100 grid grid-cols-4 gap-1">
                    <button onclick="window.openHospitalAddStock('${type}')" class="text-[9px] font-bold text-red-600 bg-red-50 hover:bg-red-100 py-1.5 rounded-lg transition-colors">Add</button>
                    <button onclick="window.openHospitalIssueBlood('${type}', ${inv.unitsAvailable || 0})" class="text-[9px] font-bold text-amber-600 bg-amber-50 hover:bg-amber-100 py-1.5 rounded-lg transition-colors">Issue</button>
                    <button onclick="window.openHospitalRemoveStock('${type}')" class="text-[9px] font-bold text-red-700 bg-red-50 hover:bg-red-100 py-1.5 rounded-lg transition-colors">Remove</button>
                    <button onclick="window.openHospitalSetThreshold('${type}')" class="text-[9px] font-bold text-slate-600 bg-slate-50 hover:bg-slate-100 py-1.5 rounded-lg transition-colors">Thresh</button>
                </div>
            </div>
            `;
        }).join('');

        document.getElementById('invTotalUnits').textContent = totalUnits;
        document.getElementById('invLowStock').textContent = lowStockCount;
        document.getElementById('invHealthy').textContent = healthyCount;
        document.getElementById('invExpiring').textContent = totalExpiring;

        // Low stock alerts
        const alertsEl = document.getElementById('lowStockAlerts');
        if (alertsEl) {
            const lowItems = allTypes.filter(type => {
                const inv = inventory[type] || { unitsAvailable: 0, minimumThreshold: 5 };
                return (inv.unitsAvailable || 0) <= (inv.minimumThreshold || 5);
            });
            if (lowItems.length === 0) {
                alertsEl.innerHTML = '<div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 flex items-center gap-3"><span class="material-symbols-outlined text-emerald-600">check_circle</span><p class="text-sm font-bold text-emerald-700">All blood types are adequately stocked</p></div>';
            } else {
                alertsEl.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-5">
                    <div class="flex items-center gap-2 mb-4"><span class="material-symbols-outlined text-red-600">warning</span><span class="text-sm font-bold text-red-700">Low Stock Alerts</span></div>
                    <div class="space-y-2">
                        ${lowItems.map(type => {
                            const inv = inventory[type] || {};
                            return `<div class="flex items-center justify-between p-3 bg-white rounded-xl">
                                <div class="flex items-center gap-3">
                                    <span class="w-8 h-8 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm">${type}</span>
                                    <div><p class="text-sm font-bold text-on-surface">${inv.unitsAvailable || 0} units available</p><p class="text-[10px] text-slate-500">Min threshold: ${inv.minimumThreshold || 5}</p></div>
                                </div>
                                <button onclick="window.openHospitalAddStock('${type}')" class="text-xs font-bold text-red-600 hover:underline">Add Stock</button>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            }
        }

        // Load inventory movement history (Feature 7)
        loadInventoryMovements();
    } catch (e) {
        console.error('Failed to load inventory:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-12">Failed to load inventory data.</div>';
    }

    loadHospitalTransfers();
}

// ============================================
// PHASE 2: INTER-HOSPITAL BLOOD TRANSFERS
// Peer-to-peer between hospitals — no admin approval step. Three stages:
// requesting hospital creates -> source hospital dispatches -> requesting hospital receives.
// ============================================

async function loadHospitalTransfers() {
    const gridEl = document.getElementById('transfersGrid');
    if (!gridEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const transfers = await fetchHospitalTransfers(hospitalName);

        if (transfers.length === 0) {
            gridEl.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">sync_alt</span><p class="text-sm">No transfers yet. Use "Request Transfer" to pull stock from a partner hospital.</p></div>';
            return;
        }

        const statusStyle = {
            'Requested': 'text-amber-600 bg-amber-50',
            'In Transit': 'text-blue-600 bg-blue-50',
            'Completed': 'text-emerald-600 bg-emerald-50',
            'Cancelled': 'text-slate-500 bg-slate-100'
        };

        gridEl.innerHTML = transfers.map(t => {
            const outgoing = t.direction === 'outgoing_request'; // this hospital is the requester
            const partnerLabel = outgoing ? `From ${t.targetHospital}` : `To ${t.requestingHospital}`;
            const roleLabel = outgoing ? 'You requested' : 'Partner requested from you';

            let actions = '';
            if (t.status === 'Requested' && !outgoing) {
                // This hospital is the source — it's the one that has the stock to send.
                actions = `<button onclick="window.dispatchTransferAction('${t.id}')" class="text-[10px] font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2.5 py-1.5 rounded-lg transition-colors">Dispatch</button>`;
            } else if (t.status === 'In Transit' && outgoing) {
                // This hospital requested it and it's on the way — confirm receipt to move the stock.
                actions = `<button onclick="window.receiveTransferAction('${t.id}')" class="text-[10px] font-bold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1.5 rounded-lg transition-colors">Confirm Received</button>`;
            }
            if (t.status === 'Requested') {
                actions += `<button onclick="window.cancelTransferAction('${t.id}')" class="text-[10px] font-bold text-red-600 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 rounded-lg transition-colors ml-1.5">Cancel</button>`;
            }

            return `
            <div class="bg-slate-50/70 rounded-2xl border border-slate-200/50 p-4">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="w-9 h-9 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-black text-xs shrink-0">${t.bloodType}</span>
                        <div class="min-w-0">
                            <p class="text-sm font-bold text-on-surface truncate">${t.units} unit${t.units > 1 ? 's' : ''} · ${t.componentType}</p>
                            <p class="text-[10px] text-slate-500 truncate">${partnerLabel}</p>
                        </div>
                    </div>
                    <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${statusStyle[t.status] || 'text-slate-500 bg-slate-100'} shrink-0">${t.status}</span>
                </div>
                <p class="text-[10px] text-slate-400 mb-3">${roleLabel} · ${t.createdAt ? new Date(t.createdAt).toLocaleDateString() : ''}</p>
                ${actions ? `<div class="flex">${actions}</div>` : ''}
            </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load hospital transfers:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load transfers.</div>';
    }
}

function initTransferModal() {
    const openBtn = document.getElementById('btnInitiateTransfer');
    const modal = document.getElementById('newTransferModal');
    const backdrop = document.getElementById('newTransferBackdrop');
    const closeBtn = document.getElementById('btnCloseNewTransfer');
    const form = document.getElementById('newTransferForm');

    const open = (prefillHospital = '') => {
        if (!modal) return;
        // May be launched from the "Partner Network Availability" panel inside the New
        // Request modal — close that one first so the two full-screen modals don't stack.
        const newRequestModal = document.getElementById('newRequestModal');
        if (newRequestModal) { newRequestModal.classList.add('hidden'); newRequestModal.classList.remove('flex'); }
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        if (prefillHospital) {
            const targetInput = document.getElementById('transferTargetHospital');
            if (targetInput) targetInput.value = prefillHospital;
        }
    };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };

    if (openBtn) openBtn.addEventListener('click', () => open());
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
    window.openTransferModal = open;

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            const btn = form.querySelector('button[type="submit"]');
            btn.disabled = true;
            try {
                await createBloodTransferRequest({
                    requestingHospital: currentUser?.name || 'General Hospital',
                    targetHospital: document.getElementById('transferTargetHospital').value,
                    bloodType: document.getElementById('transferBloodType').value,
                    componentType: document.getElementById('transferComponent').value,
                    units: document.getElementById('transferUnits').value,
                    notes: document.getElementById('transferNotes').value
                });
                close();
                showToast('Transfer request sent');
                loadHospitalTransfers();
            } catch (err) {
                console.error('Failed to create transfer request:', err);
                alert('Failed to send transfer request. Please try again.');
            } finally {
                btn.disabled = false;
            }
        };
    }
}

window.dispatchTransferAction = async (transferId) => {
    if (!confirm('Mark this transfer as dispatched? Confirm the units have physically left your facility.')) return;
    try {
        await dispatchBloodTransfer(transferId);
        showToast('Transfer marked as dispatched');
        loadHospitalTransfers();
    } catch (err) {
        console.error('Failed to dispatch transfer:', err);
        alert('Failed to dispatch transfer.');
    }
};

window.receiveTransferAction = async (transferId) => {
    if (!confirm('Confirm these units have arrived? This will add them to your available inventory.')) return;
    try {
        await receiveBloodTransfer(transferId);
        showToast('Transfer received and added to inventory');
        loadHospitalTransfers();
        loadHospitalInventoryData();
    } catch (err) {
        console.error('Failed to receive transfer:', err);
        alert('Failed to confirm receipt.');
    }
};

window.cancelTransferAction = async (transferId) => {
    const reason = prompt('Reason for cancelling this transfer (optional):') || '';
    try {
        await cancelBloodTransfer(transferId, reason);
        showToast('Transfer cancelled');
        loadHospitalTransfers();
    } catch (err) {
        console.error('Failed to cancel transfer:', err);
        alert('Failed to cancel transfer.');
    }
};

// Checks whether a partner hospital already has the selected blood type in stock, while a
// hospital is still filling out a new blood request — surfaced in the "Partner Network
// Availability" panel so staff can pull from a nearby hospital instead of waiting on a donor.
async function checkPartnerNetworkStock(bloodType, componentType) {
    const panel = document.getElementById('networkStockChecker');
    const resultsEl = document.getElementById('networkStockResults');
    if (!panel || !resultsEl || !bloodType) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    resultsEl.innerHTML = '<div class="text-[10px] text-blue-600 flex items-center gap-1.5"><span class="material-symbols-outlined text-xs animate-spin">sync</span>Checking partner hospitals...</div>';
    panel.classList.remove('hidden');

    try {
        const matches = await checkNetworkInventory(bloodType, componentType, hospitalName);
        if (matches.length === 0) {
            panel.classList.add('hidden');
            return;
        }
        resultsEl.innerHTML = matches.slice(0, 4).map(m => `
            <div class="flex items-center justify-between bg-white rounded-lg px-3 py-2">
                <div class="min-w-0">
                    <p class="text-xs font-bold text-slate-800 truncate">${m.hospitalName}</p>
                    <p class="text-[10px] text-slate-500">${m.unitsAvailable} unit(s) · ${m.componentType} · ${m.city}</p>
                </div>
                <button onclick="window.openTransferModal('${m.hospitalName.replace(/'/g, "\\'")}')" class="text-[10px] font-bold text-blue-700 bg-blue-100 hover:bg-blue-200 px-2.5 py-1.5 rounded-lg transition-colors shrink-0 ml-2">Request Transfer</button>
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to check partner network stock:', err);
        panel.classList.add('hidden');
    }
}

// Live-tracking map instances + Firestore listeners for "Donor En Route" cards, keyed by
// request id — torn down and rebuilt every time the Donors tab reloads, since the grid
// itself gets fully replaced (Leaflet needs its container element removed cleanly, and a
// stale onSnapshot listener writing into a detached map would just be a silent leak).
const activeDonorTrackingMaps = new Map();

function teardownDonorTrackingMaps() {
    activeDonorTrackingMaps.forEach(({ map, unsubscribe }) => {
        unsubscribe();
        map.remove();
    });
    activeDonorTrackingMaps.clear();
}

function initDonorTrackingMap(requestId, hospitalCity, isPublic) {
    const container = document.getElementById(`donorMap_${requestId}`);
    if (!container || activeDonorTrackingMaps.has(requestId)) return;

    const hospCoords = getCoordinatesForLocation(hospitalCity, null, null);
    const startCenter = hospCoords ? [hospCoords.lat, hospCoords.lon] : [3.848, 11.502]; // Yaoundé fallback
    const map = L.map(container, { zoomControl: false, attributionControl: false }).setView(startCenter, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

    const hospitalIcon = L.divIcon({ className: '', html: '<div style="background:#dc2626;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 0 2px #dc2626"></div>', iconSize: [14, 14] });
    const donorIcon = L.divIcon({ className: '', html: '<div style="background:#059669;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 0 2px #059669"></div>', iconSize: [14, 14] });

    let hospitalMarker = null;
    if (hospCoords) hospitalMarker = L.marker([hospCoords.lat, hospCoords.lon], { icon: hospitalIcon }).addTo(map).bindTooltip('Your hospital');
    let donorMarker = null;

    const reqRef = doc(db, isPublic ? 'public_requests' : 'requests', requestId);
    const unsubscribe = onSnapshot(reqRef, (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (typeof data.donorLat !== 'number' || typeof data.donorLng !== 'number') return;

        const pos = [data.donorLat, data.donorLng];
        if (donorMarker) {
            donorMarker.setLatLng(pos);
        } else {
            donorMarker = L.marker(pos, { icon: donorIcon }).addTo(map).bindTooltip('Donor');
        }

        const distEl = document.getElementById(`donorMapDistance_${requestId}`);
        if (distEl && hospCoords) {
            const km = calculateDistanceKm(hospCoords.lat, hospCoords.lon, data.donorLat, data.donorLng);
            distEl.textContent = `~${km} km away`;
        }

        if (hospitalMarker) map.fitBounds(L.latLngBounds([pos, [hospCoords.lat, hospCoords.lon]]).pad(0.3));
        else map.setView(pos, 13);
    }, (err) => console.warn('Donor tracking listener error:', err));

    activeDonorTrackingMaps.set(requestId, { map, unsubscribe });
}

async function loadHospitalDonors() {
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';
    const gridEl = document.getElementById('donorsGrid');
    if (!gridEl) return;

    teardownDonorTrackingMaps();

    try {
        const donors = await fetchIncomingDonors(hospitalName);

        const enRouteCount = donors.filter(d => d.status === 'Donor En Route').length;
        document.getElementById('donTotal').textContent = donors.length;
        document.getElementById('donEnRoute').textContent = enRouteCount;
        document.getElementById('donArrived').textContent = 0;

        if (donors.length === 0) {
            gridEl.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-16 text-slate-400"><span class="material-symbols-outlined text-4xl mb-3">groups</span><p class="text-sm font-medium">No incoming donors</p><p class="text-xs text-slate-400 mt-1">Donors will appear here when they accept your requests</p></div>';
        } else {
        gridEl.innerHTML = donors.map(d => {
            const donor = d.donorInfo || {};
            const matchedTime = d.matchedAt ? new Date(d.matchedAt).toLocaleString() : 'Unknown';
            const donorCity = esc(donor.city || 'Unknown');
            const isSameCity = donorCity.toLowerCase() === (currentUser?.city || '').toLowerCase();
            const isEnRoute = d.status === 'Donor En Route';
            const isCheckedIn = d.status === 'Checked In';
            const statusBadge = isCheckedIn
                ? { label: '✅ Checked In', cls: 'text-emerald-600 bg-emerald-50' }
                : isEnRoute
                    ? { label: '🚗 En Route', cls: 'text-indigo-600 bg-indigo-50' }
                    : { label: 'Assigned', cls: 'text-amber-600 bg-amber-50' };
            const publicBadge = d.isPublicRequest ? `<span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full text-orange-600 bg-orange-50">🚨 Public Request</span>` : '';
            // Compute eligibility for identity-verification block
            const lastDonationDate = donor.lastDonationDate || donor.lastDonatedAt || null;
            let eligibleFlag = '';
            let eligibleColor = 'text-emerald-600';
            let eligibleBg = 'bg-emerald-50';
            let lastDonationDisplay = 'No prior donation';
            if (lastDonationDate) {
                const daysAgo = Math.floor((new Date().getTime() - new Date(lastDonationDate).getTime()) / (1000 * 60 * 60 * 24));
                lastDonationDisplay = `${daysAgo} days ago (${new Date(lastDonationDate).toLocaleDateString()})`;
                const eligible = daysAgo >= 56;
                eligibleFlag = eligible ? '✓ ELIGIBLE' : '✗ NOT ELIGIBLE';
                eligibleColor = eligible ? 'text-emerald-600' : 'text-red-600';
                eligibleBg = eligible ? 'bg-emerald-50' : 'bg-red-50';
            } else {
                eligibleFlag = '✓ ELIGIBLE';
            }
            const cniLast4 = donor.cniLast4 || null;

            return `
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition-all">
                <div class="flex items-center gap-4 mb-4">
                    <div class="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center text-red-700 font-black text-lg shrink-0">
                        ${esc(donor.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <p class="font-bold text-on-surface truncate">${esc(donor.name) || 'Unknown Donor'}</p>
                            <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${statusBadge.cls}">${statusBadge.label}</span>
                            ${publicBadge}
                        </div>
                        <p class="text-xs text-slate-500 truncate">${esc(donor.email) || 'No email'}</p>
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold ${isSameCity ? 'text-emerald-600' : 'text-slate-500'} mt-0.5">
                            <span class="material-symbols-outlined text-xs">location_on</span>
                            ${donorCity} ${isSameCity ? '<span class="text-emerald-600 font-bold">• Nearby</span>' : ''}
                        </span>
                    </div>
                </div>
                <!-- Identity Verification Block -->
                <div class="bg-slate-50/80 rounded-xl p-3.5 mb-4 border border-slate-100">
                    <p class="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
                        <span class="material-symbols-outlined text-xs">badge</span>
                        Identity Verification
                    </p>
                    <div class="grid grid-cols-2 gap-2 text-xs">
                        <div>
                            <span class="text-slate-500">CNI (last 4)</span>
                            <p class="font-extrabold text-on-surface tracking-widest font-mono">${cniLast4 ? '••••••' + esc(cniLast4) : '<span class="text-slate-400 font-normal">Not on file</span>'}</p>
                        </div>
                        <div>
                            <span class="text-slate-500">Last Donation</span>
                            <p class="font-bold text-on-surface">${esc(lastDonationDisplay)}</p>
                        </div>
                    </div>
                    <div class="mt-2">
                        <span class="inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-wider ${eligibleBg} ${eligibleColor} border border-current/20">
                            ${eligibleFlag}
                        </span>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3 mb-4">
                    <div class="bg-slate-50 rounded-xl p-3 text-center">
                        <p class="text-lg font-black text-red-700">${esc(d.type || d.bloodType || '?')}</p>
                        <p class="text-[9px] text-slate-500 uppercase tracking-wider">Blood Type</p>
                    </div>
                    <div class="bg-slate-50 rounded-xl p-3 text-center">
                        <p class="text-lg font-black text-on-surface">${d.units || 1}</p>
                        <p class="text-[9px] text-slate-500 uppercase tracking-wider">Units</p>
                    </div>
                </div>
                <div class="space-y-2">
                    <div class="flex items-center justify-between text-xs">
                        <span class="text-slate-500">Matched at</span>
                        <span class="font-bold text-on-surface">${esc(matchedTime)}</span>
                    </div>
                    <div class="flex items-center justify-between text-xs">
                        <span class="text-slate-500">Phone</span>
                        <span class="font-bold text-on-surface">${esc(donor.phone) || 'N/A'}</span>
                    </div>
                </div>
                ${isEnRoute ? `
                <div class="mt-3">
                    <div class="flex items-center justify-between mb-1.5">
                        <p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1"><span class="material-symbols-outlined text-xs">map</span>Live Location</p>
                        <p id="donorMapDistance_${d.id}" class="text-[10px] font-bold text-indigo-600">Waiting for signal…</p>
                    </div>
                    <div id="donorMap_${d.id}" class="rounded-xl overflow-hidden border border-slate-200" style="height:160px"></div>
                </div>
                ` : ''}
                <div class="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
                    <div class="flex items-center gap-1">
                        <button onclick="window.openDonorEngagement('${d.matchedDonor}')" class="text-[10px] font-bold text-amber-600 bg-amber-50 hover:bg-amber-100 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                            <span class="material-symbols-outlined text-xs">military_tech</span>
                            Profile
                        </button>
                        ${!isCheckedIn ? `
                        <button onclick="window.removeIncomingDonorAction('${d.id}', ${!!d.isPublicRequest})" class="text-[10px] font-bold text-red-600 bg-red-50 hover:bg-red-100 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                            <span class="material-symbols-outlined text-xs">person_remove</span>
                            Remove
                        </button>
                        ` : ''}
                    </div>
                    ${isCheckedIn ? `
                    <button onclick="window.openDonationIntakeModal('${d.id}', '${d.matchedDonor}', '${d.type || d.bloodType || ''}', '${(donor.name || 'Donor').replace(/'/g, "\\'")}', '${donor.bloodType || ''}', ${d.donorScreeningPassed === false})" class="text-[10px] font-bold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                        <span class="material-symbols-outlined text-xs">vaccines</span>
                        Record Blood Draw
                    </button>
                    ` : `<span class="text-[10px] font-bold text-slate-400 px-3 py-1.5">Waiting for check-in…</span>`}
                </div>
            </div>
            `;
        }).join('');

        donors.filter(d => d.status === 'Donor En Route').forEach(d => {
            initDonorTrackingMap(d.id, currentUser?.city, !!d.isPublicRequest);
        });
        }
    } catch (e) {
        console.error('Failed to load donors:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-12">Failed to load incoming donors.</div>';
    }

    loadDonorReactions();
    loadScheduledBookings();
}

// ============================================
// HOSPITAL: SCHEDULED DONATION BOOKINGS
// A donor picks a hospital when self-scheduling a walk-in donation (submitDonationRequest) —
// that hospital owns approving/declining/completing the booking. Previously the only code that
// ever called approveDonationRequest/completeDonationRequest was the admin Donations tab, which
// referenced admin.html elements that no longer exist — bookings sat at 'pending' forever.
// ============================================

async function loadScheduledBookings() {
    const listEl = document.getElementById('scheduledBookingsList');
    if (!listEl) return;
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const bookings = await fetchDonationRequestsForHospital(hospitalName);
        const active = bookings.filter(b => ['pending', 'approved'].includes(b.status));

        if (active.length === 0) {
            listEl.innerHTML = '<div class="text-center text-slate-400 py-6 text-sm">No scheduled bookings right now.</div>';
            return;
        }

        const statusStyle = {
            pending: { label: 'Pending Review', cls: 'text-amber-600 bg-amber-50' },
            approved: { label: 'Confirmed', cls: 'text-emerald-600 bg-emerald-50' },
            cancelled: { label: 'Cancelled', cls: 'text-red-600 bg-red-50' }
        };

        listEl.innerHTML = active.map(b => {
            const st = statusStyle[b.status] || statusStyle.pending;
            const dateLabel = b.preferredDate ? new Date(b.preferredDate).toLocaleDateString() : 'Date not set';
            return `
            <div class="flex items-center justify-between gap-3 p-4 bg-slate-50/70 rounded-2xl border border-slate-200/50">
                <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <p class="font-bold text-sm text-slate-800 truncate">${b.donorName || 'Donor'}</p>
                        <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${st.cls}">${st.label}</span>
                        ${b.screeningFlags?.length ? `<span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full text-red-600 bg-red-50">⚠ Flagged</span>` : ''}
                    </div>
                    <p class="text-xs text-slate-500 mt-0.5">${b.bloodType} · ${b.units || 1} unit(s) · ${dateLabel}</p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    ${b.status === 'pending' ? `
                    <button onclick="window.hospitalCancelBookingAction('${b.id}')" class="text-[10px] font-bold text-slate-500 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors">Cancel</button>
                    <button onclick="window.rejectBookingAction('${b.id}', '${b.bloodType}')" class="text-[10px] font-bold text-red-600 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg transition-colors">Decline</button>
                    <button onclick="window.approveBookingAction('${b.id}', '${b.bloodType}')" class="text-[10px] font-bold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 px-3 py-1.5 rounded-lg transition-colors">Confirm</button>
                    ` : `
                    <button onclick="window.completeBookingAction('${b.id}')" class="text-[10px] font-bold text-teal-600 bg-teal-50 hover:bg-teal-100 px-3 py-1.5 rounded-lg transition-colors">Mark Donated</button>
                    `}
                </div>
            </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load scheduled bookings:', e);
        listEl.innerHTML = '<div class="text-center text-error py-6 text-sm">Failed to load bookings.</div>';
    }
}

function initScheduledBookingsControls() {
    const refreshBtn = document.getElementById('btnRefreshBookings');
    if (refreshBtn) refreshBtn.addEventListener('click', loadScheduledBookings);
}

// ============================================
// HOSPITAL: FRONT-DESK CHECK-IN BY PASS CODE
// A donor may arrive without their phone/app open — reception can type the pass code the
// donor was given at match time instead of relying on the donor's own "Check In" button.
// ============================================
function initDonorCheckInTokenLookup() {
    const input = document.getElementById('donorCheckInTokenInput');
    const btn = document.getElementById('btnVerifyCheckInToken');
    if (!input || !btn) return;

    const doLookup = async () => {
        const token = input.value.trim();
        if (!token) { alert('Enter a check-in code first'); return; }
        const currentUser = getCurrentUser();
        const hospitalName = currentUser?.name || 'General Hospital';
        btn.disabled = true;

        try {
            let match = await findRequestByCheckInToken(token, 'requests');
            if (match && match.hospital !== hospitalName) match = null; // not this hospital's donor
            if (!match) {
                const publicMatch = await findRequestByCheckInToken(token, 'public_requests');
                if (publicMatch && publicMatch.hospitalName === hospitalName) match = publicMatch;
            }
            if (!match) { alert('No donor found with that code at your hospital.'); return; }
            if (match.status !== 'Donor En Route') {
                alert(`This donor's status is "${match.status}" — check-in requires "Donor En Route".`);
                return;
            }

            // Look up donor identity info for verification
            let donorIdentity = { name: 'Unknown', cniLast4: null, phone: 'N/A', bloodType: 'N/A', lastDonationDate: null, eligible: true };
            if (match.matchedDonor) {
                try {
                    const donorSnap = await getDoc(doc(db, 'users', match.matchedDonor));
                    if (donorSnap.exists()) {
                        const d = donorSnap.data();
                        const lastDate = d.lastDonationDate || d.lastDonatedAt || null;
                        let eligible = true;
                        let daysAgo = 0;
                        if (lastDate) {
                            daysAgo = Math.floor((new Date().getTime() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24));
                            eligible = daysAgo >= 56;
                        }
                        donorIdentity = {
                            name: d.name || 'Unknown',
                            cniLast4: d.cniLast4 || null,
                            phone: d.phone || 'N/A',
                            bloodType: d.bloodType || match.type || match.bloodType || 'N/A',
                            lastDonationDate: lastDate,
                            eligible,
                            daysAgo,
                        };
                    }
                } catch (e) {
                    console.warn('Could not fetch donor identity:', e);
                }
            }

            const lastDonationDisplay = donorIdentity.lastDonationDate
                ? `${donorIdentity.daysAgo} days ago (${new Date(donorIdentity.lastDonationDate).toLocaleDateString()})`
                : 'No prior donation';
            const cniDisplay = donorIdentity.cniLast4
                ? `••••••${donorIdentity.cniLast4}`
                : '<span style="color:#94a3b8">Not on file</span>';
            const eligibleBadge = donorIdentity.eligible
                ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:999px;background:#ecfdf5;color:#059669;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.05em;border:1px solid #a7f3d0">✓ ELIGIBLE</span>'
                : '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:999px;background:#fef2f2;color:#dc2626;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.05em;border:1px solid #fecaca">✗ NOT ELIGIBLE</span>';

            const confirmed = await window.vpConfirm(`
                <div style="text-align:left">
                    <p style="font-size:13px;font-weight:700;margin-bottom:12px;color:#1e293b">Verify donor identity before check-in</p>
                    <table style="width:100%;font-size:12px;border-collapse:collapse">
                        <tr><td style="padding:4px 8px;color:#64748b">Name</td><td style="padding:4px 8px;font-weight:700;color:#1e293b">${esc(donorIdentity.name)}</td></tr>
                        <tr><td style="padding:4px 8px;color:#64748b">CNI (last 4)</td><td style="padding:4px 8px;font-weight:700;font-family:monospace;color:#1e293b">${cniDisplay}</td></tr>
                        <tr><td style="padding:4px 8px;color:#64748b">Blood Type</td><td style="padding:4px 8px;font-weight:700;color:#dc2626">${esc(donorIdentity.bloodType)}</td></tr>
                        <tr><td style="padding:4px 8px;color:#64748b">Phone</td><td style="padding:4px 8px;font-weight:700;color:#1e293b">${esc(donorIdentity.phone)}</td></tr>
                        <tr><td style="padding:4px 8px;color:#64748b">Last Donation</td><td style="padding:4px 8px;font-weight:700;color:#1e293b">${esc(lastDonationDisplay)}</td></tr>
                        <tr><td style="padding:4px 8px;color:#64748b">Eligibility</td><td style="padding:4px 8px">${eligibleBadge}</td></tr>
                    </table>
                    <p style="font-size:11px;color:#94a3b8;margin-top:12px;padding-top:10px;border-top:1px solid #e2e8f0">Ask the donor to present their physical CNI card. Verify the last 4 digits match.</p>
                </div>
            `, { title: 'Identity Check', confirmText: '✓ Verify & Check In', danger: false });

            if (!confirmed) return;

            await checkInDonor(match.id);
            showToast('Donor checked in successfully!');
            input.value = '';
            loadHospitalDonors();
        } catch (err) {
            console.error('Check-in lookup failed:', err);
            alert(err.message || 'Check-in failed.');
        } finally {
            btn.disabled = false;
        }
    };

    btn.addEventListener('click', doLookup);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } });
}

window.cancelHospitalRequestAction = async (id) => {
    const reason = prompt('Reason for cancelling this request:');
    if (reason === null) return;
    if (!confirm('Cancel this blood request? This cannot be undone.')) return;
    const currentUser = getCurrentUser();
    try {
        await cancelHospitalRequest(id, currentUser?.name || 'Hospital', reason || '');
        showToast('Request cancelled');
        loadHospitalRequests();
    } catch (err) {
        console.error('Failed to cancel request:', err);
        alert('Failed to cancel request.');
    }
};

window.removeIncomingDonorAction = async (id, isPublic) => {
    if (!confirm('Remove this donor from the request? The request will return to open status and the donor will be notified.')) return;
    const currentUser = getCurrentUser();
    try {
        await removeIncomingDonor(id, currentUser?.name || 'Hospital', isPublic === true);
        showToast('Donor removed');
        loadHospitalDonors();
    } catch (err) {
        console.error('Failed to remove donor:', err);
        alert('Failed to remove donor.');
    }
};

window.hospitalCancelBookingAction = async (id) => {
    if (!confirm('Cancel this scheduled booking? The donor will be notified.')) return;
    try {
        const currentUser = getCurrentUser();
        const bookings = await fetchDonationRequestsForHospital(currentUser?.name || 'General Hospital');
        const booking = bookings.find(b => b.id === id);
        if (!booking) { alert('Booking not found.'); return; }
        await hospitalCancelBooking(id, booking);
        showToast('Booking cancelled');
        loadScheduledBookings();
    } catch (err) {
        console.error('Failed to cancel booking:', err);
        alert('Failed to cancel booking.');
    }
};

window.approveBookingAction = async (id, bloodType) => {
    try {
        await approveDonationRequest(id, { bloodType });
        showToast('Booking confirmed');
        loadScheduledBookings();
    } catch (err) {
        console.error('Failed to confirm booking:', err);
        alert('Failed to confirm booking.');
    }
};

window.rejectBookingAction = async (id, bloodType) => {
    const reason = prompt('Reason for declining this booking (shown to the donor):');
    if (reason === null) return;
    try {
        await rejectDonationRequest(id, { bloodType }, reason || 'Not specified');
        showToast('Booking declined');
        loadScheduledBookings();
    } catch (err) {
        console.error('Failed to decline booking:', err);
        alert('Failed to decline booking.');
    }
};

window.completeBookingAction = async (id) => {
    if (!confirm('Mark this donor as having completed their walk-in donation? This records the unit(s) they booked and sends it to lab quarantine.')) return;
    try {
        const currentUser = getCurrentUser();
        const hospitalName = currentUser?.name || 'General Hospital';
        // Re-fetch to get full donor/blood-type context — the button only carries the booking ID.
        const bookings = await fetchDonationRequestsForHospital(hospitalName);
        const booking = bookings.find(b => b.id === id);
        if (!booking) throw new Error('Booking not found');
        await completeDonationRequest(id, booking, { hospital: hospitalName });
        showToast('Donation recorded — blood is now in lab quarantine.');
        loadScheduledBookings();
        loadHospitalDashboard();
    } catch (err) {
        console.error('Failed to complete booking:', err);
        alert(err.message || 'Failed to complete booking.');
    }
};

// ============================================
// DONOR REACTION LOG (hospital-scoped)
// Distinct from Hemovigilance: this tracks the DONOR feeling unwell after giving blood,
// not a patient reacting to a transfusion. Recorded by whichever hospital collected the
// donation, visible only within that hospital's own Donors tab.
// ============================================

async function loadDonorReactions() {
    const listEl = document.getElementById('donorReactionsList');
    if (!listEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const reactions = await fetchDonorReactions(hospitalName);
        if (reactions.length === 0) {
            listEl.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-2xl mb-2">health_and_safety</span><p class="text-sm">No donor reactions reported</p></div>';
            return;
        }

        const severityStyle = {
            mild: 'text-amber-600 bg-amber-50',
            moderate: 'text-orange-600 bg-orange-50',
            severe: 'text-red-600 bg-red-50'
        };
        const reactionLabels = {
            fainting: 'Fainting / Syncope',
            dizziness: 'Dizziness / Lightheadedness',
            nausea: 'Nausea / Vomiting',
            bruising: 'Bruising / Hematoma',
            prolonged_bleeding: 'Prolonged Bleeding',
            allergic_reaction: 'Allergic Reaction',
            other: 'Other Reaction'
        };

        listEl.innerHTML = reactions.map(r => `
            <div class="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors border border-slate-100">
                <span class="w-9 h-9 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center font-black text-xs shrink-0">${r.bloodType || '?'}</span>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <p class="text-sm font-bold text-on-surface">${r.donorName || 'Unknown Donor'}</p>
                        <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${severityStyle[r.severity] || 'text-slate-500 bg-slate-100'}">${r.severity}</span>
                        <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${r.status === 'resolved' ? 'text-emerald-600 bg-emerald-50' : 'text-slate-500 bg-slate-100'}">${r.status}</span>
                    </div>
                    <p class="text-xs text-slate-600 mt-0.5">${reactionLabels[r.reactionType] || r.reactionType} — ${r.description || ''}</p>
                    ${r.actionTaken ? `<p class="text-[10px] text-slate-400 mt-1">Action taken: ${r.actionTaken}</p>` : ''}
                    <p class="text-[10px] text-slate-400 mt-0.5">${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</p>
                </div>
                ${r.status !== 'resolved' ? `<button onclick="window.resolveDonorReaction('${r.id}')" class="text-[10px] font-bold text-emerald-600 hover:underline cursor-pointer shrink-0">Mark Resolved</button>` : ''}
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load donor reactions:', e);
        listEl.innerHTML = '<div class="text-center text-error py-8">Failed to load reaction log.</div>';
    }
}

window.resolveDonorReaction = async (reactionId) => {
    try {
        await updateDonorReaction(reactionId, { status: 'resolved' });
        showToast('Reaction marked resolved');
        loadDonorReactions();
    } catch (err) {
        console.error('Failed to resolve donor reaction:', err);
        alert('Failed to update reaction status.');
    }
};

function initDonorReactionModal() {
    const form = document.getElementById('donorReactionForm');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        const currentUser = getCurrentUser();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            await submitDonorReaction({
                donorName: document.getElementById('reactionDonorName').value,
                bloodType: document.getElementById('reactionBloodType').value,
                severity: document.getElementById('reactionSeverity').value,
                reactionType: document.getElementById('reactionType').value,
                description: document.getElementById('reactionDescription').value,
                actionTaken: document.getElementById('reactionActionTaken').value,
                hospitalName: currentUser?.name || 'General Hospital',
                reportedBy: currentUser?.name || null
            });
            window.closeDonorReactionModal();
            showToast('Donor reaction report submitted');
            loadDonorReactions();
        } catch (err) {
            console.error('Failed to submit donor reaction:', err);
            alert('Failed to submit report. Please try again.');
        } finally {
            btn.disabled = false;
        }
    };
}

window.openDonorReactionModal = () => {
    const modal = document.getElementById('donorReactionModal');
    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
};
window.closeDonorReactionModal = () => {
    const modal = document.getElementById('donorReactionModal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    const form = document.getElementById('donorReactionForm');
    if (form) form.reset();
};

// ============================================
// LAB & TESTING PIPELINE
// Every donated unit sits at "Waiting for Lab Test" until a hospital runs this pipeline —
// it's the actual mechanism behind the "unitsAvailable excludes uncleared stock" safety
// rule already enforced in db.js. This view/modal existed fully built in hospital.html with
// no JavaScript behind it at all (same shape as the Phase 3 tabs and admin nav bugs fixed
// earlier this session) — hence every stat card showing "—".
// ============================================

const COMPONENT_SHELF_LIFE_DAYS = {
    'Whole Blood': 35,
    'PRBC': 42,
    'Plasma': 365,
    'Platelets': 5,
    'Cryoprecipitate': 365
};

let labPipelineBatches = { pending: [], cleared: [], rejected: [] };
let labPipelineActiveFilter = 'pending';

async function loadLabPipeline() {
    const gridEl = document.getElementById('labPipelineGrid');
    if (!gridEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const inventory = await fetchInventory(hospitalName);
        const pending = [], cleared = [], rejected = [];

        Object.values(inventory).forEach(inv => {
            (inv.batches || []).forEach(b => {
                const entry = { ...b, bloodType: inv.bloodType };
                const status = b.testStatus || 'Cleared';
                if (status === 'Waiting for Lab Test') pending.push(entry);
                // Only batches that actually went through this pipeline (have a resolvedAt)
                // count as lab logs — stock a hospital declared pre-cleared on intake never
                // ran through here, so it doesn't belong in "Cleared Logs".
                else if (status === 'Cleared' && b.resolvedAt) cleared.push(entry);
                else if (status === 'Rejected, Not Safe') rejected.push(entry);
            });
        });

        pending.sort((a, b) => new Date(a.addedAt || 0) - new Date(b.addedAt || 0));
        cleared.sort((a, b) => new Date(b.resolvedAt || 0) - new Date(a.resolvedAt || 0));
        rejected.sort((a, b) => new Date(b.resolvedAt || 0) - new Date(a.resolvedAt || 0));
        labPipelineBatches = { pending, cleared, rejected };

        const sumUnits = (list) => list.reduce((s, b) => s + (b.units || 0), 0);
        const pendingUnits = sumUnits(pending), clearedUnits = sumUnits(cleared), rejectedUnits = sumUnits(rejected);
        const totalResolved = clearedUnits + rejectedUnits;

        document.getElementById('labPendingCount').textContent = pendingUnits;
        document.getElementById('labClearedCount').textContent = clearedUnits;
        document.getElementById('labRejectedCount').textContent = rejectedUnits;
        document.getElementById('labPassRate').textContent = totalResolved > 0 ? Math.round((clearedUnits / totalResolved) * 100) + '%' : '—';

        renderLabPipelineGrid();
    } catch (e) {
        console.error('Failed to load lab pipeline:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-12">Failed to load lab testing queue.</div>';
    }
}

function renderLabPipelineGrid() {
    const gridEl = document.getElementById('labPipelineGrid');
    if (!gridEl) return;

    const list = labPipelineBatches[labPipelineActiveFilter] || [];
    if (list.length === 0) {
        const emptyCopy = {
            pending: 'No units currently awaiting lab testing.',
            cleared: 'No cleared batches logged yet.',
            rejected: 'No rejected batches on record.'
        };
        gridEl.innerHTML = `<div class="col-span-full text-center text-slate-400 py-12">${emptyCopy[labPipelineActiveFilter]}</div>`;
        return;
    }

    if (labPipelineActiveFilter === 'pending') {
        gridEl.innerHTML = list.map(b => `
            <div class="bg-slate-50/70 rounded-2xl border border-slate-200/50 p-4">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="w-10 h-10 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center font-black text-sm shrink-0">${b.bloodType}</span>
                    <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full text-amber-600 bg-amber-100">Awaiting Test</span>
                </div>
                <p class="text-sm font-bold text-slate-800">${b.units} unit${b.units > 1 ? 's' : ''} · ${b.componentType || 'Whole Blood'}</p>
                <p class="text-[10px] text-slate-500 mt-0.5">Batch ${b.id ? b.id.slice(-8) : '—'} · Collected ${b.addedAt ? new Date(b.addedAt).toLocaleDateString() : '—'}</p>
                <button onclick="window.openLabTestModal('${b.id}', '${b.bloodType}')" class="mt-3 w-full text-[11px] font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5">
                    <span class="material-symbols-outlined text-sm">science</span> Run Test
                </button>
            </div>
        `).join('');
    } else if (labPipelineActiveFilter === 'cleared') {
        gridEl.innerHTML = list.map(b => `
            <div class="bg-slate-50/70 rounded-2xl border border-slate-200/50 p-4">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="w-10 h-10 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center font-black text-sm shrink-0">${b.bloodType}</span>
                    <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full text-emerald-600 bg-emerald-100">Cleared</span>
                </div>
                <p class="text-sm font-bold text-slate-800">${b.units} unit${b.units > 1 ? 's' : ''} · ${b.componentType || 'Whole Blood'}</p>
                <p class="text-[10px] text-slate-500 mt-0.5">Released ${b.resolvedAt ? new Date(b.resolvedAt).toLocaleString() : '—'}${b.labTechName ? ' · ' + b.labTechName : ''}</p>
                <button onclick="window.openLabCertModal('${b.id}', '${b.bloodType}')" class="mt-3 w-full text-[11px] font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5">
                    <span class="material-symbols-outlined text-sm">verified</span> View Certificate
                </button>
            </div>
        `).join('');
    } else {
        gridEl.innerHTML = list.map(b => `
            <div class="bg-slate-50/70 rounded-2xl border border-red-200/50 p-4">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="w-10 h-10 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm shrink-0">${b.bloodType}</span>
                    <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full text-red-600 bg-red-100">Rejected</span>
                </div>
                <p class="text-sm font-bold text-slate-800">${b.units} unit${b.units > 1 ? 's' : ''} · ${b.componentType || 'Whole Blood'}</p>
                <p class="text-[10px] text-red-600 font-medium mt-0.5">${b.rejectionReason || 'Failed safety screening'}</p>
                <p class="text-[10px] text-slate-500 mt-0.5">Rejected ${b.resolvedAt ? new Date(b.resolvedAt).toLocaleString() : '—'}${b.labTechName ? ' · ' + b.labTechName : ''}</p>
            </div>
        `).join('');
    }
}

function initLabPipelineControls() {
    const refreshBtn = document.getElementById('btnRefreshLabPipeline');
    if (refreshBtn) refreshBtn.addEventListener('click', loadLabPipeline);

    document.querySelectorAll('#labFilterTabs .lab-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#labFilterTabs .lab-tab-btn').forEach(b => {
                b.classList.remove('active', 'bg-white', 'text-slate-900', 'shadow-sm');
                b.classList.add('text-slate-600');
            });
            btn.classList.add('active', 'bg-white', 'text-slate-900', 'shadow-sm');
            btn.classList.remove('text-slate-600');
            labPipelineActiveFilter = btn.dataset.filter;
            renderLabPipelineGrid();
        });
    });
}

function initLabTestModal() {
    const modal = document.getElementById('labTestModal');
    const backdrop = document.getElementById('labTestBackdrop');
    const closeBtn = document.getElementById('btnCloseLabTestModal');
    const cancelBtn = document.getElementById('btnCancelLabTest');
    const form = document.getElementById('labTestForm');
    const componentSelect = document.getElementById('labComponentType');
    const shelfLifeHint = document.getElementById('labShelfLifeHint');

    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);

    if (componentSelect && shelfLifeHint) {
        componentSelect.addEventListener('change', () => {
            const days = COMPONENT_SHELF_LIFE_DAYS[componentSelect.value] || 35;
            shelfLifeHint.textContent = `Shelf life: ${days} days (${componentSelect.value})`;
        });
    }

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            // form.dataset.hospitalName is set only when admin opens this modal on behalf of a
            // shadow (unregistered) hospital — otherwise this is the logged-in hospital's own tab.
            const hospName = form.dataset.hospitalName || currentUser?.name || 'General Hospital';
            const batchId = form.dataset.batchId;
            const bloodType = form.dataset.bloodType;
            const btn = form.querySelector('button[type="submit"]');
            btn.disabled = true;

            try {
                const markers = {
                    HIV: document.getElementById('testHiv').value,
                    HBsAg: document.getElementById('testHbsag').value,
                    HCV: document.getElementById('testHcv').value,
                    VDRL: document.getElementById('testVdrl').value,
                    Malaria: document.getElementById('testMalaria').value
                };
                const failedMarkers = Object.entries(markers).filter(([, v]) => v === 'Positive').map(([k]) => k);
                const result = failedMarkers.length > 0 ? 'Rejected, Not Safe' : 'Cleared';
                const componentType = componentSelect.value;
                const shelfDays = COMPONENT_SHELF_LIFE_DAYS[componentType] || 35;
                const expiryDate = new Date(Date.now() + shelfDays * 86400000).toISOString().split('T')[0];

                await resolveLabTest(hospName, bloodType, batchId, result, failedMarkers.length > 0 ? `Reactive: ${failedMarkers.join(', ')}` : null, {
                    labTechName: document.getElementById('labTechName').value,
                    screeningResults: markers,
                    componentType,
                    expiryDate
                });

                close();
                showToast(result === 'Cleared' ? 'Unit cleared and released to stock' : 'Unit rejected and quarantined');
                if (form.dataset.hospitalName) loadShadowHospitalPendingTests();
                else loadLabPipeline();
            } catch (err) {
                console.error('Failed to resolve lab test:', err);
                alert(err.message || 'Failed to save lab test result.');
            } finally {
                btn.disabled = false;
            }
        };
    }
}

window.openLabTestModal = (batchId, bloodType, hospitalNameOverride = null) => {
    const modal = document.getElementById('labTestModal');
    const form = document.getElementById('labTestForm');
    if (!modal || !form) return;
    form.dataset.batchId = batchId;
    form.dataset.bloodType = bloodType;
    if (hospitalNameOverride) form.dataset.hospitalName = hospitalNameOverride;
    else delete form.dataset.hospitalName;
    document.getElementById('labTestBatchHeader').textContent = `Batch #${batchId.slice(-8)}`;
    document.getElementById('labTestBloodTypeBadge').textContent = hospitalNameOverride ? `${bloodType} — ${hospitalNameOverride}` : bloodType;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

function initLabCertModal() {
    const backdrop = document.getElementById('labCertBackdrop');
    const closeBtn = document.getElementById('btnCloseLabCert');
    const printBtn = document.getElementById('btnPrintLabCert');
    const close = () => {
        const modal = document.getElementById('labCertModal');
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (printBtn) printBtn.addEventListener('click', () => {
        const printWindow = window.open('', '_blank', 'width=600,height=800');
        printWindow.document.write(`<html><head><title>Lab Safety Certificate</title>
            <style>body{font-family:'Courier New',monospace;padding:40px;max-width:500px;margin:0 auto;}
            .header{text-align:center;border-bottom:2px dashed #333;padding-bottom:16px;margin-bottom:16px;}
            .header h1{font-size:18px;font-weight:900;color:#065f46;margin:0;}
            .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dotted #ddd;font-size:13px;}
            @media print{body{padding:20px;}}</style></head><body>
            <div class="header"><h1>LABORATORY SAFETY CLEARANCE CERTIFICATE</h1><p>VitalPulse Transfusion Security Protocol</p></div>
            ${document.getElementById('labCertBody').innerHTML}
            </body></html>`);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
    });
}

window.openLabCertModal = (batchId, bloodType) => {
    const modal = document.getElementById('labCertModal');
    const body = document.getElementById('labCertBody');
    if (!modal || !body) return;
    const batch = labPipelineBatches.cleared.find(b => b.id === batchId);
    if (!batch) return;

    const markerRows = batch.screeningResults
        ? Object.entries(batch.screeningResults).map(([marker, val]) => `
            <div class="flex items-center justify-between p-2 bg-slate-50 rounded-lg"><span class="font-bold text-slate-700">${marker}</span><span class="font-bold ${val === 'Negative' ? 'text-emerald-600' : 'text-red-600'}">${val} ${val === 'Negative' ? '(-)' : '(+)'}</span></div>
        `).join('')
        : '<p class="text-slate-400">No detailed screening data on record.</p>';

    body.innerHTML = `
        <div class="flex items-center justify-between p-3 bg-emerald-50 rounded-xl border border-emerald-100 mb-3">
            <div><p class="text-[10px] font-bold uppercase text-slate-400">Batch</p><p class="font-black text-slate-900">#${batch.id.slice(-8)}</p></div>
            <span class="px-3 py-1.5 rounded-xl bg-emerald-600 text-white font-black text-sm">${bloodType}</span>
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs mb-3">
            <p>Component: <span class="font-bold text-slate-700">${batch.componentType || 'Whole Blood'}</span></p>
            <p>Units: <span class="font-bold text-slate-700">${batch.units}</span></p>
            <p>Lab Technician: <span class="font-bold text-slate-700">${batch.labTechName || '—'}</span></p>
            <p>Released: <span class="font-bold text-slate-700">${batch.resolvedAt ? new Date(batch.resolvedAt).toLocaleString() : '—'}</span></p>
        </div>
        <div class="space-y-1.5">${markerRows}</div>
    `;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

async function loadHospitalSettings() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    document.getElementById('setHospitalName').value = currentUser.name || '';
    document.getElementById('setHospitalCity').value = currentUser.city || '';
    document.getElementById('setHospitalEmail').value = currentUser.email || '';
    document.getElementById('setHospitalPhone').value = currentUser.phone || '';

    const sidebarName = document.getElementById('hospitalSidebarName');
    const sidebarLoc = document.getElementById('hospitalSidebarLocation');
    if (sidebarName) sidebarName.textContent = currentUser.name || 'Hospital';
    if (sidebarLoc) sidebarLoc.textContent = (currentUser.city || 'Cameroon') + ' Network';

    // Settings form
    const form = document.getElementById('settingsForm');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Saving...';
            btn.disabled = true;

            try {
                await updateUserProfile(currentUser.uid, {
                    name: document.getElementById('setHospitalName').value,
                    city: document.getElementById('setHospitalCity').value,
                    email: document.getElementById('setHospitalEmail').value,
                    phone: document.getElementById('setHospitalPhone').value
                });
                // Update local storage
                const updated = { ...currentUser, name: document.getElementById('setHospitalName').value, city: document.getElementById('setHospitalCity').value, email: document.getElementById('setHospitalEmail').value, phone: document.getElementById('setHospitalPhone').value };
                localStorage.setItem('vitalpulse_user', JSON.stringify(updated));
                await logActivity('Profile Updated', `${updated.name} updated their hospital profile`, 'info');
                showToast('Profile saved successfully!');
                if (sidebarName) sidebarName.textContent = updated.name;
                if (sidebarLoc) sidebarLoc.textContent = (updated.city || 'Cameroon') + ' Network';
            } catch (err) {
                console.error('Failed to save settings:', err);
                alert('Failed to save settings.');
            } finally {
                btn.innerHTML = 'Save Changes';
                btn.disabled = false;
            }
        };
    }
}

function initNewRequestModal() {
    const openBtn = document.getElementById('btnNewRequest');
    const modal = document.getElementById('newRequestModal');
    const backdrop = document.getElementById('newRequestBackdrop');
    const closeBtn = document.getElementById('btnCloseNewRequest');
    const form = document.getElementById('newRequestForm');

    const open = () => { if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); } };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };

    if (openBtn) openBtn.addEventListener('click', open);
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Blood type selector
    const typeBtns = document.querySelectorAll('#requestBloodTypeGroup button');
    const selectedInput = document.getElementById('requestSelectedType');
    typeBtns.forEach(btn => {
        btn.onclick = () => {
            typeBtns.forEach(b => { b.className = 'px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold hover:border-red-300 hover:text-red-700 transition-all'; });
            btn.className = 'px-4 py-2 rounded-lg border-2 border-red-500 bg-red-50 text-red-700 text-sm font-bold transition-all';
            selectedInput.value = btn.dataset.type;
            checkPartnerNetworkStock(btn.dataset.type, document.getElementById('reqComponent')?.value);
        };
    });

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            if (!currentUser) return;
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Submitting...';
            btn.disabled = true;

            try {
                await createEmergencyRequest({
                    hospital: currentUser.name || 'General Hospital',
                    city: currentUser.city || 'Cameroon',
                    type: selectedInput.value,
                    bloodType: selectedInput.value,
                    componentType: document.getElementById('reqComponent')?.value || 'Whole Blood',
                    units: parseInt(document.getElementById('requestUnits').value, 10),
                    urgency: document.getElementById('requestUrgency').value,
                    patientName: document.getElementById('reqPatientName')?.value || '',
                    ward: document.getElementById('reqWard')?.value || '',
                    requestingDoctor: document.getElementById('reqDoctor')?.value || '',
                    diagnosis: document.getElementById('reqDiagnosis')?.value || '',
                    requiredBy: document.getElementById('reqRequiredBy')?.value || '',
                    notes: document.getElementById('requestNotes').value,
                    // Donor-facing pickup point (patient/clinical fields above are stripped before donors see them).
                    pickupLocation: document.getElementById('reqPickupPoint')?.value?.trim() || '',
                    distance: 'Local'
                });
                close();
                showToast('Request submitted successfully!');
                loadHospitalRequests();
            } catch (err) {
                console.error('Failed to create request:', err);
                alert('Failed to create request.');
            } finally {
                btn.innerHTML = 'Submit Request';
                btn.disabled = false;
            }
        };
    }
}

function initUrgentRequestModal() {
    const openBtns = document.querySelectorAll('#btnUrgentRequest, #dashUrgentBtn');
    const modal = document.getElementById('urgentModal');
    const backdrop = document.getElementById('urgentBackdrop');
    const closeBtn = document.getElementById('btnCloseUrgent');
    const form = document.getElementById('urgentRequestForm');

    const open = () => { if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); } };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };

    openBtns.forEach(btn => { if (btn) btn.addEventListener('click', open); });
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    const typeBtns = document.querySelectorAll('#urgentBloodTypeGroup button');
    const selectedInput = document.getElementById('urgentSelectedType');
    typeBtns.forEach(btn => {
        btn.onclick = () => {
            typeBtns.forEach(b => { b.className = 'px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold hover:border-red-300 hover:text-red-700 transition-all'; });
            btn.className = 'px-4 py-2 rounded-lg border-2 border-red-500 bg-red-50 text-red-700 text-sm font-bold transition-all';
            selectedInput.value = btn.dataset.type;
        };
    });

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            if (!currentUser) return;
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Broadcasting...';
            btn.disabled = true;

            try {
                await createEmergencyRequest({
                    hospital: currentUser.name || 'General Hospital',
                    city: currentUser.city || 'Cameroon',
                    type: selectedInput.value,
                    bloodType: selectedInput.value,
                    units: parseInt(document.getElementById('urgentUnits').value, 10),
                    urgency: document.getElementById('urgentLevel').value,
                    notes: document.getElementById('urgentNotes').value,
                    // Donor-facing pickup details the hospital fills in on this form — these were
                    // being dropped before, so donors only ever saw a name + Accept button.
                    componentType: document.getElementById('urgComponent')?.value || 'Whole Blood',
                    pickupLocation: document.getElementById('urgPickupLocation')?.value?.trim() || '',
                    contactPhone: document.getElementById('urgContactPhone')?.value?.trim() || '',
                    distance: 'System-wide'
                });
                close();
                showToast('Emergency broadcast sent!');
            } catch (err) {
                console.error('Failed to broadcast:', err);
                alert('Failed to broadcast emergency.');
            } finally {
                btn.innerHTML = 'Broadcast Emergency';
                btn.disabled = false;
            }
        };
    }
}

function closeInventoryActionModals() {
    ['addStockModal', 'issueModal', 'thresholdModal', 'removeStockModal'].forEach(id => {
        const modal = document.getElementById(id);
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    });
}

// A click on a modal's backdrop while a DIFFERENT inventory action button was the real
// intent (e.g. clicking "Issue" on a card while the Add modal is still open) would
// otherwise just close the current modal, since the full-screen backdrop is what
// actually receives the click — the button underneath never sees it. After closing,
// re-check what's really at that point and forward the click so switching between
// Add/Issue/Remove/Thresh works in one click instead of "close, then click again".
function handleInventoryBackdropClick(e, close) {
    close();
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const button = target && target.closest
        ? target.closest('#inventoryGrid button, #lowStockAlerts button, #btnAddStock')
        : null;
    if (button) button.click();
}

function initHospitalAddStockModal() {
    const openBtn = document.getElementById('btnAddStock');
    const modal = document.getElementById('addStockModal');
    const backdrop = document.getElementById('addStockBackdrop');
    const cancelBtn = document.getElementById('btnCancelStock');
    const form = document.getElementById('addStockForm');

    const open = (preselected = '') => {
        closeInventoryActionModals();
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            if (preselected) {
                const select = document.getElementById('stockBloodType');
                if (select) select.value = preselected;
            }
        }
    };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };

    if (openBtn) openBtn.addEventListener('click', () => open());
    if (backdrop) backdrop.addEventListener('click', (e) => handleInventoryBackdropClick(e, close));
    if (cancelBtn) cancelBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Adding...';
            btn.disabled = true;

            const currentUser = getCurrentUser();
            const hospName = currentUser?.name || 'General Hospital';
            try {
                await updateInventoryStock(
                    document.getElementById('stockBloodType').value,
                    document.getElementById('stockUnits').value,
                    'add',
                    hospName,
                    {
                        componentType: document.getElementById('stockComponent')?.value || 'Whole Blood',
                        expiresAt: document.getElementById('stockExpiry')?.value || null
                    }
                );
                await logActivity('Inventory Added', `${document.getElementById('stockUnits').value} units of ${document.getElementById('stockBloodType').value} added via hospital portal`, 'success');
                close();
                showToast('Stock added successfully!');
                loadHospitalInventoryData();
            } catch (err) {
                console.error('Failed to add stock:', err);
                alert('Failed to add stock.');
            } finally {
                btn.innerHTML = 'Add to Inventory';
                btn.disabled = false;
            }
        };
    }

    // Export button
    const exportBtn = document.getElementById('btnExportInventory');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            // Simple CSV export of the inventory grid data
            const cards = document.querySelectorAll('#inventoryGrid > div');
            if (!cards.length) return;
            let csv = 'Blood Type,Units,Status\n';
            cards.forEach(card => {
                const type = card.querySelector('.font-black.text-lg')?.textContent || '';
                const units = card.querySelector('.text-2xl.font-black')?.textContent || '0';
                const badge = card.querySelector('.text-\\[9px\\]')?.textContent?.trim() || '';
                csv += `${type},${units},${badge}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `inventory_${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }
}

window.openHospitalAddStock = (type) => {
    closeInventoryActionModals();
    const modal = document.getElementById('addStockModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        const select = document.getElementById('stockBloodType');
        if (select) select.value = type;
    }
};

function showToast(message) {
    const toast = document.getElementById('successToast');
    const msgEl = document.getElementById('toastMessage');
    if (!toast || !msgEl) return;
    msgEl.textContent = message;
    toast.classList.remove('opacity-0', 'translate-y-20');
    toast.classList.add('opacity-100', 'translate-y-0');
    setTimeout(() => {
        toast.classList.remove('opacity-100', 'translate-y-0');
        toast.classList.add('opacity-0', 'translate-y-20');
    }, 3000);
}
window.showToast = showToast;

function renderAdminActivityFeed(logs) {
    const activityFeed = document.getElementById('adminActivityFeed');
    if (!activityFeed) return;
    if (logs.length === 0) {
        activityFeed.innerHTML = '<div class="text-center text-slate-400 text-sm italic py-4">System is quiet. No logs yet.</div>';
        return;
    }
    activityFeed.innerHTML = logs.map(log => {
        let icon = 'info';
        let colorClass = 'bg-slate-100 text-slate-600';
        if (log.type === 'success') { icon = 'check_circle'; colorClass = 'bg-green-100 text-green-600'; }
        if (log.type === 'warning') { icon = 'warning'; colorClass = 'bg-amber-100 text-amber-600'; }
        if (log.type === 'error') { icon = 'error'; colorClass = 'bg-red-100 text-red-600'; }
        return `
        <div class="relative pl-8">
            <div class="absolute left-0 top-1 w-6 h-6 rounded-full ${colorClass} flex items-center justify-center">
                <span class="material-symbols-outlined text-xs" data-icon="${icon}">${icon}</span>
            </div>
            <div>
                <p class="text-sm font-bold text-on-surface">${esc(log.title)}</p>
                <p class="text-xs text-slate-500 mt-1">${esc(log.description)}</p>
                <p class="text-[10px] text-slate-400 mt-2 font-medium">${new Date(log.timestamp).toLocaleTimeString()}</p>
            </div>
        </div>
        `;
    }).join('');
}

let adminRealtimeUnsub = null;

function setupAdminRealtime() {
    if (adminRealtimeUnsub) return;

    adminRealtimeUnsub = onSnapshot(collection(db, 'requests'), (snapshot) => {
        const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const activeRequests = requests.filter(r => isRequestStatusActive(r.status));
        const activeCountEl = document.getElementById('adminActiveRequests');
        if (activeCountEl) activeCountEl.textContent = activeRequests.length;
        const requestsBadgeEl = document.getElementById('adminRequestsBadge');
        if (requestsBadgeEl) {
            const criticalCount = activeRequests.filter(r => r.urgency === 'critical' || r.urgency === 'Critical').length;
            requestsBadgeEl.textContent = criticalCount > 0 ? `${criticalCount} critical` : 'network-wide';
        }
        const resolvedReqs = requests.filter(r => isRequestStatusClosed(r.status) && (r.requestedAt || r.timestamp) && r.resolvedAt);
        const avgResponseEl = document.getElementById('adminAvgResponse');
        if (avgResponseEl) {
            let totalMins = 0;
            let valid = 0;
            resolvedReqs.forEach(r => {
                if (!(r.requestedAt || r.timestamp) || !r.resolvedAt) return;
                const delta = new Date(r.resolvedAt) - new Date(r.requestedAt || r.timestamp);
                if (isFinite(delta) && delta >= 0) {
                    totalMins += delta / 60000;
                    valid++;
                }
            });
            avgResponseEl.innerHTML = valid > 0 ? `${(totalMins / valid).toFixed(1)}<span class="text-lg ml-1">m</span>` : '--<span class="text-lg ml-1">m</span>';
        }
    }, (err) => console.error('Realtime requests subscription failed:', err));

    onSnapshot(collection(db, 'activity_logs'), (snapshot) => {
        const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
            .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
            .slice(0, 4);
        renderAdminActivityFeed(logs);
    }, (err) => console.error('Realtime activity-log subscription failed:', err));
}

async function loadAdminDashboard() {
    try {
        setupAdminRealtime();

        // 1. Load System Health Metrics
        const requests = await fetchActiveRequests();
        const activeCountEl = document.getElementById('adminActiveRequests');
        if (activeCountEl) activeCountEl.textContent = requests.length;
        const requestsBadgeEl = document.getElementById('adminRequestsBadge');
        if (requestsBadgeEl) {
            const criticalCount = requests.filter(r => r.urgency === 'critical' || r.urgency === 'Critical').length;
            requestsBadgeEl.textContent = criticalCount > 0 ? `${criticalCount} critical` : 'network-wide';
        }

        // Calculate True Avg Response Time
        const resolvedReqs = await fetchAllResolvedRequests();
        const avgResponseEl = document.getElementById('adminAvgResponse');
        
        if (avgResponseEl) {
            let totalMins = 0;
            let valid = 0;
            resolvedReqs.forEach(r => {
                if (!(r.requestedAt || r.timestamp) || !r.resolvedAt) return;
                const delta = new Date(r.resolvedAt) - new Date(r.requestedAt || r.timestamp);
                if (isFinite(delta) && delta >= 0) {
                    totalMins += delta / 60000;
                    valid++;
                }
            });
            avgResponseEl.innerHTML = valid > 0 ? `${(totalMins / valid).toFixed(1)}<span class="text-lg ml-1">m</span>` : '--<span class="text-lg ml-1">m</span>';
        }

        // Run together rather than as another sequential await — loadAdminDashboard's chain
        // gates initAdminNavigation() at the end of this same function, so every extra
        // sequential await here delays every nav button becoming clickable.
        const [verifiedClinicsCount, allRegisteredHospitals, allRegisteredDonors] = await Promise.all([
            fetchClinicsOnlineCount(),
            fetchAllHospitals(),
            fetchAllDonors()
        ]);
        const totalDonorsEl = document.getElementById('adminTotalDonors');
        if (totalDonorsEl) totalDonorsEl.textContent = allRegisteredDonors.length;
        const clinicsOnlineEl = document.getElementById('adminClinicsOnline');
        const clinicsOnlineBar = document.getElementById('adminClinicsOnlineBar');

        // % of every hospital that has ever registered which is currently verified & active —
        // a real ratio against the network's own total, not an arbitrary guessed denominator.
        const targetClinics = Math.max(allRegisteredHospitals.length, 1);
        const percentage = Math.min(100, Math.round((verifiedClinicsCount / targetClinics) * 100));
        if (clinicsOnlineEl) clinicsOnlineEl.textContent = percentage + '%';
        if (clinicsOnlineBar) clinicsOnlineBar.style.width = percentage + '%';

        // 2. Load Hospital Verifications
        const tableBody = document.getElementById('adminPendingHospitals');
        if (tableBody) {
            const pendingHospitals = await fetchPendingHospitals();
            const pendingBadgeEl = document.getElementById('pendingCountBadge');
            if (pendingBadgeEl) pendingBadgeEl.textContent = pendingHospitals.length;
            if (pendingHospitals.length === 0) {
                 tableBody.innerHTML = '<tr><td colspan="4" class="px-6 py-8 text-center text-slate-500 font-medium">No pending verifications.</td></tr>';
            } else {
                 tableBody.innerHTML = pendingHospitals.map(h => `
                 <tr class="hover:bg-surface-container-low/50 transition-colors">
                     <td class="px-6 py-5">
                         <div class="font-bold text-on-surface">${esc(h.name)}</div>
                         <div class="text-[11px] text-slate-400">ID: ${h.id.slice(0,8).toUpperCase()}</div>
                     </td>
                     <td class="px-6 py-5 text-sm text-slate-600">${esc(h.city) || 'Cameroon'}</td>
                     <td class="px-6 py-5">
                         ${h.licenseUrl
                             ? `<a href="${safeUrl(h.licenseUrl)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-xs font-bold text-tertiary hover:bg-tertiary-container/10 px-2 py-1 rounded transition-colors">
                                 <span class="material-symbols-outlined text-sm" data-icon="description">description</span> Review Document
                                </a>`
                             : `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-slate-300 px-2 py-1">
                                 <span class="material-symbols-outlined text-sm" data-icon="description">description</span> No document
                                </span>`}
                     </td>
                     <td class="px-6 py-5 text-right space-x-2">
                         <button onclick="window.handleAdminReject('${h.id}')" class="text-xs font-bold px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors">Reject</button>
                         <button onclick="window.handleAdminApprove('${h.id}')" class="text-xs font-bold px-4 py-2 rounded-lg bg-primary-container text-on-primary-container hover:shadow-md transition-all">Approve</button>
                     </td>
                 </tr>
                 `).join('');
            }
        }

        // 2b. Load Pending Donor KYC Verifications (system_admin approval queue)
        await renderPendingKycReviews();

        // 3. Load Recent Activity Feed
        renderAdminActivityFeed(await fetchRecentLogs(4));

        // 4. Load Overview Campaigns from DB
        const overviewCampaignsGrid = document.getElementById('overviewCampaignsGrid');
        if (overviewCampaignsGrid) {
            const campaigns = await fetchAllCampaigns();
            const activeCampaigns = campaigns.filter(c => c.status === 'active' || c.status === 'planning').slice(0, 3);
            
            if (activeCampaigns.length === 0) {
                overviewCampaignsGrid.innerHTML = `
                    <div class="col-span-full text-center py-8">
                        <span class="material-symbols-outlined text-4xl text-slate-300 mb-2">campaign</span>
                        <p class="text-slate-500 text-sm">No active campaigns</p>
                    </div>
                `;
            } else {
                overviewCampaignsGrid.innerHTML = activeCampaigns.map(c => {
                    const progress = c.targetUnits ? Math.round((c.unitsCollected || 0) / c.targetUnits * 100) : 0;
                    const statusColors = c.status === 'active' 
                        ? { badge: 'bg-green-500', text: 'text-green-600' }
                        : { badge: 'bg-blue-500', text: 'text-blue-600' };
                    
                    return `
                    <div class="bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm border border-outline-variant/10 group">
                        <div class="h-32 overflow-hidden relative bg-gradient-to-br from-red-50 to-red-100">
                            <div class="absolute inset-0 flex items-center justify-center">
                                <span class="material-symbols-outlined text-4xl text-red-200">campaign</span>
                            </div>
                            <div class="absolute top-3 right-3 px-2 py-1 ${statusColors.badge} text-white text-[9px] font-black uppercase rounded-sm">${esc(c.status)}</div>
                        </div>
                        <div class="p-5">
                            <h3 class="font-black text-base text-on-surface leading-tight mb-1 truncate">${esc(c.title)}</h3>
                            <p class="text-xs text-slate-500 mb-4 flex items-center gap-1">
                                <span class="material-symbols-outlined text-[12px]">location_on</span> ${esc(c.location)}
                            </p>
                            <div class="space-y-2">
                                <div class="flex justify-between text-xs font-bold text-on-surface">
                                    <span>${c.unitsCollected || 0} / ${c.targetUnits || 0} units</span>
                                    <span class="${statusColors.text}">${progress}%</span>
                                </div>
                                <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                                    <div class="${statusColors.badge} h-full rounded-full" style="width: ${progress}%"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    `;
                }).join('');
            }
        }

        // 5. Emergency Broadcast Modal Logic
        const openBtn = document.getElementById('openUrgentModalBtn');
        const closeBtn = document.getElementById('btnCancelUrgent');
        const backdrop = document.getElementById('urgentRequestBackdrop');
        const modal = document.getElementById('urgentRequestModal');
        
        const openModal = () => {
            modal?.classList.remove('hidden');
            modal?.classList.add('flex');
        };
        const closeModal = () => {
            modal?.classList.add('hidden');
            modal?.classList.remove('flex');
        };
        
        // Remove old listeners to prevent duplication on multiple loadAdminDashboard calls
        const newOpenBtn = openBtn?.cloneNode(true);
        if (openBtn && newOpenBtn) openBtn.parentNode.replaceChild(newOpenBtn, openBtn);
        const newCloseBtn = closeBtn?.cloneNode(true);
        if (closeBtn && newCloseBtn) closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        const newBackdrop = backdrop?.cloneNode(true);
        if (backdrop && newBackdrop) backdrop.parentNode.replaceChild(newBackdrop, backdrop);
        const newXBtn = document.getElementById('btnCloseUrgentModal')?.cloneNode(true);
        const oldXBtn = document.getElementById('btnCloseUrgentModal');
        if (oldXBtn && newXBtn) oldXBtn.parentNode.replaceChild(newXBtn, oldXBtn);

        const activeOpenBtn = document.getElementById('openUrgentModalBtn');
        const activeCloseBtn = document.getElementById('btnCancelUrgent');
        const activeBackdrop = document.getElementById('urgentRequestBackdrop');
        const activeXBtn = document.getElementById('btnCloseUrgentModal');

        if (activeOpenBtn) activeOpenBtn.addEventListener('click', openModal);
        if (activeCloseBtn) activeCloseBtn.addEventListener('click', closeModal);
        if (activeBackdrop) activeBackdrop.addEventListener('click', closeModal);
        if (activeXBtn) activeXBtn.addEventListener('click', closeModal);

        const typeBtns = document.querySelectorAll('#urgentBloodTypeGroup button');
        const selectedTypeInput = document.getElementById('urgentSelectedType');
        
        typeBtns.forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                // Reset all
                typeBtns.forEach(b => {
                    b.classList.remove('border-primary-container', 'bg-primary-container/10', 'text-primary');
                    b.classList.add('border-slate-100', 'text-slate-700');
                });
                // Highlight clicked
                btn.classList.add('border-primary-container', 'bg-primary-container/10', 'text-primary');
                btn.classList.remove('border-slate-100', 'text-slate-700');
                selectedTypeInput.value = btn.dataset.type;
            };
        });

        const form = document.getElementById('urgentRequestForm');
        if (form) {
            form.onsubmit = async (e) => {
                e.preventDefault();
                const btn = form.querySelector('button[type="submit"]');
                btn.innerHTML = 'Broadcasting...';
                btn.disabled = true;

                const bloodType = document.getElementById('urgentSelectedType').value;
                const units = document.getElementById('urgentUnits').value;
                const urgency = document.getElementById('urgentLevel').value;
                const notes = document.getElementById('urgentNotes').value;

                try {
                    await createEmergencyRequest({
                        hospital: 'Central Command',
                        city: 'National',
                        type: bloodType,
                        units: parseInt(units, 10),
                        distance: 'System-wide',
                        urgency: urgency,
                        notes: notes
                    });
                    
                    form.reset();
                    // select O- default visually
                    document.querySelector('#urgentBloodTypeGroup button[data-type="O-"]').click();
                    closeModal();
                    loadAdminDashboard(); // refresh dashboard metrics
                } catch(err) {
                    console.error("Failed to broadcast", err);
                    alert("Failure to push to system.");
                } finally {
                    btn.innerHTML = 'Broadcast Request';
                    btn.disabled = false;
                }
            };
        }

        initHospitalDetailModal();
        initDonorDetailModal();
        initAdminNavigation();
        initNotificationSystem();
        initCampaignModal();
        
        // Overview page campaign buttons
        const overviewNewCampaignBtn = document.getElementById('btnNewCampaignOverview');
        const overviewScheduleCampaignBtn = document.getElementById('btnScheduleNewCampaign');
        
        if (overviewNewCampaignBtn) {
            overviewNewCampaignBtn.onclick = () => {
                const modal = document.getElementById('campaignModal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                    document.getElementById('campaignModalTitle').textContent = 'Create Campaign';
                    document.getElementById('campaignForm').reset();
                    document.getElementById('campaignId').value = '';
                }
            };
        }
        
        if (overviewScheduleCampaignBtn) {
            overviewScheduleCampaignBtn.onclick = () => {
                const modal = document.getElementById('campaignModal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                    document.getElementById('campaignModalTitle').textContent = 'Create Campaign';
                    document.getElementById('campaignForm').reset();
                    document.getElementById('campaignId').value = '';
                }
            };
        }
    } catch (e) {
        console.error("Failed to load admin dashboard", e);
    }
}

// Global SPA Router Logic
let adminNavigationInitialized = false;
function initAdminNavigation() {
    if(adminNavigationInitialized) return;
    
    const btnOverview = document.getElementById('nav-overview');
    const btnVerifications = document.getElementById('nav-verifications');
    const btnUsers = document.getElementById('nav-users');
    const btnLogs = document.getElementById('nav-logs');
    const btnAnalytics = document.getElementById('nav-analytics');
    const btnCampaigns = document.getElementById('nav-campaigns');
    const btnPublicTriage = document.getElementById('nav-public-triage');
    const btnShadowHospitals = document.getElementById('nav-shadow-hospitals');
    const btnSafetyOversight = document.getElementById('nav-safety-oversight');
    const btnSettings = document.getElementById('nav-settings');

    const viewOverview = document.getElementById('view-overview');
    const viewVerifications = document.getElementById('view-verifications');
    const viewUsers = document.getElementById('view-users');
    const viewLogs = document.getElementById('view-logs');
    const viewAnalytics = document.getElementById('view-analytics');
    const viewCampaigns = document.getElementById('view-campaigns');
    const viewPublicTriage = document.getElementById('view-public-triage');
    const viewShadowHospitals = document.getElementById('view-shadow-hospitals');
    const viewSafetyOversight = document.getElementById('view-safety-oversight');
    const viewSettings = document.getElementById('view-settings');

    // btnDonations/btnInventory/viewDonations/viewInventory used to be part of this guard,
    // but admin.html's sidebar no longer has those nav items or view containers (replaced
    // by Public Triage and Shadow Hospitals) — the stale references made this guard always
    // fail, which silently skipped every addEventListener below and broke all navigation
    // except Overview (which only "worked" because it's the default visible view).
    if (!btnOverview || !btnVerifications || !btnUsers || !btnLogs || !btnAnalytics || !btnCampaigns || !btnSettings) return;

    const globalTitle = document.getElementById('globalHeaderTitle');
    const globalSubtitle = document.getElementById('globalHeaderSubtitle');

    const allViews = [viewOverview, viewVerifications, viewUsers, viewLogs, viewAnalytics, viewCampaigns, viewPublicTriage, viewShadowHospitals, viewSafetyOversight, viewSettings];
    const allNavBtns = [btnOverview, btnVerifications, btnUsers, btnLogs, btnAnalytics, btnCampaigns, btnPublicTriage, btnShadowHospitals, btnSafetyOversight, btnSettings];

    const resetViews = () => {
        allViews.forEach(v => { if (v) { v.classList.add('hidden'); v.classList.remove('block'); } });
        const inactiveClass = 'text-slate-500 dark:text-slate-400 px-4 py-3 flex items-center gap-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200 cursor-pointer';
        allNavBtns.forEach(b => { if (b) b.className = inactiveClass; });
    };

    const activeClass = 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 font-bold rounded-r-full px-4 py-3 flex items-center gap-3 transition-all duration-200 cursor-default';

    const switchView = (target) => {
        resetViews();

        if(target === 'overview') {
            viewOverview.classList.remove('hidden');
            viewOverview.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'System Overview';
            if(globalSubtitle) globalSubtitle.textContent = 'Global Dashboard';
            btnOverview.className = activeClass;
        } else if(target === 'verifications') {
            viewVerifications.classList.remove('hidden');
            viewVerifications.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Hospital Verifications';
            if(globalSubtitle) globalSubtitle.textContent = 'Institutional Management';
            btnVerifications.className = activeClass;
            window.renderHospitalVerificationsTab(document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending');
        } else if(target === 'users') {
            viewUsers.classList.remove('hidden');
            viewUsers.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'User Management';
            if(globalSubtitle) globalSubtitle.textContent = 'Donor Directory';
            btnUsers.className = activeClass;
            window.renderUserManagementTab(document.querySelector('#userTabs button.text-primary')?.dataset.tab || 'all');
        } else if(target === 'logs') {
            viewLogs.classList.remove('hidden');
            viewLogs.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Emergency Operations Audits';
            if(globalSubtitle) globalSubtitle.textContent = 'Global Requests Log';
            btnLogs.className = activeClass;
            window.renderRequestLogsTab(document.querySelector('#logTabs button.text-primary')?.dataset.tab || 'all');
        } else if(target === 'analytics') {
            viewAnalytics.classList.remove('hidden');
            viewAnalytics.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Analytics & Insights';
            if(globalSubtitle) globalSubtitle.textContent = 'System Performance';
            btnAnalytics.className = activeClass;
            loadAnalyticsDashboard();
        } else if(target === 'campaigns') {
            viewCampaigns.classList.remove('hidden');
            viewCampaigns.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Network Campaigns';
            if(globalSubtitle) globalSubtitle.textContent = 'Broadcast Coordination';
            btnCampaigns.className = activeClass;
            loadCampaignsDashboard();
        } else if(target === 'public-triage') {
            viewPublicTriage.classList.remove('hidden');
            viewPublicTriage.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Public Request Triage';
            if(globalSubtitle) globalSubtitle.textContent = 'Unverified Emergency Requests';
            btnPublicTriage.className = activeClass;
            loadPublicTriageQueue();
        } else if(target === 'shadow-hospitals') {
            viewShadowHospitals.classList.remove('hidden');
            viewShadowHospitals.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Unregistered Hospital Leaderboard';
            if(globalSubtitle) globalSubtitle.textContent = 'Partner Outreach Targets';
            btnShadowHospitals.className = activeClass;
            loadShadowHospitalsLeaderboard();
            loadShadowHospitalPendingTests();
        } else if(target === 'safety-oversight') {
            viewSafetyOversight.classList.remove('hidden');
            viewSafetyOversight.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'National Safety Oversight';
            if(globalSubtitle) globalSubtitle.textContent = 'Hemovigilance & Donor Safety';
            btnSafetyOversight.className = activeClass;
            loadSafetyOversightView();
        } else if(target === 'settings') {
            viewSettings.classList.remove('hidden');
            viewSettings.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'System Settings';
            if(globalSubtitle) globalSubtitle.textContent = 'Global Configurations';
            btnSettings.className = activeClass;
            loadSettingsDashboard();
        }
        history.replaceState(null, '', '#' + target);
    };

    window.adminSwitchView = switchView;

    btnOverview.addEventListener('click', (e) => { e.preventDefault(); switchView('overview'); });
    btnVerifications.addEventListener('click', (e) => { e.preventDefault(); switchView('verifications'); });
    btnUsers.addEventListener('click', (e) => { e.preventDefault(); switchView('users'); });
    btnLogs.addEventListener('click', (e) => { e.preventDefault(); switchView('logs'); });
    btnAnalytics.addEventListener('click', (e) => { e.preventDefault(); switchView('analytics'); });
    btnCampaigns.addEventListener('click', (e) => { e.preventDefault(); switchView('campaigns'); });
    if (btnPublicTriage) btnPublicTriage.addEventListener('click', (e) => { e.preventDefault(); switchView('public-triage'); });
    if (btnShadowHospitals) btnShadowHospitals.addEventListener('click', (e) => { e.preventDefault(); switchView('shadow-hospitals'); });
    if (btnSafetyOversight) btnSafetyOversight.addEventListener('click', (e) => { e.preventDefault(); switchView('safety-oversight'); });
    btnSettings.addEventListener('click', (e) => { e.preventDefault(); switchView('settings'); });

    // Shortcuts & UI Hacks
    const btnSkipVerifications = document.getElementById('btnOverviewVerifications');
    if(btnSkipVerifications) {
        btnSkipVerifications.addEventListener('click', (e) => { e.preventDefault(); switchView('verifications'); });
    }

    const hospitalSearchInput = document.getElementById('hospitalSearchInput');
    if (hospitalSearchInput) {
        hospitalSearchInput.addEventListener('input', () => {
            adminHospitalsQuery = hospitalSearchInput.value.trim();
            adminHospitalsPage = 1;
            window.renderHospitalVerificationsTab(document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending');
        });
    }

    const userSearchInput = document.getElementById('userSearchInput');
    if (userSearchInput) {
        userSearchInput.addEventListener('input', () => {
            adminUsersQuery = userSearchInput.value.trim();
            adminUsersPage = 1;
            window.renderUserManagementTab(document.querySelector('#userTabs button.text-primary')?.dataset.tab || 'all');
        });
    }

    const logSearchInput = document.getElementById('logSearchInput');
    if (logSearchInput) {
        logSearchInput.addEventListener('input', () => {
            adminLogsQuery = logSearchInput.value.trim();
            window.renderRequestLogsTab(document.querySelector('#logTabs button.text-primary')?.dataset.tab || 'all');
        });
    }

    initAdminGlobalSearch();

    // Internal Sub-Tabs for Hospitals
    const hospitalTabBtns = document.querySelectorAll('#hospitalTabs button');
    hospitalTabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            hospitalTabBtns.forEach(b => {
                b.className = 'cursor-pointer px-3.5 py-1.5 text-[10px] font-bold rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-all';
            });
            btn.className = 'cursor-pointer px-3.5 py-1.5 text-[10px] font-bold rounded-lg bg-amber-500 text-white shadow-sm transition-all';
            window.renderHospitalVerificationsTab(btn.dataset.tab);
        });
    });

    // Internal Sub-Tabs for Users
    const userTabBtns = document.querySelectorAll('#userTabs button');
    userTabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            userTabBtns.forEach(b => {
                b.className = 'cursor-pointer px-3.5 py-1.5 text-[10px] font-bold rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-all';
            });
            btn.className = 'cursor-pointer px-3.5 py-1.5 text-[10px] font-bold rounded-lg bg-violet-500 text-white shadow-sm transition-all';
            window.renderUserManagementTab(btn.dataset.tab);
        });
    });

    // Internal Sub-Tabs for Logs
    const logTabBtns = document.querySelectorAll('#logTabs button');
    logTabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            logTabBtns.forEach(b => {
                b.className = 'cursor-pointer px-3.5 py-1.5 text-[10px] font-bold rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-all';
            });
            btn.className = 'cursor-pointer px-3.5 py-1.5 text-[10px] font-bold rounded-lg bg-red-500 text-white shadow-sm transition-all';
            window.renderRequestLogsTab(btn.dataset.tab);
        });
    });

    initPublicTriageControls();
    initShadowHospitalsControls();
    initSafetyOversightControls();
    initRequestDetailModal();
    initAdminActivityLogModal();
    initCampaignParticipantsModal();
    initAdminChangePassword();
    initAdminNotificationDropdownControls();
    initShadowHospitalIntake();

    // Restore view from URL hash on reload
    const adminViews = ['overview', 'verifications', 'users', 'logs', 'analytics', 'campaigns', 'public-triage', 'shadow-hospitals', 'safety-oversight', 'settings'];
    const adminHash = window.location.hash.replace('#', '');
    if (adminHash && adminViews.includes(adminHash)) switchView(adminHash);

    window.addEventListener('hashchange', () => {
        const v = window.location.hash.replace('#', '');
        if (v && adminViews.includes(v)) switchView(v);
    });

    adminNavigationInitialized = true;
}

// ============================================
// ADMIN: PUBLIC REQUEST TRIAGE QUEUE
// Admin-only review of requests submitted through the no-login public request page —
// approving/flagging/resolving here is the human check the "soft verification" design
// relies on, since these requests bypass hospital staff entirely.
// ============================================

async function loadPublicTriageQueue() {
    const gridEl = document.getElementById('publicTriageGrid');
    if (!gridEl) return;

    try {
        const all = await fetchPublicRequests();
        document.getElementById('cntTriagePending').textContent = all.filter(r => r.status === 'Pending Review').length;
        document.getElementById('cntTriageBroadcasting').textContent = all.filter(r => r.status === 'Broadcasting').length;
        document.getElementById('cntTriageFlagged').textContent = all.filter(r => r.status === 'Flagged').length;

        const filterVal = document.getElementById('publicTriageStatusFilter')?.value || '';
        const requests = filterVal ? all.filter(r => r.status === filterVal) : all;

        if (requests.length === 0) {
            gridEl.innerHTML = '<div class="col-span-full text-center text-slate-400 py-12">No public requests match this filter.</div>';
            return;
        }

        const statusStyle = {
            'Pending Review': 'text-amber-600 bg-amber-50',
            'Broadcasting': 'text-emerald-600 bg-emerald-50',
            'Flagged': 'text-red-600 bg-red-50',
            'Resolved': 'text-slate-500 bg-slate-100'
        };
        const trustStyle = {
            'trusted': 'text-emerald-600 bg-emerald-50',
            'downgraded': 'text-amber-600 bg-amber-50',
            'blocked': 'text-red-600 bg-red-50'
        };
        const verificationStyle = {
            'Hospital-Confirmed': 'text-emerald-600 bg-emerald-50',
            'Document Attached': 'text-blue-600 bg-blue-50',
            'Unverified': 'text-slate-500 bg-slate-100'
        };

        gridEl.innerHTML = requests.map(r => {
            let actions = '';
            if (r.status === 'Pending Review') {
                actions = `<button onclick="window.approveTriageRequest('${r.id}')" class="text-[10px] font-bold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1.5 rounded-lg transition-colors">Approve & Broadcast</button>`;
            }
            if (r.status !== 'Resolved') {
                actions += `<button onclick="window.flagTriageRequest('${r.id}')" class="text-[10px] font-bold text-red-600 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 rounded-lg transition-colors ml-1.5">Flag</button>`;
                actions += `<button onclick="window.resolveTriageRequest('${r.id}')" class="text-[10px] font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-lg transition-colors ml-1.5">Resolve</button>`;
            }

            return `
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-xs shrink-0">${esc(r.bloodType)}</span>
                        <div class="min-w-0">
                            <p class="text-sm font-bold text-slate-800 truncate">${esc(r.category) || 'General Request'}</p>
                            <p class="text-[10px] text-slate-500 truncate">${esc(r.hospitalName)}${r.isRegisteredHospital ? ' (Partner)' : ''}${r.ward ? ' · ' + esc(r.ward) : ''} · ${esc(r.city)}</p>
                        </div>
                    </div>
                    <div class="flex flex-col items-end gap-1 shrink-0">
                        <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${statusStyle[r.status] || 'text-slate-500 bg-slate-100'}">${esc(r.status)}</span>
                        ${r.verificationLevel ? `<span class="text-[9px] font-bold px-2 py-0.5 rounded-full ${verificationStyle[r.verificationLevel] || 'text-slate-500 bg-slate-100'}">${esc(r.verificationLevel)}</span>` : ''}
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-2 text-[11px] text-slate-500 mb-3">
                    <p>Submitted by: <span class="font-bold text-slate-700">${esc(r.submitterName) || 'Anonymous'}</span> (${esc(r.relationship) || '—'})</p>
                    <p>Phone: <span class="font-bold text-slate-700">${esc(r.contactPhone) || '—'}</span></p>
                    <p>Urgency: <span class="font-bold text-slate-700">${esc(r.urgency)}</span></p>
                    <p>Track ${esc(r.track) || '—'} · <span class="font-bold px-1.5 py-0.5 rounded ${trustStyle[r.phoneTrust] || 'text-slate-500 bg-slate-100'}">${esc(r.phoneTrust) || 'unknown'}</span></p>
                </div>
                ${r.documentUrl ? `<a href="${safeUrl(r.documentUrl)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[10px] font-bold text-blue-600 hover:underline mb-3"><span class="material-symbols-outlined text-xs">description</span>View attached document</a>` : '<p class="text-[10px] text-slate-400 mb-3">No proof document attached</p>'}
                <p class="text-[10px] text-slate-400 mb-3">${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</p>
                ${actions ? `<div class="flex flex-wrap">${actions}</div>` : ''}
            </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load public triage queue:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load public requests.</div>';
    }
}

function initPublicTriageControls() {
    const refreshBtn = document.getElementById('btnRefreshPublicTriage');
    if (refreshBtn) refreshBtn.addEventListener('click', loadPublicTriageQueue);
    const filter = document.getElementById('publicTriageStatusFilter');
    if (filter) filter.addEventListener('change', loadPublicTriageQueue);
}

window.approveTriageRequest = async (requestId) => {
    if (!confirm('Approve this request and broadcast it to nearby donors now?')) return;
    try {
        await approvePublicRequest(requestId);
        showToast('Request approved and broadcasting');
        loadPublicTriageQueue();
    } catch (err) {
        console.error('Failed to approve request:', err);
        alert('Failed to approve request.');
    }
};

window.flagTriageRequest = async (requestId) => {
    const reason = prompt('Reason for flagging this request as suspicious:');
    if (!reason) return;
    try {
        await flagPublicRequest(requestId, reason);
        showToast('Request flagged');
        loadPublicTriageQueue();
    } catch (err) {
        console.error('Failed to flag request:', err);
        alert('Failed to flag request.');
    }
};

window.resolveTriageRequest = async (requestId) => {
    try {
        await resolvePublicRequest(requestId);
        showToast('Request marked resolved');
        loadPublicTriageQueue();
    } catch (err) {
        console.error('Failed to resolve request:', err);
        alert('Failed to resolve request.');
    }
};

// ============================================
// ADMIN: UNREGISTERED (SHADOW) HOSPITAL LEADERBOARD
// Hospitals mentioned by name in public requests but not yet on VitalPulse — ranked by
// demand so admin can prioritize outreach to onboard the ones patients need most.
// ============================================

async function loadShadowHospitalsLeaderboard() {
    const gridEl = document.getElementById('shadowHospitalsGrid');
    if (!gridEl) return;

    try {
        const hospitals = await fetchShadowHospitals();
        if (hospitals.length === 0) {
            gridEl.innerHTML = '<div class="col-span-full text-center text-slate-400 py-12">No unregistered hospitals mentioned yet.</div>';
            return;
        }

        const statusStyle = {
            'unclaimed': 'text-slate-500 bg-slate-100',
            'invite_sent': 'text-blue-600 bg-blue-50',
            'claimed': 'text-emerald-600 bg-emerald-50'
        };

        gridEl.innerHTML = hospitals.map(h => `
            <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
                <div class="flex items-start justify-between gap-2 mb-3">
                    <div class="min-w-0">
                        <p class="text-sm font-bold text-slate-800 truncate">${esc(h.name)}</p>
                        <p class="text-[10px] text-slate-500">${esc(h.city)}</p>
                    </div>
                    <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${statusStyle[h.status] || 'text-slate-500 bg-slate-100'} shrink-0">${esc((h.status || 'unclaimed').replace('_', ' '))}</span>
                </div>
                <p class="text-2xl font-black text-slate-900">${Number(h.requestCount) || 0}</p>
                <p class="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-3">Patient requests</p>
                <p class="text-[10px] text-slate-500 mb-3">${h.contactPhone || h.contactEmail ? `Contact: ${esc(h.contactPhone || h.contactEmail)}` : 'No contact info on file'}</p>
                <div class="flex gap-1.5">
                    <button onclick="window.addShadowHospitalContact('${h.id}')" class="text-[10px] font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-lg transition-colors">Add Contact</button>
                    <button onclick="window.sendShadowHospitalInvite('${h.id}')" class="text-[10px] font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2.5 py-1.5 rounded-lg transition-colors">Send Invite</button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load shadow hospitals leaderboard:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load leaderboard.</div>';
    }
}

function initShadowHospitalsControls() {
    const refreshBtn = document.getElementById('btnRefreshShadowHospitals');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
        loadShadowHospitalsLeaderboard();
        loadShadowHospitalPendingTests();
    });
    initLabTestModal();
}

// Blood collected on behalf of a shadow hospital (via adminProxyCheckInDonor) always lands here
// first — 'Waiting for Lab Test'. Since that hospital has no VitalPulse login, this is the only
// place in the entire app that can ever clear or reject it. Without this view, that blood was
// permanently stuck.
async function loadShadowHospitalPendingTests() {
    const gridEl = document.getElementById('shadowLabPendingGrid');
    if (!gridEl) return;

    try {
        const hospitals = await fetchShadowHospitals();
        const perHospital = await Promise.all(hospitals.map(async (h) => {
            const pending = await fetchPendingLabTests(h.name).catch(() => []);
            return pending.map(p => ({ ...p, shadowHospitalName: h.name }));
        }));
        const allPending = perHospital.flat();

        if (allPending.length === 0) {
            gridEl.innerHTML = '<div class="col-span-full text-center text-slate-400 py-8">No pending tests for unregistered hospitals.</div>';
            return;
        }

        gridEl.innerHTML = allPending.map(b => `
            <div class="bg-slate-50/70 rounded-2xl border border-slate-200/50 p-4">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="w-10 h-10 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center font-black text-sm shrink-0">${b.bloodType}</span>
                    <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full text-amber-600 bg-amber-100">Awaiting Test</span>
                </div>
                <p class="text-sm font-bold text-slate-800">${b.units} unit${b.units > 1 ? 's' : ''} · ${b.componentType || 'Whole Blood'}</p>
                <p class="text-[10px] text-slate-500 mt-0.5">${b.shadowHospitalName}</p>
                <p class="text-[10px] text-slate-400">Collected ${b.addedAt ? new Date(b.addedAt).toLocaleDateString() : '—'}</p>
                <button onclick="window.openLabTestModal('${b.id}', '${b.bloodType}', '${b.shadowHospitalName.replace(/'/g, "\\'")}')" class="mt-3 w-full text-[11px] font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 py-2 rounded-lg transition-colors flex items-center justify-center gap-1.5">
                    <span class="material-symbols-outlined text-sm">science</span> Run Test
                </button>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load shadow hospital pending tests:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load pending tests.</div>';
    }
}

// adminProxyCheckInDonor is the ONLY way a shadow (unregistered) hospital's donation ever gets
// recorded — that hospital has no login to do it themselves. This box was the missing trigger:
// the function existed and worked but nothing in the UI ever called it.
function initShadowHospitalIntake() {
    const tokenInput = document.getElementById('shadowIntakeToken');
    const labTypeSelect = document.getElementById('shadowIntakeLabType');
    const btn = document.getElementById('btnVerifyShadowIntake');
    if (!tokenInput || !btn) return;

    btn.addEventListener('click', async () => {
        const token = tokenInput.value.trim();
        if (!token) { alert('Enter a pass code first'); return; }
        btn.disabled = true;

        try {
            const match = await findRequestByCheckInToken(token, 'public_requests');
            if (!match) { alert('No public request found with that pass code.'); return; }
            if (match.status === 'Completed') { alert('This donation has already been recorded.'); return; }
            if (!confirm(`Confirm intake for ${match.bloodType || 'blood'} donation at ${match.hospitalName || 'this hospital'}?`)) return;

            await adminProxyCheckInDonor(match.id, token, labTypeSelect?.value || null);
            showToast('Donor intake verified — blood sent to lab quarantine.');
            tokenInput.value = '';
            if (labTypeSelect) labTypeSelect.value = '';
            loadShadowHospitalPendingTests();
        } catch (err) {
            console.error('Shadow hospital intake failed:', err);
            alert(err.message || 'Failed to verify intake.');
        } finally {
            btn.disabled = false;
        }
    });
}

window.addShadowHospitalContact = async (shadowId) => {
    const phone = prompt('Contact phone number for this hospital (e.g. +237 6XX XXX XXX):');
    if (phone === null) return;
    try {
        await updateShadowHospitalContact(shadowId, phone, null);
        showToast('Contact info saved');
        loadShadowHospitalsLeaderboard();
    } catch (err) {
        console.error('Failed to save contact info:', err);
        alert('Failed to save contact info.');
    }
};

window.sendShadowHospitalInvite = async (shadowId) => {
    try {
        await sendPartnerInvitation(shadowId);
        showToast('Invitation sent');
        loadShadowHospitalsLeaderboard();
    } catch (err) {
        console.error('Failed to send invite:', err);
        alert(err.message || 'Failed to send invite. Add contact info first.');
    }
};

// ============================================
// ADMIN: NATIONAL SAFETY OVERSIGHT
// Combines Hemovigilance (patient transfusion reactions) and Donor Reactions across every
// hospital — the two per-hospital logs feed this one national rollup so admin can see
// safety patterns that no single hospital's own dashboard would reveal.
// ============================================

async function loadSafetyOversightView() {
    const patientGridEl = document.getElementById('safetyPatientReactionsGrid');
    const donorGridEl = document.getElementById('safetyDonorReactionsGrid');
    if (!patientGridEl && !donorGridEl) return;

    try {
        const [patientReports, donorReports] = await Promise.all([
            fetchAllHemovigilanceReports(),
            fetchAllDonorReactions()
        ]);

        const severePatient = ['severe', 'life_threatening', 'fatal'];
        const severeCount = patientReports.filter(r => severePatient.includes(r.severity)).length
            + donorReports.filter(r => r.severity === 'severe').length;
        const pendingCount = patientReports.filter(r => r.status === 'pending_review').length
            + donorReports.filter(r => r.status === 'reported').length;

        document.getElementById('safetyTotalPatientReactions').textContent = patientReports.length;
        document.getElementById('safetyTotalDonorReactions').textContent = donorReports.length;
        document.getElementById('safetySevereCount').textContent = severeCount;
        document.getElementById('safetyPendingCount').textContent = pendingCount;

        const patientSeverityStyle = {
            mild: 'text-amber-600 bg-amber-50', moderate: 'text-orange-600 bg-orange-50',
            severe: 'text-red-600 bg-red-50', life_threatening: 'text-red-700 bg-red-100', fatal: 'text-red-800 bg-red-200'
        };
        if (patientGridEl) {
            if (patientReports.length === 0) {
                patientGridEl.innerHTML = '<div class="col-span-full text-center text-slate-400 py-8">No patient transfusion reactions reported yet.</div>';
            } else {
                patientGridEl.innerHTML = patientReports.map(r => `
                    <div class="bg-slate-50/70 rounded-2xl border border-slate-200/50 p-4">
                        <div class="flex items-start justify-between gap-2 mb-2">
                            <span class="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-xs shrink-0">${esc(r.bloodType) || '?'}</span>
                            <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${patientSeverityStyle[r.severity] || 'text-slate-500 bg-slate-100'}">${esc((r.severity || '').replace(/_/g, ' '))}</span>
                        </div>
                        <p class="text-xs font-bold text-slate-800">${esc((r.reactionType || '').replace(/_/g, ' '))}</p>
                        <p class="text-[10px] text-slate-500 mt-0.5">${esc(r.hospitalName) || 'Unknown hospital'} · ${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}</p>
                        <p class="text-[10px] text-slate-600 mt-2">${esc(r.description) || ''}</p>
                        <div class="flex items-center justify-between mt-3">
                            <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${r.status === 'resolved' ? 'text-emerald-600 bg-emerald-50' : 'text-amber-600 bg-amber-50'}">${esc((r.status || 'pending_review').replace(/_/g, ' '))}</span>
                            ${r.status !== 'resolved' ? `<button onclick="window.adminResolveHemoReport('${r.id}')" class="text-[10px] font-bold text-emerald-600 hover:underline cursor-pointer">Mark Resolved</button>` : ''}
                        </div>
                    </div>
                `).join('');
            }
        }

        if (donorGridEl) {
            if (donorReports.length === 0) {
                donorGridEl.innerHTML = '<div class="col-span-full text-center text-slate-400 py-8">No donor reactions reported yet.</div>';
            } else {
                const donorSeverityStyle = { mild: 'text-amber-600 bg-amber-50', moderate: 'text-orange-600 bg-orange-50', severe: 'text-red-600 bg-red-50' };
                donorGridEl.innerHTML = donorReports.map(r => `
                    <div class="bg-slate-50/70 rounded-2xl border border-slate-200/50 p-4">
                        <div class="flex items-start justify-between gap-2 mb-2">
                            <span class="w-9 h-9 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center font-black text-xs shrink-0">${esc(r.bloodType) || '?'}</span>
                            <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${donorSeverityStyle[r.severity] || 'text-slate-500 bg-slate-100'}">${esc(r.severity)}</span>
                        </div>
                        <p class="text-xs font-bold text-slate-800">${esc(r.donorName) || 'Unknown Donor'} — ${esc((r.reactionType || '').replace(/_/g, ' '))}</p>
                        <p class="text-[10px] text-slate-500 mt-0.5">${esc(r.hospitalName) || 'Unknown hospital'} · ${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}</p>
                        <p class="text-[10px] text-slate-600 mt-2">${esc(r.description) || ''}</p>
                        <div class="flex items-center justify-between mt-3">
                            <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${r.status === 'resolved' ? 'text-emerald-600 bg-emerald-50' : 'text-slate-500 bg-slate-100'}">${esc(r.status)}</span>
                            ${r.status !== 'resolved' ? `<button onclick="window.adminResolveDonorReaction('${r.id}')" class="text-[10px] font-bold text-emerald-600 hover:underline cursor-pointer">Mark Resolved</button>` : ''}
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch (e) {
        console.error('Failed to load national safety oversight:', e);
        if (patientGridEl) patientGridEl.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load reports.</div>';
        if (donorGridEl) donorGridEl.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load reports.</div>';
    }
}

function initSafetyOversightControls() {
    const refreshBtn = document.getElementById('btnRefreshSafetyOversight');
    if (refreshBtn) refreshBtn.addEventListener('click', loadSafetyOversightView);
}

window.adminResolveHemoReport = async (reportId) => {
    try {
        await updateHemovigilanceReport(reportId, { status: 'resolved' });
        showToast('Report marked resolved');
        loadSafetyOversightView();
    } catch (err) {
        console.error('Failed to resolve hemovigilance report:', err);
        alert('Failed to update report.');
    }
};

window.adminResolveDonorReaction = async (reactionId) => {
    try {
        await updateDonorReaction(reactionId, { status: 'resolved' });
        showToast('Reaction marked resolved');
        loadSafetyOversightView();
    } catch (err) {
        console.error('Failed to resolve donor reaction:', err);
        alert('Failed to update reaction.');
    }
};

// ----------------------------------------------------
// NATIVE CSV EXPORT ENGINE
// By directly extracting the visual DOM, we guarantee 
// exactly what the Admin is currently looking at (Filtered)
// is what gets exported.
// ----------------------------------------------------

window.downloadCSVFromTable = (tableBodyId, filename) => {
    const tableData = [];
    const rows = document.querySelectorAll(`#${tableBodyId} tr`);
    
    if (rows.length === 0 || (rows.length === 1 && rows[0].innerText.includes('No '))) {
        alert("No data available to export.");
        return;
    }

    // Extract headers dynamically by looking at the previous sibling thead
    const thead = document.querySelector(`#${tableBodyId}`).closest('table').querySelector('thead');
    if (thead) {
        const headers = Array.from(thead.querySelectorAll('th')).map(th => th.innerText.trim());
        tableData.push(headers.join(","));
    }

    rows.forEach(row => {
        const cols = row.querySelectorAll('td');
        const rowData = Array.from(cols).map(col => {
            // Scrub out any extra inner text formatting, button labels, or newlines
            let text = col.innerText.replace(/(\r\n|\n|\r)/gm, " ").trim();
            // Handle quotes properly in CSV format
            return `"${text.replace(/"/g, '""')}"`;
        });
        tableData.push(rowData.join(","));
    });

    const csvContent = "data:text/csv;charset=utf-8," + tableData.join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${filename}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

document.addEventListener('DOMContentLoaded', () => {
    const btnExportUsers = document.getElementById('btnExportUsersCSV');
    if(btnExportUsers) {
        btnExportUsers.addEventListener('click', (e) => {
            e.preventDefault();
            window.downloadCSVFromTable('adminUsersTableBody', 'VitalPulse_Donor_Directory');
        });
    }

    const btnExportLogs = document.getElementById('btnExportLogsCSV');
    if(btnExportLogs) {
        btnExportLogs.addEventListener('click', (e) => {
            e.preventDefault();
            window.downloadCSVFromTable('adminLogsTableBody', 'VitalPulse_Emergency_Audit_Logs');
        });
    }
});

// ============================================
// ADMIN: GLOBAL HEADER SEARCH
// Previously the search box looked fully functional but just cleared itself on Enter — no
// query ever ran. Now searches hospitals/donors/requests together and opens the same detail
// views their own management tabs already use.
// ============================================
let adminSearchDebounceTimer = null;

function initAdminGlobalSearch() {
    const input = document.getElementById('inputAdminSearch');
    const resultsEl = document.getElementById('adminSearchResults');
    if (!input || !resultsEl) return;

    const closeResults = () => { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; };

    const runSearch = async () => {
        const term = input.value.trim().toLowerCase();
        if (term.length < 2) { closeResults(); return; }

        resultsEl.classList.remove('hidden');
        resultsEl.innerHTML = '<div class="p-4 text-center text-xs text-slate-400">Searching…</div>';

        try {
            const [hospitals, donors, requests] = await Promise.all([
                fetchAllHospitals(),
                fetchAllDonors(),
                fetchAllSystemRequests()
            ]);
            adminLogsCache = requests; // lets a clicked request result open the same detail modal Logs uses

            const matchedHospitals = hospitals.filter(h => (h.name || '').toLowerCase().includes(term)).slice(0, 5);
            const matchedDonors = donors.filter(d => (d.name || '').toLowerCase().includes(term) || (d.email || '').toLowerCase().includes(term)).slice(0, 5);
            const matchedRequests = requests.filter(r => r.id.toLowerCase().includes(term) || (r.bloodType || '').toLowerCase().includes(term) || (r.hospital || '').toLowerCase().includes(term)).slice(0, 5);

            if (matchedHospitals.length === 0 && matchedDonors.length === 0 && matchedRequests.length === 0) {
                resultsEl.innerHTML = '<div class="p-4 text-center text-xs text-slate-400">No matches found.</div>';
                return;
            }

            const section = (title, itemsHtml) => !itemsHtml ? '' : `<div class="px-3 pt-3 pb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">${title}</div>${itemsHtml}`;

            const hospitalItems = matchedHospitals.map(h => `
                <div onclick="window.viewHospitalDetail('${h.id}'); document.getElementById('adminSearchResults').classList.add('hidden');" class="px-3 py-2 hover:bg-slate-50 cursor-pointer flex items-center gap-2">
                    <span class="material-symbols-outlined text-slate-400 text-base">local_hospital</span>
                    <span class="text-sm font-bold text-slate-700 truncate">${esc(h.name)}</span>
                </div>`).join('');

            const donorItems = matchedDonors.map(d => `
                <div onclick="window.viewDonorDetail('${d.id}'); document.getElementById('adminSearchResults').classList.add('hidden');" class="px-3 py-2 hover:bg-slate-50 cursor-pointer flex items-center gap-2">
                    <span class="material-symbols-outlined text-slate-400 text-base">bloodtype</span>
                    <span class="text-sm font-bold text-slate-700 truncate">${esc(d.name || d.email || 'Donor')}</span>
                </div>`).join('');

            const requestItems = matchedRequests.map(r => `
                <div onclick="window.viewRequestDetail('${r.id}'); document.getElementById('adminSearchResults').classList.add('hidden');" class="px-3 py-2 hover:bg-slate-50 cursor-pointer flex items-center gap-2">
                    <span class="material-symbols-outlined text-slate-400 text-base">emergency</span>
                    <span class="text-sm font-bold text-slate-700 truncate">#${r.id.slice(0, 8).toUpperCase()} · ${esc(r.bloodType) || 'Any'}</span>
                </div>`).join('');

            resultsEl.innerHTML = section('Hospitals', hospitalItems) + section('Donors', donorItems) + section('Requests', requestItems);
        } catch (e) {
            console.error('Admin search failed:', e);
            resultsEl.innerHTML = '<div class="p-4 text-center text-xs text-error">Search failed.</div>';
        }
    };

    input.addEventListener('input', () => {
        clearTimeout(adminSearchDebounceTimer);
        adminSearchDebounceTimer = setTimeout(runSearch, 300);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(adminSearchDebounceTimer);
            runSearch();
        } else if (e.key === 'Escape') {
            input.value = '';
            closeResults();
            input.blur();
        }
    });

    document.addEventListener('click', (e) => {
        if (!resultsEl.contains(e.target) && e.target !== input) closeResults();
    });
}

const requestStatusLc = (status) => (status || '').toLowerCase();
const isRequestStatusActive = (status) => REQUEST_ACTIVE_STATUSES.map(s => s.toLowerCase()).includes(requestStatusLc(status));
const isRequestStatusClosed = (status) => REQUEST_CLOSED_STATUSES.map(s => s.toLowerCase()).includes(requestStatusLc(status));

let adminLogsCache = [];
let adminLogsQuery = '';
let adminHospitalsTab = '';
let adminHospitalsQuery = '';
let adminHospitalsPage = 1;
let adminHospitalsPerPage = 8;
let adminUsersTab = '';
let adminUsersQuery = '';
let adminUsersPage = 1;
let adminUsersPerPage = 8;

function renderAdminPagination(container, page, totalPages, total, key) {
    if (!container) return;
    if (totalPages <= 1) {
        container.innerHTML = `<span class="text-xs font-bold text-slate-500">${total} record${total === 1 ? '' : 's'}</span>`;
        return;
    }
    container.innerHTML = `
        <span class="text-xs font-bold text-slate-500">${total} records</span>
        <div class="flex items-center gap-2">
            <button onclick="window.adminPageNav('${key}', -1)" ${page <= 1 ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Prev</button>
            <span class="text-xs font-bold text-slate-600">${page} / ${Math.max(totalPages, 1)}</span>
            <button onclick="window.adminPageNav('${key}', 1)" ${page >= totalPages ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
        </div>`;
}

window.adminPageNav = (key, delta) => {
    if (key === 'hospitals') {
        adminHospitalsPage = Math.max(1, adminHospitalsPage + delta);
        window.renderHospitalVerificationsTab(document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending');
    } else if (key === 'users') {
        adminUsersPage = Math.max(1, adminUsersPage + delta);
        window.renderUserManagementTab(document.querySelector('#userTabs button.text-primary')?.dataset.tab || 'all');
    }
};

window.renderRequestLogsTab = async (tab) => {
    const tableBody = document.getElementById('adminLogsTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '<tr><td colspan="7" class="px-6 py-8 text-center text-slate-500">Retrieving operational logs...</td></tr>';

    try {
        const allRequests = await fetchAllSystemRequests();

        // Populate the stats cards (Total / Active / Resolved)
        const statTotal = document.getElementById('statTotalRequests');
        const statActive = document.getElementById('statActiveRequests');
        const statResolved = document.getElementById('statResolvedRequests');
        if (statTotal) statTotal.textContent = allRequests.length;
        if (statActive) statActive.textContent = allRequests.filter(r => isRequestStatusActive(r.status)).length;
        if (statResolved) statResolved.textContent = allRequests.filter(r => isRequestStatusClosed(r.status)).length;

        let filtered = [];
        if (tab === 'open') {
            filtered = allRequests.filter(r => isRequestStatusActive(r.status));
        } else if (tab === 'resolved') {
            filtered = allRequests.filter(r => isRequestStatusClosed(r.status));
        } else {
            filtered = allRequests;
        }

        if (adminLogsQuery) {
            const q = adminLogsQuery.toLowerCase();
            filtered = filtered.filter(r =>
                (r.bloodType || r.type || '').toLowerCase().includes(q) ||
                (r.hospital || r.hospitalName || '').toLowerCase().includes(q) ||
                r.id.toLowerCase().includes(q)
            );
        }
        adminLogsCache = filtered;

        if (filtered.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="7" class="px-6 py-8 text-center text-slate-500 font-medium tracking-wide">No ${tab} requests logged.</td></tr>`;
            return;
        }

        tableBody.innerHTML = filtered.map(r => {
             let statusUI = '';
             if (r.status === 'Open' || r.status === 'open') {
                 statusUI = '<span class="px-2 py-1 bg-amber-100 text-amber-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Open (Searching)</span>';
             } else if (r.status === 'Donor Assigned' || r.status === 'Matching' || r.status === 'matched') {
                 statusUI = '<span class="px-2 py-1 bg-amber-100 text-amber-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Donor Assigned</span>';
             } else if (r.status === 'Donor En Route') {
                 statusUI = '<span class="px-2 py-1 bg-indigo-100 text-indigo-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Donor En Route</span>';
             } else if (r.status === 'Resolved' || r.status === 'resolved') {
                 statusUI = '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Resolved</span>';
             } else {
                 statusUI = `<span class="px-2 py-1 bg-slate-100 text-slate-700 rounded-md text-[10px] font-bold tracking-widest uppercase">${esc(r.status)}</span>`;
             }

             // Handle relative time logic — the requests collection stores requestedAt,
             // but legacy docs may only have timestamp or createdAt.
             const reqDateRaw = r.requestedAt || r.timestamp || r.createdAt || r.updatedAt;
             let timeString = '';
             if (!reqDateRaw) {
                 timeString = '—';
             } else {
                 const reqDate = new Date(reqDateRaw);
                 const now = new Date();
                 const diffMs = now - reqDate;
                 let diffMins = Math.floor(diffMs / 60000);
                 if (diffMins < 0) diffMins = 0;
                 if (diffMins < 60) {
                     timeString = `${diffMins} min${diffMins === 1 ? '' : 's'} ago`;
                 } else if (diffMins < 1440) {
                     timeString = `${Math.floor(diffMins / 60)} hr${Math.floor(diffMins / 60) === 1 ? '' : 's'} ago`;
                 } else {
                     timeString = `${Math.floor(diffMins / 1440)} day${Math.floor(diffMins / 1440) === 1 ? '' : 's'} ago`;
                 }
             }

             const origin = r.hospital || r.hospitalName || 'Central Command';
             
             return `
             <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4">
                    <p class="font-mono text-xs font-bold text-slate-700">${r.id.slice(0,8).toUpperCase()}</p>
                </td>
                <td class="p-4"><span class="font-black text-primary bg-primary/5 px-2 py-1 rounded text-xs">${esc(r.bloodType) || 'Any'}</span></td>
                <td class="p-4">
                    <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-[14px] text-slate-400" data-icon="${origin === 'Central Command' ? 'admin_panel_settings' : 'local_hospital'}">${origin === 'Central Command' ? 'admin_panel_settings' : 'local_hospital'}</span>
                        <span class="text-xs font-bold text-on-surface truncate max-w-[150px]">${esc(origin)}</span>
                    </div>
                </td>
                <td class="p-4"><span class="text-xs font-semibold whitespace-nowrap">${Number(r.unitsRequired) || 1} Units</span></td>
                <td class="p-4">${statusUI}</td>
                <td class="p-4"><span class="text-[11px] font-bold text-slate-400">${timeString}</span></td>
                <td class="p-4 text-right">
                    <button onclick="window.viewRequestDetail('${r.id}')" class="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors cursor-pointer" title="View Detail">
                        <span class="material-symbols-outlined text-sm">visibility</span>
                    </button>
                </td>
             </tr>
             `;
        }).join('');
    } catch (err) {
        console.error(err);
        tableBody.innerHTML = '<tr><td colspan="7" class="text-center text-error py-4">Failed to load request logs.</td></tr>';
    }
};

// ============================================
// ADMIN: REQUEST DETAIL MODAL
// Looks up from the already-fetched Logs table cache rather than re-querying Firestore —
// same pattern as openLabCertModal reading from labPipelineBatches.
// ============================================
function initRequestDetailModal() {
    const modal = document.getElementById('requestDetailModal');
    const closeBtn = document.getElementById('btnCloseRequestDetail');
    const close = () => modal?.classList.add('hidden');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
}

window.viewRequestDetail = (requestId) => {
    const modal = document.getElementById('requestDetailModal');
    const content = document.getElementById('requestDetailContent');
    if (!modal || !content) return;

    const r = adminLogsCache.find(x => x.id === requestId);
    if (!r) return;

    const field = (label, value) => `
        <div class="flex items-center justify-between py-2.5 border-b border-slate-100 last:border-0">
            <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">${esc(label)}</span>
            <span class="text-sm font-bold text-slate-800 text-right">${esc(value) ?? '—'}</span>
        </div>`;

    content.innerHTML = `
        <div class="space-y-1">
            ${field('Request ID', '#' + r.id.slice(0, 8).toUpperCase())}
            ${field('Blood Type', r.bloodType || r.type || 'Any')}
            ${field('Component', r.componentType || 'Whole Blood')}
            ${field('Units', r.unitsRequired || r.units || 1)}
            ${field('Status', r.status)}
            ${field('Hospital', r.hospital || r.hospitalName || 'Central Command')}
            ${field('Urgency', r.urgency || 'standard')}
            ${field('Requested At', r.requestedAt ? new Date(r.requestedAt).toLocaleString() : '—')}
            ${r.matchedDonor ? field('Matched Donor ID', r.matchedDonor) : ''}
            ${r.matchedAt ? field('Matched At', new Date(r.matchedAt).toLocaleString()) : ''}
            ${r.checkInToken ? field('Check-In Pass Code', r.checkInToken) : ''}
            ${r.checkedInAt ? field('Checked In At', new Date(r.checkedInAt).toLocaleString()) : ''}
            ${r.donationCompletedAt ? field('Blood Drawn At', new Date(r.donationCompletedAt).toLocaleString()) : ''}
            ${r.labResolvedAt ? field('Lab Resolved At', new Date(r.labResolvedAt).toLocaleString()) : ''}
            ${r.issuedAt ? field('Issued At', new Date(r.issuedAt).toLocaleString()) : ''}
            ${r.resolvedAt ? field('Resolved At', new Date(r.resolvedAt).toLocaleString()) : ''}
            ${(r.adminResolutionNote || r.resolutionReason) ? field('Resolution Note', r.adminResolutionNote || r.resolutionReason) : ''}
        </div>
    `;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

// ============================================
// ADMIN: FULL ACTIVITY LOG MODAL
// The Overview page's small 4-item preview (adminActivityFeed) already worked; this is the
// searchable/filterable/exportable full view it was always supposed to link out to.
// ============================================
let adminActivityLogCache = [];
let adminActivityLogFiltered = [];

async function loadFullActivityLog(filter = 'all', searchTerm = '') {
    const body = document.getElementById('activityLogBody');
    const countEl = document.getElementById('activityLogCount');
    if (!body) return;

    body.innerHTML = '<div class="text-center text-slate-400 py-8 text-sm">Loading...</div>';
    try {
        const logs = await fetchRecentLogs(200);
        adminActivityLogCache = logs;

        let filtered = logs;
        if (filter === 'admin') {
            filtered = filtered.filter(l => l.actor);
        } else if (filter !== 'all') {
            filtered = filtered.filter(l => l.type === filter);
        }
        if (searchTerm.trim()) {
            const term = searchTerm.trim().toLowerCase();
            filtered = filtered.filter(l => (l.title || '').toLowerCase().includes(term) || (l.description || '').toLowerCase().includes(term));
        }
        adminActivityLogFiltered = filtered;

        if (countEl) countEl.textContent = `${filtered.length} events`;

        if (filtered.length === 0) {
            body.innerHTML = '<div class="text-center text-slate-400 py-8 text-sm">No matching activity.</div>';
            return;
        }

        body.innerHTML = filtered.map(log => {
            let icon = 'info';
            let colorClass = 'bg-slate-100 text-slate-600';
            if (log.type === 'success') { icon = 'check_circle'; colorClass = 'bg-green-100 text-green-600'; }
            if (log.type === 'warning') { icon = 'warning'; colorClass = 'bg-amber-100 text-amber-600'; }
            if (log.type === 'error') { icon = 'error'; colorClass = 'bg-red-100 text-red-600'; }
            return `
            <div class="flex items-start gap-3 py-3 border-b border-slate-50 last:border-0">
                <div class="w-8 h-8 rounded-full ${colorClass} flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-sm">${icon}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-bold text-slate-800">${esc(log.title)}</p>
                    <p class="text-xs text-slate-500 mt-0.5">${esc(log.description)}</p>
                    <p class="text-[10px] text-slate-400 mt-1">${log.timestamp ? new Date(log.timestamp).toLocaleString() : ''}</p>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Failed to load activity log:', e);
        body.innerHTML = '<div class="text-center text-error py-8 text-sm">Failed to load activity log.</div>';
    }
}

function initAdminActivityLogModal() {
    const modal = document.getElementById('activityLogModal');
    const closeBtn = document.getElementById('btnCloseActivityLog');
    const searchInput = document.getElementById('activityLogSearch');
    const filterBtns = document.querySelectorAll('#activityLogFilters button');
    const exportBtn = document.getElementById('btnExportActivityLog');
    const clearBtnModal = document.getElementById('btnClearActivityLogsModal');
    const clearBtnInline = document.getElementById('btnClearActivityLogs');
    const openBtns = [document.getElementById('btnViewAllActivity'), document.getElementById('btnViewAllActivityInline')];

    let activeFilter = 'all';

    const close = () => { modal?.classList.add('hidden'); modal?.classList.remove('flex'); };
    const open = () => { modal?.classList.remove('hidden'); modal?.classList.add('flex'); loadFullActivityLog(activeFilter, searchInput?.value || ''); };

    openBtns.forEach(btn => { if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); open(); }); });
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    let searchDebounceTimer = null;
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => loadFullActivityLog(activeFilter, searchInput.value), 300);
        });
    }

    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            activeFilter = btn.dataset.filter;
            filterBtns.forEach(b => {
                b.className = 'px-3 py-1 text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 transition-all cursor-pointer';
            });
            btn.className = 'px-3 py-1 text-[10px] font-bold rounded-full bg-slate-800 text-white transition-all cursor-pointer';
            loadFullActivityLog(activeFilter, searchInput?.value || '');
        });
    });

    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const rows = [['Timestamp', 'Title', 'Type', 'Actor', 'Description'], ...adminActivityLogFiltered.map(l => [l.timestamp, l.title, l.type, l.actor || '', l.description])];
            const csv = rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `vitalpulse-activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const clearAll = async () => {
        if (!confirm('Clear the entire activity log? This cannot be undone.')) return;
        try {
            await clearAllActivityLogs();
            showToast('Activity log cleared');
            loadFullActivityLog(activeFilter, searchInput?.value || '');
            const feed = document.getElementById('adminActivityFeed');
            if (feed) feed.innerHTML = '<div class="text-center text-slate-400 text-sm italic py-4">System is quiet. No logs yet.</div>';
        } catch (e) {
            console.error('Failed to clear activity log:', e);
            alert('Failed to clear activity log.');
        }
    };
    if (clearBtnModal) clearBtnModal.addEventListener('click', clearAll);
    if (clearBtnInline) clearBtnInline.addEventListener('click', clearAll);
}

window.renderHospitalVerificationsTab = async (tab) => {
    const tableBody = document.getElementById('adminHospitalsTableBody');
    if (!tableBody) return;
    
    tableBody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500">Loading directory...</td></tr>';
    
    try {
        const allHospitals = await fetchAllHospitals();

        // Populate the stats cards (Total / Pending / Verified / Rejected)
        const statTotal = document.getElementById('statTotalHospitals');
        const statPending = document.getElementById('statPendingHospitals');
        const statVerified = document.getElementById('statVerifiedHospitals');
        const statRejected = document.getElementById('statRejectedHospitals');
        if (statTotal) statTotal.textContent = allHospitals.length;
        if (statPending) statPending.textContent = allHospitals.filter(h => h.isVerified === false && !h.rejected).length;
        if (statVerified) statVerified.textContent = allHospitals.filter(h => h.isVerified === true).length;
        if (statRejected) statRejected.textContent = allHospitals.filter(h => h.rejected === true).length;

        if (tab !== adminHospitalsTab) { adminHospitalsTab = tab; adminHospitalsPage = 1; }

        let filtered = [];
        if (tab === 'verified') {
            filtered = allHospitals.filter(h => h.isVerified === true);
        } else if (tab === 'rejected') {
            filtered = allHospitals.filter(h => h.rejected === true);
        } else {
            filtered = allHospitals.filter(h => h.isVerified === false && !h.rejected);
        }

        if (adminHospitalsQuery) {
            const q = adminHospitalsQuery.toLowerCase();
            filtered = filtered.filter(h =>
                (h.name || '').toLowerCase().includes(q) ||
                (h.city || '').toLowerCase().includes(q) ||
                h.id.toLowerCase().includes(q)
            );
        }

        const hospitalTotalPages = Math.max(1, Math.ceil(filtered.length / adminHospitalsPerPage));
        adminHospitalsPage = Math.min(adminHospitalsPage, hospitalTotalPages);
        const hospitalPageItems = filtered.slice((adminHospitalsPage - 1) * adminHospitalsPerPage, adminHospitalsPage * adminHospitalsPerPage);

        if (hospitalPageItems.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500 font-medium tracking-wide">No ${tab} institutions found.</td></tr>`;
            renderAdminPagination(document.getElementById('adminHospitalsPagination'), adminHospitalsPage, hospitalTotalPages, filtered.length, 'hospitals');
            return;
        }

        tableBody.innerHTML = hospitalPageItems.map(h => {
             const statusBadge = h.rejected ? '<span class="px-2 py-1 bg-red-100 text-red-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Rejected</span>' :
                                 h.isVerified && h.isActive === false ? '<span class="px-2 py-1 bg-slate-200 text-slate-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Deactivated</span>' :
                                 h.isVerified ? '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Verified</span>' : 
                                 '<span class="px-2 py-1 bg-amber-100 text-amber-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Pending</span>';
             
             let actions = '';
             if(!h.rejected && !h.isVerified) {
                 actions = `<div class="flex items-center justify-end gap-2">
                     <button onclick="window.handleAdminApprove('${h.id}')" class="cursor-pointer w-8 h-8 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100 flex items-center justify-center transition-colors shadow-sm" title="Approve">
                         <span class="material-symbols-outlined text-sm" data-icon="check">check</span>
                     </button>
                     <button onclick="window.handleAdminReject('${h.id}')" class="cursor-pointer w-8 h-8 rounded bg-red-50 text-red-600 hover:bg-red-100 flex items-center justify-center transition-colors shadow-sm" title="Reject">
                         <span class="material-symbols-outlined text-sm" data-icon="close">close</span>
                     </button>
                 </div>`;
             } else if (h.isVerified) {
                 actions = h.isActive === false
                     ? `<div class="text-right">
                         <button onclick="window.handleAdminReactivateHospital('${h.id}')" class="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors shadow-sm text-[10px] font-bold">
                             <span class="material-symbols-outlined text-[12px]" data-icon="power_settings_new">power_settings_new</span> Reactivate
                         </button>
                        </div>`
                     : `<div class="text-right">
                         <button onclick="window.handleAdminDeactivateHospital('${h.id}')" class="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-red-50 text-red-600 hover:bg-red-100 transition-colors shadow-sm text-[10px] font-bold">
                             <span class="material-symbols-outlined text-[12px]" data-icon="toggle_off">toggle_off</span> Deactivate
                         </button>
                        </div>`;
             } else {
                 actions = `<div class="text-right text-xs text-slate-400 font-medium">Processed</div>`;
             }

             return `
             <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4">
                    <div class="flex items-center gap-3">
                        <div class="hidden sm:flex w-9 h-9 rounded bg-slate-100 items-center justify-center text-slate-400 shrink-0">
                            <span class="material-symbols-outlined text-sm" data-icon="local_hospital">local_hospital</span>
                        </div>
                        <div class="min-w-0">
                            <p class="font-bold text-on-surface truncate">${esc(h.name)}</p>
                            <p class="text-[10px] text-slate-500 font-mono">ID: ${h.id.slice(0,8).toUpperCase()}</p>
                        </div>
                    </div>
                </td>
                <td class="p-4"><span class="text-xs font-semibold whitespace-nowrap">${esc(h.city) || 'Unspecified'}</span></td>
                <td class="p-4">
                    <button onclick="window.viewHospitalDetail('${h.id}')" class="cursor-pointer bg-slate-100 text-slate-600 px-2 py-1 rounded text-[10px] font-bold flex items-center gap-1 hover:bg-slate-200 transition-colors">
                        <span class="material-symbols-outlined text-[12px]" data-icon="description">description</span> License
                    </button>
                </td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 text-right">${actions}</td>
             </tr>
             `;
        }).join('');

        renderAdminPagination(document.getElementById('adminHospitalsPagination'), adminHospitalsPage, hospitalTotalPages, filtered.length, 'hospitals');
    } catch (err) {
        console.error(err);
        tableBody.innerHTML = '<tr><td colspan="5" class="text-center text-error py-4">Failed to load directory.</td></tr>';
    }
};

// Global exposure for onClick handlers. Name is optional — rows call with just the id (safe
// against names containing quotes), so the handler fetches the institution to build the
// confirmation message and pass the real name downstream.
window.handleAdminApprove = async (id, name) => {
    if (!name) {
        try { const h = await fetchHospitalById(id); name = h?.name || ''; } catch { /* keep default */ }
    }
    if(confirm(`Approve ${name}?`)) {
        try {
            await verifyHospital(id, name, true);
        } catch (err) {
            console.error('Failed to approve hospital:', err);
            alert('Failed to approve hospital. Please try again.');
            return;
        }
        loadAdminDashboard();
        const activeTab = document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending';
        if (window.renderHospitalVerificationsTab) window.renderHospitalVerificationsTab(activeTab);
    }
};

// Donor KYC review queue — requested directly by the Security Lead (2026-08-02): donor
// accounts must be approved by a system_admin (never a hospital) before they get full
// dashboard access, and that approval must be based on evidence actually on file. The
// verifyDonor Cloud Function itself already enforces "both document and selfie present"
// server-side (functions/src/kyc.ts) — the disabled Approve button here is a UX nicety on
// top of that, not the real boundary.
async function renderPendingKycReviews() {
    const tableBody = document.getElementById('adminPendingKycReviews');
    if (!tableBody) return;
    try {
        const rows = await fetchPendingKycReviews();
        const badgeEl = document.getElementById('kycPendingCountBadge');
        if (badgeEl) badgeEl.textContent = rows.length;
        if (rows.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500 font-medium">No pending donor KYC submissions.</td></tr>';
            return;
        }
        tableBody.innerHTML = rows.map(row => {
            const hasDoc = Boolean(row.kycDocRef);
            const hasDocBack = Boolean(row.kycDocBackRef);
            const hasSelfie = Boolean(row.livenessSelfieRef);
            const canApprove = hasDoc && hasSelfie;
            const submitted = row.submittedAt?.toDate ? row.submittedAt.toDate() : (row.submittedAt ? new Date(row.submittedAt) : null);
            return `
            <tr class="hover:bg-slate-50/50 transition-colors">
                <td class="px-6 py-5">
                    <div class="font-bold text-slate-800">${esc(row.donorName || row.donorEmail || 'Donor')}</div>
                    <div class="text-[11px] text-slate-400">${esc(row.donorEmail || '')}</div>
                </td>
                <td class="px-6 py-5 text-sm text-slate-600">${esc(row.donorBloodType) || '—'}</td>
                <td class="px-6 py-5 text-sm text-slate-600">${submitted ? submitted.toLocaleDateString() : '—'}</td>
                <td class="px-6 py-5">
                    <div class="flex items-center gap-2">
                        <button data-view-kyc-doc="${esc(row.kycDocRef || '')}" ${hasDoc ? '' : 'disabled'} class="inline-flex items-center gap-1 text-xs font-bold ${hasDoc ? 'text-tertiary hover:bg-tertiary-container/10 cursor-pointer' : 'text-slate-300 cursor-not-allowed'} px-2 py-1 rounded transition-colors">
                            <span class="material-symbols-outlined text-sm">description</span> Front
                        </button>
                        ${row.docType === 'national_id' ? `
                        <button data-view-kyc-doc="${esc(row.kycDocBackRef || '')}" ${hasDocBack ? '' : 'disabled'} class="inline-flex items-center gap-1 text-xs font-bold ${hasDocBack ? 'text-tertiary hover:bg-tertiary-container/10 cursor-pointer' : 'text-slate-300 cursor-not-allowed'} px-2 py-1 rounded transition-colors">
                            <span class="material-symbols-outlined text-sm">description</span> Back
                        </button>` : ''}
                        <button data-view-kyc-doc="${esc(row.livenessSelfieRef || '')}" ${hasSelfie ? '' : 'disabled'} class="inline-flex items-center gap-1 text-xs font-bold ${hasSelfie ? 'text-tertiary hover:bg-tertiary-container/10 cursor-pointer' : 'text-slate-300 cursor-not-allowed'} px-2 py-1 rounded transition-colors">
                            <span class="material-symbols-outlined text-sm">face</span> Selfie
                        </button>
                    </div>
                    ${canApprove ? '' : '<div class="text-[10px] text-amber-600 font-semibold mt-1">Awaiting both document + selfie</div>'}
                </td>
                <td class="px-6 py-5 text-right space-x-2">
                    <button onclick="window.handleAdminRejectDonorKyc('${row.donorUid}')" class="text-xs font-bold px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors">Reject</button>
                    <button onclick="window.handleAdminApproveDonorKyc('${row.donorUid}')" ${canApprove ? '' : 'disabled title="Both the identity document and liveness selfie must be submitted first"'} class="text-xs font-bold px-4 py-2 rounded-lg ${canApprove ? 'bg-primary-container text-on-primary-container hover:shadow-md transition-all' : 'bg-slate-100 text-slate-300 cursor-not-allowed'}">Approve</button>
                </td>
            </tr>`;
        }).join('');

        tableBody.querySelectorAll('[data-view-kyc-doc]').forEach(btn => {
            const path = btn.dataset.viewKycDoc;
            if (!path) return;
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    const url = await fetchKycDocumentUrl(path);
                    window.open(url, '_blank', 'noopener');
                } catch (err) {
                    console.error('Failed to load KYC document:', err);
                    alert('Failed to load document. Please try again.');
                } finally {
                    btn.disabled = false;
                }
            });
        });
    } catch (err) {
        console.error('Failed to load pending KYC reviews:', err);
        tableBody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-red-500 font-medium">Failed to load pending KYC reviews.</td></tr>';
    }
}

window.handleAdminApproveDonorKyc = async (targetUid) => {
    if (!confirm('Approve this donor? They will get full dashboard access immediately.')) return;
    try {
        await httpsCallable(getFunctions(), 'verifyDonor')({ targetUid });
    } catch (err) {
        console.error('Failed to approve donor KYC:', err);
        alert(err?.message || 'Failed to approve donor. Please try again.');
        return;
    }
    renderPendingKycReviews();
};

window.handleAdminRejectDonorKyc = async (targetUid) => {
    const reason = prompt('Reason for rejection (shown to the donor):', '');
    if (reason === null) return; // cancelled
    try {
        await httpsCallable(getFunctions(), 'rejectDonorKyc')({ targetUid, reason: reason || undefined });
    } catch (err) {
        console.error('Failed to reject donor KYC:', err);
        alert(err?.message || 'Failed to reject donor. Please try again.');
        return;
    }
    renderPendingKycReviews();
};

window.handleAdminReject = async (id, name) => {
    if (!name) {
        try { const h = await fetchHospitalById(id); name = h?.name || ''; } catch { /* keep default */ }
    }
    if(confirm(`Reject ${name}?`)) {
        try {
            await rejectHospital(id, name);
        } catch (err) {
            console.error('Failed to reject hospital:', err);
            alert('Failed to reject hospital. Please try again.');
            return;
        }
        loadAdminDashboard();
        const activeTab = document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending';
        if (window.renderHospitalVerificationsTab) window.renderHospitalVerificationsTab(activeTab);
    }
};

// Deactivation kicks the hospital's entire staff out (revokes their refresh
// tokens and flips the suspended kill-switch claim server-side) — not just a
// cosmetic label. The hospital's history stays intact for audit/record-keeping.
window.handleAdminDeactivateHospital = async (id, name) => {
    if (!name) {
        try { const h = await fetchHospitalById(id); name = h?.name || ''; } catch { /* keep default */ }
    }
    if(confirm(`WARNING: Deactivate ${name}?\n\nAll of the hospital's staff will be signed out and locked out immediately. The hospital will no longer appear in the verified network. This can be undone with Reactivate — nothing is deleted.`)) {
        try {
            await deactivateHospital(id, name);
        } catch (err) {
            console.error('Failed to deactivate hospital:', err);
            alert('Failed to deactivate hospital. Please try again.');
            return;
        }
        loadAdminDashboard();
        const activeTab = document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending';
        if (window.renderHospitalVerificationsTab) window.renderHospitalVerificationsTab(activeTab);
    }
};

window.handleAdminReactivateHospital = async (id, name) => {
    if (!name) {
        try { const h = await fetchHospitalById(id); name = h?.name || ''; } catch { /* keep default */ }
    }
    if(confirm(`Reactivate ${name}?\n\nStaff locked out by the deactivation will regain access. Staff suspended individually (for personal reasons) stay suspended.`)) {
        try {
            await reactivateHospital(id, name);
        } catch (err) {
            console.error('Failed to reactivate hospital:', err);
            alert('Failed to reactivate hospital. Please try again.');
            return;
        }
        loadAdminDashboard();
        const activeTab = document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending';
        if (window.renderHospitalVerificationsTab) window.renderHospitalVerificationsTab(activeTab);
    }
};

function initHospitalDetailModal() {
    const modal = document.getElementById('hospitalDetailModal');
    const backdrop = document.getElementById('hospitalDetailBackdrop');
    const closeBtn = document.getElementById('btnCloseHospitalDetail');
    const contentEl = document.getElementById('hospitalDetailContent');
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    };
    
    if (backdrop) {
        backdrop.addEventListener('click', closeModal);
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }

    if (modal && !modal.dataset.overlayCloseBound) {
        modal.dataset.overlayCloseBound = '1';
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }
}

window.viewHospitalDetail = async (hospitalId) => {
    const modal = document.getElementById('hospitalDetailModal');
    const contentEl = document.getElementById('hospitalDetailContent');
    
    if (!modal || !contentEl) return;
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    
    contentEl.innerHTML = `
        <div class="flex items-center justify-center py-12">
            <div class="flex items-center gap-3 text-slate-500">
                <span class="material-symbols-outlined animate-spin">sync</span>
                <span>Loading details...</span>
            </div>
        </div>
    `;
    
    try {
        const hospital = await fetchHospitalById(hospitalId);
        
        if (!hospital) {
            contentEl.innerHTML = '<p class="text-center text-red-500 py-8">Hospital not found.</p>';
            return;
        }
        
        const statusBadge = hospital.isVerified 
            ? '<span class="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">Verified</span>'
            : hospital.rejected
            ? '<span class="px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold">Rejected</span>'
            : '<span class="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold">Pending</span>';
        
        const createdDate = hospital.createdAt ? new Date(hospital.createdAt).toLocaleDateString() : 'N/A';
        
        contentEl.innerHTML = `
            <div class="space-y-6">
                <div class="flex items-start gap-4">
                    <div class="w-16 h-16 rounded-xl bg-slate-100 flex items-center justify-center text-primary shrink-0">
                        <span class="material-symbols-outlined text-3xl">local_hospital</span>
                    </div>
                    <div class="flex-1">
                        <h3 class="text-xl font-black text-on-surface">${esc(hospital.name) || 'Unnamed Hospital'}</h3>
                        <p class="text-sm text-slate-500">${esc(hospital.city) || 'No city specified'}, Cameroon</p>
                        <div class="mt-2">${statusBadge}</div>
                    </div>
                </div>
                
                <div class="grid grid-cols-2 gap-4">
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Email</p>
                        <p class="text-sm font-medium text-on-surface">${esc(hospital.email) || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Phone</p>
                        <p class="text-sm font-medium text-on-surface">${esc(hospital.phone) || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Registration Date</p>
                        <p class="text-sm font-medium text-on-surface">${createdDate}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Hospital ID</p>
                        <p class="text-sm font-medium text-on-surface font-mono">${hospital.id.slice(0,12).toUpperCase()}</p>
                    </div>
                </div>
                
                <div class="bg-surface-container-low p-4 rounded-lg">
                    <div class="flex items-center justify-between mb-3">
                        <p class="text-sm font-bold text-on-surface">License Document</p>
                        <span class="material-symbols-outlined text-slate-400">description</span>
                    </div>
                    ${hospital.licenseUrl 
                        ? `<a href="${safeUrl(hospital.licenseUrl)}" target="_blank" rel="noopener" class="inline-flex items-center gap-2 text-primary text-sm font-bold hover:underline">
                            <span class="material-symbols-outlined text-sm">${(hospital.licenseFileName || '').match(/\.(png|jpe?g|webp|gif)$/i) ? 'image' : 'description'}</span>
                            ${esc(hospital.licenseFileName || 'View Document')}
                            <span class="material-symbols-outlined text-sm">open_in_new</span>
                           </a>`
                        : `<div class="flex items-center gap-2 text-slate-500 text-sm">
                            <span class="material-symbols-outlined text-sm">warning</span>
                            No license document uploaded
                           </div>`
                    }
                </div>
                
                ${!hospital.isVerified && !hospital.rejected ? `
                <div class="flex gap-3 pt-4 border-t border-slate-200">
                    <button onclick="window.handleAdminApprove('${hospital.id}'); document.getElementById('hospitalDetailModal').classList.add('hidden');" class="flex-1 bg-emerald-500 text-white py-3 px-4 rounded-lg font-bold text-sm hover:bg-emerald-600 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">check</span> Approve
                    </button>
                    <button onclick="window.handleAdminReject('${hospital.id}'); document.getElementById('hospitalDetailModal').classList.add('hidden');" class="flex-1 bg-red-500 text-white py-3 px-4 rounded-lg font-bold text-sm hover:bg-red-600 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">close</span> Reject
                    </button>
                </div>
                ` : ''}
            </div>
        `;
    } catch (err) {
        console.error('Failed to load hospital detail:', err);
        contentEl.innerHTML = '<p class="text-center text-red-500 py-8">Failed to load hospital details.</p>';
    }
};

window.renderUserManagementTab = async (tab) => {
    const tableBody = document.getElementById('adminUsersTableBody');
    if (!tableBody) return;
    
    tableBody.innerHTML = '<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500">Loading donor directory...</td></tr>';
    
    try {
        const allDonors = await fetchAllDonors();

        // Populate the stats cards (Total / Active / Suspended)
        const statTotal = document.getElementById('statTotalDonorsAdmin');
        const statActive = document.getElementById('statActiveDonors');
        const statSuspended = document.getElementById('statSuspendedDonors');
        if (statTotal) statTotal.textContent = allDonors.length;
        if (statActive) statActive.textContent = allDonors.filter(u => u.isSuspended !== true).length;
        if (statSuspended) statSuspended.textContent = allDonors.filter(u => u.isSuspended === true).length;

        if (tab !== adminUsersTab) { adminUsersTab = tab; adminUsersPage = 1; }

        let filtered = [];
        if (tab === 'active') {
            filtered = allDonors.filter(u => u.isSuspended !== true);
        } else if (tab === 'suspended') {
            filtered = allDonors.filter(u => u.isSuspended === true);
        } else {
            filtered = allDonors;
        }

        if (adminUsersQuery) {
            const q = adminUsersQuery.toLowerCase();
            filtered = filtered.filter(u =>
                (u.name || '').toLowerCase().includes(q) ||
                (u.city || '').toLowerCase().includes(q) ||
                (u.bloodType || '').toLowerCase().includes(q) ||
                u.id.toLowerCase().includes(q)
            );
        }

        const userTotalPages = Math.max(1, Math.ceil(filtered.length / adminUsersPerPage));
        adminUsersPage = Math.min(adminUsersPage, userTotalPages);
        const userPageItems = filtered.slice((adminUsersPage - 1) * adminUsersPerPage, adminUsersPage * adminUsersPerPage);

        if (userPageItems.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500 font-medium tracking-wide">No ${tab} donors found.</td></tr>`;
            renderAdminPagination(document.getElementById('adminUsersPagination'), adminUsersPage, userTotalPages, filtered.length, 'users');
            return;
        }

        tableBody.innerHTML = userPageItems.map(u => {
             const isSuspended = u.isSuspended === true;
             const isAvailable = u.isAvailable !== false;

             const statusBadge = isSuspended ? '<span class="px-2 py-1 bg-red-100 text-red-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Suspended</span>' :
                                 '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Active</span>';
             
             const availBadge = isSuspended ? '<span class="text-xs text-slate-400 font-semibold italic">Locked</span>' :
                                (isAvailable ? '<span class="text-xs text-emerald-600 font-semibold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Ready</span>' : '<span class="text-xs text-amber-600 font-semibold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>Busy</span>');
             
             const registeredOn = u.registeredAt ? new Date(u.registeredAt).toLocaleDateString() : 'Legacy';
             const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleDateString() : 'Unknown';

let actions = '';
              if(!isSuspended) {
                  actions = `<div class="flex items-center gap-2 justify-end">
                      <button onclick="window.viewDonorDetail('${u.id}')" class="cursor-pointer bg-slate-100 text-slate-600 px-2 py-1.5 rounded text-xs font-bold hover:bg-slate-200 transition-colors shadow-sm" title="View Profile">
                          <span class="material-symbols-outlined text-sm">visibility</span>
                      </button>
                      <button onclick="window.handleAdminSuspendUser('${u.id}')" class="cursor-pointer bg-red-50 text-red-600 px-3 py-1.5 rounded text-xs font-bold hover:bg-red-100 transition-colors shadow-sm">Suspend</button>
                  </div>`;
              } else {
                  actions = `<div class="flex items-center gap-2 justify-end">
                      <button onclick="window.viewDonorDetail('${u.id}')" class="cursor-pointer bg-slate-100 text-slate-600 px-2 py-1.5 rounded text-xs font-bold hover:bg-slate-200 transition-colors shadow-sm" title="View Profile">
                          <span class="material-symbols-outlined text-sm">visibility</span>
                      </button>
                      <button onclick="window.handleAdminReactivateUser('${u.id}')" class="cursor-pointer bg-emerald-50 text-emerald-600 px-3 py-1.5 rounded text-xs font-bold hover:bg-emerald-100 transition-colors shadow-sm">Reactivate</button>
                  </div>`;
              }

             return `
             <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-full bg-slate-200 border-2 border-white shadow-sm overflow-hidden shrink-0">
                            <img src="https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(u.name)}" alt="${esc(u.name)}" class="w-full h-full object-cover"/>
                        </div>
                        <div class="min-w-0">
                            <p class="font-bold text-on-surface truncate">${esc(u.name)}</p>
                            <p class="text-[10px] text-slate-500 font-mono">ID: ${u.id.slice(0,8).toUpperCase()}</p>
                        </div>
                    </div>
                </td>
                <td class="p-4"><span class="font-black text-primary bg-primary/5 px-2 py-1 rounded text-xs">${esc(u.bloodType) || 'N/A'}</span></td>
                <td class="p-4"><span class="text-xs font-semibold whitespace-nowrap">${esc(u.city) || 'Unspecified'}</span></td>
                <td class="p-4">
                    <p class="text-[10px] text-slate-500 font-medium">Joined: ${registeredOn}</p>
                    <div class="mt-0.5">${availBadge}</div>
                </td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 flex items-center justify-end h-full">
                    ${actions}
                </td>
             </tr>
             `;
        }).join('');

        renderAdminPagination(document.getElementById('adminUsersPagination'), adminUsersPage, userTotalPages, filtered.length, 'users');
    } catch (err) {
        console.error(err);
        tableBody.innerHTML = '<tr><td colspan="6" class="text-center text-error py-4">Failed to load directory.</td></tr>';
    }
};

window.handleAdminSuspendUser = async (id, name) => {
    if (!name) {
        try { const d = await fetchDonorById(id); name = d?.name || ''; } catch { /* keep default */ }
    }
    if(confirm(`WARNING: Are you sure you want to suspend ${name}?\n\nThey will be immediately removed from the matchmaking pool.`)) {
        try {
            await suspendDonor(id, name);
        } catch (err) {
            console.error('Failed to suspend donor:', err);
            alert('Failed to suspend donor. Please try again.');
            return;
        }
        loadAdminDashboard();
        const activeTab = document.querySelector('#userTabs button.text-primary')?.dataset.tab || 'all';
        if (window.renderUserManagementTab) window.renderUserManagementTab(activeTab);
    }
};

window.handleAdminReactivateUser = async (id, name) => {
    if (!name) {
        try { const d = await fetchDonorById(id); name = d?.name || ''; } catch { /* keep default */ }
    }
    if(confirm(`Reactivate ${name}?\n\nThey will become eligible for blood requests again.`)) {
        try {
            await reactivateDonor(id, name);
        } catch (err) {
            console.error('Failed to reactivate donor:', err);
            alert('Failed to reactivate donor. Please try again.');
            return;
        }
        loadAdminDashboard();
        const activeTab = document.querySelector('#userTabs button.text-primary')?.dataset.tab || 'all';
        if (window.renderUserManagementTab) window.renderUserManagementTab(activeTab);
    }
};

function initDonorDetailModal() {
    const modal = document.getElementById('donorDetailModal');
    const backdrop = document.getElementById('donorDetailBackdrop');
    const closeBtn = document.getElementById('btnCloseDonorDetail');
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    };
    
    if (backdrop) backdrop.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    if (modal && !modal.dataset.overlayCloseBound) {
        modal.dataset.overlayCloseBound = '1';
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }
}

window.viewDonorDetail = async (donorId) => {
    const modal = document.getElementById('donorDetailModal');
    const contentEl = document.getElementById('donorDetailContent');
    
    if (!modal || !contentEl) return;
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    
    contentEl.innerHTML = `
        <div class="flex items-center justify-center py-12">
            <div class="flex items-center gap-3 text-slate-500">
                <span class="material-symbols-outlined animate-spin">sync</span>
                <span>Loading profile...</span>
            </div>
        </div>
    `;
    
    try {
        const donor = await fetchDonorById(donorId);
        
        if (!donor) {
            contentEl.innerHTML = '<p class="text-center text-red-500 py-8">Donor not found.</p>';
            return;
        }
        
        const isSuspended = donor.isSuspended === true;
        const statusBadge = isSuspended 
            ? '<span class="px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold">Suspended</span>'
            : '<span class="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">Active</span>';
        
        const createdDate = donor.createdAt ? new Date(donor.createdAt).toLocaleDateString() : 'N/A';
        
        // Eligibility / identity info
        const cniLast4 = donor.cniLast4 || null;
        const lastDonationDate = donor.lastDonationDate || donor.lastDonatedAt || null;
        let eligibleHtml = '';
        if (lastDonationDate) {
            const daysAgo = Math.floor((new Date().getTime() - new Date(lastDonationDate).getTime()) / (1000 * 60 * 60 * 24));
            const eligible = daysAgo >= 56;
            const badgeColor = eligible ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-red-100 text-red-800 border-red-200';
            eligibleHtml = `<span class="inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-wider ${badgeColor} border">${eligible ? '✓ ELIGIBLE' : '✗ NOT ELIGIBLE'}</span>`;
        } else {
            eligibleHtml = '<span class="inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200">✓ ELIGIBLE</span>';
        }
        const lastDonationDisplay = lastDonationDate ? new Date(lastDonationDate).toLocaleDateString() : 'No prior donation';
        const emergencyContact = donor.emergencyContactName || donor.emergencyContactPhone
            ? `${donor.emergencyContactName || '—'} ${donor.emergencyContactPhone ? '· ' + donor.emergencyContactPhone : ''}`
            : 'Not set';
        
        const donations = donor.donations || [];
        const completedDonations = donations.filter(d => d.status === 'completed' || d.status === 'approved');
        
        let donationsHtml = '';
        if (donations.length === 0) {
            donationsHtml = '<p class="text-sm text-slate-500 text-center py-4">No donation requests yet.</p>';
        } else {
            donationsHtml = donations.slice(0, 5).map(d => {
                const statusColors = {
                    'pending': 'bg-amber-100 text-amber-700',
                    'approved': 'bg-emerald-100 text-emerald-700',
                    'completed': 'bg-blue-100 text-blue-700',
                    'rejected': 'bg-red-100 text-red-700',
                    'cancelled': 'bg-slate-100 text-slate-700'
                };
                const date = d.preferredDate ? new Date(d.preferredDate).toLocaleDateString() : 'N/A';
                return `
                <div class="flex items-center justify-between p-3 bg-surface-container-low rounded-lg">
                    <div class="flex items-center gap-3">
                        <span class="font-black text-primary bg-primary/5 px-2 py-1 rounded text-xs">${esc(d.bloodType)}</span>
                        <div>
                            <p class="text-sm font-medium text-on-surface">${Number(d.units) || 1} Unit${(Number(d.units) || 1) > 1 ? 's' : ''}</p>
                            <p class="text-[10px] text-slate-500">${esc(d.preferredLocation) || 'No location'}</p>
                        </div>
                    </div>
                    <div class="text-right">
                        <span class="px-2 py-1 ${statusColors[d.status] || 'bg-slate-100 text-slate-700'} rounded text-[10px] font-bold capitalize">${esc(d.status)}</span>
                        <p class="text-[10px] text-slate-400 mt-1">${date}</p>
                    </div>
                </div>
                `;
            }).join('');
            
            if (donations.length > 5) {
                donationsHtml += `<p class="text-center text-xs text-slate-500 mt-3">+ ${donations.length - 5} more requests</p>`;
            }
        }
        
        contentEl.innerHTML = `
            <div class="space-y-6">
                <div class="flex items-start gap-4">
                    <div class="w-16 h-16 rounded-full bg-slate-200 border-2 border-white shadow-sm overflow-hidden shrink-0">
                        <img src="https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(donor.name || '')}" alt="${esc(donor.name)}" class="w-full h-full object-cover"/>
                    </div>
                    <div class="flex-1">
                        <h3 class="text-xl font-black text-on-surface">${esc(donor.name) || 'Unknown Donor'}</h3>
                        <p class="text-sm text-slate-500">${esc(donor.city) || 'No city'}, Cameroon</p>
                        <div class="mt-2 flex items-center gap-2">${statusBadge}</div>
                    </div>
                </div>
                
                <div class="bg-slate-50/80 rounded-xl p-3.5 border border-slate-100">
                    <p class="text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
                        <span class="material-symbols-outlined text-xs">badge</span>
                        Identity Verification
                    </p>
                    <div class="grid grid-cols-2 gap-3 text-xs">
                        <div>
                            <span class="text-slate-500">CNI (last 4)</span>
                            <p class="font-extrabold text-on-surface tracking-widest font-mono">${cniLast4 ? '••••••' + esc(cniLast4) : '<span class="text-slate-400 font-normal">Not on file</span>'}</p>
                        </div>
                        <div>
                            <span class="text-slate-500">Last Donation</span>
                            <p class="font-bold text-on-surface">${esc(lastDonationDisplay)}</p>
                        </div>
                    </div>
                    <div class="mt-2">${eligibleHtml}</div>
                </div>

                <div class="grid grid-cols-2 gap-4">
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Blood Type</p>
                        <p class="text-2xl font-black text-primary">${esc(donor.bloodType) || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Donations</p>
                        <p class="text-2xl font-black text-on-surface">${completedDonations.length}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Phone</p>
                        <p class="text-sm font-bold text-on-surface">${esc(donor.phone) || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Emergency Contact</p>
                        <p class="text-sm font-medium text-on-surface">${esc(emergencyContact)}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Email</p>
                        <p class="text-sm font-medium text-on-surface truncate">${esc(donor.email) || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Member Since</p>
                        <p class="text-sm font-medium text-on-surface">${createdDate}</p>
                    </div>
                </div>
                
                <div>
                    <h4 class="text-sm font-bold text-on-surface mb-3">Recent Donations</h4>
                    <div class="space-y-2 max-h-64 overflow-y-auto">
                        ${donationsHtml}
                    </div>
                </div>
                
                ${!isSuspended ? `
                <div class="flex gap-3 pt-4 border-t border-slate-200">
                    <button onclick="window.handleAdminSuspendUser('${donor.id}'); document.getElementById('donorDetailModal').classList.add('hidden');" class="flex-1 bg-red-500 text-white py-3 px-4 rounded-lg font-bold text-sm hover:bg-red-600 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">block</span> Suspend
                    </button>
                </div>
                ` : `
                <div class="flex gap-3 pt-4 border-t border-slate-200">
                    <button onclick="window.handleAdminReactivateUser('${donor.id}'); document.getElementById('donorDetailModal').classList.add('hidden');" class="flex-1 bg-emerald-500 text-white py-3 px-4 rounded-lg font-bold text-sm hover:bg-emerald-600 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">check_circle</span> Reactivate
                    </button>
                </div>
                `}
            </div>
        `;
    } catch (err) {
        console.error('Failed to load donor detail:', err);
        contentEl.innerHTML = '<p class="text-center text-red-500 py-8">Failed to load donor profile.</p>';
    }
};

// ============================================
// ANALYTICS DASHBOARD
// ============================================

async function loadAnalyticsDashboard() {
    const totalStockEl = document.getElementById('analyticsTotalStock');
    const totalDonorsEl = document.getElementById('analyticsTotalDonors');
    const totalHospitalsEl = document.getElementById('analyticsTotalHospitals');
    const thisMonthEl = document.getElementById('analyticsThisMonth');
    const pendingDonationsEl = document.getElementById('analyticsPendingDonations');
    const unitsPendingTestEl = document.getElementById('analyticsUnitsPendingTest');
    const unitsRejectedEl = document.getElementById('analyticsUnitsRejected');
    const avgResolutionEl = document.getElementById('analyticsAvgResolution');
    const donorRetentionEl = document.getElementById('analyticsDonorRetention');

    const bloodStockChartEl = document.getElementById('analyticsStockChart');
    const bloodTypeDemandChartEl = document.getElementById('analyticsDemandChart');
    const regionalShortageChartEl = document.getElementById('analyticsShortageChart');
    const donorTrendChartEl = document.getElementById('analyticsDonorChart');
    const responseTimeChartEl = document.getElementById('analyticsResponseChart');
    const acceptanceChartEl = document.getElementById('analyticsAcceptanceChart');
    const hospitalPerfChartEl = document.getElementById('analyticsHospitalPerfChart');
    const geoChartEl = document.getElementById('analyticsGeoChart');

    try {
        const [inventory, allDonors, allHospitals, allDonations, allRequests] = await Promise.all([
            fetchGlobalInventory(),
            fetchAllDonors(),
            fetchAllHospitals(),
            fetchAllDonationRequests(),
            fetchAllSystemRequests()
        ]);

        const totalStock = Object.values(inventory).reduce((sum, inv) => sum + (inv.unitsAvailable || 0), 0);
        if (totalStockEl) totalStockEl.textContent = totalStock;
        if (totalDonorsEl) totalDonorsEl.textContent = allDonors.length;
        if (totalHospitalsEl) totalHospitalsEl.textContent = allHospitals.length;

        const thisMonth = allDonations.filter(d => {
            const created = new Date(d.createdAt);
            const now = new Date();
            return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
        }).length;
        if (thisMonthEl) thisMonthEl.textContent = thisMonth;

        if (pendingDonationsEl) pendingDonationsEl.textContent = allDonations.filter(d => d.status === 'pending').length;

        // National blood-safety pipeline: how much of the country's supply is cleared vs.
        // still waiting on lab results vs. rejected. Admin-only rollup — hospitals only ever
        // see their own numbers on their own inventory tab.
        const inventoryEntries = Object.values(inventory);
        if (unitsPendingTestEl) unitsPendingTestEl.textContent = inventoryEntries.reduce((sum, inv) => sum + (inv.unitsPendingTest || 0), 0);
        if (unitsRejectedEl) unitsRejectedEl.textContent = inventoryEntries.reduce((sum, inv) => sum + (inv.unitsRejected || 0), 0);

        // Avg. Resolution: how long a request sits open nationally, request-creation to fulfillment.
        if (avgResolutionEl) {
            const resolvedRequests = allRequests.filter(r => r.resolvedAt && r.requestedAt);
            if (resolvedRequests.length > 0) {
                const totalHours = resolvedRequests.reduce((sum, r) => sum + (new Date(r.resolvedAt) - new Date(r.requestedAt)) / (1000 * 60 * 60), 0);
                avgResolutionEl.textContent = Math.round((totalHours / resolvedRequests.length) * 10) / 10 + 'h';
            } else {
                avgResolutionEl.textContent = '--h';
            }
        }

        // Donor Retention: share of donors who have come back for more than one completed donation.
        if (donorRetentionEl) {
            const completedByDonor = {};
            allDonations.filter(d => d.status === 'completed' && d.donorId).forEach(d => {
                completedByDonor[d.donorId] = (completedByDonor[d.donorId] || 0) + 1;
            });
            const distinctDonors = Object.keys(completedByDonor).length;
            const returningDonors = Object.values(completedByDonor).filter(count => count > 1).length;
            donorRetentionEl.textContent = distinctDonors > 0 ? Math.round((returningDonors / distinctDonors) * 100) + '%' : '--%';
        }

        const acceptanceRateEl = document.getElementById('analyticsAcceptanceRate');
        if (acceptanceRateEl) {
            const accepted = allDonations.filter(d => d.status === 'approved' || d.status === 'completed').length;
            const rejected = allDonations.filter(d => d.status === 'rejected').length;
            const total = accepted + rejected;
            acceptanceRateEl.textContent = total > 0 ? Math.round((accepted / total) * 100) + '%' : '--%';
        }

        const citiesCoveredEl = document.getElementById('analyticsCitiesCovered');
        if (citiesCoveredEl) {
            const covered = new Set();
            allDonors.forEach(d => { if (d.city) covered.add(d.city); });
            allHospitals.forEach(h => { if (h.city) covered.add(h.city); });
            citiesCoveredEl.textContent = covered.size;
        }

        if (bloodStockChartEl) {
            const existing = Chart.getChart(bloodStockChartEl);
            if (existing) existing.destroy();
            const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
            const stockData = bloodTypes.map(type => inventoryEntries.filter(inv => inv.bloodType === type).reduce((sum, inv) => sum + (inv.unitsAvailable || 0), 0));
            new Chart(bloodStockChartEl, {
                type: 'bar', data: {
                    labels: bloodTypes, datasets: [{
                        label: 'Units', data: stockData,
                        backgroundColor: ['#EF4444', '#F97316', '#EAB308', '#84CC16', '#22C55E', '#14B8A6', '#8B5CF6', '#A78BFA'],
                        borderRadius: 6
                    }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

        if (bloodTypeDemandChartEl) {
            const existing = Chart.getChart(bloodTypeDemandChartEl);
            if (existing) existing.destroy();
            const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
            const demandData = bloodTypes.map(type => allRequests.filter(r => r.bloodType === type).length);
            new Chart(bloodTypeDemandChartEl, {
                type: 'bar', data: {
                    labels: bloodTypes, datasets: [{
                        label: 'Requests', data: demandData, backgroundColor: '#005f7b', borderRadius: 6
                    }]
                }, options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { x: { beginAtZero: true, grid: { color: '#e5e7eb' } }, y: { grid: { display: false } } }
                }
            });
        }

        if (regionalShortageChartEl) {
            const existing = Chart.getChart(regionalShortageChartEl);
            if (existing) existing.destroy();
            const hospitalCities = {};
            allHospitals.forEach(h => { if (h.name) hospitalCities[h.name] = h.city || 'Unknown'; });
            const cityShortages = {};
            Object.values(inventory).forEach(inv => {
                if (inv.hospital) {
                    const city = hospitalCities[inv.hospital] || 'Unknown';
                    if (!cityShortages[city]) cityShortages[city] = 0;
                    if ((inv.unitsAvailable || 0) < (inv.minimumThreshold || 5)) cityShortages[city]++;
                }
            });
            const sorted = Object.entries(cityShortages).sort((a, b) => b[1] - a[1]).slice(0, 6);
            new Chart(regionalShortageChartEl, {
                type: 'bar', data: {
                    labels: sorted.map(s => s[0]), datasets: [{
                        label: 'Shortages', data: sorted.map(s => s[1]),
                        backgroundColor: ['#DC2626', '#EA580C', '#D97706', '#CA8A04', '#A16207', '#92400E'],
                        borderRadius: 6
                    }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

        if (donorTrendChartEl) {
            const existing = Chart.getChart(donorTrendChartEl);
            if (existing) existing.destroy();
            const months = [];
            const uniqueDonorsPerMonth = [];
            const now = new Date();
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                months.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric' }));
                const donors = new Set(allDonations.filter(don => {
                    const created = new Date(don.createdAt);
                    return created.getMonth() === d.getMonth() && created.getFullYear() === d.getFullYear();
                }).map(don => don.donorId));
                uniqueDonorsPerMonth.push(donors.size);
            }
            new Chart(donorTrendChartEl, {
                type: 'line', data: {
                    labels: months, datasets: [{
                        label: 'Donors', data: uniqueDonorsPerMonth,
                        borderColor: '#22C55E', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.4
                    }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

        if (responseTimeChartEl) {
            const existing = Chart.getChart(responseTimeChartEl);
            if (existing) existing.destroy();
            const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
            const filtered = bloodTypes.map(type => {
                const resolved = allRequests.filter(r => r.bloodType === type && r.resolvedAt && r.requestedAt);
                if (resolved.length === 0) return null;
                const totalHours = resolved.reduce((sum, r) => sum + (new Date(r.resolvedAt) - new Date(r.requestedAt)) / (1000 * 60 * 60), 0);
                return { type, time: Math.round((totalHours / resolved.length) * 10) / 10 };
            }).filter(Boolean);
            new Chart(responseTimeChartEl, {
                type: 'bar', data: {
                    labels: filtered.map(t => t.type), datasets: [{
                        label: 'Avg Hours', data: filtered.map(t => t.time), backgroundColor: '#3B82F6', borderRadius: 6
                    }]
                }, options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { x: { beginAtZero: true, grid: { color: '#e5e7eb' } }, y: { grid: { display: false } } }
                }
            });
        }

        if (acceptanceChartEl) {
            const existing = Chart.getChart(acceptanceChartEl);
            if (existing) existing.destroy();
            // Cancelled donations aren't a screening outcome, so they're excluded from the rate.
            const approved = allDonations.filter(d => d.status === 'approved' || d.status === 'completed').length;
            const pending = allDonations.filter(d => d.status === 'pending').length;
            const rejected = allDonations.filter(d => d.status === 'rejected').length;
            new Chart(acceptanceChartEl, {
                type: 'doughnut', data: {
                    labels: ['Approved', 'Pending', 'Rejected'],
                    datasets: [{ data: [approved, pending, rejected], backgroundColor: ['#22C55E', '#EAB308', '#EF4444'], borderWidth: 0 }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }
                }
            });
        }

        if (hospitalPerfChartEl) {
            const existing = Chart.getChart(hospitalPerfChartEl);
            if (existing) existing.destroy();
            const completedByHospital = {};
            allRequests.filter(r => r.status === 'Resolved' && r.hospital).forEach(r => {
                completedByHospital[r.hospital] = (completedByHospital[r.hospital] || 0) + 1;
            });
            const topHospitals = Object.entries(completedByHospital).sort((a, b) => b[1] - a[1]).slice(0, 8);
            new Chart(hospitalPerfChartEl, {
                type: 'bar', data: {
                    labels: topHospitals.map(h => h[0]), datasets: [{
                        label: 'Completed Requests', data: topHospitals.map(h => h[1]), backgroundColor: '#8B5CF6', borderRadius: 6
                    }]
                }, options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { x: { beginAtZero: true, grid: { color: '#e5e7eb' } }, y: { grid: { display: false } } }
                }
            });
        }

        if (geoChartEl) {
            const existing = Chart.getChart(geoChartEl);
            if (existing) existing.destroy();
            const donorsByCity = {}, hospitalsByCity = {};
            allDonors.forEach(d => { const city = d.city || 'Unknown'; donorsByCity[city] = (donorsByCity[city] || 0) + 1; });
            allHospitals.forEach(h => { const city = h.city || 'Unknown'; hospitalsByCity[city] = (hospitalsByCity[city] || 0) + 1; });
            const cities = Object.keys({ ...donorsByCity, ...hospitalsByCity })
                .sort((a, b) => (donorsByCity[b] || 0) - (donorsByCity[a] || 0)).slice(0, 8);
            new Chart(geoChartEl, {
                type: 'bar', data: {
                    labels: cities, datasets: [
                        { label: 'Donors', data: cities.map(c => donorsByCity[c] || 0), backgroundColor: '#EF4444', borderRadius: 6 },
                        { label: 'Hospitals', data: cities.map(c => hospitalsByCity[c] || 0), backgroundColor: '#005f7b', borderRadius: 6 }
                    ]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

    } catch (e) {
        console.error('Failed to load analytics:', e);
    }
}

// ============================================
// SETTINGS DASHBOARD
// ============================================

async function loadSettingsDashboard() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    
    const displayNameInput = document.getElementById('adminDisplayName');
    const emailInput = document.getElementById('adminEmail');
    const saveBtn = document.getElementById('btnSaveSettings');
    
    if (displayNameInput) displayNameInput.value = currentUser.name || '';
    if (emailInput) emailInput.value = currentUser.email || '';
    
    try {
        const settings = await fetchSystemSettings();
        
        const criticalSms = document.getElementById('settingCriticalSms');
        const hospitalDigest = document.getElementById('settingHospitalDigest');
        const donorAlerts = document.getElementById('settingDonorAlerts');
        const autoMatch = document.getElementById('settingAutoMatch');
        const emergencyBroadcast = document.getElementById('settingEmergencyBroadcast');
        const registrationApproval = document.getElementById('settingRegistrationApproval');
        const lowStockThreshold = document.getElementById('settingLowStockThreshold');
        
        if (criticalSms) criticalSms.checked = settings.criticalSupplySms !== false;
        if (hospitalDigest) hospitalDigest.checked = settings.hospitalDigest === true;
        if (donorAlerts) donorAlerts.checked = settings.donorAlerts !== false;
        if (autoMatch) autoMatch.checked = settings.autoMatchDonors !== false;
        if (emergencyBroadcast) emergencyBroadcast.checked = settings.emergencyBroadcastEnabled !== false;
        if (registrationApproval) registrationApproval.checked = settings.registrationApprovalRequired === true;
        if (lowStockThreshold) lowStockThreshold.value = settings.lowStockThreshold || 5;
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const currentUser = getCurrentUser();
            const newDisplayName = document.getElementById('adminDisplayName')?.value;
            
            // Update user profile if name changed
            if (currentUser && newDisplayName && newDisplayName !== currentUser.name) {
                try {
                    await updateUserProfile(currentUser.uid, { name: newDisplayName });
                    // Update localStorage
                    const updatedUser = { ...currentUser, name: newDisplayName };
                    localStorage.setItem('vitalpulse_user', JSON.stringify(updatedUser));
                } catch (e) {
                    console.error('Failed to update profile:', e);
                }
            }
            
            const settings = {
                criticalSupplySms: document.getElementById('settingCriticalSms')?.checked || false,
                hospitalDigest: document.getElementById('settingHospitalDigest')?.checked || false,
                donorAlerts: document.getElementById('settingDonorAlerts')?.checked || false,
                autoMatchDonors: document.getElementById('settingAutoMatch')?.checked || false,
                emergencyBroadcastEnabled: document.getElementById('settingEmergencyBroadcast')?.checked || false,
                registrationApprovalRequired: document.getElementById('settingRegistrationApproval')?.checked || false,
                lowStockThreshold: parseInt(document.getElementById('settingLowStockThreshold')?.value || '5', 10)
            };
            
            try {
                await updateSystemSettings(settings);
                
                const notification = document.getElementById('settingsSaveNotification');
                if (notification) {
                    notification.classList.remove('hidden');
                    setTimeout(() => {
                        notification.classList.add('hidden');
                    }, 3000);
                }
            } catch (e) {
                console.error('Failed to save settings:', e);
                alert('Failed to save settings. Please try again.');
            }
        };
    }
}

// ============================================
// NOTIFICATION SYSTEM
// ============================================

let notifications = [];
let notificationSystemInitialized = false;
let adminNotifUnsub = null;

function initNotificationSystem() {
    if (notificationSystemInitialized) return;
    notificationSystemInitialized = true;

    const notifBtn = document.getElementById('btnAdminNotifications');
    const notifDropdown = document.getElementById('notificationDropdown');
    const clearBtn = document.getElementById('btnClearNotifications');
    const settingsBtn = document.getElementById('btnNotificationSettings');

    adminNotifUnsub = subscribeToAdminNotifications((items) => {
        notifications = items;
        renderNotificationList();
        updateNotificationBadge();
    });

    if (notifBtn && notifDropdown) {
        notifBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            notifDropdown.classList.toggle('hidden');
            if (!notifDropdown.classList.contains('hidden')) renderNotificationList();
        });
        
        document.addEventListener('click', (e) => {
            if (!notifDropdown.contains(e.target) && e.target !== notifBtn) {
                notifDropdown.classList.add('hidden');
            }
        });
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearAllAdminNotifications();
        });
    }
    
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            document.getElementById('notificationDropdown')?.classList.add('hidden');
            window.adminSwitchView?.('settings');
        });
    }
}

function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    const markReadBtn = document.getElementById('btnMarkNotifsRead');
    const unread = notifications.filter(n => !n.read).length;
    if (badge) {
        badge.textContent = unread > 9 ? '9+' : unread;
        badge.classList.toggle('hidden', unread === 0);
    }
    if (markReadBtn) markReadBtn.classList.toggle('hidden', unread === 0);
}

function initAdminChangePassword() {
    const btn = document.getElementById('btnAdminChangePassword');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const currentUser = getCurrentUser();
        if (!currentUser?.email) { showToast('No account email on file.', 'error'); return; }
        if (!confirm(`Send a password reset link to ${currentUser.email}?`)) return;
        try {
            await sendPasswordReset(currentUser.email);
            showToast('Password reset link sent to your email');
        } catch (e) {
            console.error('Failed to send password reset:', e);
            showToast('Failed to send reset link. Please try again.', 'error');
        }
    });
}

function initAdminNotificationDropdownControls() {
    const markReadBtn = document.getElementById('btnMarkNotifsRead');
    const closeBtn = document.getElementById('btnCloseNotifDropdown');
    if (markReadBtn) {
        markReadBtn.addEventListener('click', () => {
            notifications.forEach(n => { n.read = true; });
            renderNotificationList();
            updateNotificationBadge();
            markAllAdminNotificationsRead();
        });
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            document.getElementById('notificationDropdown')?.classList.add('hidden');
        });
    }
}

function renderNotificationList() {
    const list = document.getElementById('notificationList');
    if (!list) return;
    
    if (notifications.length === 0) {
        list.innerHTML = '<p class="text-center text-slate-500 py-8 text-sm">No notifications</p>';
        return;
    }
    
    list.innerHTML = notifications.map(n => {
        const timeAgo = getTimeAgo(n.createdAt);
        const icon = n.type === 'warning' ? 'warning' : n.type === 'success' ? 'check_circle' : 'info';
        const iconClass = n.type === 'warning' ? 'text-amber-500' : n.type === 'success' ? 'text-emerald-500' : 'text-blue-500';
        
        return `
        <div class="p-3 rounded-lg hover:bg-surface-container-low cursor-pointer transition-colors ${n.read ? 'opacity-60' : ''}" onclick="window.markNotificationRead(${n.id})">
            <div class="flex items-start gap-3">
                <span class="material-symbols-outlined ${iconClass} text-lg">${icon}</span>
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm text-on-surface">${esc(n.title)}</p>
                    <p class="text-xs text-slate-500 truncate">${esc(n.message)}</p>
                    <p class="text-[10px] text-slate-400 mt-1">${timeAgo}</p>
                </div>
                ${!n.read ? '<span class="w-2 h-2 bg-primary rounded-full"></span>' : ''}
            </div>
        </div>
        `;
    }).join('');
}

function getTimeAgo(dateStr) {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

window.markNotificationRead = (id) => {
    const notif = notifications.find(n => n.id === id);
    if (notif && !notif.read) {
        notif.read = true;
        renderNotificationList();
        updateNotificationBadge();
        markAdminNotificationRead(id);
    }
};

// ============================================
// CAMPAIGN MANAGEMENT
// ============================================

async function loadCampaignsDashboard() {
    const gridEl = document.getElementById('campaignsGrid');
    const activeCountEl = document.getElementById('campaignsActiveCount');
    const planningCountEl = document.getElementById('campaignsPlanningCount');
    const completedCountEl = document.getElementById('campaignsCompletedCount');
    const totalUnitsEl = document.getElementById('campaignsTotalUnits');
    
    if (!gridEl) return;
    
    try {
        const campaigns = await fetchAllCampaigns();
        
        // Update stats
        const active = campaigns.filter(c => c.status === 'active').length;
        const planning = campaigns.filter(c => c.status === 'planning').length;
        const completed = campaigns.filter(c => c.status === 'completed').length;
        const units = campaigns.reduce((sum, c) => sum + (c.unitsCollected || 0), 0);
        
        if (activeCountEl) activeCountEl.textContent = active;
        if (planningCountEl) planningCountEl.textContent = planning;
        if (completedCountEl) completedCountEl.textContent = completed;
        if (totalUnitsEl) totalUnitsEl.textContent = units;
        
        if (campaigns.length === 0) {
            gridEl.innerHTML = `
                <div class="col-span-full text-center py-12">
                    <span class="material-symbols-outlined text-5xl text-slate-300 mb-4">campaign</span>
                    <p class="text-slate-500 font-medium">No campaigns yet</p>
                    <p class="text-xs text-slate-400 mt-2">Click "New Campaign" to create your first campaign</p>
                </div>
            `;
            return;
        }
        
        gridEl.innerHTML = campaigns.map(c => {
            const progress = c.targetUnits ? Math.round((c.unitsCollected || 0) / c.targetUnits * 100) : 0;
            const statusColors = {
                'active': { bg: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-800', text: 'text-emerald-600' },
                'planning': { bg: 'bg-blue-500', badge: 'bg-blue-100 text-blue-800', text: 'text-blue-600' },
                'completed': { bg: 'bg-slate-500', badge: 'bg-slate-100 text-slate-800', text: 'text-slate-600' },
                'cancelled': { bg: 'bg-red-500', badge: 'bg-red-100 text-red-800', text: 'text-red-600' }
            };
            const colors = statusColors[c.status] || statusColors.planning;
            const startDate = c.startDate ? new Date(c.startDate).toLocaleDateString() : 'TBD';
            
            return `
            <div class="bg-surface-container-lowest border border-outline-variant/20 rounded-2xl p-6 shadow-sm flex flex-col relative overflow-hidden group">
                <div class="absolute top-0 left-0 w-full h-1 ${colors.bg}"></div>
                <div class="flex justify-between items-start mb-4">
                    <div class="p-3 ${colors.text.replace('text-', 'bg-').replace('600', '50').replace('800', '100')} rounded-xl ${colors.text}">
                        <span class="material-symbols-outlined" data-icon="celebration">celebration</span>
                    </div>
                    <span class="${colors.badge} text-[10px] font-bold px-2 py-1 rounded-md uppercase tracking-widest">${esc(c.status)}</span>
                </div>
                <h3 class="font-black text-xl text-on-surface mb-1">${esc(c.title)}</h3>
                <p class="text-xs text-slate-500 flex items-center gap-1 mb-2"><span class="material-symbols-outlined text-[14px]" data-icon="location_on">location_on</span> ${esc(c.location)}</p>
                <p class="text-xs text-slate-400 mb-4">Start: ${startDate}</p>
                
                <div class="mt-auto space-y-2">
                    <div class="flex justify-between text-xs font-bold text-on-surface">
                        <span>Target: ${Number(c.targetUnits) || 0} Units</span>
                        <span class="${colors.text}">${progress}%</span>
                    </div>
                    <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                        <div class="${colors.bg} h-full rounded-full" style="width: ${progress}%"></div>
                    </div>
                </div>
                
                <div class="flex gap-2 mt-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onclick="window.viewCampaignParticipants('${c.id}')" class="flex-1 bg-emerald-50 text-emerald-600 py-2 px-3 rounded-lg text-xs font-bold hover:bg-emerald-100 transition-colors">Participants</button>
                    <button onclick="window.editCampaign('${c.id}')" class="flex-1 bg-slate-100 text-slate-600 py-2 px-3 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors">Edit</button>
                    <button onclick="window.deleteCampaign('${c.id}')" class="flex-1 bg-red-50 text-red-600 py-2 px-3 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors">Delete</button>
                </div>
            </div>
            `;
        }).join('');
        
        initCampaignModal();
        
    } catch (e) {
        console.error('Failed to load campaigns:', e);
        gridEl.innerHTML = '<p class="col-span-full text-center text-error py-8">Failed to load campaigns</p>';
    }
}

function initCampaignModal() {
    const newBtn = document.getElementById('btnNewCampaign');
    const modal = document.getElementById('campaignModal');
    const backdrop = document.getElementById('campaignBackdrop');
    const cancelBtn = document.getElementById('btnCancelCampaign');
    const form = document.getElementById('campaignForm');
    
    const openModal = (campaign = null) => {
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        
        const titleEl = document.getElementById('campaignModalTitle');
        const idInput = document.getElementById('campaignId');
        const titleInput = document.getElementById('campaignTitle');
        const locationInput = document.getElementById('campaignLocation');
        const targetInput = document.getElementById('campaignTargetUnits');
        const statusSelect = document.getElementById('campaignStatus');
        const startDateInput = document.getElementById('campaignStartDate');
        const descInput = document.getElementById('campaignDescription');
        
        if (campaign) {
            if (titleEl) titleEl.textContent = 'Edit Campaign';
            if (idInput) idInput.value = campaign.id;
            if (titleInput) titleInput.value = campaign.title || '';
            if (locationInput) locationInput.value = campaign.location || '';
            if (targetInput) targetInput.value = campaign.targetUnits || '';
            if (statusSelect) statusSelect.value = campaign.status || 'planning';
            if (startDateInput) startDateInput.value = campaign.startDate || '';
            if (descInput) descInput.value = campaign.description || '';
        } else {
            if (titleEl) titleEl.textContent = 'Create Campaign';
            if (form) form.reset();
            if (idInput) idInput.value = '';
            const today = new Date().toISOString().split('T')[0];
            if (startDateInput) startDateInput.min = today;
        }
    };
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            if (form) form.reset();
        }
    };
    
    if (newBtn) {
        newBtn.onclick = () => openModal();
    }
    
    if (backdrop) {
        backdrop.onclick = closeModal;
    }
    
    if (cancelBtn) {
        cancelBtn.onclick = closeModal;
    }
    
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Saving...';
            btn.disabled = true;
            
            const id = document.getElementById('campaignId').value;
            const campaignData = {
                title: document.getElementById('campaignTitle').value,
                location: document.getElementById('campaignLocation').value,
                targetUnits: parseInt(document.getElementById('campaignTargetUnits').value, 10),
                status: document.getElementById('campaignStatus').value,
                startDate: document.getElementById('campaignStartDate').value,
                description: document.getElementById('campaignDescription').value,
                unitsCollected: 0
            };
            
            try {
                if (id) {
                    await updateCampaign(id, campaignData);
                } else {
                    await createCampaign(campaignData);
                }
                closeModal();
                loadCampaignsDashboard();
            } catch (err) {
                console.error('Failed to save campaign:', err);
                alert('Failed to save campaign. Please try again.');
            } finally {
                btn.innerHTML = 'Save Campaign';
                btn.disabled = false;
            }
        };
    }
}

window.editCampaign = async (id) => {
    const campaigns = await fetchAllCampaigns();
    const campaign = campaigns.find(c => c.id === id);
    if (campaign) {
        const modal = document.getElementById('campaignModal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            
            document.getElementById('campaignId').value = campaign.id;
            document.getElementById('campaignTitle').value = campaign.title || '';
            document.getElementById('campaignLocation').value = campaign.location || '';
            document.getElementById('campaignTargetUnits').value = campaign.targetUnits || '';
            document.getElementById('campaignStatus').value = campaign.status || 'planning';
            document.getElementById('campaignStartDate').value = campaign.startDate || '';
            document.getElementById('campaignDescription').value = campaign.description || '';
            
            document.getElementById('campaignModalTitle').textContent = 'Edit Campaign';
        }
    }
};

window.deleteCampaign = async (id, title) => {
    if (!title) {
        try {
            const campaigns = await fetchAllCampaigns();
            title = campaigns.find(c => c.id === id)?.title || '';
        } catch { /* keep default */ }
    }
    if (confirm(`Delete campaign "${title}"? This action cannot be undone.`)) {
        try {
            await deleteCampaign(id);
            loadCampaignsDashboard();
        } catch (err) {
            console.error('Failed to delete campaign:', err);
            alert('Failed to delete campaign.');
        }
    }
};

// ============================================
// ADMIN: CAMPAIGN PARTICIPANTS MODAL
// Two distinct audiences: hospitals that joined as organizing participants (stored directly
// on the campaign doc via joinCampaign) and donors who registered interest (donor_engagement
// docs via donorJoinCampaign) — this modal existed with zero JS behind it despite both data
// sources already being fully built and used elsewhere (hospital Campaigns tab, donor dashboard).
// ============================================
function initCampaignParticipantsModal() {
    const modal = document.getElementById('campaignParticipantsModal');
    const closeBtn = document.getElementById('btnCloseCampaignParticipants');
    const closeFooterBtn = document.getElementById('btnCloseCampaignParticipantsFooter');
    const close = () => modal?.classList.add('hidden');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (closeFooterBtn) closeFooterBtn.addEventListener('click', close);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
}

window.viewCampaignParticipants = async (campaignId, title) => {
    const modal = document.getElementById('campaignParticipantsModal');
    const subtitle = document.getElementById('campaignParticipantsSubtitle');
    const body = document.getElementById('campaignParticipantsBody');
    if (!modal || !body) return;

    if (subtitle) subtitle.textContent = title || 'Loading campaign...';
    body.innerHTML = '<p class="text-center text-slate-500 py-8 text-sm">Loading participants...</p>';
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    try {
        const [campaigns, interestedDonors] = await Promise.all([
            fetchAllCampaigns(),
            fetchCampaignInterestedDonors(campaignId).catch(() => [])
        ]);
        const campaign = campaigns.find(c => c.id === campaignId);
        const hospitalParticipants = campaign?.participants || [];

        if (subtitle && campaign?.title) subtitle.textContent = campaign.title;

        const hospitalSection = `
            <div>
                <p class="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Organizing Hospitals (${hospitalParticipants.length})</p>
                ${hospitalParticipants.length === 0
                    ? '<p class="text-sm text-slate-400 py-2">No hospitals have joined yet.</p>'
                    : hospitalParticipants.map(p => `
                        <div class="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                            <div class="flex items-center gap-2">
                                <span class="material-symbols-outlined text-slate-400 text-base">local_hospital</span>
                                <span class="text-sm font-bold text-slate-700">${esc(p.hospitalName)}</span>
                            </div>
                            <span class="text-xs text-slate-400">${esc(p.hospitalCity) || ''}</span>
                        </div>
                    `).join('')}
            </div>`;

        const donorSection = `
            <div>
                <p class="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 mt-4">Interested Donors (${interestedDonors.length})</p>
                ${interestedDonors.length === 0
                    ? '<p class="text-sm text-slate-400 py-2">No donors have registered interest yet.</p>'
                    : interestedDonors.map(d => `
                        <div class="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                            <div class="flex items-center gap-2">
                                <span class="material-symbols-outlined text-slate-400 text-base">bloodtype</span>
                                <span class="text-sm font-bold text-slate-700">${esc(d.donorName) || 'Donor'}</span>
                            </div>
                            <span class="text-xs text-slate-400">${d.createdAt ? new Date(d.createdAt).toLocaleDateString() : ''}</span>
                        </div>
                    `).join('')}
            </div>`;

        body.innerHTML = hospitalSection + donorSection;
    } catch (e) {
        console.error('Failed to load campaign participants:', e);
        body.innerHTML = '<p class="text-center text-error py-8 text-sm">Failed to load participants.</p>';
    }
};

// ============================================
// HOSPITAL: Complete Donation Intake (Blood Drawn)
// This modal existed fully built in hospital.html with no JS behind it — the live "Complete"
// button used to just fire a bare confirm() and record a blind default (1 Whole Blood unit,
// no lab-confirmed type, no screening notes). Now it actually collects what was drawn.
// ============================================
function initDonationIntakeModal() {
    const modal = document.getElementById('donationIntakeModal');
    const backdrop = document.getElementById('donationIntakeBackdrop');
    const closeBtn = document.getElementById('btnCloseDonationIntake');
    const form = document.getElementById('donationIntakeForm');
    const componentSelect = document.getElementById('intakeComponent');
    const expiryEl = document.getElementById('intakeExpiry');

    const close = () => {
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
        if (form) form.reset();
    };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    if (componentSelect && expiryEl) {
        componentSelect.addEventListener('change', () => {
            const days = COMPONENT_SHELF_LIFE_DAYS[componentSelect.value] || 35;
            expiryEl.value = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
        });
    }

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const requestId = form.dataset.requestId;
            const donorId = form.dataset.donorId;
            const btn = form.querySelector('button[type="submit"]');
            btn.disabled = true;

            try {
                await completeDonorArrival(requestId, {
                    units: parseInt(document.getElementById('intakeUnits').value, 10) || 1,
                    componentType: componentSelect.value,
                    labConfirmedBloodType: document.getElementById('intakeLabBloodType').value || null,
                    expiresAt: expiryEl.value || null,
                    notes: document.getElementById('intakeNotes').value || ''
                });

                const currentUser = getCurrentUser();
                if (currentUser?.phone) {
                    try {
                        await sendSmsNotification(currentUser.phone, `[VitalPulse] Donation completed at ${currentUser.name}. Donor ID: ${donorId?.slice(0, 8)}. Thank you for saving lives!`);
                    } catch (e) { console.warn('SMS notification failed:', e); }
                }

                close();
                showToast('Donation intake recorded — blood is now in lab quarantine.');
                loadHospitalDonors();
                loadHospitalDashboard();
            } catch (err) {
                console.error('Failed to complete donation intake:', err);
                alert(err.message || 'Failed to complete donation intake.');
            } finally {
                btn.disabled = false;
            }
        };
    }
}

window.openDonationIntakeModal = (requestId, donorId, bloodType, donorName, donorOnFileType, screeningFlagged) => {
    const modal = document.getElementById('donationIntakeModal');
    const form = document.getElementById('donationIntakeForm');
    if (!modal || !form) return;

    form.dataset.requestId = requestId;
    form.dataset.donorId = donorId;
    form.dataset.bloodType = bloodType;

    const label = document.getElementById('donationIntakeDonorLabel');
    if (label) label.textContent = donorName ? `Recording intake for ${donorName}` : 'Record what was actually collected';

    const onFileEl = document.getElementById('intakeDonorOnFileType');
    if (onFileEl) onFileEl.textContent = donorOnFileType ? `On file: ${donorOnFileType}` : '';

    const screeningNote = document.getElementById('donationIntakeScreeningNote');
    if (screeningNote) screeningNote.classList.toggle('hidden', !screeningFlagged || screeningFlagged === 'false');

    const expiryEl = document.getElementById('intakeExpiry');
    if (expiryEl) expiryEl.value = new Date(Date.now() + 35 * 86400000).toISOString().split('T')[0];

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

// ============================================
// HOSPITAL: notification toggle save
// ============================================
function initHospitalNotificationToggles() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    // Load saved preferences from user profile
    const prefs = currentUser.notificationPrefs || { urgent: true, donor: true, stock: true };
    const urgentToggle = document.getElementById('notifUrgent');
    const donorToggle = document.getElementById('notifDonor');
    const stockToggle = document.getElementById('notifStock');

    if (urgentToggle) urgentToggle.checked = prefs.urgent !== false;
    if (donorToggle) donorToggle.checked = prefs.donor !== false;
    if (stockToggle) stockToggle.checked = prefs.stock !== false;

    const savePrefs = async () => {
        try {
            await updateUserProfile(currentUser.uid, {
                notificationPrefs: {
                    urgent: urgentToggle?.checked ?? true,
                    donor: donorToggle?.checked ?? true,
                    stock: stockToggle?.checked ?? true
                }
            });
            const updated = JSON.parse(localStorage.getItem('vitalpulse_user') || '{}');
            updated.notificationPrefs = {
                urgent: urgentToggle?.checked ?? true,
                donor: donorToggle?.checked ?? true,
                stock: stockToggle?.checked ?? true
            };
            localStorage.setItem('vitalpulse_user', JSON.stringify(updated));
        } catch (e) {
            console.error('Failed to save notification prefs:', e);
        }
    };

    if (urgentToggle) urgentToggle.addEventListener('change', savePrefs);
    if (donorToggle) donorToggle.addEventListener('change', savePrefs);
    if (stockToggle) stockToggle.addEventListener('change', savePrefs);
}

// ============================================
// HOSPITAL: real-time dashboard subscription
// ============================================
let hospitalRequestsUnsub = null;

function subscribeHospitalDashboard() {
    // Unsubscribe previous listener
    if (hospitalRequestsUnsub) {
        hospitalRequestsUnsub();
        hospitalRequestsUnsub = null;
    }

    const feedEl = document.getElementById('dashRequestsFeed');
    if (!feedEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        hospitalRequestsUnsub = subscribeToRequests((requests) => {
            const myRequests = requests.filter(r => r.hospital === hospitalName);
            if (myRequests.length === 0) {
                feedEl.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">check_circle</span><p class="text-sm">No active requests from your hospital</p></div>';
                return;
            }
            feedEl.innerHTML = myRequests.slice(0, 8).map(req => {
                const statusColor = req.status === 'Donor Assigned' || req.status === 'Donor En Route' ? 'bg-amber-500' : 'bg-blue-500';
                const statusLabel = ['Donor Assigned', 'Donor En Route'].includes(req.status) ? req.status : 'Open';
                return `
                <div class="flex items-center justify-between p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors ring-2 ring-red-200">
                    <div class="flex items-center gap-3 min-w-0">
                        <span class="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm shrink-0">${req.type || req.bloodType || '?'}</span>
                        <div class="min-w-0">
                            <p class="text-sm font-bold text-on-surface truncate">${req.hospital}</p>
                            <p class="text-xs text-slate-500">${req.units || 1} unit${(req.units || 1) > 1 ? 's' : ''} needed</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="w-2 h-2 rounded-full ${statusColor} ${['Donor Assigned', 'Donor En Route'].includes(req.status) ? 'animate-pulse' : ''}"></span>
                        <span class="text-[10px] font-bold text-slate-500 uppercase">${statusLabel}</span>
                    </div>
                </div>
                `;
            }).join('');
        });
    } catch (e) {
        console.error('Failed to subscribe to requests:', e);
    }
}

// Patch loadHospitalDashboard to include subscription, notification init, and activity log
const _origLoadHospitalDashboard = loadHospitalDashboard;
loadHospitalDashboard = async function() {
    if (_origLoadHospitalDashboard) await _origLoadHospitalDashboard();
    subscribeHospitalDashboard();
    loadHospitalActivityLog();
};

// Patch loadHospitalSettings to include notification toggle init, history, and modals
const _origLoadHospitalSettings = loadHospitalSettings;
loadHospitalSettings = async function() {
    if (_origLoadHospitalSettings) await _origLoadHospitalSettings();
    initHospitalNotificationToggles();
    loadNotificationHistory();
    initNotificationFeatures();
    initDonorEngagementModal();
};

// ============================================
// HOSPITAL NOTIFICATION SYSTEM (in-app bell)
// ============================================

// Expose to window so dynamically-created onclick handlers can reach them
window.getCurrentUser = getCurrentUser;
window.markHospitalNotificationRead = markHospitalNotificationRead;
window.markAllHospitalNotificationsRead = markAllHospitalNotificationsRead;

let _hospitalNotifCache = null;

function initHospitalNotifications() {
    const notifBtn = document.getElementById('btnHospitalNotifications');
    if (!notifBtn) return;

    notifBtn.addEventListener('click', async () => {
        const currentUser = getCurrentUser();
        if (!currentUser) return;

        // Create panel with skeleton immediately — no await
        const panel = document.createElement('div');
        panel.id = 'hospitalNotifPanel';
        panel.className = 'fixed inset-0 z-50 flex items-end sm:items-start sm:justify-end sm:pt-16 sm:pr-4';
        panel.innerHTML = `
            <div class="absolute inset-0 bg-black/20" onclick="document.getElementById('hospitalNotifPanel')?.remove()"></div>
            <div class="relative bg-white w-full sm:w-96 max-h-[70vh] rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col">
                <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
                    <h3 class="font-black text-on-surface flex items-center gap-2">
                        <span class="material-symbols-outlined text-primary">notifications</span>
                        Notifications
                    </h3>
                    <button onclick="document.getElementById('hospitalNotifPanel')?.remove()" class="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition-colors">
                        <span class="material-symbols-outlined text-sm">close</span>
                    </button>
                </div>
                <div id="hospitalNotifBody" class="overflow-y-auto flex-1 p-3 space-y-1">
                    <div class="flex items-center gap-3 p-4 animate-pulse"><div class="w-4 h-4 rounded bg-slate-200"></div><div class="flex-1 space-y-2"><div class="h-3 bg-slate-200 rounded w-3/4"></div><div class="h-2 bg-slate-200/60 rounded w-1/2"></div></div></div>
                    <div class="flex items-center gap-3 p-4 animate-pulse"><div class="w-4 h-4 rounded bg-slate-200"></div><div class="flex-1 space-y-2"><div class="h-3 bg-slate-200 rounded w-2/3"></div><div class="h-2 bg-slate-200/60 rounded w-1/3"></div></div></div>
                    <div class="flex items-center gap-3 p-4 animate-pulse"><div class="w-4 h-4 rounded bg-slate-200"></div><div class="flex-1 space-y-2"><div class="h-3 bg-slate-200 rounded w-5/6"></div><div class="h-2 bg-slate-200/60 rounded w-2/3"></div></div></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        // Now fetch data (from cache or network) and fill in
        try {
            let notifications = _hospitalNotifCache?.notifications;
            let unreadCount = _hospitalNotifCache?.unreadCount || 0;
            if (!notifications) {
                const fetched = await Promise.all([
                    fetchHospitalNotifications(currentUser.uid, 10),
                    fetchUnreadHospitalNotificationCount(currentUser.uid)
                ]);
                notifications = fetched[0];
                unreadCount = fetched[1];
                _hospitalNotifCache = { notifications, unreadCount };
            } else {
                fetchHospitalNotifications(currentUser.uid, 10).then(n => {
                    _hospitalNotifCache.notifications = n;
                }).catch(() => {});
                fetchUnreadHospitalNotificationCount(currentUser.uid).then(c => {
                    _hospitalNotifCache.unreadCount = c;
                }).catch(() => {});
            }
            const badge = document.getElementById('hospitalNotifBadge');
            if (badge) {
                if (unreadCount > 0) {
                    badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
                    badge.classList.remove('hidden');
                    badge.classList.add('flex', 'items-center', 'justify-center', 'text-[8px]', 'font-bold', 'text-white');
                    badge.style.width = '18px';
                    badge.style.height = '18px';
                } else {
                    badge.classList.add('hidden');
                    badge.classList.remove('flex', 'items-center', 'justify-center', 'text-[8px]', 'font-bold', 'text-white');
                    badge.style.width = '';
                    badge.style.height = '';
                }
            }
            const body = document.getElementById('hospitalNotifBody');
            if (body) {
                if (notifications.length === 0) {
                    body.innerHTML = '<div class="flex flex-col items-center justify-center py-10 text-slate-500"><span class="material-symbols-outlined text-3xl mb-2 text-slate-300">notifications_off</span><p class="text-sm font-medium">No notifications yet</p></div>';
                } else {
                    const header = document.querySelector('#hospitalNotifPanel h3')?.closest('.flex');
                    if (header && unreadCount > 0) {
                        header.insertAdjacentHTML('beforeend', `<button onclick="(async () => { const cu = getCurrentUser(); if(cu){await markAllHospitalNotificationsRead(cu.uid); const p = document.getElementById('hospitalNotifPanel'); if(p) p.remove();} })()" class="text-[10px] font-bold text-primary hover:underline ml-auto">Mark all read</button>`);
                    }
                    body.innerHTML = notifications.map(n => {
                        const icons = { 'error': 'emergency', 'success': 'check_circle', 'info': 'info', 'warning': 'warning' };
                        const colors = { 'error': 'text-red-600 bg-red-50', 'success': 'text-emerald-600 bg-emerald-50', 'info': 'text-blue-600 bg-blue-50', 'warning': 'text-amber-600 bg-amber-50' };
                        const c = colors[n.type] || colors.info;
                        const icon = icons[n.type] || icons.info;
                        return `
                            <div class="flex items-start gap-3 p-3 rounded-xl ${n.read ? 'opacity-60' : 'bg-surface-container-low'} hover:bg-slate-50 transition-colors cursor-pointer" onclick="${!n.read ? `(async () => { await markHospitalNotificationRead('${n.id}'); this.classList.remove('bg-surface-container-low'); this.style.opacity='0.6'; })()` : ''}">
                                <span class="material-symbols-outlined text-sm mt-0.5 ${c.split(' ')[0]}">${icon}</span>
                                <div class="min-w-0 flex-1">
                                    <p class="text-xs font-bold text-on-surface ${n.read ? '' : ''}">${n.title}</p>
                                    <p class="text-[11px] text-on-surface-variant mt-0.5 line-clamp-2">${n.message}</p>
                                    <p class="text-[9px] text-slate-400 mt-1">${new Date(n.createdAt).toLocaleString()}</p>
                                </div>
                                ${!n.read ? '<span class="w-2 h-2 rounded-full bg-primary shrink-0 mt-1"></span>' : ''}
                            </div>
                        `;
                    }).join('');
                }
            }
        } catch (e) {
            const body = document.getElementById('hospitalNotifBody');
            if (body) body.innerHTML = '<div class="flex flex-col items-center justify-center py-10 text-slate-500"><span class="material-symbols-outlined text-3xl mb-2 text-slate-300">error_outline</span><p class="text-sm font-medium">Could not load notifications</p></div>';
        }
    });

    // Poll every 30 seconds — also caches full notification list for instant panel open
    const poll = async () => {
        const cu = getCurrentUser();
        if (!cu) return;
        try {
            const [count, notifications] = await Promise.all([
                fetchUnreadHospitalNotificationCount(cu.uid),
                fetchHospitalNotifications(cu.uid, 10)
            ]);
            _hospitalNotifCache = { notifications, unreadCount: count };
            const badge = document.getElementById('hospitalNotifBadge');
            if (badge) {
                if (count > 0) {
                    badge.textContent = count > 9 ? '9+' : count;
                    badge.classList.remove('hidden');
                    badge.classList.add('flex', 'items-center', 'justify-center', 'text-[8px]', 'font-bold', 'text-white');
                    badge.style.width = '18px';
                    badge.style.height = '18px';
                } else {
                    badge.classList.add('hidden');
                    badge.classList.remove('flex', 'items-center', 'justify-center', 'text-[8px]', 'font-bold', 'text-white');
                    badge.style.width = '';
                    badge.style.height = '';
                }
            }
        } catch (e) { /* silent */ }
    };
    poll();
    setInterval(poll, 30000);
}

// ============================================
// HOSPITAL ACTIVITY LOG
// ============================================
async function loadHospitalActivityLog() {
    const logEl = document.getElementById('dashHospitalLog');
    const countEl = document.getElementById('dashLogCount');
    if (!logEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const logs = await fetchRecentLogs(15);
        if (countEl) countEl.textContent = `${logs.length} events`;

        if (logs.length === 0) {
            logEl.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-2xl mb-2">history</span><p class="text-sm">No activity recorded yet</p></div>';
            return;
        }

        logEl.innerHTML = logs.map(log => {
            const iconMap = {
                'success': { icon: 'check_circle', bg: 'bg-emerald-100', text: 'text-emerald-600' },
                'warning': { icon: 'warning', bg: 'bg-amber-100', text: 'text-amber-600' },
                'error': { icon: 'error', bg: 'bg-red-100', text: 'text-red-600' },
                'info': { icon: 'info', bg: 'bg-blue-100', text: 'text-blue-600' }
            };
            const style = iconMap[log.type] || iconMap.info;
            const time = log.timestamp ? new Date(log.timestamp).toLocaleString() : '';
            return `
            <div class="flex items-start gap-3 p-2 hover:bg-slate-50 rounded-lg transition-colors">
                <div class="w-7 h-7 rounded-full ${style.bg} flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-xs ${style.text}">${style.icon}</span>
                </div>
                <div class="min-w-0 flex-1">
                    <p class="text-xs font-bold text-on-surface truncate">${log.title}</p>
                    <p class="text-[10px] text-slate-500 leading-tight line-clamp-2">${log.description || ''}</p>
                    <p class="text-[9px] text-slate-400 mt-0.5">${time}</p>
                </div>
            </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load activity log:', e);
        logEl.innerHTML = '<div class="text-center text-error text-sm py-8">Failed to load activity log.</div>';
    }
}

// ============================================
// HOSPITAL: FULL ACTIVITY LOG MODAL
// Same "built with no JS" pattern as its admin-side counterpart — scoped to this hospital's
// own log via fetchRecentLogs(limit, hospitalName), which already existed for exactly this.
// ============================================
let hospitalActivityLogCache = [];

async function loadFullHospitalActivityLog(filter = 'all', searchTerm = '') {
    const body = document.getElementById('hospitalLogModalBody');
    const countEl = document.getElementById('hospitalLogModalCount');
    if (!body) return;
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    body.innerHTML = '<div class="text-center text-slate-400 py-8 text-sm">Loading...</div>';
    try {
        const logs = await fetchRecentLogs(200, hospitalName);
        hospitalActivityLogCache = logs;

        let filtered = filter === 'all' ? logs : logs.filter(l => l.type === filter);
        if (searchTerm.trim()) {
            const term = searchTerm.trim().toLowerCase();
            filtered = filtered.filter(l => (l.title || '').toLowerCase().includes(term) || (l.description || '').toLowerCase().includes(term));
        }

        if (countEl) countEl.textContent = `${filtered.length} events`;

        if (filtered.length === 0) {
            body.innerHTML = '<div class="text-center text-slate-400 py-8 text-sm">No matching activity.</div>';
            return;
        }

        body.innerHTML = filtered.map(log => {
            let icon = 'info';
            let colorClass = 'bg-slate-100 text-slate-600';
            if (log.type === 'success') { icon = 'check_circle'; colorClass = 'bg-green-100 text-green-600'; }
            if (log.type === 'warning') { icon = 'warning'; colorClass = 'bg-amber-100 text-amber-600'; }
            if (log.type === 'error') { icon = 'error'; colorClass = 'bg-red-100 text-red-600'; }
            return `
            <div class="flex items-start gap-3 py-3 border-b border-slate-50 last:border-0">
                <div class="w-8 h-8 rounded-full ${colorClass} flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-sm">${icon}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-bold text-slate-800">${log.title}</p>
                    <p class="text-xs text-slate-500 mt-0.5">${log.description}</p>
                    <p class="text-[10px] text-slate-400 mt-1">${log.timestamp ? new Date(log.timestamp).toLocaleString() : ''}</p>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('Failed to load hospital activity log:', e);
        body.innerHTML = '<div class="text-center text-error py-8 text-sm">Failed to load activity log.</div>';
    }
}

function initHospitalActivityLogModal() {
    const modal = document.getElementById('hospitalActivityLogModal');
    const closeBtn = document.getElementById('btnCloseHospitalLogModal');
    const searchInput = document.getElementById('hospitalLogModalSearch');
    const filterBtns = document.querySelectorAll('#hospitalLogModalFilters button');
    const exportBtn = document.getElementById('btnHospitalExportLog');
    const clearBtnModal = document.getElementById('btnHospitalClearLogModal');
    const clearBtnInline = document.getElementById('btnHospitalClearLog');
    const openBtns = [document.getElementById('btnHospitalViewAllLog')];

    let activeFilter = 'all';
    const close = () => modal?.classList.add('hidden');
    const open = () => { modal?.classList.remove('hidden'); loadFullHospitalActivityLog(activeFilter, searchInput?.value || ''); };

    openBtns.forEach(btn => { if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); open(); }); });
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    if (searchInput) searchInput.addEventListener('input', () => loadFullHospitalActivityLog(activeFilter, searchInput.value));

    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            activeFilter = btn.dataset.filter;
            filterBtns.forEach(b => {
                b.className = 'px-3 py-1 text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 transition-all cursor-pointer';
            });
            btn.className = 'px-3 py-1 text-[10px] font-bold rounded-full bg-slate-800 text-white transition-all cursor-pointer';
            loadFullHospitalActivityLog(activeFilter, searchInput?.value || '');
        });
    });

    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const rows = [['Timestamp', 'Title', 'Type', 'Description'], ...hospitalActivityLogCache.map(l => [l.timestamp, l.title, l.type, l.description])];
            const csv = rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `hospital-activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const clearAll = async () => {
        const currentUser = getCurrentUser();
        const hospitalName = currentUser?.name || 'General Hospital';
        if (!confirm('Clear your hospital\'s activity log? This cannot be undone.')) return;
        try {
            await clearHospitalActivityLogs(hospitalName);
            showToast('Activity log cleared');
            loadFullHospitalActivityLog(activeFilter, searchInput?.value || '');
            loadHospitalActivityLog();
        } catch (e) {
            console.error('Failed to clear hospital activity log:', e);
            alert('Failed to clear activity log.');
        }
    };
    if (clearBtnModal) clearBtnModal.addEventListener('click', clearAll);
    if (clearBtnInline) clearBtnInline.addEventListener('click', clearAll);
}

// ============================================
// ISSUE BLOOD TO PATIENT MODAL
// ============================================
function initIssueBloodModal() {
    const modal = document.getElementById('issueModal');
    const backdrop = document.getElementById('issueBackdrop');
    const closeBtn = document.getElementById('btnCloseIssue');
    const form = document.getElementById('issueForm');

    const close = () => {
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); }
    };

    if (backdrop) backdrop.addEventListener('click', (e) => handleInventoryBackdropClick(e, close));
    if (closeBtn) closeBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            if (!currentUser) return;

            const bloodType = document.getElementById('issueBloodType').value;
            const units = parseInt(document.getElementById('issueUnits').value, 10);
            const currentStock = parseInt(document.getElementById('issueCurrentQty').value, 10);

            if (!bloodType) { alert('Please select a blood type from the inventory.'); return; }
            if (units > currentStock) {
                if (!confirm(`Only ${currentStock} units of ${bloodType} available. Issue ${units} anyway? This will result in negative stock.`)) return;
            }

            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Issuing...';
            btn.disabled = true;

            try {
                const crossmatchCheck = document.getElementById('issueCrossmatchConfirm');
                const crossmatchConfirmed = crossmatchCheck ? crossmatchCheck.checked : false;
                await issueBloodToPatient(bloodType, units, {
                    patientName: document.getElementById('issuePatientName').value,
                    patientId: document.getElementById('issuePatientId').value,
                    ward: document.getElementById('issueWard').value,
                    requestingDoctor: document.getElementById('issueDoctor').value,
                    diagnosis: document.getElementById('issueDiagnosis').value,
                    hospital: currentUser.name || 'General Hospital',
                    crossmatchConfirmed,
                    crossmatchResult: crossmatchConfirmed ? 'Compatible' : 'Not Tested',
                    crossmatchTechId: document.getElementById('issueCrossmatchTech')?.value || '',
                    patientBloodType: document.getElementById('issuePatientBloodType')?.value || ''
                });
                close();
                showToast(`Issued ${units} unit(s) of ${bloodType} to patient`);
                loadHospitalInventoryData();
                loadHospitalDashboard();
            } catch (err) {
                console.error('Failed to issue blood:', err);
                alert(err.message || 'Failed to issue blood. Please try again.');
            } finally {
                btn.innerHTML = 'Confirm Issue to Patient';
                btn.disabled = false;
            }
        };
    }
}

window.openHospitalIssueBlood = (type, currentStock) => {
    closeInventoryActionModals();
    const modal = document.getElementById('issueModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('issueBloodType').value = type;
    document.getElementById('issueCurrentQty').value = currentStock || 0;
    document.getElementById('issueBloodTypeLabel').textContent = `${type} — Issue to Patient`;
    document.getElementById('issueCurrentStock').textContent = `Current stock: ${currentStock || 0} units`;
    document.getElementById('issueUnits').max = currentStock || 0;
};

// ============================================
// BLOOD COMPATIBILITY GUIDE MODAL
// ============================================
function initCompatibilityGuideModal() {
    const modal = document.getElementById('compatModal');
    const backdrop = document.getElementById('compatBackdrop');
    const closeBtn = document.getElementById('btnCloseCompat');

    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Build compatibility grids when modal opens
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
    }

    // Pre-fill compatibility data when modal is about to open
    const fillCompatData = () => {
        const allTypes = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
        const donorGrid = document.getElementById('compatDonorGrid');
        const recipientGrid = document.getElementById('compatRecipientGrid');

        if (!donorGrid || !recipientGrid) return;

        donorGrid.innerHTML = allTypes.map(type => {
            const canDonateTo = getCompatibleBloodTypes(type);
            return `
            <div class="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <div class="flex items-center gap-2 mb-2">
                    <span class="w-8 h-8 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm">${type}</span>
                    <span class="text-xs font-bold text-on-surface">Donates to</span>
                </div>
                <div class="flex flex-wrap gap-1">
                    ${canDonateTo.map(t => `<span class="text-[10px] font-bold px-2 py-0.5 rounded-md ${t === type ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}">${t}</span>`).join('')}
                </div>
            </div>
            `;
        }).join('');

        recipientGrid.innerHTML = allTypes.map(type => {
            // getCompatibleBloodTypes answers "who can X donate to" — using it here would
            // render the donate-to list under the "Receives from" label (the 2026-07-24
            // inverted-compatibility bug class). The recipient grid needs the inverse.
            const canReceiveFrom = getCompatibleDonorTypes(type);
            return `
            <div class="p-3 bg-blue-50 rounded-xl border border-blue-100">
                <div class="flex items-center gap-2 mb-2">
                    <span class="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-black text-sm">${type}</span>
                    <span class="text-xs font-bold text-on-surface">Receives from</span>
                </div>
                <div class="flex flex-wrap gap-1">
                    ${canReceiveFrom.map(t => `<span class="text-[10px] font-bold px-2 py-0.5 rounded-md ${t === type ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}">${t}</span>`).join('')}
                </div>
            </div>
            `;
        }).join('');
    };

    // Fill data when modal opens
    const observer = new MutationObserver(() => {
        if (!modal.classList.contains('hidden')) fillCompatData();
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
}

// ============================================
// THRESHOLD SETTINGS MODAL
// ============================================
function initThresholdModal() {
    const modal = document.getElementById('thresholdModal');
    const backdrop = document.getElementById('thresholdBackdrop');
    const closeBtn = document.getElementById('btnCloseThreshold');
    const form = document.getElementById('thresholdForm');

    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };
    if (backdrop) backdrop.addEventListener('click', (e) => handleInventoryBackdropClick(e, close));
    if (closeBtn) closeBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const bloodType = document.getElementById('thresholdBloodType').value;
            const value = parseInt(document.getElementById('thresholdValue').value, 10);

            if (!bloodType || isNaN(value) || value < 0) { alert('Please enter a valid threshold value.'); return; }

            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Saving...';
            btn.disabled = true;

            const currentUser = getCurrentUser();
            const hospName = currentUser?.name || 'General Hospital';
            try {
                await setInventoryThreshold(bloodType, value, hospName);
                close();
                showToast(`Minimum threshold for ${bloodType} set to ${value} units`);
                loadHospitalInventoryData();
            } catch (err) {
                console.error('Failed to set threshold:', err);
                alert('Failed to set threshold.');
            } finally {
                btn.innerHTML = 'Save Threshold';
                btn.disabled = false;
            }
        };
    }
}

window.openHospitalSetThreshold = (type) => {
    closeInventoryActionModals();
    const modal = document.getElementById('thresholdModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('thresholdBloodType').value = type;
    document.getElementById('thresholdTypeDisplay').textContent = type;
    document.getElementById('thresholdTypeLabel').textContent = type;
    document.getElementById('thresholdValue').value = 5;
};

// ============================================
// REQUEST TIMELINE MODAL (Feature 6)
// ============================================

function initTimelineModal() {
    const modal = document.getElementById('timelineModal');
    const backdrop = document.getElementById('timelineBackdrop');
    const closeBtn = document.getElementById('btnCloseTimeline');
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
}

window.openRequestTimeline = async (requestId) => {
    const modal = document.getElementById('timelineModal');
    const content = document.getElementById('timelineContent');
    const reqIdLabel = document.getElementById('timelineRequestId');
    if (!modal || !content) return;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (reqIdLabel) reqIdLabel.textContent = `#${requestId.slice(0, 8).toUpperCase()}`;
    content.innerHTML = '<div class="flex items-center justify-center py-12 text-slate-400"><span class="material-symbols-outlined animate-spin mr-3">sync</span><span class="text-sm">Loading timeline...</span></div>';

    try {
        const reqDoc = await getDoc(doc(db, 'requests', requestId));
        if (!reqDoc.exists()) {
            content.innerHTML = '<div class="text-center py-12 text-slate-400"><span class="material-symbols-outlined block text-3xl mb-2">timeline</span><p class="text-sm">Request not found</p></div>';
            return;
        }
        const req = reqDoc.data();
        const timeline = [
            { status: 'Opened', description: 'Request was created', timestamp: req.requestedAt || req.timestamp || req.createdAt, color: 'text-blue-500', icon: 'add_circle' },
            { status: 'Matching', description: `Looking for ${req.bloodType} donors in ${req.city}`, timestamp: req.matchedAt, color: 'text-amber-500', icon: 'search' },
            { status: 'Donor Assigned', description: 'A donor accepted the request', timestamp: req.assignedAt, color: 'text-indigo-500', icon: 'person_pin' },
            { status: 'Donor En Route', description: 'Donor is heading to the hospital', timestamp: req.enRouteAt, color: 'text-purple-500', icon: 'directions_car' },
            { status: 'Resolved', description: 'Request fulfilled — donation completed', timestamp: req.resolvedAt || req.updatedAt, color: 'text-emerald-500', icon: 'check_circle' },
        ].filter(e => e.timestamp);
        if (timeline.length === 0) {
            content.innerHTML = '<div class="text-center py-12 text-slate-400"><span class="material-symbols-outlined block text-3xl mb-2">timeline</span><p class="text-sm">No timeline available</p></div>';
            return;
        }

        content.innerHTML = timeline.map((entry, i) => {
            const isLast = i === timeline.length - 1;
            const dotColor = entry.color.replace('text-', 'bg-').replace('500', '500');
            return `
            <div class="relative flex gap-4 pb-8 ${isLast ? '' : ''}">
                ${!isLast ? '<div class="absolute left-[17px] top-8 bottom-0 w-0.5 bg-slate-200"></div>' : ''}
                <div class="shrink-0">
                    <div class="w-9 h-9 rounded-full ${dotColor} bg-opacity-20 flex items-center justify-center ${entry.color}">
                        <span class="material-symbols-outlined text-sm">${entry.icon}</span>
                    </div>
                </div>
                <div class="flex-1 min-w-0 pt-1">
                    <p class="font-bold text-sm text-on-surface">${entry.status}</p>
                    <p class="text-xs text-slate-500">${entry.description}</p>
                    <p class="text-[10px] text-slate-400 mt-1">${entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '—'}</p>
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load timeline:', err);
        content.innerHTML = '<div class="text-center text-error py-8">Failed to load timeline.</div>';
    }
};

// ============================================
// REMOVE STOCK MODAL (Feature 8)
// ============================================

function initRemoveStockModal() {
    const modal = document.getElementById('removeStockModal');
    const backdrop = document.getElementById('removeStockBackdrop');
    const closeBtn = document.getElementById('btnCloseRemoveStock');
    const form = document.getElementById('removeStockForm');

    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };
    if (backdrop) backdrop.addEventListener('click', (e) => handleInventoryBackdropClick(e, close));
    if (closeBtn) closeBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Removing...';
            btn.disabled = true;

            const currentUser = getCurrentUser();
            const hospName = currentUser?.name || 'General Hospital';
            try {
                const bloodType = document.getElementById('removeStockBloodType').value;
                const units = parseInt(document.getElementById('removeStockUnits').value, 10);
                const reason = document.getElementById('removeStockReason').value;
                await deductInventoryStock(bloodType, units, reason, hospName);
                await logActivity('Stock Removed', `${units} unit(s) of ${bloodType} removed — Reason: ${reason}`, 'warning');
                close();
                showToast(`${units} unit(s) of ${bloodType} removed`);
                loadHospitalInventoryData();
            } catch (err) {
                console.error('Failed to remove stock:', err);
                alert('Failed to remove stock.');
            } finally {
                btn.innerHTML = 'Remove from Inventory';
                btn.disabled = false;
            }
        };
    }
}

window.openHospitalRemoveStock = (type) => {
    closeInventoryActionModals();
    const modal = document.getElementById('removeStockModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('removeStockBloodType').value = type;
};

// ============================================
// INVENTORY MOVEMENT HISTORY (Feature 7)
// ============================================

function initInventoryMovementsRefresh() {
    const btn = document.getElementById('btnRefreshMovements');
    if (btn) btn.addEventListener('click', loadInventoryMovements);
}

async function loadInventoryMovements() {
    const container = document.getElementById('movementHistoryBody');
    if (!container) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const movements = await fetchInventoryMovements(hospitalName);

        if (movements.length === 0) {
            container.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">swap_vert</span><p class="text-sm">No inventory movements recorded yet</p></div>';
            return;
        }

        const MOVEMENT_STYLE = {
            addition: { icon: 'add_circle', color: 'text-emerald-600 bg-emerald-50', label: 'Addition' },
            removal: { icon: 'remove_circle', color: 'text-red-600 bg-red-50', label: 'Removal' },
            issuance: { icon: 'bloodtype', color: 'text-amber-600 bg-amber-50', label: 'Issued' },
            intake: { icon: 'volunteer_activism', color: 'text-blue-600 bg-blue-50', label: 'Donation Intake' },
            cleared: { icon: 'verified', color: 'text-emerald-600 bg-emerald-50', label: 'Cleared for Use' },
            rejected: { icon: 'dangerous', color: 'text-red-700 bg-red-100', label: 'Lab Rejected' },
            mismatch: { icon: 'warning', color: 'text-orange-600 bg-orange-50', label: 'Type Mismatch' },
            transfer_requested: { icon: 'sync_alt', color: 'text-blue-600 bg-blue-50', label: 'Transfer Requested' },
            transfer_dispatched: { icon: 'local_shipping', color: 'text-indigo-600 bg-indigo-50', label: 'Transfer Dispatched' },
            transfer_completed: { icon: 'task_alt', color: 'text-emerald-600 bg-emerald-50', label: 'Transfer Completed' },
            transfer_cancelled: { icon: 'cancel', color: 'text-slate-500 bg-slate-100', label: 'Transfer Cancelled' },
        };
        container.innerHTML = movements.map(m => {
            const style = MOVEMENT_STYLE[m.type] || { icon: 'info', color: 'text-slate-600 bg-slate-50', label: 'Other' };
            const { icon, color, label } = style;
            return `
            <div class="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                <div class="w-8 h-8 rounded-lg ${color} flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-sm">${icon}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <p class="text-sm font-bold text-on-surface truncate">${m.bloodType || '—'}</p>
                        <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${color}">${label}</span>
                        ${m.units ? `<span class="text-xs font-bold text-slate-600">${m.units} unit${m.units > 1 ? 's' : ''}</span>` : ''}
                    </div>
                    <p class="text-xs text-slate-500 truncate mt-0.5">${m.description}</p>
                    <p class="text-[10px] text-slate-400 mt-0.5">${m.timestamp ? new Date(m.timestamp).toLocaleString() : '—'}</p>
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load movements:', err);
        container.innerHTML = '<div class="text-center text-error py-8">Failed to load movement history.</div>';
    }
}

// ============================================
// PHASE 3: HEMOVIGILANCE
// ============================================

async function loadHemovigilanceView() {
    const listEl = document.getElementById('hemoReportsList');
    if (!listEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const reports = await fetchHemovigilanceReports(hospitalName);

        const severeStatuses = ['severe', 'life_threatening', 'fatal'];
        document.getElementById('hemoTotalReports').textContent = reports.length;
        document.getElementById('hemoSevereCount').textContent = reports.filter(r => severeStatuses.includes(r.severity)).length;
        document.getElementById('hemoPendingReview').textContent = reports.filter(r => r.status === 'pending_review').length;
        document.getElementById('hemoResolvedCount').textContent = reports.filter(r => r.status === 'resolved').length;

        if (reports.length === 0) {
            listEl.innerHTML = '<div class="flex flex-col items-center justify-center py-20 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">monitor_heart</span><p class="text-sm">No adverse reactions reported yet</p></div>';
            return;
        }

        const reactionLabels = {
            febrile_reaction: 'Febrile Non-Hemolytic Reaction',
            allergic_reaction: 'Allergic Reaction',
            hemolytic_reaction: 'Hemolytic Reaction',
            transfusion_related_acute_lung_injury: 'TRALI',
            transfusion_associated_circulatory_overload: 'TACO',
            post_transfusion_purpura: 'Post-Transfusion Purpura',
            other: 'Other Reaction'
        };
        const severityStyle = {
            mild: 'text-amber-600 bg-amber-50',
            moderate: 'text-orange-600 bg-orange-50',
            severe: 'text-red-600 bg-red-50',
            life_threatening: 'text-red-700 bg-red-100',
            fatal: 'text-red-800 bg-red-200'
        };

        listEl.innerHTML = reports.map(r => `
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                <div class="flex items-start justify-between gap-3 mb-2">
                    <div class="flex items-center gap-3">
                        <span class="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm shrink-0">${r.bloodType || '?'}</span>
                        <div>
                            <p class="text-sm font-bold text-on-surface">${reactionLabels[r.reactionType] || r.reactionType || 'Unspecified Reaction'}</p>
                            <p class="text-[10px] text-slate-400">${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</p>
                        </div>
                    </div>
                    <span class="text-[9px] font-bold uppercase px-2 py-1 rounded-full ${severityStyle[r.severity] || 'text-slate-600 bg-slate-50'}">${(r.severity || '').replace(/_/g, ' ')}</span>
                </div>
                <p class="text-xs text-slate-600 mb-3">${r.description || ''}</p>
                <div class="flex items-center justify-between">
                    <span class="text-[10px] font-bold uppercase px-2 py-1 rounded-full ${r.status === 'resolved' ? 'text-emerald-600 bg-emerald-50' : r.status === 'reviewed' ? 'text-blue-600 bg-blue-50' : 'text-amber-600 bg-amber-50'}">${(r.status || 'pending_review').replace(/_/g, ' ')}</span>
                    ${r.status !== 'resolved' ? `
                    <div class="flex gap-2">
                        ${r.status !== 'reviewed' ? `<button onclick="window.updateHemoStatus('${r.id}', 'reviewed')" class="text-[10px] font-bold text-blue-600 hover:underline cursor-pointer">Mark Reviewed</button>` : ''}
                        <button onclick="window.updateHemoStatus('${r.id}', 'resolved')" class="text-[10px] font-bold text-emerald-600 hover:underline cursor-pointer">Mark Resolved</button>
                    </div>` : ''}
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to load hemovigilance reports:', err);
        listEl.innerHTML = '<div class="text-center text-error py-8">Failed to load reports.</div>';
    }
}

window.updateHemoStatus = async (reportId, status) => {
    try {
        await updateHemovigilanceReport(reportId, { status });
        showToast(`Report marked as ${status.replace(/_/g, ' ')}`);
        loadHemovigilanceView();
    } catch (err) {
        console.error('Failed to update report status:', err);
        alert('Failed to update report status.');
    }
};

function initHemovigilanceModal() {
    const form = document.getElementById('hemoReportForm');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        const currentUser = getCurrentUser();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            await submitHemovigilanceReport({
                bloodType: document.getElementById('hemoBloodType').value,
                severity: document.getElementById('hemoSeverity').value,
                reactionType: document.getElementById('hemoReactionType').value,
                batchId: document.getElementById('hemoBatchId').value,
                patientInitials: document.getElementById('hemoPatientInitials').value,
                description: document.getElementById('hemoDescription').value,
                hospitalName: currentUser?.name || 'General Hospital',
                reportedBy: currentUser?.name || null
            });
            window.closeHemovigilanceModal();
            showToast('Adverse reaction report submitted');
            loadHemovigilanceView();
        } catch (err) {
            console.error('Failed to submit hemovigilance report:', err);
            alert('Failed to submit report. Please try again.');
        } finally {
            btn.disabled = false;
        }
    };
}

window.openHemovigilanceModal = () => {
    const modal = document.getElementById('hemoReportModal');
    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
};
window.closeHemovigilanceModal = () => {
    const modal = document.getElementById('hemoReportModal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    const form = document.getElementById('hemoReportForm');
    if (form) form.reset();
};

// ============================================
// PHASE 3: DEMAND FORECASTING
// ============================================

function renderForecastGrid(forecasts) {
    const gridEl = document.getElementById('forecastGrid');
    if (!gridEl) return;
    if (!forecasts || forecasts.length === 0) {
        gridEl.innerHTML = '<div class="col-span-full text-center text-slate-400 py-12 text-sm">No forecast data available yet.</div>';
        return;
    }
    const trendStyle = {
        critical: { color: 'text-red-600 bg-red-50', icon: 'warning' },
        increasing: { color: 'text-amber-600 bg-amber-50', icon: 'trending_up' },
        stable: { color: 'text-blue-600 bg-blue-50', icon: 'trending_flat' },
        decreasing: { color: 'text-emerald-600 bg-emerald-50', icon: 'trending_down' }
    };
    gridEl.innerHTML = forecasts.map(f => {
        const style = trendStyle[f.trend] || trendStyle.stable;
        return `
        <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
            <div class="flex items-center justify-between mb-3">
                <span class="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center font-black">${f.bloodType}</span>
                <span class="text-[9px] font-bold uppercase px-2 py-1 rounded-full ${style.color} flex items-center gap-1"><span class="material-symbols-outlined text-xs">${style.icon}</span>${f.trend}</span>
            </div>
            <p class="text-2xl font-black text-slate-900">${f.predictedDemand}</p>
            <p class="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-2">Predicted Demand (units)</p>
            <div class="text-xs text-slate-500 space-y-0.5">
                <p>Current stock: <span class="font-bold text-slate-700">${f.currentStock}</span></p>
                <p>Active demand: <span class="font-bold text-slate-700">${f.activeDemand}</span></p>
                <p>Confidence: <span class="font-bold text-slate-700">${f.confidence}%</span></p>
            </div>
        </div>
        `;
    }).join('');
}

async function loadForecastingView() {
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const liveForecast = await computeDemandForecast(hospitalName);
        renderForecastGrid(liveForecast);
    } catch (err) {
        console.error('Failed to compute demand forecast:', err);
    }

    const pastListEl = document.getElementById('pastForecastsList');
    if (!pastListEl) return;
    try {
        const past = await fetchDemandForecasts(hospitalName);
        if (past.length === 0) {
            pastListEl.innerHTML = '<div class="px-6 py-8 text-center text-slate-400 text-sm">No past forecasts yet. Click "Generate Forecast" above.</div>';
            return;
        }
        pastListEl.innerHTML = past.map(f => `
            <div class="px-6 py-4 flex items-center justify-between">
                <div>
                    <p class="text-sm font-bold text-on-surface">${(f.forecasts || []).length} blood types forecasted</p>
                    <p class="text-[10px] text-slate-400">${f.generatedAt ? new Date(f.generatedAt).toLocaleString() : ''}</p>
                </div>
                <span class="text-[10px] font-bold text-slate-400 uppercase">${f.algorithm || 'Trend-based'}</span>
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to load past forecasts:', err);
        pastListEl.innerHTML = '<div class="px-6 py-8 text-center text-error text-sm">Failed to load past forecasts.</div>';
    }
}

window.generateDemandForecast = async (btn) => {
    const hospitalName = getCurrentUser()?.name || 'General Hospital';
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
    try {
        const forecasts = await computeDemandForecast(hospitalName);
        renderForecastGrid(forecasts);
        await saveDemandForecast({
            hospitalName,
            forecasts: forecasts.map(f => ({ bloodType: f.bloodType, predictedUnits: f.predictedDemand, confidence: f.confidence, period: '30-day' })),
            algorithm: 'Trend-based (active demand + stock ratio)'
        });
        showToast('Demand forecast generated');
        loadForecastingView();
    } catch (err) {
        console.error('Failed to generate demand forecast:', err);
        alert('Failed to generate forecast. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
};

// ============================================
// PHASE 3: MYTH-BUSTING HUB
// ============================================

async function loadMythBustingView() {
    const gridEl = document.getElementById('mythArticlesGrid');
    if (!gridEl) return;

    try {
        const articles = await fetchMythArticles();
        if (articles.length === 0) {
            gridEl.innerHTML = '<div class="col-span-full text-center py-20 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2 block">psychology</span><p class="text-sm">No articles published yet</p></div>';
            return;
        }
        const categoryLabels = { health: 'Health & Safety', safety: 'Blood Safety', process: 'Donation Process', general: 'General' };
        gridEl.innerHTML = articles.map(a => `
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
                <div class="flex items-center justify-between mb-3">
                    <span class="text-[9px] font-bold uppercase px-2 py-1 rounded-full text-purple-600 bg-purple-50">${categoryLabels[a.category] || 'General'}</span>
                    <button onclick="window.likeMythArticleAction('${a.id}')" class="flex items-center gap-1 text-slate-400 hover:text-red-500 transition-colors cursor-pointer">
                        <span class="material-symbols-outlined text-sm">favorite</span>
                        <span class="text-xs font-bold">${a.likes || 0}</span>
                    </button>
                </div>
                <h4 class="text-base font-extrabold text-slate-900 mb-2">${a.title}</h4>
                <div class="bg-red-50 border border-red-100 rounded-xl p-3 mb-2">
                    <p class="text-[9px] font-bold text-red-600 uppercase tracking-wider mb-1">Myth</p>
                    <p class="text-xs text-slate-700">${a.myth}</p>
                </div>
                <div class="bg-emerald-50 border border-emerald-100 rounded-xl p-3">
                    <p class="text-[9px] font-bold text-emerald-600 uppercase tracking-wider mb-1">Fact</p>
                    <p class="text-xs text-slate-700">${a.fact}</p>
                </div>
                <p class="text-[10px] text-slate-400 mt-3">By ${a.authorName || 'VitalPulse Team'} · ${a.createdAt ? new Date(a.createdAt).toLocaleDateString() : ''}</p>
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to load myth articles:', err);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load articles.</div>';
    }
}

window.likeMythArticleAction = async (articleId) => {
    try {
        await likeMythArticle(articleId, true);
        loadMythBustingView();
    } catch (err) {
        console.error('Failed to like article:', err);
    }
};

function initMythArticleModal() {
    const form = document.getElementById('mythArticleForm');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            await createMythArticle({
                title: document.getElementById('mythTitle').value,
                myth: document.getElementById('mythMythText').value,
                fact: document.getElementById('mythFactText').value,
                category: document.getElementById('mythCategory').value
            });
            window.closeMythArticleModal();
            showToast('Article published');
            loadMythBustingView();
        } catch (err) {
            console.error('Failed to publish article:', err);
            alert('Failed to publish article. Please try again.');
        } finally {
            btn.disabled = false;
        }
    };
}

window.openMythArticleModal = () => {
    const modal = document.getElementById('mythArticleModal');
    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
};
window.closeMythArticleModal = () => {
    const modal = document.getElementById('mythArticleModal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    const form = document.getElementById('mythArticleForm');
    if (form) form.reset();
};

// ============================================
// PHASE 3: LIFE SAVER CERTIFICATES
// ============================================

async function loadCertificatesView() {
    const listEl = document.getElementById('certificatesList');
    if (!listEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const certs = await fetchHospitalIssuedCertificates(hospitalName);

        document.getElementById('certTotalIssued').textContent = certs.length;
        document.getElementById('certUniqueDonors').textContent = new Set(certs.map(c => c.donorId)).size;
        document.getElementById('certTotalLives').textContent = certs.reduce((sum, c) => sum + ((c.unitsDonated || 0) * 3), 0);

        if (certs.length === 0) {
            listEl.innerHTML = '<div class="flex flex-col items-center justify-center py-20 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">workspace_premium</span><p class="text-sm">No certificates issued yet</p></div>';
            return;
        }

        listEl.innerHTML = certs.map(c => `
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 flex items-center justify-between">
                <div class="flex items-center gap-3 min-w-0">
                    <span class="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center shrink-0"><span class="material-symbols-outlined">workspace_premium</span></span>
                    <div class="min-w-0">
                        <p class="text-sm font-bold text-on-surface truncate">${c.donorName}</p>
                        <p class="text-xs text-slate-500">${c.bloodType} · ${c.donationCount} donation${c.donationCount > 1 ? 's' : ''} · ${c.unitsDonated} unit${c.unitsDonated > 1 ? 's' : ''}</p>
                        <p class="text-[10px] text-slate-400 mt-0.5">${c.certificateNumber}</p>
                    </div>
                </div>
                <p class="text-[10px] text-slate-400 shrink-0">${c.issuedDate ? new Date(c.issuedDate).toLocaleDateString() : ''}</p>
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to load certificates:', err);
        listEl.innerHTML = '<div class="text-center text-error py-8">Failed to load certificates.</div>';
    }
}

function initIssueCertModal() {
    const form = document.getElementById('issueCertForm');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        const currentUser = getCurrentUser();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            await generateLifeSaverCertificate({
                donorId: document.getElementById('certDonorId').value,
                donorName: document.getElementById('certDonorName').value,
                bloodType: document.getElementById('certBloodType').value,
                donationCount: parseInt(document.getElementById('certDonationCount').value, 10),
                unitsDonated: parseInt(document.getElementById('certUnitsDonated').value, 10),
                hospitalName: currentUser?.name || 'General Hospital',
                issuedBy: currentUser?.name || null
            });
            window.closeIssueCertModal();
            showToast('Certificate issued successfully');
            loadCertificatesView();
        } catch (err) {
            console.error('Failed to issue certificate:', err);
            alert('Failed to issue certificate. Please try again.');
        } finally {
            btn.disabled = false;
        }
    };
}

window.openIssueCertModal = () => {
    const modal = document.getElementById('issueCertModal');
    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
};
window.closeIssueCertModal = () => {
    const modal = document.getElementById('issueCertModal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    const form = document.getElementById('issueCertForm');
    if (form) form.reset();
};

// ============================================
// DASHBOARD MINI CHART (Feature 9)
// ============================================

let dashChartInstance = null;

async function loadDashboardChart() {
    const canvas = document.getElementById('dashChart');
    if (!canvas) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const requests = await fetchHospitalRequests(hospitalName);

        const days = [];
        const counts = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            days.push(date.toLocaleDateString('en-US', { weekday: 'short' }));
            const count = requests.filter(r =>
                r.requestedAt && r.requestedAt.startsWith(dateStr)
            ).length;
            counts.push(count);
        }

        if (dashChartInstance) dashChartInstance.destroy();

        dashChartInstance = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: days,
                datasets: [{
                    label: 'Requests',
                    data: counts,
                    backgroundColor: counts.map(c => c > 0 ? '#dc2626' : '#fecaca'),
                    borderRadius: 4,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.parsed.y} request${ctx.parsed.y !== 1 ? 's' : ''}`
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { stepSize: 1 } },
                    x: { grid: { display: false } }
                }
            }
        });
    } catch (err) {
        console.error('Failed to load dashboard chart:', err);
    }
}

// ============================================
// PRINT REQUEST SLIP (Feature 10)
// ============================================

window.printRequestSlip = async (requestId) => {
    try {
        const docRef = doc(db, 'requests', requestId);
        const snapshot = await getDoc(docRef);
        if (!snapshot.exists()) { alert('Request not found.'); return; }

        const reqData = { id: snapshot.id, ...snapshot.data() };

        const printWindow = window.open('', '_blank', 'width=600,height=800');
        printWindow.document.write(`
            <html>
            <head><title>Blood Request Slip</title>
            <style>
                body { font-family: 'Courier New', monospace; padding: 40px; max-width: 500px; margin: 0 auto; }
                .header { text-align: center; border-bottom: 2px dashed #333; padding-bottom: 16px; margin-bottom: 16px; }
                .header h1 { font-size: 24px; font-weight: 900; color: #991b1b; margin: 0; }
                .header p { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0; }
                .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dotted #ddd; font-size: 13px; }
                .row-label { font-weight: bold; color: #333; }
                .row-value { color: #555; }
                .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #ccc; font-size: 10px; color: #999; text-align: center; }
                @media print { body { padding: 20px; } }
            </style>
            </head>
            <body>
                <div class="header">
                    <h1>VITALPULSE</h1>
                    <p>Blood Request Slip</p>
                </div>
                <div class="row"><span class="row-label">Request ID</span><span class="row-value">#${reqData.id.slice(0, 8).toUpperCase()}</span></div>
                <div class="row"><span class="row-label">Hospital</span><span class="row-value">${reqData.hospital || '—'}</span></div>
                <div class="row"><span class="row-label">Blood Type</span><span class="row-value">${reqData.bloodType || reqData.type || '—'}</span></div>
                <div class="row"><span class="row-label">Component</span><span class="row-value">${reqData.componentType || 'Whole Blood'}</span></div>
                <div class="row"><span class="row-label">Units</span><span class="row-value">${reqData.units || 1}</span></div>
                <div class="row"><span class="row-label">Urgency</span><span class="row-value">${(reqData.urgency || 'standard').toUpperCase()}</span></div>
                <div class="row"><span class="row-label">Status</span><span class="row-value">${reqData.status || 'Open'}</span></div>
                <div class="row"><span class="row-label">Patient Name</span><span class="row-value">${reqData.patientName || '—'}</span></div>
                <div class="row"><span class="row-label">Ward</span><span class="row-value">${reqData.ward || '—'}</span></div>
                <div class="row"><span class="row-label">Doctor</span><span class="row-value">${reqData.requestingDoctor || '—'}</span></div>
                <div class="row"><span class="row-label">Diagnosis</span><span class="row-value">${reqData.diagnosis || '—'}</span></div>
                <div class="row"><span class="row-label">Required By</span><span class="row-value">${reqData.requiredBy || '—'}</span></div>
                <div class="row"><span class="row-label">Requested At</span><span class="row-value">${reqData.requestedAt ? new Date(reqData.requestedAt).toLocaleString() : '—'}</span></div>
                <div class="footer">
                    <p>VitalPulse Blood Donation System — vitalpulse.cm</p>
                    <p>Generated: ${new Date().toLocaleString()}</p>
                </div>
                <script>
                    window.onload = function() { window.print(); window.close(); }
                </script>
            </body>
            </html>
        `);
        printWindow.document.close();
    } catch (err) {
        console.error('Failed to print slip:', err);
        alert('Failed to generate print slip.');
    }
};

window.printDonorSlip = async (donationId) => {
    try {
        const docRef = doc(db, 'donation_requests', donationId);
        const snapshot = await getDoc(docRef);
        if (!snapshot.exists()) { alert('Donation not found.'); return; }
        const data = { id: snapshot.id, ...snapshot.data() };
        const printWindow = window.open('', '_blank', 'width=600,height=800');
        printWindow.document.write(`
            <html><head><title>Donation Receipt</title>
            <style>
                body { font-family: 'Courier New', monospace; padding: 40px; max-width: 500px; margin: 0 auto; }
                .header { text-align: center; border-bottom: 2px dashed #333; padding-bottom: 16px; margin-bottom: 16px; }
                .header h1 { font-size: 24px; font-weight: 900; color: #991b1b; margin: 0; }
                .header p { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0; }
                .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dotted #ddd; font-size: 13px; }
                .row-label { font-weight: bold; color: #333; }
                .row-value { color: #555; }
                .thank-you { text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #ccc; font-size: 14px; color: #991b1b; font-weight: bold; }
                .footer { margin-top: 8px; font-size: 10px; color: #999; text-align: center; }
                @media print { body { padding: 20px; } }
            </style></head><body>
                <div class="header"><h1>VITALPULSE</h1><p>Donation Receipt</p></div>
                <div class="row"><span class="row-label">Donation ID</span><span class="row-value">#${data.id.slice(0, 8).toUpperCase()}</span></div>
                <div class="row"><span class="row-label">Donor Name</span><span class="row-value">${data.donorName || '—'}</span></div>
                <div class="row"><span class="row-label">Blood Type</span><span class="row-value">${data.bloodType || '—'}</span></div>
                <div class="row"><span class="row-label">Units</span><span class="row-value">${data.units || 1}</span></div>
                <div class="row"><span class="row-label">Component</span><span class="row-value">${data.componentType || 'Whole Blood'}</span></div>
                <div class="row"><span class="row-label">Date</span><span class="row-value">${data.preferredDate ? new Date(data.preferredDate).toLocaleString() : data.createdAt ? new Date(data.createdAt).toLocaleString() : '—'}</span></div>
                <div class="row"><span class="row-label">Hospital</span><span class="row-value">${data.hospital || data.preferredLocation || '—'}</span></div>
                <div class="row" style="border-bottom:none;"><span class="row-label">Status</span><span class="row-value">${data.status || 'Pending'}</span></div>
                <div class="thank-you">Thank you for your life-saving donation!</div>
                <div class="footer"><p>VitalPulse Blood Donation System — vitalpulse.cm</p><p>Generated: ${new Date().toLocaleString()}</p></div>
                <script>window.onload=function(){window.print();window.close();}</script>
            </body></html>
        `);
        printWindow.document.close();
    } catch (err) {
        console.error('Failed to print donation slip:', err);
        alert('Failed to generate donation slip.');
    }
};

// ============================================
// DONOR ENGAGEMENT — Hospital View (Feature)
// ============================================

function initDonorEngagementModal() {
    const modal = document.getElementById('donorEngagementModal');
    const backdrop = document.getElementById('donorEngagementBackdrop');
    const closeBtn = document.getElementById('btnCloseDonorEngagement');
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
}

window.openDonorEngagement = async (donorId) => {
    const modal = document.getElementById('donorEngagementModal');
    const content = document.getElementById('donorEngagementContent');
    const nameLabel = document.getElementById('donorEngagementName');
    if (!modal || !content) return;

    modal.classList.remove('hidden');
    modal.classList.add('flex');

    content.innerHTML = '<div class="flex items-center justify-center py-12 text-slate-400"><span class="material-symbols-outlined animate-spin mr-3">sync</span><span class="text-sm">Loading donor profile...</span></div>';

    try {
        const engagement = await computeDonorEngagement(donorId);
        if (!engagement) {
            content.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">Donor not found</p></div>';
            return;
        }

        if (nameLabel) nameLabel.textContent = engagement.donations[0]?.donorName || 'Donor';

        const badgesHtml = engagement.badges.length > 0
            ? engagement.badges.map(b => `
                <div class="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                    <span class="material-symbols-outlined text-sm" style="color:${b.color}">${b.icon}</span>
                    <span class="text-xs font-bold text-slate-700">${b.name}</span>
                </div>
            `).join('')
            : '<p class="text-xs text-slate-400">No badges earned yet</p>';

        const tierBadge = `
            <div class="flex items-center gap-3 p-4 rounded-xl" style="background-color: ${engagement.tierColor}15;">
                <span class="material-symbols-outlined text-2xl" style="color: ${engagement.tierColor}">${engagement.tierIcon}</span>
                <div>
                    <p class="font-black text-lg" style="color: ${engagement.tierColor}">${engagement.tier} Tier</p>
                    <p class="text-xs text-slate-500">${engagement.donationCount} donation${engagement.donationCount !== 1 ? 's' : ''}</p>
                </div>
            </div>
        `;

        content.innerHTML = `
            ${tierBadge}

            <div class="grid grid-cols-3 gap-3">
                <div class="bg-slate-50 rounded-xl p-3 text-center">
                    <p class="text-xl font-black text-on-surface">${engagement.donationCount}</p>
                    <p class="text-[9px] text-slate-500 uppercase">Donations</p>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center">
                    <p class="text-xl font-black text-on-surface">${engagement.totalUnits}</p>
                    <p class="text-[9px] text-slate-500 uppercase">Units</p>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center">
                    <p class="text-xl font-black text-amber-600">${engagement.points}</p>
                    <p class="text-[9px] text-slate-500 uppercase">Points</p>
                </div>
            </div>

            ${engagement.nextTier ? `
            <div>
                <div class="flex justify-between text-xs font-bold text-slate-500 mb-1">
                    <span>Progress to ${engagement.nextTier}</span>
                    <span>${Math.round(engagement.nextTierProgress)}%</span>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div class="h-full rounded-full" style="width: ${Math.min(100, engagement.nextTierProgress)}%; background: ${engagement.tierColor}"></div>
                </div>
            </div>
            ` : ''}

            <div>
                <h4 class="text-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                    <span class="material-symbols-outlined text-sm text-amber-600">badge</span>
                    Badges (${engagement.badges.length})
                </h4>
                <div class="space-y-2">
                    ${badgesHtml}
                </div>
            </div>
        `;
    } catch (err) {
        console.error('Failed to load donor engagement:', err);
        content.innerHTML = '<div class="text-center text-error py-8">Failed to load donor profile.</div>';
    }
};

// ============================================
// CAMPAIGNS VIEW — Hospital Participation
// ============================================

async function loadHospitalCampaignsView() {
    const grid = document.getElementById('campaignsGrid');
    if (!grid) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';
    const hospitalCity = currentUser?.city || '';

    try {
        const campaigns = await fetchHospitalCampaigns(hospitalName);

        if (campaigns.length === 0) {
            grid.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-16 text-slate-400"><span class="material-symbols-outlined text-4xl mb-3">campaign</span><p class="text-sm font-medium">No campaigns available</p><p class="text-xs text-slate-400 mt-1">Campaigns will appear here when admins create them</p></div>';
            return;
        }

        grid.innerHTML = campaigns.map(c => {
            const progress = c.targetUnits ? Math.round(((c.unitsCollected || 0) / c.targetUnits) * 100) : 0;
            const statusColors = {
                'active': { bg: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-800' },
                'planning': { bg: 'bg-blue-500', badge: 'bg-blue-100 text-blue-800' },
                'completed': { bg: 'bg-slate-500', badge: 'bg-slate-100 text-slate-800' },
                'cancelled': { bg: 'bg-red-500', badge: 'bg-red-100 text-red-800' }
            };
            const colors = statusColors[c.status] || statusColors.planning;
            const startDate = c.startDate ? new Date(c.startDate).toLocaleDateString() : 'TBD';

            return `
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition-all flex flex-col relative overflow-hidden">
                <div class="absolute top-0 left-0 w-full h-1 ${colors.bg}"></div>
                <div class="flex justify-between items-start mb-4">
                    <div>
                        <h3 class="font-extrabold text-base text-on-surface leading-tight">${c.title}</h3>
                        <p class="text-xs text-slate-500 mt-1 flex items-center gap-1">
                            <span class="material-symbols-outlined text-xs">location_on</span>
                            ${c.location}
                        </p>
                    </div>
                    <span class="${colors.badge} text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">${c.status}</span>
                </div>
                <div class="space-y-2 mb-4">
                    <div class="flex justify-between text-xs font-bold text-on-surface">
                        <span>${c.unitsCollected || 0} / ${c.targetUnits || 0} units</span>
                        <span>${progress}%</span>
                    </div>
                    <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                        <div class="${colors.bg} h-full rounded-full" style="width: ${progress}%"></div>
                    </div>
                </div>
                <div class="text-xs text-slate-500 mb-4">
                    <span class="font-medium">Start:</span> ${startDate}
                    ${c.participantCount > 0 ? ` • <span class="font-medium">${c.participantCount}</span> hospital${c.participantCount > 1 ? 's' : ''} participating` : ''}
                </div>
                <div class="mt-auto pt-3 border-t border-slate-100">
                    ${c.hasJoined
                        ? `<button onclick="window.handleLeaveCampaign('${c.id}', '${hospitalName}')" class="w-full text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 py-2 rounded-lg transition-colors flex items-center justify-center gap-1">
                            <span class="material-symbols-outlined text-xs">logout</span>
                            Leave Campaign
                        </button>`
                        : (c.status === 'active' || c.status === 'planning')
                        ? `<button onclick="window.handleJoinCampaign('${c.id}', '${hospitalName}', '${hospitalCity}')" class="w-full text-xs font-bold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 py-2 rounded-lg transition-colors flex items-center justify-center gap-1">
                            <span class="material-symbols-outlined text-xs">add_circle</span>
                            Join Campaign
                        </button>`
                        : `<span class="block text-center text-xs text-slate-400 font-medium py-2">Campaign ${c.status}</span>`
                    }
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load campaigns:', err);
        grid.innerHTML = '<div class="col-span-full text-center text-error py-12">Failed to load campaigns.</div>';
    }
}

window.handleJoinCampaign = async (campaignId, hospitalName, hospitalCity) => {
    try {
        await joinCampaign(campaignId, hospitalName, hospitalCity);
        showToast('Successfully joined campaign!');
        loadHospitalCampaignsView();
    } catch (err) {
        console.error('Failed to join campaign:', err);
        alert(err.message || 'Failed to join campaign.');
    }
};

window.handleLeaveCampaign = async (campaignId, hospitalName) => {
    try {
        await leaveCampaign(campaignId, hospitalName);
        showToast('Left campaign.');
        loadHospitalCampaignsView();
    } catch (err) {
        console.error('Failed to leave campaign:', err);
        alert(err.message || 'Failed to leave campaign.');
    }
};

// ============================================
// NOTIFICATION HISTORY + SMS/WhatsApp
// ============================================

async function loadNotificationHistory() {
    const container = document.getElementById('notificationHistoryBody');
    if (!container) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const logs = await fetchNotificationLog(hospitalName);

        if (logs.length === 0) {
            container.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">notifications_off</span><p class="text-sm">No notifications sent yet</p><p class="text-xs text-slate-400 mt-1">Enable SMS/WhatsApp and perform actions to trigger notifications</p></div>';
            return;
        }

        container.innerHTML = logs.map(log => {
            const icon = log.channel === 'sms' ? 'sms' : log.channel === 'whatsapp' ? 'chat' : 'notifications';
            const color = log.status === 'pending' ? 'text-amber-600 bg-amber-50' : log.status === 'sent' ? 'text-emerald-600 bg-emerald-50' : 'text-red-600 bg-red-50';
            const statusText = log.status === 'pending' ? 'Tap to Send' : log.status;
            return `
            <div class="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                <div class="w-8 h-8 rounded-lg ${color} flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-sm">${icon}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${color}">${statusText}</span>
                        <span class="text-[9px] text-slate-400">${new Date(log.sentAt).toLocaleString()}</span>
                    </div>
                    <p class="text-xs text-slate-600 mt-1 line-clamp-2">${log.message}</p>
                    <div class="flex gap-2 mt-2">
                        ${log.link ? `<a href="${log.link}" target="_blank" class="inline-flex items-center gap-1 text-[10px] font-bold ${log.channel === 'whatsapp' ? 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100' : 'text-blue-600 bg-blue-50 hover:bg-blue-100'} px-2.5 py-1 rounded-lg transition-colors">
                            <span class="material-symbols-outlined text-xs">${log.channel === 'whatsapp' ? 'chat' : 'sms'}</span>
                            Open ${log.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}
                        </a>` : ''}
                    </div>
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load notifications:', err);
        container.innerHTML = '<div class="text-center text-error py-8">Failed to load notifications.</div>';
    }
}

function initNotificationFeatures() {
    // Wire send test notification button
    const testBtn = document.getElementById('btnSendTestNotification');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            const currentUser = getCurrentUser();
            const phone = currentUser?.phone || '+237 6XX XXX XXX';
            try {
                const result = await sendWhatsAppNotification(phone, `[VitalPulse] Test notification from ${currentUser?.name || 'Hospital'} — All systems operational.`);
                if (result.link) {
                    showToast('Opening WhatsApp with your test message...');
                    setTimeout(() => window.open(result.link, '_blank'), 500);
                }
                loadNotificationHistory();
            } catch (err) {
                console.error('Failed to send test:', err);
                alert('Failed to send test notification.');
            }
        });
    }

    // Wire SMS/WhatsApp toggles to save preferences
    const notifSms = document.getElementById('notifSms');
    const notifWhatsapp = document.getElementById('notifWhatsapp');
    const currentUser = getCurrentUser();

    if (notifSms && currentUser) {
        notifSms.addEventListener('change', async () => {
            try {
                await updateUserProfile(currentUser.uid, { notifSms: notifSms.checked });
                showToast(notifSms.checked ? 'SMS notifications enabled' : 'SMS notifications disabled');
            } catch (e) { console.error(e); }
        });
    }

    if (notifWhatsapp && currentUser) {
        notifWhatsapp.addEventListener('change', async () => {
            try {
                await updateUserProfile(currentUser.uid, { notifWhatsapp: notifWhatsapp.checked });
                showToast(notifWhatsapp.checked ? 'WhatsApp notifications enabled' : 'WhatsApp notifications disabled');
            } catch (e) { console.error(e); }
        });
    }
}

export async function loadHospitalStaffView() {
    const currentUser = getCurrentUser();
    const hospitalId = currentUser?.uid || currentUser?.hospitalId;
    const container = document.getElementById('staffRosterList');
    if (!container) return;

    try {
        const staffList = await fetchHospitalStaff(hospitalId).catch(() => []);
        if (staffList.length === 0) {
            container.innerHTML = `
                <div class="col-span-full py-12 text-center text-slate-400">
                    <span class="material-symbols-outlined text-4xl mb-2">badge</span>
                    <p class="text-sm font-bold text-slate-600">No Staff Accounts Created Yet</p>
                    <p class="text-xs text-slate-400 mt-1">Click "+ Add Staff Account" above to set up individual staff logins for Reception, Nurses, and Lab Techs.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = staffList.map(s => {
            const roleBadges = (s.roles || [s.role || 'staff']).map(r => {
                const color = r === 'lab_tech' ? 'bg-purple-100 text-purple-700' : r === 'nurse' ? 'bg-emerald-100 text-emerald-700' : r === 'reception' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700';
                return `<span class="text-[10px] font-bold ${color} px-2 py-0.5 rounded-full uppercase tracking-wider">${r.replace('_', ' ')}</span>`;
            }).join(' ');

            return `
            <div class="bg-slate-50 rounded-2xl p-5 border border-slate-200 flex flex-col justify-between space-y-4">
                <div class="flex items-start justify-between">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center font-black text-slate-700 shadow-sm">
                            ${s.name ? s.name.charAt(0).toUpperCase() : 'S'}
                        </div>
                        <div>
                            <h4 class="font-extrabold text-sm text-slate-900">${s.name || 'Staff Member'}</h4>
                            <p class="text-[11px] text-slate-500 font-mono">${s.email || ''}</p>
                        </div>
                    </div>
                    <span class="w-2.5 h-2.5 rounded-full ${s.active !== false ? 'bg-emerald-500' : 'bg-red-500'}" title="${s.active !== false ? 'Active Account' : 'Inactive'}"></span>
                </div>
                <div class="flex flex-wrap gap-1">
                    ${roleBadges}
                </div>
                <div class="pt-3 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-500 font-medium">
                    <span>PIN Access: ${s.pinHash ? '•••• (Set)' : 'Not Set'}</span>
                    <span class="text-[10px] text-slate-400">Added: ${new Date(s.createdAt || Date.now()).toLocaleDateString()}</span>
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load staff list:', err);
        container.innerHTML = `<div class="col-span-full py-8 text-center text-red-500 text-sm">Failed to load staff list: ${err.message}</div>`;
    }
}

window.openAddStaffModal = () => {
    const modal = document.getElementById('modalAddStaff');
    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
};

window.closeAddStaffModal = () => {
    const modal = document.getElementById('modalAddStaff');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
};

window.openStaffQuickSwitchModal = async () => {
    const modal = document.getElementById('modalStaffQuickSwitch');
    const select = document.getElementById('selectQuickSwitchStaff');
    const errAlert = document.getElementById('alertQuickSwitchError');
    if (errAlert) errAlert.classList.add('hidden');

    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }

    if (select) {
        select.innerHTML = '<option value="">Loading staff members...</option>';
        try {
            const currentUser = getCurrentUser();
            const hospitalId = currentUser?.uid || currentUser?.hospitalId;
            const staffList = await fetchHospitalStaff(hospitalId).catch(() => []);
            if (staffList.length === 0) {
                select.innerHTML = '<option value="">No staff accounts created yet</option>';
                return;
            }
            select.innerHTML = staffList.map(s => `
                <option value="${s.uid}">${s.name} (${(s.roles || [s.role || 'staff']).join(', ')})</option>
            `).join('');
        } catch (e) {
            select.innerHTML = '<option value="">Failed to load staff</option>';
        }
    }
};

window.closeStaffQuickSwitchModal = () => {
    const modal = document.getElementById('modalStaffQuickSwitch');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
};

function initStaffModalHandlers() {
    const formAdd = document.getElementById('formAddStaff');
    if (formAdd) {
        formAdd.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('inputAddStaffName')?.value.trim();
            const email = document.getElementById('inputAddStaffEmail')?.value.trim();
            const pin = document.getElementById('inputAddStaffPin')?.value.trim();

            const roles = [];
            if (document.getElementById('roleReception')?.checked) roles.push('reception');
            if (document.getElementById('roleNurse')?.checked) roles.push('nurse');
            if (document.getElementById('roleLabTech')?.checked) roles.push('lab_tech');
            if (document.getElementById('roleAdmin')?.checked) roles.push('hospital_admin');

            if (roles.length === 0) {
                showToast('Please select at least one role for this staff member.', 'error');
                return;
            }

            try {
                showToast('Creating staff account...');
                const currentUser = getCurrentUser();
                const hospitalId = currentUser?.uid || currentUser?.hospitalId;
                const res = await createStaffAccountCall({ name, email, roles, hospitalId, pin: pin || undefined });
                showToast(`Staff account created! (${name})`);
                window.closeAddStaffModal();
                formAdd.reset();
                loadHospitalStaffView();
            } catch (err) {
                console.error('Failed to create staff account:', err);
                showToast(err.message || 'Failed to create staff account.', 'error');
            }
        });
    }

    const formQuick = document.getElementById('formStaffQuickSwitch');
    if (formQuick) {
        formQuick.addEventListener('submit', async (e) => {
            e.preventDefault();
            const staffUid = document.getElementById('selectQuickSwitchStaff')?.value;
            const pin = document.getElementById('inputQuickSwitchPin')?.value.trim();
            const errAlert = document.getElementById('alertQuickSwitchError');

            if (!staffUid) {
                showToast('Please select a staff member.', 'error');
                return;
            }

            try {
                showToast('Verifying PIN...');
                const currentUser = getCurrentUser();
                const hospitalId = currentUser?.uid || currentUser?.hospitalId;
                const res = await verifyStaffPinCall({ staffUid, pin, hospitalId });

                // Update active staff session UI badge
                const badge = document.getElementById('activeStaffBadge');
                if (badge) badge.textContent = `Staff: ${res.name}`;

                // Save active staff session in sessionStorage and update nav visibility
                setActiveStaffSession({ uid: res.staffUid, name: res.name, roles: res.roles });
                updateHospitalNavVisibility();

                showToast(`Switched active session to ${res.name}!`);
                window.closeStaffQuickSwitchModal();
                formQuick.reset();
                if (errAlert) errAlert.classList.add('hidden');
            } catch (err) {
                console.error('PIN verification failed:', err);
                if (errAlert) {
                    errAlert.textContent = err.message || 'PIN verification failed.';
                    errAlert.classList.remove('hidden');
                } else {
                    showToast(err.message || 'PIN verification failed.', 'error');
                }
            }
        });
    }
}

// Call initStaffModalHandlers during hospital dashboard init
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
        initStaffModalHandlers();
    });
    initStaffModalHandlers();
}




