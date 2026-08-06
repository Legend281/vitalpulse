import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  setCustomUserClaims: vi.fn(),
  writeAudit: vi.fn(),
  staffDocGet: vi.fn(),
  staffDocSet: vi.fn(),
  userDocSet: vi.fn(),
}));

vi.mock('./firebaseAdmin', () => ({
  auth: {
    createUser: mocks.createUser,
    setCustomUserClaims: mocks.setCustomUserClaims,
  },
  db: {
    collection: (collName: string) => {
      if (collName === 'hospitals') {
        return {
          doc: (hId: string) => ({
            collection: (subColl: string) => ({
              doc: (sUid: string) => ({
                set: mocks.staffDocSet,
                get: mocks.staffDocGet,
              }),
            }),
          }),
        };
      }
      return {
        doc: (uId: string) => ({
          set: mocks.userDocSet,
        }),
      };
    },
  },
}));

vi.mock('./audit', () => ({
  writeAudit: mocks.writeAudit,
}));

import { createStaffAccountHandler, verifyStaffPinHandler } from './staffManagement';

function req(authData?: { uid: string; token?: Record<string, unknown> }, data?: unknown): CallableRequest {
  return {
    auth: authData
      ? {
          uid: authData.uid,
          token: (authData.token ?? {}) as unknown as CallableRequest['auth'],
        }
      : undefined,
    data: data ?? {},
  } as CallableRequest;
}

describe('staffManagement Cloud Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createStaffAccountHandler', () => {
    it('rejects unauthenticated callers', async () => {
      await expect(createStaffAccountHandler(req(undefined, {}))).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });

    it('rejects non-admin callers (e.g. donor)', async () => {
      await expect(
        createStaffAccountHandler(
          req({ uid: 'd1', token: { role: 'donor' } }, { name: 'Nurse Joy', email: 'nurse@vitalpulse.cm', roles: ['nurse'] }),
        ),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('creates staff account with multi-role claims and staff profile', async () => {
      mocks.createUser.mockResolvedValueOnce({ uid: 'staff123' });
      mocks.staffDocSet.mockResolvedValueOnce({});
      mocks.userDocSet.mockResolvedValueOnce({});

      const result = await createStaffAccountHandler(
        req(
          { uid: 'admin1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
          { name: 'Ngu Patricia', email: 'patricia@hospital.cm', roles: ['nurse', 'lab_tech'], pin: '1234' },
        ),
      );

      expect(result).toMatchObject({
        success: true,
        staffUid: 'staff123',
        roles: ['nurse', 'lab_tech'],
        hospitalId: 'H1',
      });

      expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('staff123', {
        roles: ['nurse', 'lab_tech'],
        role: 'nurse',
        hospitalId: 'H1',
        staffUid: 'staff123',
      });

      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'createStaffAccount',
          targetUid: 'staff123',
        }),
      );
    });
  });

  describe('verifyStaffPinHandler', () => {
    it('locks out account after 5 consecutive failed PIN attempts and audits STAFF_PIN_FAILED', async () => {
      mocks.staffDocGet.mockResolvedValue({
        exists: true,
        data: () => ({
          uid: 's1',
          name: 'Tech John',
          active: true,
          pinHash: 'WRONG_HASH',
        }),
      });

      for (let i = 1; i <= 4; i++) {
        await expect(
          verifyStaffPinHandler(
            req(
              { uid: 's1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
              { staffUid: 's1', pin: '0000', hospitalId: 'H1' },
            ),
          ),
        ).rejects.toThrow(/Incorrect 4-digit PIN/);
      }

      // 5th failed attempt triggers lockout
      await expect(
        verifyStaffPinHandler(
          req(
            { uid: 's1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
            { staffUid: 's1', pin: '0000', hospitalId: 'H1' },
          ),
        ),
      ).rejects.toThrow(/locked for 15 minutes/);

      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'STAFF_PIN_FAILED',
          targetUid: 's1',
          details: expect.objectContaining({ isLockedOut: true }),
        }),
      );
    });
  });
});
