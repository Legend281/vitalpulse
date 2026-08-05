import { describe, expect, it, beforeEach, vi } from 'vitest';
import { hasAnyRole, getActiveRoles, isLegacyAccount, setActiveStaffSession, clearActiveStaffSession } from './roleGating';

// Mock sessionStorage for tests (vitest uses jsdom which has sessionStorage)
beforeEach(() => {
    sessionStorage.clear();
});

describe('getActiveRoles', () => {
    it('returns roles from PIN-switched staff session (sessionStorage) first', () => {
        setActiveStaffSession({ uid: 'staff1', name: 'Patricia', roles: ['nurse', 'lab_tech'] });
        // Even if the user object has hospital_admin, the staff session wins
        expect(getActiveRoles({ role: 'hospital_admin', roles: ['hospital_admin'] })).toEqual(['nurse', 'lab_tech']);
    });

    it('returns user.roles array when no staff session exists', () => {
        expect(getActiveRoles({ roles: ['nurse', 'lab_tech'] })).toEqual(['nurse', 'lab_tech']);
    });

    it('falls back to legacy user.role string as single-element array', () => {
        expect(getActiveRoles({ role: 'hospital_admin' })).toEqual(['hospital_admin']);
    });

    it('returns empty array when user is null', () => {
        expect(getActiveRoles(null)).toEqual([]);
    });

    it('returns empty array when user has no role data at all', () => {
        expect(getActiveRoles({ uid: 'abc', name: 'test' })).toEqual([]);
    });

    it('falls back to legacy role when roles array is empty', () => {
        expect(getActiveRoles({ roles: [], role: 'lab_tech' })).toEqual(['lab_tech']);
    });
});

describe('hasAnyRole', () => {
    it('matches a single role from user.roles', () => {
        expect(hasAnyRole({ roles: ['nurse'] }, ['nurse'])).toBe(true);
    });

    it('matches when user has one of several allowed roles', () => {
        expect(hasAnyRole({ roles: ['nurse'] }, ['lab_tech', 'nurse', 'hospital_admin'])).toBe(true);
    });

    it('matches a multi-role user against any allowed role', () => {
        expect(hasAnyRole({ roles: ['nurse', 'lab_tech'] }, ['lab_tech'])).toBe(true);
    });

    it('returns false when user has no matching role', () => {
        expect(hasAnyRole({ roles: ['reception'] }, ['lab_tech', 'hospital_admin'])).toBe(false);
    });

    it('returns false for empty roles array and no legacy role', () => {
        expect(hasAnyRole({ roles: [] }, ['nurse'])).toBe(false);
    });

    it('returns false when user is null', () => {
        expect(hasAnyRole(null, ['nurse'])).toBe(false);
    });

    it('returns false when allowedRoles is empty', () => {
        expect(hasAnyRole({ roles: ['nurse'] }, [])).toBe(false);
    });

    it('returns false when allowedRoles is null/undefined', () => {
        expect(hasAnyRole({ roles: ['nurse'] }, null)).toBe(false);
        expect(hasAnyRole({ roles: ['nurse'] }, undefined)).toBe(false);
    });

    it('falls back to legacy role string', () => {
        expect(hasAnyRole({ role: 'hospital_admin' }, ['hospital_admin'])).toBe(true);
    });

    it('HOSTILE: hospital_admin does NOT auto-pass lab_tech-only checks', () => {
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['lab_tech'])).toBe(false);
    });

    it('HOSTILE: hospital_admin does NOT auto-pass nurse-only checks', () => {
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['nurse'])).toBe(false);
    });

    it('uses PIN-switched staff session over hospital account claims', () => {
        setActiveStaffSession({ uid: 's1', name: 'Nurse Pat', roles: ['nurse'] });
        // Hospital account is hospital_admin, but PIN session is nurse
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['nurse'])).toBe(true);
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['hospital_admin'])).toBe(false);
    });
});

