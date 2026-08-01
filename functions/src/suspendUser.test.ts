import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => {
  const set = vi.fn();
  const doc = vi.fn(() => ({ set }));
  const collection = vi.fn(() => ({ doc }));
  return { set, doc, collection };
});

vi.mock('./firebaseAdmin', () => ({
  auth: {
    getUser: vi.fn(),
    setCustomUserClaims: vi.fn(),
    revokeRefreshTokens: vi.fn(),
  },
  db: { collection: mocks.collection },
}));
vi.mock('./audit', () => ({ writeAudit: vi.fn() }));

import { setUserSuspensionHandler } from './suspendUser';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';

const mockAuth = auth as unknown as {
  getUser: ReturnType<typeof vi.fn>;
  setCustomUserClaims: ReturnType<typeof vi.fn>;
  revokeRefreshTokens: ReturnType<typeof vi.fn>;
};
const mockDb = db as unknown as { collection: typeof mocks.collection };

function req(auth: { uid: string; token: Record<string, unknown> } | undefined, data: unknown): CallableRequest {
  return { auth, data } as unknown as CallableRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setUserSuspensionHandler', () => {
  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(setUserSuspensionHandler(req(undefined, { targetUid: 't1', suspend: true }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('HOSTILE: rejects a payload missing suspend', async () => {
    await expect(
      setUserSuspensionHandler(req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a whitespace-only targetUid', async () => {
    await expect(
      setUserSuspensionHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: '   ', suspend: true }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a targetUid containing embedded whitespace', async () => {
    await expect(
      setUserSuspensionHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1 t2', suspend: true }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a reason longer than 500 characters', async () => {
    await expect(
      setUserSuspensionHandler(
        req(
          { uid: 'admin-1', token: { role: 'system_admin' } },
          { targetUid: 't1', suspend: true, reason: 'x'.repeat(501) },
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects self-suspension even by a system_admin', async () => {
    await expect(
      setUserSuspensionHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 'admin-1', suspend: true }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: a suspended system_admin cannot suspend anyone, and the target is never resolved', async () => {
    await expect(
      setUserSuspensionHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin', suspended: true } }, { targetUid: 't1', suspend: true }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('HOSTILE: a donor cannot call suspendUser at all, and the target is never resolved (no existence oracle)', async () => {
    await expect(
      setUserSuspensionHandler(
        req({ uid: 'donor-1', token: { role: 'donor' } }, { targetUid: 'some-real-uid', suspend: true }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('HOSTILE: a hospital_admin cannot call suspendUser', async () => {
    await expect(
      setUserSuspensionHandler(
        req({ uid: 'hadmin-1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { targetUid: 't1', suspend: true }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('HOSTILE: a caller with no role claim cannot call suspendUser', async () => {
    await expect(
      setUserSuspensionHandler(req({ uid: 'nobody-1', token: {} }, { targetUid: 't1', suspend: true })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockAuth.getUser).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects when the target user does not exist', async () => {
    mockAuth.getUser.mockRejectedValue(new Error('no such user'));
    await expect(
      setUserSuspensionHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 'ghost', suspend: true }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('system_admin suspends a donor: claim flipped, tokens revoked, users doc mirrored, audited', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { role: 'donor' } });
    const result = await setUserSuspensionHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', suspend: true, reason: 'abusive behavior' }),
    );

    expect(result).toEqual({ success: true, suspended: true });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', { role: 'donor', hospitalId: null, suspended: true });
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('t1');
    expect(mocks.collection).toHaveBeenCalledWith('users');
    expect(mocks.doc).toHaveBeenCalledWith('t1');
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ isSuspended: true, isAvailable: false, statusChangedAt: expect.anything() }),
      { merge: true },
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'admin-1',
      action: 'suspendUser',
      targetUid: 't1',
      details: { actorRole: 'system_admin', previousSuspended: false, reason: 'abusive behavior' },
    });
  });

  it('suspending preserves an existing role and its hospital scope', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { role: 'hospital_staff', hospitalId: 'H1' } });
    await setUserSuspensionHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', suspend: true }),
    );
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', {
      role: 'hospital_staff',
      hospitalId: 'H1',
      suspended: true,
    });
  });

  it('suspending a user with no claims stores null placeholders (no orphan claims)', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: {} });
    await setUserSuspensionHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', suspend: true }),
    );
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', { role: null, hospitalId: null, suspended: true });
  });

  it('system_admin reactivates a donor: kill-switch claim cleared, doc mirrored, audited', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: { role: 'donor', suspended: true } });
    const result = await setUserSuspensionHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', suspend: false }),
    );

    expect(result).toEqual({ success: true, suspended: false });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', { role: 'donor', hospitalId: null });
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ isSuspended: false, isAvailable: true, statusChangedAt: expect.anything() }),
      { merge: true },
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'admin-1',
      action: 'reactivateUser',
      targetUid: 't1',
      details: { actorRole: 'system_admin', previousSuspended: true, reason: null },
    });
  });

  it('reactivation never re-grants a role that was stripped while suspended', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 't1', customClaims: {} });
    await setUserSuspensionHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { targetUid: 't1', suspend: false }),
    );
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('t1', { role: null, hospitalId: null });
  });
});

