import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => {
  const set = vi.fn();
  const get = vi.fn();
  const doc = vi.fn(() => ({ set, get }));
  const collection = vi.fn(() => ({ doc }));
  return { set, get, doc, collection };
});

vi.mock('./firebaseAdmin', () => ({
  auth: {
    getUser: vi.fn(),
    setCustomUserClaims: vi.fn(),
    revokeRefreshTokens: vi.fn(),
    listUsers: vi.fn(),
  },
  db: { collection: mocks.collection },
}));
vi.mock('./audit', () => ({ writeAudit: vi.fn() }));

import { setHospitalActiveHandler } from './hospitalStatus';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';

const mockAuth = auth as unknown as {
  getUser: ReturnType<typeof vi.fn>;
  setCustomUserClaims: ReturnType<typeof vi.fn>;
  revokeRefreshTokens: ReturnType<typeof vi.fn>;
  listUsers: ReturnType<typeof vi.fn>;
};
const mockDb = db as unknown as { collection: typeof mocks.collection };

function req(auth: { uid: string; token: Record<string, unknown> } | undefined, data: unknown): CallableRequest {
  return { auth, data } as unknown as CallableRequest;
}

function hospitalUser(uid: string, claims: Record<string, unknown>) {
  return { uid, customClaims: claims };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ exists: true, data: () => ({ role: 'hospital' }) });
  mockAuth.listUsers.mockResolvedValue({ users: [], pageToken: undefined });
});

