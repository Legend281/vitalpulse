import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const set = vi.fn();
  const add = vi.fn();
  const doc = vi.fn(() => ({ get, create, update, set }));
  const collection = vi.fn(() => ({ doc, add }));
  const save = vi.fn();
  const file = vi.fn(() => ({ save }));
  const bucket = vi.fn(() => ({ file }));
  return { get, create, update, set, add, doc, collection, save, file, bucket };
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
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') },
}));
vi.mock('firebase-admin/storage', () => ({
  getStorage: vi.fn(() => ({ bucket: mocks.bucket })),
}));

import { bootstrapDonorAccountHandler, submitKycHandler, submitLivenessSelfieHandler, reviewDonorKycHandler } from './kyc';
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

const SMALL_BASE64 = Buffer.from('hello world').toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ exists: false, data: () => undefined });
});

describe('bootstrapDonorAccountHandler (onDonorSignUp)', () => {
  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(bootstrapDonorAccountHandler(req(undefined, {}))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('HOSTILE: rejects when the caller does not exist in Firebase Auth', async () => {
    mockAuth.getUser.mockRejectedValue(new Error('no such user'));
    await expect(bootstrapDonorAccountHandler(req({ uid: 'u1', token: {} }, {}))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('HOSTILE: refuses to re-bootstrap an account that already has a role (no self-reset)', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 'u1', customClaims: { role: 'donor', kycStatus: 'verified' } });
    await expect(bootstrapDonorAccountHandler(req({ uid: 'u1', token: {} }, {}))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('HOSTILE: refuses to re-bootstrap an account that already has a hospital role', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 'u1', customClaims: { role: 'hospital_staff', hospitalId: 'H1' } });
    await expect(bootstrapDonorAccountHandler(req({ uid: 'u1', token: {} }, {}))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('HOSTILE: refuses when a donors/{uid} record already exists (double-invocation)', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 'u1', customClaims: {} });
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    await expect(bootstrapDonorAccountHandler(req({ uid: 'u1', token: {} }, {}))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('bootstraps a fresh account: donor+pending claim, donors/{uid} created, tokens revoked, audited', async () => {
    mockAuth.getUser.mockResolvedValue({ uid: 'u1', customClaims: {} });
    const result = await bootstrapDonorAccountHandler(req({ uid: 'u1', token: {} }, {}));

    expect(result).toEqual({ success: true, kycStatus: 'pending' });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('u1', { role: 'donor', kycStatus: 'pending' });
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('u1');
    expect(mocks.collection).toHaveBeenCalledWith('donors');
    expect(mocks.doc).toHaveBeenCalledWith('u1');
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ kycStatus: 'pending', kycDocType: null, kycDocRef: null, kycSubmittedAt: null }),
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'u1',
      action: 'onDonorSignUp',
      targetUid: 'u1',
      details: { kycStatus: 'pending' },
    });
  });
});

