/**
 * VitalPulse role model — Security Master Plan Part 1.2.
 * This is the ONLY place role names and grant permissions are defined;
 * grantRole/revokeRole must not duplicate this logic.
 */

export const ROLES = [
  'donor',
  'hospital_staff',
  'lab_tech',
  'hospital_admin',
  'system_admin',
  'nbtp_viewer',
] as const;

export type Role = (typeof ROLES)[number];

/** Roles that must carry a hospitalId claim scoping them to one hospital. */
export const HOSPITAL_SCOPED_ROLES: readonly Role[] = ['hospital_staff', 'lab_tech', 'hospital_admin'];

export function isHospitalScopedRole(role: Role): boolean {
  return HOSPITAL_SCOPED_ROLES.includes(role);
}

export interface CallerClaims {
  role?: Role;
  hospitalId?: string;
  suspended?: boolean;
  /** Set by deactivateHospital; reactivateHospital only clears suspensions carrying this marker. */
  hospitalSuspendedAt?: string;
  /** Donor-only. Mirrors donors/{uid}.kycStatus so rules/UI can gate on the token
   *  claim without an extra read. Set only by kyc.ts's Cloud Functions. */
  kycStatus?: 'pending' | 'verified' | 'rejected';
}

/**
 * Can `caller` grant/revoke `targetRole` (optionally scoped to `targetHospitalId`)?
 * Mirrors Master Plan 1.2 separation-of-duties + Policy 2.3 (no self-service elevation).
 */
export function canGrant(
  caller: CallerClaims,
  targetRole: Role,
  targetHospitalId: string | undefined,
): { allowed: true } | { allowed: false; reason: string } {
  if (caller.suspended) {
    return { allowed: false, reason: 'Caller account is suspended.' };
  }

  if (caller.role === 'system_admin') {
    return { allowed: true };
  }

  if (caller.role === 'hospital_admin') {
    if (targetRole !== 'hospital_staff' && targetRole !== 'lab_tech') {
      return {
        allowed: false,
        reason: 'hospital_admin may only grant hospital_staff or lab_tech.',
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