describe('isLegacyAccount', () => {
    it('returns true for null user', () => {
        expect(isLegacyAccount(null)).toBe(true);
    });

    it('returns true for user with no role data', () => {
        expect(isLegacyAccount({ uid: 'abc' })).toBe(true);
    });

    it('returns true for user with hospital_admin single role but no roles array', () => {
        expect(isLegacyAccount({ role: 'hospital_admin' })).toBe(true);
    });

    it('returns true for user with hospital_staff single role but no roles array', () => {
        expect(isLegacyAccount({ role: 'hospital_staff' })).toBe(true);
    });

    it('returns false for user with roles array', () => {
        expect(isLegacyAccount({ roles: ['nurse', 'lab_tech'] })).toBe(false);
    });

    it('returns false for user with fine-grained single role (nurse)', () => {
        expect(isLegacyAccount({ role: 'nurse' })).toBe(false);
    });

    it('returns false for user with fine-grained single role (reception)', () => {
        expect(isLegacyAccount({ role: 'reception' })).toBe(false);
    });

    it('returns false when PIN-switched staff session is active', () => {
        setActiveStaffSession({ uid: 's1', name: 'Lab Tech', roles: ['lab_tech'] });
        expect(isLegacyAccount({ role: 'hospital_admin' })).toBe(false);
    });
});

describe('setActiveStaffSession / clearActiveStaffSession', () => {
    it('stores and retrieves a staff session', () => {
        setActiveStaffSession({ uid: 's1', name: 'Patricia', roles: ['nurse', 'lab_tech'] });
        const raw = JSON.parse(sessionStorage.getItem('vitalpulse_active_staff'));
        expect(raw.uid).toBe('s1');
        expect(raw.name).toBe('Patricia');
        expect(raw.roles).toEqual(['nurse', 'lab_tech']);
        expect(raw.switchedAt).toBeTruthy();
    });

    it('clears the staff session', () => {
        setActiveStaffSession({ uid: 's1', name: 'Patricia', roles: ['nurse'] });
        clearActiveStaffSession();
        expect(sessionStorage.getItem('vitalpulse_active_staff')).toBeNull();
    });

    it('after clearing, hasAnyRole falls back to hospital account claims', () => {
        setActiveStaffSession({ uid: 's1', name: 'Nurse', roles: ['nurse'] });
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['nurse'])).toBe(true); // staff session
        clearActiveStaffSession();
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['nurse'])).toBe(false); // back to account
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['hospital_admin'])).toBe(true);
    });
});

