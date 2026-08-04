import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const set = vi.fn();
  const update = vi.fn();
  const doc = vi.fn(() => ({ get, set, update }));
  const collection = vi.fn(() => ({ doc }));
  return { get, set, update, doc, collection };
});

vi.mock('./firebaseAdmin', () => ({
  auth: {
    getUserByEmail: vi.fn(),
    updateUser: vi.fn(),
    revokeRefreshTokens: vi.fn(),
  },
  db: { collection: mocks.collection },
}));
vi.mock('./audit', () => ({ writeAudit: vi.fn() }));
vi.mock('firebase-functions/params', () => ({
  defineSecret: vi.fn(() => ({ value: () => 'test-resend-api-key' })),
  defineString: vi.fn(() => ({ value: () => 'https://vitalpulse-fa458.web.app' })),
}));

import {
  requestPasswordResetHandler,
  checkPasswordResetTokenHandler,
  confirmPasswordResetHandler,
} from './passwordReset';
import { auth } from './firebaseAdmin';
import { writeAudit } from './audit';

const mockAuth = auth as unknown as {
  getUserByEmail: ReturnType<typeof vi.fn>;
  updateUser: ReturnType<typeof vi.fn>;
  revokeRefreshTokens: ReturnType<typeof vi.fn>;
};

function req(data: unknown): CallableRequest {
  return { auth: undefined, data } as unknown as CallableRequest;
}

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue({ ok: true, text: async () => '' });
  mocks.get.mockResolvedValue({ exists: false, data: () => undefined });
});
afterEach(() => vi.unstubAllGlobals());

