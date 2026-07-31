import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

vi.mock('./firebaseAdmin', () => ({
  auth: {
    getUser: vi.fn(),
    setCustomUserClaims: vi.fn(),
    revokeRefreshTokens: vi.fn(),
  },
}));
vi.mock('./audit', () => ({ writeAudit: vi.fn() }));

import { revokeRoleHandler } from './revokeRole';
import { auth } from './firebaseAdmin';
import { writeAudit } from './audit';

const mockAuth = auth as unknown as {
  getUser: ReturnType<typeof vi.fn>;
  setCustomUserClaims: ReturnType<typeof vi.fn>;
  revokeRefreshTokens: ReturnType<typeof vi.fn>;
};

function req(auth: { uid: string; token: Record<string, unknown> } | undefined, data: unknown): CallableRequest {
  return { auth, data } as unknown as CallableRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('revokeRoleHandler', () => {
  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(revokeRoleHandler(req(undefined, { targetUid: 't1' }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('HOSTILE: rejects a malformed payload', async () => {
    await expect(
      revokeRoleHandler(req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: '' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a whitespace-only targetUid', async () => {
    await expect(
      revokeRoleHandler(req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: '   ' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a targetUid containing embedded whitespace', async () => {
    await expect(
      revokeRoleHandler(req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1 t2' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: a suspended system_admin cannot revoke anything, even a target with no existing role', async () => {
    // Regression test: this used to slip past the suspended check entirely,
    // because canGrant() (where suspended is checked) was only reached when
    // the target already had a role claim.
    await expect(
      revokeRoleHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin', suspended: true } }, { targetUid: 't1' }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('HOSTILE: a donor cannot call revokeRole at all, and the target is never resolved (no existence oracle)', async () => {
    await expect(
      revokeRoleHandler(req({ uid: 'donor-1', token: { role: 'donor' } }, { targetUid: 'some-real-uid' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('HOSTILE: an unauthenticated-role (no role claim at all) caller cannot call revokeRole', async () => {
    await expect(
      revokeRoleHandler(req({ uid: 'nobody-1', token: {} }, { targetUid: 'some-real-uid' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects self-revocation even by a system_admin', async () => {
    await expect(
      revokeRoleHandler(req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 'admin-1' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects when the target user does not exist', async () => {
    mockAuth.getUser.mockRejectedValue(new Error('no such user'));
    await expect(
      revokeRoleHandler(req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 'ghost' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HOSTILE: hospital_admin cannot revoke hospital_staff at a different hospital', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { role: 'hospital_staff', hospitalId: 'H2' } });
    await expect(
      revokeRoleHandler(
        req({ uid: 'hadmin-1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { targetUid: 't1' }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: hospital_admin cannot revoke another hospital_admin', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { role: 'hospital_admin', hospitalId: 'H1' } });
    await expect(
      revokeRoleHandler(
        req({ uid: 'hadmin-1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { targetUid: 't1' }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: a non-system_admin cannot revoke a target that has no role to begin with', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: {} });
    await expect(
      revokeRoleHandler(
        req({ uid: 'hadmin-1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { targetUid: 't1' }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('hospital_admin successfully revokes hospital_staff at their own hospital', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { role: 'hospital_staff', hospitalId: 'H1' } });
    const result = await revokeRoleHandler(
      req({ uid: 'hadmin-1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { targetUid: 't1' }),
    );

    expect(result).toEqual({ success: true, suspended: false });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', {});
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('t1');
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'hadmin-1',
      action: 'revokeRole',
      targetUid: 't1',
      details: { actorRole: 'hospital_admin', previousRole: 'hospital_staff', suspended: false },
    });
  });

  it('system_admin can revoke (no-op) a target that already has no role', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: {} });
    const result = await revokeRoleHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1' }),
    );
    expect(result).toEqual({ success: true, suspended: false });
  });

  it('suspend:true flips the kill-switch claim and records it in the audit event', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { role: 'donor' } });
    const result = await revokeRoleHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', suspend: true }),
    );

    expect(result).toEqual({ success: true, suspended: true });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', { suspended: true });
  });

  it('preserves a pre-existing suspension even when suspend is not requested again', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { role: 'donor', suspended: true } });
    const result = await revokeRoleHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1' }),
    );
    expect(result).toEqual({ success: true, suspended: true });
  });
});
