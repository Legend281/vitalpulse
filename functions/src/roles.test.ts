import { describe, expect, it } from 'vitest';
import { canGrant, isHospitalScopedRole } from './roles';

describe('isHospitalScopedRole', () => {
  it('flags hospital_staff, lab_tech, hospital_admin as hospital-scoped', () => {
    expect(isHospitalScopedRole('hospital_staff')).toBe(true);
    expect(isHospitalScopedRole('lab_tech')).toBe(true);
    expect(isHospitalScopedRole('hospital_admin')).toBe(true);
  });

  it('does not flag donor, system_admin, nbtp_viewer as hospital-scoped', () => {
    expect(isHospitalScopedRole('donor')).toBe(false);
    expect(isHospitalScopedRole('system_admin')).toBe(false);
    expect(isHospitalScopedRole('nbtp_viewer')).toBe(false);
  });
});

describe('canGrant — authorization matrix (Master Plan 1.2 separation of duties)', () => {
  it('system_admin can grant any role, anywhere', () => {
    const caller = { role: 'system_admin' as const };
    for (const role of ['donor', 'hospital_staff', 'lab_tech', 'hospital_admin', 'system_admin', 'nbtp_viewer'] as const) {
      const hospitalId = isHospitalScopedRole(role) ? 'H1' : undefined;
      expect(canGrant(caller, role, hospitalId)).toEqual({ allowed: true });
    }
  });

  it('HOSTILE: a suspended system_admin cannot grant anything', () => {
    const caller = { role: 'system_admin' as const, suspended: true };
    expect(canGrant(caller, 'donor', undefined).allowed).toBe(false);
  });

  it('hospital_admin can grant hospital_staff at their own hospital', () => {
    const caller = { role: 'hospital_admin' as const, hospitalId: 'H1' };
    expect(canGrant(caller, 'hospital_staff', 'H1')).toEqual({ allowed: true });
  });

  it('hospital_admin can grant lab_tech at their own hospital', () => {
    const caller = { role: 'hospital_admin' as const, hospitalId: 'H1' };
    expect(canGrant(caller, 'lab_tech', 'H1')).toEqual({ allowed: true });
  });

  it('HOSTILE: hospital_admin cannot grant hospital_staff at a different hospital', () => {
    const caller = { role: 'hospital_admin' as const, hospitalId: 'H1' };
    expect(canGrant(caller, 'hospital_staff', 'H2').allowed).toBe(false);
  });

  it('HOSTILE: hospital_admin cannot promote someone to hospital_admin', () => {
    const caller = { role: 'hospital_admin' as const, hospitalId: 'H1' };
    expect(canGrant(caller, 'hospital_admin', 'H1').allowed).toBe(false);
  });

  it('HOSTILE: hospital_admin cannot self-verify into system_admin', () => {
    const caller = { role: 'hospital_admin' as const, hospitalId: 'H1' };
    expect(canGrant(caller, 'system_admin', undefined).allowed).toBe(false);
  });

  it('HOSTILE: hospital_admin cannot grant nbtp_viewer', () => {
    const caller = { role: 'hospital_admin' as const, hospitalId: 'H1' };
    expect(canGrant(caller, 'nbtp_viewer', undefined).allowed).toBe(false);
  });

  it('HOSTILE: hospital_admin with no hospitalId claim cannot grant anything hospital-scoped', () => {
    const caller = { role: 'hospital_admin' as const };
    expect(canGrant(caller, 'hospital_staff', 'H1').allowed).toBe(false);
  });

  it.each(['donor', 'hospital_staff', 'lab_tech', 'nbtp_viewer'] as const)(
    'HOSTILE: %s cannot grant any role',
    (role) => {
      const caller = { role };
      expect(canGrant(caller, 'donor', undefined).allowed).toBe(false);
      expect(canGrant(caller, 'hospital_staff', 'H1').allowed).toBe(false);
    },
  );

  it('HOSTILE: an unauthenticated/roleless caller cannot grant anything', () => {
    expect(canGrant({}, 'donor', undefined).allowed).toBe(false);
  });
});
