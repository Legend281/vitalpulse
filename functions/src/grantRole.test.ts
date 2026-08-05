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

import { grantRoleHandler } from './grantRole';
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
  mockAuth.getUser.mockResolvedValue({ uid: 'target-1', customClaims: {} });
});

describe('grantRoleHandler', () => {
  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(
      grantRoleHandler(req(undefined, { targetUid: 't1', role: 'donor' })),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('HOSTILE: rejects a malformed payload', async () => {
    await expect(
      grantRoleHandler(req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', role: 'not-a-real-role' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a whitespace-only targetUid', async () => {
    await expect(
      grantRoleHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: '   ', role: 'donor' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a hospitalId containing embedded whitespace', async () => {
    await expect(
      grantRoleHandler(
        req(
          { uid: 'admin-1', token: { role: 'system_admin' } },
          { targetUid: 't1', role: 'lab_tech', hospitalId: 'H1 H2' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects self-grant even by a system_admin', async () => {
    await expect(
      grantRoleHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 'admin-1', role: 'system_admin' }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects hospital_admin granting hospital_staff to another hospital', async () => {
    await expect(
      grantRoleHandler(
        req(
          { uid: 'hadmin-1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
          { targetUid: 't1', role: 'hospital_staff', hospitalId: 'H2' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects a hospital-scoped role grant missing hospitalId', async () => {
    await expect(
      grantRoleHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', role: 'lab_tech' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a global role grant that carries a hospitalId', async () => {
    await expect(
      grantRoleHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', role: 'donor', hospitalId: 'H1' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects when the target user does not exist', async () => {
    mockAuth.getUser.mockRejectedValue(new Error('no such user'));
    await expect(
      grantRoleHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 'ghost', role: 'donor' }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('system_admin successfully grants hospital_admin, revokes tokens, and audits', async () => {
    const result = await grantRoleHandler(
      req(
        { uid: 'admin-1', token: { role: 'system_admin' } },
        { targetUid: 't1', role: 'hospital_admin', hospitalId: 'H1' },
      ),
    );

    expect(result).toEqual({ success: true, role: 'hospital_admin', hospitalId: 'H1' });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', expect.objectContaining({ role: 'hospital_admin', hospitalId: 'H1' }));
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('t1');
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'admin-1',
      action: 'grantRole',
      targetUid: 't1',
      details: { actorRole: 'system_admin', role: 'hospital_admin', hospitalId: 'H1' },
    });
  });

  it('hospital_admin successfully grants lab_tech within their own hospital', async () => {
    const result = await grantRoleHandler(
      req(
        { uid: 'hadmin-1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
        { targetUid: 't1', role: 'lab_tech', hospitalId: 'H1' },
      ),
    );

    expect(result.success).toBe(true);
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', expect.objectContaining({ role: 'lab_tech', hospitalId: 'H1' }));
  });

  it('preserves an existing suspension when re-granting a role', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { suspended: true } });
    await grantRoleHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', role: 'donor' }),
    );
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', expect.objectContaining({ role: 'donor', suspended: true }));
  });
});