describe('canAccessView', () => {
    const map = {
        staff: ['hospital_admin'],
        settings: ['hospital_admin'],
        campaigns: ['hospital_admin'],
        forecasting: ['hospital_admin'],
        mythbusting: ['hospital_admin'],
        certificates: ['hospital_admin'],
        lab: ['lab_tech', 'hospital_admin'],
        requests: ['nurse', 'hospital_admin'],
        hemovigilance: ['nurse', 'lab_tech', 'hospital_admin'],
        donors: ['reception', 'nurse', 'hospital_admin'],
        inventory: ['nurse', 'lab_tech', 'hospital_admin'],
    };

    it('allows hospital_admin to access staff roster', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['hospital_admin'] }, 'staff', map)).toBe(true);
    });

    it('blocks nurse from accessing staff roster', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['nurse'] }, 'staff', map)).toBe(false);
    });

    it('blocks reception from accessing staff roster', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['reception'] }, 'staff', map)).toBe(false);
    });

    it('blocks lab_tech from accessing staff roster', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['lab_tech'] }, 'staff', map)).toBe(false);
    });

    it('allows legacy account (no roles array) to access staff roster under 30-day grace period', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ role: 'hospital_admin' }, 'staff', map)).toBe(true);
    });

    it('allows PIN-switched hospital_admin staff session to access staff roster', () => {
        const { canAccessView, setActiveStaffSession } = require('./roleGating');
        setActiveStaffSession({ uid: 'admin1', name: 'Admin', roles: ['hospital_admin'] });
        expect(canAccessView({ roles: ['nurse'] }, 'staff', map)).toBe(true);
    });

    it('allows hospital_admin to access settings', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['hospital_admin'] }, 'settings', map)).toBe(true);
    });

    it('blocks nurse/lab_tech/reception from accessing settings', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['nurse'] }, 'settings', map)).toBe(false);
        expect(canAccessView({ roles: ['lab_tech'] }, 'settings', map)).toBe(false);
        expect(canAccessView({ roles: ['reception'] }, 'settings', map)).toBe(false);
    });

    it('allows hospital_admin to access campaigns', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['hospital_admin'] }, 'campaigns', map)).toBe(true);
    });

    it('blocks nurse/lab_tech/reception from accessing campaigns', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['nurse'] }, 'campaigns', map)).toBe(false);
        expect(canAccessView({ roles: ['lab_tech'] }, 'campaigns', map)).toBe(false);
        expect(canAccessView({ roles: ['reception'] }, 'campaigns', map)).toBe(false);
    });

    it('allows hospital_admin to access forecasting, mythbusting, certificates', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['hospital_admin'] }, 'forecasting', map)).toBe(true);
        expect(canAccessView({ roles: ['hospital_admin'] }, 'mythbusting', map)).toBe(true);
        expect(canAccessView({ roles: ['hospital_admin'] }, 'certificates', map)).toBe(true);
    });

    it('blocks nurse/lab_tech/reception from accessing forecasting, mythbusting, certificates', () => {
        const { canAccessView } = require('./roleGating');
        ['nurse', 'lab_tech', 'reception'].forEach(role => {
            expect(canAccessView({ roles: [role] }, 'forecasting', map)).toBe(false);
            expect(canAccessView({ roles: [role] }, 'mythbusting', map)).toBe(false);
            expect(canAccessView({ roles: [role] }, 'certificates', map)).toBe(false);
        });
    });

    it('Lab & Testing: allows lab_tech and hospital_admin; blocks nurse and reception', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['lab_tech'] }, 'lab', map)).toBe(true);
        expect(canAccessView({ roles: ['hospital_admin'] }, 'lab', map)).toBe(true);
        expect(canAccessView({ roles: ['nurse'] }, 'lab', map)).toBe(false);
        expect(canAccessView({ roles: ['reception'] }, 'lab', map)).toBe(false);
    });

    it('My Requests: allows nurse and hospital_admin; blocks lab_tech and reception', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['nurse'] }, 'requests', map)).toBe(true);
        expect(canAccessView({ roles: ['hospital_admin'] }, 'requests', map)).toBe(true);
        expect(canAccessView({ roles: ['lab_tech'] }, 'requests', map)).toBe(false);
        expect(canAccessView({ roles: ['reception'] }, 'requests', map)).toBe(false);
    });

    it('Hemovigilance: allows nurse, lab_tech, and hospital_admin; blocks reception', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['nurse'] }, 'hemovigilance', map)).toBe(true);
        expect(canAccessView({ roles: ['lab_tech'] }, 'hemovigilance', map)).toBe(true);
        expect(canAccessView({ roles: ['hospital_admin'] }, 'hemovigilance', map)).toBe(true);
        expect(canAccessView({ roles: ['reception'] }, 'hemovigilance', map)).toBe(false);
    });

    it('Incoming Donors: allows reception, nurse, and hospital_admin; blocks lab_tech', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['reception'] }, 'donors', map)).toBe(true);
        expect(canAccessView({ roles: ['nurse'] }, 'donors', map)).toBe(true);
        expect(canAccessView({ roles: ['hospital_admin'] }, 'donors', map)).toBe(true);
        expect(canAccessView({ roles: ['lab_tech'] }, 'donors', map)).toBe(false);
    });

    it('Inventory: allows nurse, lab_tech, and hospital_admin; blocks reception', () => {
        const { canAccessView } = require('./roleGating');
        expect(canAccessView({ roles: ['nurse'] }, 'inventory', map)).toBe(true);
        expect(canAccessView({ roles: ['lab_tech'] }, 'inventory', map)).toBe(true);
        expect(canAccessView({ roles: ['hospital_admin'] }, 'inventory', map)).toBe(true);
        expect(canAccessView({ roles: ['reception'] }, 'inventory', map)).toBe(false);
    });

    it('Inventory Button Gating: Add/Issue allowed for lab_tech & admin; blocked for nurse & reception', () => {
        expect(hasAnyRole({ roles: ['lab_tech'] }, ['lab_tech', 'hospital_admin'])).toBe(true);
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['lab_tech', 'hospital_admin'])).toBe(true);
        expect(hasAnyRole({ roles: ['nurse'] }, ['lab_tech', 'hospital_admin'])).toBe(false);
        expect(hasAnyRole({ roles: ['reception'] }, ['lab_tech', 'hospital_admin'])).toBe(false);
    });

    it('Inventory Button Gating: Remove/Thresh/Transfer allowed for hospital_admin ONLY', () => {
        expect(hasAnyRole({ roles: ['hospital_admin'] }, ['hospital_admin'])).toBe(true);
        expect(hasAnyRole({ roles: ['lab_tech'] }, ['hospital_admin'])).toBe(false);
        expect(hasAnyRole({ roles: ['nurse'] }, ['hospital_admin'])).toBe(false);
        expect(hasAnyRole({ roles: ['reception'] }, ['hospital_admin'])).toBe(false);
    });
});