describe('requestPasswordResetHandler', () => {
  it('HOSTILE: rejects an invalid email', async () => {
    await expect(requestPasswordResetHandler(req({ email: 'not-an-email' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects a payload carrying extra fields', async () => {
    await expect(
      requestPasswordResetHandler(req({ email: 'd1@example.com', newPassword: 'hunter2hunter2' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('does not require authentication — callable before any Firebase Auth session exists', async () => {
    mockAuth.getUserByEmail.mockRejectedValue(new Error('auth/user-not-found'));
    await expect(requestPasswordResetHandler(req({ email: 'nobody@example.com' }))).resolves.toEqual({
      success: true,
    });
  });

  it('ANTI-ENUMERATION: returns success without sending when no account exists for the email', async () => {
    mockAuth.getUserByEmail.mockRejectedValue(new Error('auth/user-not-found'));
    const result = await requestPasswordResetHandler(req({ email: 'nobody@example.com' }));
    expect(result).toEqual({ success: true });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('ANTI-ENUMERATION: returns success without sending for a disabled/suspended account', async () => {
    mockAuth.getUserByEmail.mockResolvedValue({ uid: 'd1', disabled: true });
    const result = await requestPasswordResetHandler(req({ email: 'd1@example.com' }));
    expect(result).toEqual({ success: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('generates a token, stores its hash, and emails a reset link for a valid account', async () => {
    mockAuth.getUserByEmail.mockResolvedValue({ uid: 'd1', disabled: false });

    const result = await requestPasswordResetHandler(req({ email: 'd1@example.com' }));

    expect(result).toEqual({ success: true });
    expect(mocks.collection).toHaveBeenCalledWith('passwordResetTokens');
    expect(mocks.doc).toHaveBeenCalledWith('d1');
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        used: false,
        email: 'd1@example.com',
        createdAtMs: expect.any(Number),
        expiresAtMs: expect.any(Number),
      }),
    );
    // 30-minute TTL, not Firebase's fixed ~1hr default.
    const setArgs = mocks.set.mock.calls[0][0];
    expect(setArgs.expiresAtMs - setArgs.createdAtMs).toBe(30 * 60 * 1000);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-resend-api-key' }),
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.from).toBe('Vital Pulse Team <onboarding@resend.dev>');
    expect(body.to).toEqual(['d1@example.com']);
    expect(body.html).toContain('https://vitalpulse-fa458.web.app/reset-password.html?uid=d1&token=');

    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'd1',
      action: 'requestPasswordReset',
      targetUid: 'd1',
    });
  });

  it('does not send a second email within the 60s cooldown for the same account', async () => {
    mockAuth.getUserByEmail.mockResolvedValue({ uid: 'd1', disabled: false });
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ createdAtMs: Date.now() - 5000 }) });

    const result = await requestPasswordResetHandler(req({ email: 'd1@example.com' }));

    expect(result).toEqual({ success: true });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('allows a new request once the cooldown has elapsed', async () => {
    mockAuth.getUserByEmail.mockResolvedValue({ uid: 'd1', disabled: false });
    mocks.get.mockResolvedValue({ exists: true, data: () => ({ createdAtMs: Date.now() - 120_000 }) });

    const result = await requestPasswordResetHandler(req({ email: 'd1@example.com' }));

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalled();
  });

  it('FAILS OPEN on the response even if the Resend API call throws, and does not audit a send that never happened', async () => {
    mockAuth.getUserByEmail.mockResolvedValue({ uid: 'd1', disabled: false });
    mockFetch.mockRejectedValue(new Error('network down'));

    const result = await requestPasswordResetHandler(req({ email: 'd1@example.com' }));

    expect(result).toEqual({ success: true });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('checkPasswordResetTokenHandler', () => {
  const RAW_TOKEN = 'a'.repeat(64);
  const TOKEN_HASH = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');

  it('HOSTILE: rejects a malformed payload', async () => {
    await expect(checkPasswordResetTokenHandler(req({ uid: 'd1' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('does not consume the token — only reports validity', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({ tokenHash: TOKEN_HASH, expiresAtMs: Date.now() + 60_000, used: false }),
    });
    const result = await checkPasswordResetTokenHandler(req({ uid: 'd1', token: RAW_TOKEN }));
    expect(result).toEqual({ valid: true });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mockAuth.updateUser).not.toHaveBeenCalled();
  });

  it('rejects an expired token the same way confirm does', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({ tokenHash: TOKEN_HASH, expiresAtMs: Date.now() - 1000, used: false }),
    });
    await expect(checkPasswordResetTokenHandler(req({ uid: 'd1', token: RAW_TOKEN }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('rejects when no record exists for the uid', async () => {
    mocks.get.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(checkPasswordResetTokenHandler(req({ uid: 'd1', token: RAW_TOKEN }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});

describe('confirmPasswordResetHandler', () => {
  const RAW_TOKEN = 'a'.repeat(64);
  const TOKEN_HASH = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');

  it('HOSTILE: rejects a missing/malformed payload', async () => {
    await expect(confirmPasswordResetHandler(req({ uid: 'd1' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('HOSTILE: rejects a token that is not 64 hex characters', async () => {
    await expect(
      confirmPasswordResetHandler(req({ uid: 'd1', token: 'not-hex', newPassword: 'longenough1' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects a password shorter than 8 characters', async () => {
    await expect(
      confirmPasswordResetHandler(req({ uid: 'd1', token: RAW_TOKEN, newPassword: 'short' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HOSTILE: rejects when no reset-token record exists for the uid', async () => {
    mocks.get.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(
      confirmPasswordResetHandler(req({ uid: 'd1', token: RAW_TOKEN, newPassword: 'longenough1' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockAuth.updateUser).not.toHaveBeenCalled();
  });

  it('HOSTILE: rejects an already-used token (no replay)', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({ tokenHash: TOKEN_HASH, expiresAtMs: Date.now() + 60_000, used: true }),
    });
    await expect(
      confirmPasswordResetHandler(req({ uid: 'd1', token: RAW_TOKEN, newPassword: 'longenough1' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('HOSTILE: rejects an expired token', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({ tokenHash: TOKEN_HASH, expiresAtMs: Date.now() - 1000, used: false }),
    });
    await expect(
      confirmPasswordResetHandler(req({ uid: 'd1', token: RAW_TOKEN, newPassword: 'longenough1' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('HOSTILE: rejects a token whose hash does not match the stored hash (wrong/guessed token)', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({ tokenHash: TOKEN_HASH, expiresAtMs: Date.now() + 60_000, used: false }),
    });
    const wrongToken = 'b'.repeat(64);
    await expect(
      confirmPasswordResetHandler(req({ uid: 'd1', token: wrongToken, newPassword: 'longenough1' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockAuth.updateUser).not.toHaveBeenCalled();
  });

  it('updates the password, marks the token used, revokes sessions, and audits on a valid token', async () => {
    mocks.get.mockResolvedValue({
      exists: true,
      data: () => ({ tokenHash: TOKEN_HASH, expiresAtMs: Date.now() + 60_000, used: false }),
    });

    const result = await confirmPasswordResetHandler(
      req({ uid: 'd1', token: RAW_TOKEN, newPassword: 'longenough1' }),
    );

    expect(result).toEqual({ success: true });
    expect(mockAuth.updateUser).toHaveBeenCalledWith('d1', { password: 'longenough1' });
    expect(mocks.update).toHaveBeenCalledWith({ used: true });
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('d1');
    expect(writeAudit).toHaveBeenCalledWith({
      actorUid: 'd1',
      action: 'confirmPasswordReset',
      targetUid: 'd1',
    });
  });
});
