import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { hashPin } from './staffPin';

/**
 * The Firestore mock models the four collections this module touches:
 *   users/{uid}                         hospital display name lookup
 *   hospitals/{hid}/staff/{uid}         the staff record (holds the PIN hash)
 *   staff_index/{email}                 email -> {hospitalId, staffUid} routing
 *   staff_login_attempts/{key}          persisted lockout counter
 *
 * Attempt counters are backed by a real in-memory store rather than a bare
 * vi.fn(), because the lockout logic reads its own previous writes — a stub that
 * always returns "no document" would make every attempt look like the first and
 * the lockout tests would pass vacuously.
 */
const mocks = vi.hoisted(() => {
  const attemptStore = new Map<string, Record<string, unknown>>();
  return {
    attemptStore,
    createUser: vi.fn(),
    getUser: vi.fn(),
    getUserByEmail: vi.fn(),
    setCustomUserClaims: vi.fn(),
    createCustomToken: vi.fn(),
    writeAudit: vi.fn(),
    staffDocGet: vi.fn(),
    staffDocSet: vi.fn(),
    userDocGet: vi.fn(),
    userDocSet: vi.fn(),
    staffIndexGet: vi.fn(),
    staffIndexSet: vi.fn(),
    collectionGroupGet: vi.fn(),
  };
});