describe('setHospitalActiveHandler', () => {
  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(setHospitalActiveHandler(req(undefined, { hospitalId: 'H1', active: false }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('HOSTILE: rejects a payload missing active', async () => {
    await expect(
      setHospitalActiveHandler(req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: 'H1' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a whitespace-only hospitalId', async () => {
    await expect(
      setHospitalActiveHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: '   ', active: false }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a reason longer than 500 characters', async () => {
    await expect(
      setHospitalActiveHandler(
        req(
          { uid: 'admin-1', token: { role: 'system_admin' } },
          { hospitalId: 'H1', active: false, reason: 'x'.repeat(501) },
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects self-deactivation even by a system_admin', async () => {
    await expect(
      setHospitalActiveHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: 'admin-1', active: false }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: a suspended system_admin cannot deactivate hospitals, and the target is never resolved', async () => {
    await expect(
      setHospitalActiveHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin', suspended: true } }, { hospitalId: 'H1', active: false }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it('HOSTILE: a donor cannot call it at all, and the target is never resolved (no existence oracle)', async () => {
    await expect(
      setHospitalActiveHandler(
        req({ uid: 'donor-1', token: { role: 'donor' } }, { hospitalId: 'some-real-id', active: false }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it('HOSTILE: a hospital_admin cannot call it', async () => {
    await expect(
      setHospitalActiveHandler(
        req({ uid: 'hadmin-1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { hospitalId: 'H2', active: false }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it('HOSTILE: a caller with no role claim cannot call it', async () => {
    await expect(
      setHospitalActiveHandler(req({ uid: 'nobody-1', token: {} }, { hospitalId: 'H1', active: false })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.collection).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects when the hospital users doc does not exist', async () => {
    mocks.get.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(
      setHospitalActiveHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: 'ghost', active: false }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HOSTILE: rejects when a Firestore read error occurs', async () => {
    mocks.get.mockRejectedValue(new Error('quota'));
    await expect(
      setHospitalActiveHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: 'H1', active: false }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HOSTILE: rejects a target that is not a hospital account', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ role: 'donor' }) });
    await expect(
      setHospitalActiveHandler(
        req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: 'donor-1', active: false }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('deactivates every account scoped to the hospital (including its own) and audits', async () => {
    mockAuth.listUsers.mockResolvedValue({
      users: [
        hospitalUser('staff-1', { role: 'hospital_staff', hospitalId: 'H1' }),
        hospitalUser('staff-2', { role: 'lab_tech', hospitalId: 'H1' }),
        hospitalUser('other-staff', { role: 'hospital_staff', hospitalId: 'H2' }),
        hospitalUser('h1-own', { role: 'hospital_admin', hospitalId: 'H1' }),
        hospitalUser('plain', { role: 'donor' }),
      ],
      pageToken: undefined,
    });

    const result = await setHospitalActiveHandler(
      req(
        { uid: 'admin-1', token: { role: 'system_admin' } },
        { hospitalId: 'H1', active: false, reason: 'license expired' },
      ),
    );

    expect(result).toEqual({ success: true, active: false, staffAffected: 3 });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('staff-1', {
      role: 'hospital_staff',
      hospitalId: 'H1',
      suspended: true,
      hospitalSuspendedAt: expect.any(String),
    });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('h1-own', {
      role: 'hospital_admin',
      hospitalId: 'H1',
      suspended: true,
      hospitalSuspendedAt: expect.any(String),
    });
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalledWith(
      expect.stringContaining('other'),
      expect.anything(),
    );
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalledWith('plain', expect.anything());
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledTimes(3);
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false, statusChangedAt: expect.anything() }),
      { merge: true },
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'admin-1',
      action: 'deactivateHospital',
      targetUid: 'H1',
      details: { actorRole: 'system_admin', staffAffected: 3, reason: 'license expired' },
    });
  });

  it('deactivates a hospital with no staff at all (still mirrors isActive and audits)', async () => {
    const result = await setHospitalActiveHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: 'H1', active: false }),
    );

    expect(result).toEqual({ success: true, active: false, staffAffected: 0 });
    expect(mocks.set).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'deactivateHospital', details: expect.objectContaining({ staffAffected: 0 }) }),
    );
  });

  it('processes every page when staff exceed a single listUsers page', async () => {
    mockAuth.listUsers
      .mockResolvedValueOnce({ users: [hospitalUser('s1', { role: 'hospital_staff', hospitalId: 'H1' })], pageToken: 'tok-2' })
      .mockResolvedValueOnce({ users: [hospitalUser('s2', { role: 'hospital_staff', hospitalId: 'H1' })], pageToken: undefined });

    const result = await setHospitalActiveHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: 'H1', active: false }),
    );

    expect(result).toEqual({ success: true, active: false, staffAffected: 2 });
    expect(mockAuth.listUsers).toHaveBeenCalledTimes(2);
  });

  it('reactivates only staff carrying the hospitalSuspendedAt marker — individual suspensions survive', async () => {
    mockAuth.listUsers.mockResolvedValue({
      users: [
        hospitalUser('s1', { role: 'hospital_staff', hospitalId: 'H1', suspended: true, hospitalSuspendedAt: '2026-07-01T00:00:00.000Z' }),
        hospitalUser('s2', { role: 'lab_tech', hospitalId: 'H1', suspended: true }),
        hospitalUser('s3', { role: 'hospital_staff', hospitalId: 'H1' }),
        hospitalUser('own', { role: 'hospital_admin', hospitalId: 'H1', suspended: true, hospitalSuspendedAt: '2026-07-01T00:00:00.000Z' }),
      ],
      pageToken: undefined,
    });

    const result = await setHospitalActiveHandler(
      req({ uid: 'admin-1', token: { role: 'system_admin' } }, { hospitalId: 'H1', active: true }),
    );

    expect(result).toEqual({ success: true, active: true, staffAffected: 2 });
    // s1/own: marker present -> suspension lifted, marker removed
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('s1', { role: 'hospital_staff', hospitalId: 'H1' });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('own', { role: 'hospital_admin', hospitalId: 'H1' });
    // s2: individually suspended (no marker) -> untouched
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalledWith('s2', expect.anything());
    // s3: never suspended -> untouched
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalledWith('s3', expect.anything());
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true, statusChangedAt: expect.anything() }),
      { merge: true },
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'admin-1',
      action: 'reactivateHospital',
      targetUid: 'H1',
      details: { actorRole: 'system_admin', staffAffected: 2, reason: null },
    });
  });
});