describe('submitKycHandler', () => {
  // National ID requires both faces (schema-enforced) — validPayload includes both so the
  // existing HOSTILE/happy-path tests below exercise the realistic, most-restrictive case.
  const validPayload = {
    docType: 'national_id',
    fileBase64: SMALL_BASE64,
    fileName: 'id.jpg',
    mimeType: 'image/jpeg',
    fileBackBase64: SMALL_BASE64,
    fileNameBack: 'id-back.jpg',
    mimeTypeBack: 'image/jpeg',
  };

  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(submitKycHandler(req(undefined, validPayload))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('HOSTILE: rejects a suspended donor', async () => {
    await expect(
      submitKycHandler(req({ uid: 'd1', token: { role: 'donor', suspended: true } }, validPayload)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects a non-donor caller (e.g. hospital_staff)', async () => {
    await expect(
      submitKycHandler(req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, validPayload)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects a caller with no role claim', async () => {
    await expect(submitKycHandler(req({ uid: 'd1', token: {} }, validPayload))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('HOSTILE: rejects an invalid docType', async () => {
    await expect(
      submitKycHandler(req({ uid: 'd1', token: { role: 'donor' } }, { ...validPayload, docType: 'birth_certificate' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects an unsupported mimeType', async () => {
    await expect(
      submitKycHandler(req({ uid: 'd1', token: { role: 'donor' } }, { ...validPayload, mimeType: 'application/zip' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a file over the 5MB decoded-byte limit', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    await expect(
      submitKycHandler(req({ uid: 'd1', token: { role: 'donor' } }, { ...validPayload, fileBase64: oversized })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects when onDonorSignUp was never called (no donors/{uid} doc)', async () => {
    mocks.get.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(
      submitKycHandler(req({ uid: 'd1', token: { role: 'donor' } }, validPayload)),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('HOSTILE: rejects resubmission once already verified', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'verified' }) });
    await expect(
      submitKycHandler(req({ uid: 'd1', token: { role: 'donor', kycStatus: 'verified' } }, validPayload)),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('accepts a valid submission: uploads front+back to Storage, updates donors doc, queues admin review, audits', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    const result = await submitKycHandler(req({ uid: 'd1', token: { role: 'donor', kycStatus: 'pending' } }, validPayload));

    expect(result.success).toBe(true);
    expect(result.kycDocRef).toMatch(/^kyc\/d1\/national_id_\d+\.jpg$/);
    expect(result.kycDocBackRef).toMatch(/^kyc\/d1\/national_id_back_\d+\.jpg$/);
    expect(mocks.bucket).toHaveBeenCalled();
    expect(mocks.file).toHaveBeenCalledWith(result.kycDocRef);
    expect(mocks.file).toHaveBeenCalledWith(result.kycDocBackRef);
    expect(mocks.save).toHaveBeenCalledWith(expect.any(Buffer), { contentType: 'image/jpeg', resumable: false });
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        kycStatus: 'pending',
        kycDocType: 'national_id',
        kycDocBackRef: result.kycDocBackRef,
        kycRejectionReason: null,
      }),
    );
    expect(mocks.collection).toHaveBeenCalledWith('adminQueue');
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kyc_review', donorUid: 'd1', status: 'pending', kycDocBackRef: result.kycDocBackRef }),
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'd1',
      action: 'submitKYC',
      targetUid: 'd1',
      details: { docType: 'national_id', mimeType: 'image/jpeg', hasBack: true },
    });
  });

  it('HOSTILE: rejects a national_id submission missing the back image', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    const { fileBackBase64: _b, fileNameBack: _n, mimeTypeBack: _m, ...frontOnly } = validPayload;
    await expect(
      submitKycHandler(req({ uid: 'd1', token: { role: 'donor' } }, frontOnly)),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('does not require a back image for non-national_id doc types', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    const passportPayload = { docType: 'passport', fileBase64: SMALL_BASE64, fileName: 'passport.jpg', mimeType: 'image/jpeg' };
    const result = await submitKycHandler(req({ uid: 'd1', token: { role: 'donor', kycStatus: 'pending' } }, passportPayload));

    expect(result.success).toBe(true);
    expect(result.kycDocBackRef).toBeNull();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ kycDocBackRef: null }));
  });

  it('resubmission after rejection resets the claim to pending', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'rejected' }) });
    await submitKycHandler(req({ uid: 'd1', token: { role: 'donor', kycStatus: 'rejected' } }, validPayload));

    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('d1', { role: 'donor', kycStatus: 'pending' });
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('d1');
  });

  it('does not touch the custom claim when already pending (no redundant token revocation)', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    await submitKycHandler(req({ uid: 'd1', token: { role: 'donor', kycStatus: 'pending' } }, validPayload));
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
  });
});

describe('submitLivenessSelfieHandler', () => {
  const validPayload = { fileBase64: SMALL_BASE64, mimeType: 'image/jpeg' };

  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(submitLivenessSelfieHandler(req(undefined, validPayload))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('HOSTILE: rejects a suspended donor', async () => {
    await expect(
      submitLivenessSelfieHandler(req({ uid: 'd1', token: { role: 'donor', suspended: true } }, validPayload)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects a non-donor caller (e.g. hospital_staff)', async () => {
    await expect(
      submitLivenessSelfieHandler(req({ uid: 'h1', token: { role: 'hospital_staff', hospitalId: 'H1' } }, validPayload)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects a caller with no role claim', async () => {
    await expect(submitLivenessSelfieHandler(req({ uid: 'd1', token: {} }, validPayload))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('HOSTILE: rejects a non-JPEG mimeType (e.g. a PNG/PDF smuggled in as the "liveness" file)', async () => {
    await expect(
      submitLivenessSelfieHandler(req({ uid: 'd1', token: { role: 'donor' } }, { ...validPayload, mimeType: 'image/png' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a file over the 5MB decoded-byte limit', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    await expect(
      submitLivenessSelfieHandler(req({ uid: 'd1', token: { role: 'donor' } }, { ...validPayload, fileBase64: oversized })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects when onDonorSignUp was never called (no donors/{uid} doc)', async () => {
    mocks.get.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(
      submitLivenessSelfieHandler(req({ uid: 'd1', token: { role: 'donor' } }, validPayload)),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('HOSTILE: rejects resubmission once already verified', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'verified' }) });
    await expect(
      submitLivenessSelfieHandler(req({ uid: 'd1', token: { role: 'donor', kycStatus: 'verified' } }, validPayload)),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('accepts a valid submission: uploads to Storage, updates donors doc, syncs admin queue, audits', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    const result = await submitLivenessSelfieHandler(req({ uid: 'd1', token: { role: 'donor', kycStatus: 'pending' } }, validPayload));

    expect(result.success).toBe(true);
    expect(result.livenessSelfieRef).toMatch(/^kyc\/d1\/liveness_\d+\.jpg$/);
    expect(mocks.bucket).toHaveBeenCalled();
    expect(mocks.file).toHaveBeenCalledWith(result.livenessSelfieRef);
    expect(mocks.save).toHaveBeenCalledWith(expect.any(Buffer), { contentType: 'image/jpeg', resumable: false });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ livenessSelfieRef: result.livenessSelfieRef }),
    );
    expect(mocks.collection).toHaveBeenCalledWith('adminQueue');
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ livenessSelfieRef: result.livenessSelfieRef }),
      { merge: true },
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'd1',
      action: 'submitLivenessSelfie',
      targetUid: 'd1',
      details: { mimeType: 'image/jpeg' },
    });
  });
});

describe('reviewDonorKycHandler', () => {
  it('HOSTILE: rejects unauthenticated callers', async () => {
    await expect(reviewDonorKycHandler(req(undefined, { targetUid: 'd1' }), 'verified')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('HOSTILE: rejects a suspended system_admin', async () => {
    await expect(
      reviewDonorKycHandler(
        req({ uid: 'a1', token: { role: 'system_admin', suspended: true } }, { targetUid: 'd1' }),
        'verified',
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects a non-system_admin caller (e.g. hospital_admin)', async () => {
    await expect(
      reviewDonorKycHandler(
        req({ uid: 'h1', token: { role: 'hospital_admin', hospitalId: 'H1' } }, { targetUid: 'd1' }),
        'verified',
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects a donor reviewing their own KYC', async () => {
    await expect(
      reviewDonorKycHandler(req({ uid: 'd1', token: { role: 'donor' } }, { targetUid: 'd1' }), 'verified'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('HOSTILE: rejects a malformed payload (missing targetUid)', async () => {
    await expect(
      reviewDonorKycHandler(req({ uid: 'a1', token: { role: 'system_admin' } }, {}), 'verified'),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects when no donors/{uid} record exists', async () => {
    mocks.get.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(
      reviewDonorKycHandler(req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1' }), 'verified'),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HOSTILE: rejects re-verifying an already-verified donor (no-op guard)', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'verified' }) });
    await expect(
      reviewDonorKycHandler(req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1' }), 'verified'),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('HOSTILE: rejects when the Firestore donors/{uid} record exists but the target has since been deleted from Firebase Auth (data-integrity drift, not a crash)', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    mockAuth.getUser.mockRejectedValue(new Error('no such user'));
    await expect(
      reviewDonorKycHandler(req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1' }), 'verified'),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects reviewing a target whose Auth claim is not actually a donor', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    mockAuth.getUser.mockResolvedValue({ uid: 'd1', customClaims: { role: 'hospital_staff', hospitalId: 'H1' } });
    await expect(
      reviewDonorKycHandler(req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1' }), 'verified'),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('HOSTILE: rejects verifying a donor with no identity document submitted', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending', livenessSelfieRef: 'kyc/d1/liveness_1.jpg' }) });
    mockAuth.getUser.mockResolvedValue({ uid: 'd1', customClaims: { role: 'donor', kycStatus: 'pending' } });
    await expect(
      reviewDonorKycHandler(req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1' }), 'verified'),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects verifying a donor with no liveness selfie submitted', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending', kycDocRef: 'kyc/d1/national_id_1.jpg' }) });
    mockAuth.getUser.mockResolvedValue({ uid: 'd1', customClaims: { role: 'donor', kycStatus: 'pending' } });
    await expect(
      reviewDonorKycHandler(req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1' }), 'verified'),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('allows rejecting a donor even with no evidence submitted at all (no evidence gate on rejection)', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    mockAuth.getUser.mockResolvedValue({ uid: 'd1', customClaims: { role: 'donor', kycStatus: 'pending' } });
    const result = await reviewDonorKycHandler(
      req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1', reason: 'Never completed onboarding' }),
      'rejected',
    );
    expect(result).toEqual({ success: true, kycStatus: 'rejected' });
  });

  it('verifies a pending donor: claim set, tokens revoked, doc updated, queue updated, notified, audited', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({ kycStatus: 'pending', kycDocRef: 'kyc/d1/national_id_1.jpg', livenessSelfieRef: 'kyc/d1/liveness_1.jpg' }),
    });
    mockAuth.getUser.mockResolvedValue({ uid: 'd1', customClaims: { role: 'donor', kycStatus: 'pending' } });

    const result = await reviewDonorKycHandler(
      req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1' }),
      'verified',
    );

    expect(result).toEqual({ success: true, kycStatus: 'verified' });
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('d1', {
      role: 'donor',
      hospitalId: undefined,
      suspended: false,
      kycStatus: 'verified',
    });
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('d1');
    expect(mocks.update).toHaveBeenCalledWith({ kycStatus: 'verified', kycRejectionReason: null });
    expect(mocks.collection).toHaveBeenCalledWith('donor_notifications');
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ donorId: 'd1', type: 'success', title: expect.stringContaining('verified') }),
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'a1',
      action: 'verifyDonor',
      targetUid: 'd1',
      details: { decision: 'verified', reason: null },
    });
  });

  it('rejects a pending donor with a reason: doc updated, notified with the reason, audited', async () => {
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ kycStatus: 'pending' }) });
    mockAuth.getUser.mockResolvedValue({ uid: 'd1', customClaims: { role: 'donor', kycStatus: 'pending' } });

    const result = await reviewDonorKycHandler(
      req({ uid: 'a1', token: { role: 'system_admin' } }, { targetUid: 'd1', reason: 'Photo unreadable' }),
      'rejected',
    );

    expect(result).toEqual({ success: true, kycStatus: 'rejected' });
    expect(mocks.update).toHaveBeenCalledWith({ kycStatus: 'rejected', kycRejectionReason: 'Photo unreadable' });
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ donorId: 'd1', type: 'warning', message: expect.stringContaining('Photo unreadable') }),
    );
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'a1',
      action: 'rejectDonorKyc',
      targetUid: 'd1',
      details: { decision: 'rejected', reason: 'Photo unreadable' },
    });
  });
});
