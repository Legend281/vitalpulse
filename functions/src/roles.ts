/**
 * VitalPulse role model — Security Master Plan Part 1.2.
 * This is the ONLY place role names and grant permissions are defined;
 * grantRole/revokeRole must not duplicate this logic.
 */

export const ROLES = [
  'donor',
  'reception',
  'nurse',
  'hospital_staff',
  'lab_tech',
  'hospital_admin',
  'system_admin',
  'nbtp_viewer',
] as const;

export type Role = (typeof ROLES)[number];

/** Roles that must carry a hospitalId claim scoping them to one hospital. */
export const HOSPITAL_SCOPED_ROLES: readonly Role[] = [
  'reception',
  'nurse',
  'hospital_staff',
  'lab_tech',
  'hospital_admin',
];

export function isHospitalScopedRole(role: Role): boolean {
  return HOSPITAL_SCOPED_ROLES.includes(role);
}

export interface CallerClaims {
  /** Array of active roles granted to this account. Primary role model. */
  roles?: Role[];
  /** Legacy single-role field maintained for backwards compatibility. */
  role?: Role;
  hospitalId?: string;
  staffUid?: string;
  suspended?: boolean;
  hospitalSuspendedAt?: string;
  kycStatus?: 'pending' | 'verified' | 'rejected';
}

/**
 * Checks whether `caller` possesses at least one of the `allowedRoles`.
 */
export function hasAnyRole(caller: CallerClaims, allowedRoles: Role[]): boolean {
  if (caller.suspended) return false;
  const callerRoles: Role[] =
    caller.roles && caller.roles.length > 0
      ? caller.roles
      : caller.role
        ? [caller.role]
        : [];
  return callerRoles.some((r) => allowedRoles.includes(r));
}

/**
 * Can `caller` grant/revoke `targetRole` (optionally scoped to `targetHospitalId`)?
 */
export function canGrant(
  caller: CallerClaims,
  targetRole: Role,
  targetHospitalId: string | undefined,
): { allowed: true } | { allowed: false; reason: string } {
  if (caller.suspended) {
    return { allowed: false, reason: 'Caller account is suspended.' };
  }

  if (hasAnyRole(caller, ['system_admin'])) {
    return { allowed: true };
  }

  if (hasAnyRole(caller, ['hospital_admin'])) {
    const validStaffRoles: Role[] = ['reception', 'nurse', 'hospital_staff', 'lab_tech'];
    if (!validStaffRoles.includes(targetRole)) {
      return {
        allowed: false,
        reason: 'hospital_admin may only grant reception, nurse, hospital_staff, or lab_tech.',
      };
    }
    if (!caller.hospitalId || targetHospitalId !== caller.hospitalId) {
      return {
        allowed: false,
        reason: 'hospital_admin may only grant roles scoped to their own hospital.',
      };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: 'Caller role is not authorized to grant roles.' };
}
