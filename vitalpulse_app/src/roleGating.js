/**
 * roleGating.js — Shared frontend permission system for the hospital dashboard.
 *
 * This is the ONE place all client-side role checks happen. Every sidebar
 * visibility check, route guard, and button-level gating calls hasAnyRole()
 * from here. Do not write role-checking logic anywhere else.
 *
 * Resolution order for the active user's roles:
 *   1. Active PIN-switched staff session (sessionStorage) — used on shared
 *      devices where multiple staff members use the same browser tab.
 *   2. Hospital account's own claims (localStorage via getCurrentUser()) —
 *      fallback when no PIN switch has occurred.
 *   3. Legacy single-role string (user.role) — backwards compatibility for
 *      accounts that predate the multi-role claims migration.
 *
 * If none of these yield any roles, the user is treated as having NO roles
 * (i.e., a legacy account with no claims set). Phase 5 handles the grace
 * period for these accounts — they see the full combined dashboard.
 */

const STAFF_SESSION_KEY = 'vitalpulse_active_staff';

/**
 * Returns the roles array for the currently active session.
 *
 * @param {object|null} user - The user object from getCurrentUser() (localStorage).
 *   Expected shape: { role?: string, roles?: string[], ... }
 * @returns {string[]} Array of role strings, possibly empty.
 */
export function getActiveRoles(user) {
    // 1. Check for an active PIN-switched staff session
    try {
        const staffSession = sessionStorage.getItem(STAFF_SESSION_KEY);
        if (staffSession) {
            const parsed = JSON.parse(staffSession);
            if (Array.isArray(parsed.roles) && parsed.roles.length > 0) {
                return parsed.roles;
            }
        }
    } catch (e) {
        // sessionStorage unavailable or corrupt — fall through
    }

    if (!user) return [];

    // 2. Multi-role array from claims (set by grantRole/createStaffAccount)
    if (Array.isArray(user.roles) && user.roles.length > 0) {
        return user.roles;
    }

    // 3. Legacy single-role string
    if (typeof user.role === 'string' && user.role) {
        return [user.role];
    }

    return [];
}

/**
 * Checks whether the active user has at least one of the allowed roles.
 *
 * @param {object|null} user - The user object from getCurrentUser().
 * @param {string[]} allowedRoles - Array of role strings to check against.
 * @returns {boolean}
 */
export function hasAnyRole(user, allowedRoles) {
    if (!allowedRoles || allowedRoles.length === 0) return false;
    const activeRoles = getActiveRoles(user);
    return activeRoles.some(r => allowedRoles.includes(r));
}

/**
 * Returns true if the user is a legacy account — no `roles` array set in
 * claims and no active staff PIN session. These accounts see the full
 * combined dashboard during the 30-day grace period.
 *
 * @param {object|null} user - The user object from getCurrentUser().
 * @returns {boolean}
 */
export function isLegacyAccount(user) {
    // If there's an active PIN session, they're not legacy
    try {
        const staffSession = sessionStorage.getItem(STAFF_SESSION_KEY);
        if (staffSession) {
            const parsed = JSON.parse(staffSession);
            if (Array.isArray(parsed.roles) && parsed.roles.length > 0) {
                return false;
            }
        }
    } catch (e) { /* fall through */ }

    if (!user) return true;

    // Has multi-role array → not legacy
    if (Array.isArray(user.roles) && user.roles.length > 0) {
        return false;
    }

    // Has a hospital-scoped single role that ISN'T one of the new fine-grained
    // ones → legacy shared-login account
    const FINE_GRAINED_ROLES = ['reception', 'nurse', 'lab_tech'];
    if (typeof user.role === 'string' && FINE_GRAINED_ROLES.includes(user.role)) {
        return false;
    }

    // No roles array, and role is hospital_admin/hospital_staff/undefined → legacy
    return true;
}

/**
 * Sets the active staff session after a successful PIN verification.
 * Stored in sessionStorage so it clears when the tab/browser closes.
 *
 * @param {{ uid: string, name: string, roles: string[] }} staffMember
 */
export function setActiveStaffSession(staffMember) {
    try {
        sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify({
            uid: staffMember.uid,
            name: staffMember.name,
            roles: staffMember.roles,
            switchedAt: new Date().toISOString(),
        }));
    } catch (e) {
        console.warn('Failed to set staff session in sessionStorage:', e);
    }
}

/**
 * Returns the active staff session, or null if none.
 * @returns {{ uid: string, name: string, roles: string[], switchedAt: string }|null}
 */
export function getActiveStaffSession() {
    try {
        const raw = sessionStorage.getItem(STAFF_SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

/**
 * Clears the active staff session (e.g., on logout or explicit "end session").
 */
export function clearActiveStaffSession() {
    try {
        sessionStorage.removeItem(STAFF_SESSION_KEY);
    } catch (e) { /* ignore */ }
}

/**
 * Evaluates whether the current active session can access a specific dashboard view/route.
 * If user is a legacy account (30-day grace period), returns true for all views.
 *
 * @param {object|null} user - Current user object from getCurrentUser().
 * @param {string} viewId - View ID (e.g. 'staff', 'settings').
 * @param {Record<string, string[]>} permissionMap - Map of viewId -> allowed role array.
 * @returns {boolean}
 */
export function canAccessView(user, viewId, permissionMap = {}) {
    if (isLegacyAccount(user)) return true;
    const allowed = permissionMap[viewId];
    if (!allowed || allowed.length === 0) return true;
    return hasAnyRole(user, allowed);
}

/**
 * Computes the first view permitted for the active session from a given list of view IDs.
 *
 * @param {object|null} user - Current user object from getCurrentUser().
 * @param {string[]} viewIds - Array of view IDs to check in priority order.
 * @param {Record<string, string[]>} permissionMap - Map of viewId -> allowed role array.
 * @returns {string} First accessible viewId, defaulting to 'dashboard'.
 */
export function getFirstAccessibleView(user, viewIds = [], permissionMap = {}) {
    for (const viewId of viewIds) {
        if (canAccessView(user, viewId, permissionMap)) {
            return viewId;
        }
    }
    return 'dashboard';
}
