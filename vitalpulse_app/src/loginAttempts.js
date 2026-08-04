import { normalizeCameroonPhone } from './phone';

// Sign In failed-attempt tracking (Stream C1.2, "5 failed attempts will require
// verification"). Pure localStorage bookkeeping — deliberately NOT a security control:
// a hostile client can clear localStorage or call the Firebase Auth SDK directly,
// bypassing this entirely. Real brute-force protection needs server-side rate limiting
// or Firebase App Check (not configured anywhere in this project yet — see
// vitalpulse_app/docs/PHASE0_AUDIT.md §10). This exists purely to match the mockup's UX
// (a warning, then a short client-side cooldown) until that real protection lands.
const STORAGE_KEY = 'vitalpulse_login_failures';
export const LOGIN_WARNING_THRESHOLD = 3;
export const LOGIN_LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 30_000;

function readState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { count: 0, lockedUntil: null };
        const parsed = JSON.parse(raw);
        return {
            count: typeof parsed.count === 'number' ? parsed.count : 0,
            lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : null,
        };
    } catch {
        return { count: 0, lockedUntil: null };
    }
}

export function readLoginFailureState() {
    return readState();
}

export function recordLoginFailure() {
    const state = readState();
    state.count += 1;
    state.lockedUntil = state.count >= LOGIN_LOCKOUT_THRESHOLD ? Date.now() + LOCKOUT_DURATION_MS : null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
}

export function clearLoginFailures() {
    localStorage.removeItem(STORAGE_KEY);
}

export function isLockedOut(state) {
    return Boolean(state.lockedUntil && state.lockedUntil > Date.now());
}

export function shouldShowAttemptsWarning(state) {
    return state.count >= LOGIN_WARNING_THRESHOLD;
}

export function lockoutSecondsRemaining(state) {
    if (!isLockedOut(state)) return 0;
    return Math.ceil((state.lockedUntil - Date.now()) / 1000);
}

// Forgot-Password gate: "shouldn't work if the user hasn't tried logging in with this
// identifier at least once" (Security Lead's explicit call — since the reset flow always
// replies the same generic way whether or not an account exists, the only thing that
// actually reveals account existence is the email/SMS itself; requiring a prior sign-in
// attempt on this identifier adds friction against someone blind-farming the reset form).
// SAME CAVEAT AS ABOVE: this is a client-side UX nudge, not a security boundary — it's
// trivially bypassed by clearing localStorage or calling the Cloud Function directly. The
// real anti-enumeration protection is, and remains, the generic response from the reset
// backend itself.
const ATTEMPTED_KEY = 'vitalpulse_attempted_identifiers';
const MAX_ATTEMPTED_IDENTIFIERS = 25;

function normalizeIdentifier(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return '';
    const phone = normalizeCameroonPhone(trimmed);
    return phone || trimmed.toLowerCase();
}

function readAttemptedList() {
    try {
        const parsed = JSON.parse(localStorage.getItem(ATTEMPTED_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function recordAttemptedIdentifier(raw) {
    const normalized = normalizeIdentifier(raw);
    if (!normalized) return;
    const list = readAttemptedList().filter((v) => v !== normalized);
    list.push(normalized);
    while (list.length > MAX_ATTEMPTED_IDENTIFIERS) list.shift();
    localStorage.setItem(ATTEMPTED_KEY, JSON.stringify(list));
}

export function hasAttemptedIdentifier(raw) {
    const normalized = normalizeIdentifier(raw);
    return normalized ? readAttemptedList().includes(normalized) : false;
}