vi.mock('./firebaseAdmin', () => ({
  auth: {
    createUser: mocks.createUser,
    getUser: mocks.getUser,
    getUserByEmail: mocks.getUserByEmail,
    setCustomUserClaims: mocks.setCustomUserClaims,
    createCustomToken: mocks.createCustomToken,
  },
  db: {
    collection: (collName: string) => {
      if (collName === 'hospitals') {
        return {
          doc: () => ({
            collection: () => ({
              doc: () => ({ set: mocks.staffDocSet, get: mocks.staffDocGet }),
            }),
          }),
        };
      }
      if (collName === 'staff_index') {
        return { doc: () => ({ get: mocks.staffIndexGet, set: mocks.staffIndexSet }) };
      }
      if (collName === 'staff_login_attempts') {
        return {
          doc: (key: string) => ({
            _key: key, // consumed by the runTransaction stub below
            get: async () => ({
              exists: mocks.attemptStore.has(key),
              data: () => mocks.attemptStore.get(key),
            }),
            delete: async () => { mocks.attemptStore.delete(key); },
          }),
        };
      }
      return { doc: () => ({ set: mocks.userDocSet, get: mocks.userDocGet }) };
    },
    collectionGroup: () => ({
      where: () => ({ limit: () => ({ get: mocks.collectionGroupGet }) }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Single-threaded test harness: read-your-writes against attemptStore is
      // sufficient to exercise the counter's increment/window/lockout logic.
      let currentKey = '';
      const tx = {
        get: async (ref: { _key: string }) => {
          currentKey = ref._key;
          return { exists: mocks.attemptStore.has(currentKey), data: () => mocks.attemptStore.get(currentKey) };
        },
        set: (ref: { _key: string }, data: Record<string, unknown>) => {
          mocks.attemptStore.set(ref._key, { ...(mocks.attemptStore.get(ref._key) ?? {}), ...data });
        },
      };
      return fn(tx);
    },
  },
}));

vi.mock('./audit', () => ({ writeAudit: mocks.writeAudit }));

import {
  createStaffAccountHandler,
  verifyStaffPinHandler,
  authenticateStaffDirectLoginHandler,
} from './staffManagement';

function req(authData?: { uid: string; token?: Record<string, unknown> }, data?: unknown): CallableRequest {
  return {
    auth: authData
      ? { uid: authData.uid, token: (authData.token ?? {}) as unknown as CallableRequest['auth'] }
      : undefined,
    data: data ?? {},
  } as CallableRequest;
}

const hospitalDoc = { exists: true, data: () => ({ name: 'Buea Regional Hospital', city: 'Buea' }) };

describe('staffManagement Cloud Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.attemptStore.clear();
    mocks.userDocGet.mockResolvedValue(hospitalDoc);
    mocks.staffIndexGet.mockResolvedValue({ exists: false, data: () => undefined });
    mocks.collectionGroupGet.mockResolvedValue({ empty: true, docs: [] });
    mocks.staffDocSet.mockResolvedValue({});
    mocks.userDocSet.mockResolvedValue({});
    mocks.staffIndexSet.mockResolvedValue({});
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

      const result = await createStaffAccountHandler(
        req(
          { uid: 'admin1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
          { name: 'Ngu Patricia', email: 'Patricia@Hospital.CM', roles: ['nurse', 'lab_tech'], pin: '1234' },
        ),
      );

      expect(result).toMatchObject({
        success: true,
        staffUid: 'staff123',
        roles: ['nurse', 'lab_tech'],
        hospitalId: 'H1',
        hospitalName: 'Buea Regional Hospital',
      });

      expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('staff123', {
        roles: ['nurse', 'lab_tech'],
        role: 'nurse',
        hospitalId: 'H1',
        staffUid: 'staff123',
      });
    });

    it('stamps hospitalName on BOTH the staff record and the users doc', async () => {
      // Regression guard for the "receptionist's dashboard is blank" bug: every
      // hospital-scoped query keys on the hospital NAME, and without this the
      // client fell back to the staff member's own name.
      mocks.createUser.mockResolvedValueOnce({ uid: 'staff123' });

      await createStaffAccountHandler(
        req(
          { uid: 'admin1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
          { name: 'Ngu Patricia', email: 'patricia@hospital.cm', roles: ['reception'], pin: '1234' },
        ),
      );

      expect(mocks.staffDocSet).toHaveBeenCalledWith(
        expect.objectContaining({ hospitalName: 'Buea Regional Hospital', hospitalId: 'H1' }),
      );
      expect(mocks.userDocSet).toHaveBeenCalledWith(
        expect.objectContaining({ hospitalName: 'Buea Regional Hospital', hospitalId: 'H1' }),
        { merge: true },
      );
    });

    it('refuses to create staff for a hospital with no name on file', async () => {
      mocks.userDocGet.mockResolvedValue({ exists: true, data: () => ({}) });
      await expect(
        createStaffAccountHandler(
          req(
            { uid: 'admin1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
            { name: 'Ngu Patricia', email: 'patricia@hospital.cm', roles: ['nurse'] },
          ),
        ),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    });

    it('never writes the PIN in plaintext and never reuses a salt', async () => {
      mocks.createUser.mockResolvedValueOnce({ uid: 'a1' });
      await createStaffAccountHandler(
        req({ uid: 'admin1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
            { name: 'Alice Ako', email: 'a@h.cm', roles: ['nurse'], pin: '1234' }),
      );
      mocks.createUser.mockResolvedValueOnce({ uid: 'b1' });
      await createStaffAccountHandler(
        req({ uid: 'admin1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
            { name: 'Bertrand Bih', email: 'b@h.cm', roles: ['nurse'], pin: '1234' }),
      );

      const [first] = mocks.staffDocSet.mock.calls[0];
      const [second] = mocks.staffDocSet.mock.calls[1];
      expect(JSON.stringify(first)).not.toContain('1234');
      expect(first.pinSalt).not.toEqual(second.pinSalt);
      // Identical PINs must not produce identical hashes — that is the whole
      // point of the per-account salt, and what the old unsalted SHA-256 lacked.
      expect(first.pinHash).not.toEqual(second.pinHash);
    });
  });

  describe('verifyStaffPinHandler', () => {
    it('locks out account after 5 consecutive failed PIN attempts and audits STAFF_PIN_FAILED', async () => {
      const record = await hashPin('1234');
      mocks.staffDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ uid: 's1', name: 'Tech John', active: true, hospitalName: 'Buea Regional Hospital', ...record }),
      });

      for (let i = 1; i <= 4; i++) {
        await expect(
          verifyStaffPinHandler(
            req({ uid: 's1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
                { staffUid: 's1', pin: '0000', hospitalId: 'H1' }),
          ),
        ).rejects.toThrow(/Incorrect 4-digit PIN/);
      }

      await expect(
        verifyStaffPinHandler(
          req({ uid: 's1', token: { role: 'hospital_staff', hospitalId: 'H1' } },
              { staffUid: 's1', pin: '0000', hospitalId: 'H1' }),
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

    it('accepts the correct PIN against a salted scrypt record', async () => {
      const record = await hashPin('4321');
      mocks.staffDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ uid: 's1', name: 'Tech John', roles: ['lab_tech'], active: true, hospitalName: 'Buea Regional Hospital', ...record }),
      });

      const res = await verifyStaffPinHandler(
        req({ uid: 'h1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
            { staffUid: 's1', pin: '4321', hospitalId: 'H1' }),
      );
      expect(res).toMatchObject({ success: true, staffUid: 's1', roles: ['lab_tech'] });
    });

    it('rejects a deactivated staff member even with the right PIN', async () => {
      const record = await hashPin('4321');
      mocks.staffDocGet.mockResolvedValue({
        exists: true,
        data: () => ({ uid: 's1', name: 'Tech John', active: false, ...record }),
      });
      await expect(
        verifyStaffPinHandler(
          req({ uid: 'h1', token: { role: 'hospital_admin', hospitalId: 'H1' } },
              { staffUid: 's1', pin: '4321', hospitalId: 'H1' }),
        ),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });

  describe('authenticateStaffDirectLoginHandler', () => {
    const staffRecord = (extra: Record<string, unknown> = {}) => ({
      uid: 's1',
      name: 'Ngu Patricia',
      email: 'patricia@hospital.cm',
      roles: ['reception'],
      hospitalId: 'H1',
      hospitalName: 'Buea Regional Hospital',
      active: true,
      ...extra,
    });

    it('is callable while unauthenticated — it IS the sign-in path', async () => {
      const record = await hashPin('1234');
      mocks.staffIndexGet.mockResolvedValue({ exists: true, data: () => ({ hospitalId: 'H1', staffUid: 's1' }) });
      mocks.staffDocGet.mockResolvedValue({ exists: true, data: () => staffRecord(record) });
      mocks.getUser.mockResolvedValue({ uid: 's1' });
      mocks.createCustomToken.mockResolvedValue('CUSTOM_TOKEN');

      const res = await authenticateStaffDirectLoginHandler(
        req(undefined, { email: 'patricia@hospital.cm', pin: '1234' }),
      );
      expect(res).toMatchObject({ success: true, token: 'CUSTOM_TOKEN', hospitalId: 'H1', hospitalName: 'Buea Regional Hospital' });
    });

    it('sets custom claims on login, repairing accounts the old client fallback left claimless', async () => {
      const record = await hashPin('1234');
      mocks.staffIndexGet.mockResolvedValue({ exists: true, data: () => ({ hospitalId: 'H1', staffUid: 's1' }) });
      mocks.staffDocGet.mockResolvedValue({ exists: true, data: () => staffRecord(record) });
      mocks.getUser.mockResolvedValue({ uid: 's1' });
      mocks.createCustomToken.mockResolvedValue('T');

      await authenticateStaffDirectLoginHandler(req(undefined, { email: 'patricia@hospital.cm', pin: '1234' }));

      expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('s1', {
        roles: ['reception'],
        role: 'reception',
        hospitalId: 'H1',
        staffUid: 's1',
      });
    });

    it('returns the SAME error for an unknown email and a wrong PIN (no account oracle)', async () => {
      const record = await hashPin('1234');
      mocks.staffIndexGet.mockResolvedValue({ exists: true, data: () => ({ hospitalId: 'H1', staffUid: 's1' }) });
      mocks.staffDocGet.mockResolvedValue({ exists: true, data: () => staffRecord(record) });
      const wrongPin = await authenticateStaffDirectLoginHandler(
        req(undefined, { email: 'patricia@hospital.cm', pin: '9999' }),
      ).catch((e: Error) => e.message);

      mocks.attemptStore.clear();
      mocks.staffIndexGet.mockResolvedValue({ exists: false, data: () => undefined });
      mocks.collectionGroupGet.mockResolvedValue({ empty: true, docs: [] });
      const unknownEmail = await authenticateStaffDirectLoginHandler(
        req(undefined, { email: 'nobody@hospital.cm', pin: '1234' }),
      ).catch((e: Error) => e.message);

      expect(wrongPin).toEqual(unknownEmail);
    });

    it('locks out after 5 failed attempts, and the counter survives across calls', async () => {
      const record = await hashPin('1234');
      mocks.staffIndexGet.mockResolvedValue({ exists: true, data: () => ({ hospitalId: 'H1', staffUid: 's1' }) });
      mocks.staffDocGet.mockResolvedValue({ exists: true, data: () => staffRecord(record) });

      for (let i = 1; i <= 4; i++) {
        await expect(
          authenticateStaffDirectLoginHandler(req(undefined, { email: 'patricia@hospital.cm', pin: '0000' })),
        ).rejects.toThrow(/Incorrect email or 4-digit PIN/);
      }
      await expect(
        authenticateStaffDirectLoginHandler(req(undefined, { email: 'patricia@hospital.cm', pin: '0000' })),
      ).rejects.toThrow(/locked for 15 minutes/);

      // Even the CORRECT pin is refused while locked out.
      await expect(
        authenticateStaffDirectLoginHandler(req(undefined, { email: 'patricia@hospital.cm', pin: '1234' })),
      ).rejects.toMatchObject({ code: 'resource-exhausted' });
    });

    it('accepts a legacy unsalted SHA-256 hash once, then upgrades it to scrypt', async () => {
      // Migration path: existing staff must not be locked out by the new scheme.
      const legacyHash = createHash('sha256').update('VitalPulse_PIN_1234').digest('hex');
      mocks.staffIndexGet.mockResolvedValue({ exists: true, data: () => ({ hospitalId: 'H1', staffUid: 's1' }) });
      mocks.staffDocGet.mockResolvedValue({ exists: true, data: () => staffRecord({ pinHash: legacyHash }) });
      mocks.getUser.mockResolvedValue({ uid: 's1' });
      mocks.createCustomToken.mockResolvedValue('T');

      const res = await authenticateStaffDirectLoginHandler(
        req(undefined, { email: 'patricia@hospital.cm', pin: '1234' }),
      );
      expect(res).toMatchObject({ success: true });

      const upgrade = mocks.staffDocSet.mock.calls.find(([data]) => data.pinAlgo);
      expect(upgrade).toBeTruthy();
      expect(upgrade![0].pinSalt).toBeTruthy();
      expect(upgrade![0].pinHash).not.toEqual(legacyHash);
    });

    it('rejects a deactivated staff account', async () => {
      const record = await hashPin('1234');
      mocks.staffIndexGet.mockResolvedValue({ exists: true, data: () => ({ hospitalId: 'H1', staffUid: 's1' }) });
      mocks.staffDocGet.mockResolvedValue({ exists: true, data: () => staffRecord({ ...record, active: false }) });
      await expect(
        authenticateStaffDirectLoginHandler(req(undefined, { email: 'patricia@hospital.cm', pin: '1234' })),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('rejects a malformed PIN before touching the database', async () => {
      await expect(
        authenticateStaffDirectLoginHandler(req(undefined, { email: 'patricia@hospital.cm', pin: 'abcd' })),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
      expect(mocks.staffIndexGet).not.toHaveBeenCalled();
    });
  });
});
