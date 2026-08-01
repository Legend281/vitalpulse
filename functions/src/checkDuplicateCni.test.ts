import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const limit = vi.fn(() => ({ get }));
  const where = vi.fn(() => ({ limit }));
  const doc = vi.fn(() => ({ get }));
  const collection = vi.fn(() => ({ where, doc }));
  return { get, limit, where, doc, collection };
});

vi.mock('./firebaseAdmin', () => ({
  auth: {
    deleteUser: vi.fn(),
  },
  db: { collection: mocks.collection },
}));
vi.mock('./audit', () => ({ writeAudit: vi.fn() }));

import { checkDuplicateCniHandler } from './checkDuplicateCni';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';

const mockAuth = auth as unknown as { deleteUser: ReturnType<typeof vi.fn> };
const mockDb = db as unknown as { collection: typeof mocks.collection };

const VALID_HASH = 'a'.repeat(64);

function req(auth: { uid: string; token: Record<string, unknown> } | undefined, data: unknown): CallableRequest {
  return { auth, data } as unknown as CallableRequest;
}

function adminReq() {
  return req({ uid: 'admin-1', token: { role: 'system_admin' } }, { cniHash: VALID_HASH });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReset();
  mocks.get.mockResolvedValue({ empty: true });
});

describe('checkDuplicateCniHandler', () => {
  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(checkDuplicateCniHandler(req(undefined, { cniHash: VALID_HASH }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('HOSTILE: rejects a hash that is not 64 lowercase hex chars', async () => {
    for (const bad of ['abc', 'A'.repeat(64), 'g'.repeat(64), ' ', VALID_HASH.toUpperCase()]) {
      await expect(
        checkDuplicateCniHandler(req({ uid: 'donor-1', token: {} }, { cniHash: bad })),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects an empty payload', async () => {
    await expect(checkDuplicateCniHandler(req({ uid: 'donor-1', token: {} }, {}))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('queries users/cniHash with limit 1 and returns duplicate:false when free', async () => {
    const result = await checkDuplicateCniHandler(adminReq());

    expect(result).toEqual({ duplicate: false });
    expect(mocks.collection).toHaveBeenCalledWith('users');
    expect(mocks.where).toHaveBeenCalledWith('cniHash', '==', VALID_HASH);
    expect(mocks.limit).toHaveBeenCalledWith(1);
    expect(mockAuth.deleteUser).not.toHaveBeenCalled();
  });

  it('duplicate + caller mid-registration (no users doc): rolls back the account and audits', async () => {
    mocks.get
      .mockResolvedValueOnce({ empty: false })
      .mockResolvedValueOnce({ exists: false });

    const result = await checkDuplicateCniHandler(adminReq());

    expect(result).toEqual({ duplicate: true });
    expect(mockAuth.deleteUser).toHaveBeenCalledWith('admin-1');
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'admin-1',
      action: 'registrationDuplicateCniRollback',
      details: { actorRole: null },
    });
  });

  it('duplicate + caller HAS a users doc: duplicate reported but account NEVER deleted', async () => {
    mocks.get
      .mockResolvedValueOnce({ empty: false })
      .mockResolvedValueOnce({ exists: true, data: () => ({ role: 'donor' }) });

    const result = await checkDuplicateCniHandler(adminReq());

    expect(result).toEqual({ duplicate: true });
    expect(mockAuth.deleteUser).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
