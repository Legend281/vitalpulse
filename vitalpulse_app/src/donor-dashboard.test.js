import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn()),
}));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('./auth', () => ({ getCurrentUser: vi.fn(), sendPasswordReset: vi.fn(), hashNationalId: vi.fn() }));

import { validateKycFile, resolveLastDonationDate } from './donor-dashboard.js';

function makeFile({ type = 'image/jpeg', size = 1024, name = 'id.jpg' } = {}) {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

describe('resolveLastDonationDate (56-Day WHO Deferral Tracking)', () => {
  it('returns null when no donation date exists on user or engagement', () => {
    expect(resolveLastDonationDate(null, null)).toBeNull();
    expect(resolveLastDonationDate({ name: 'John' }, { donations: [] })).toBeNull();
  });

  it('resolves lastDonationDate from currentUser profile', () => {
    const user = { lastDonationDate: '2026-07-29T10:00:00.000Z' };
    expect(resolveLastDonationDate(user, null)).toEqual('2026-07-29T10:00:00.000Z');
  });

  it('resolves lastDonatedAt from currentUser profile if lastDonationDate is missing', () => {
    const user = { lastDonatedAt: '2026-07-20T10:00:00.000Z' };
    expect(resolveLastDonationDate(user, null)).toEqual('2026-07-20T10:00:00.000Z');
  });

  it('picks the most recent date between profile lastDonationDate and engagement history', () => {
    const user = { lastDonationDate: '2026-07-29T10:00:00.000Z' }; // 8 days ago
    const engagement = {
      donations: [
        { status: 'completed', completedAt: '2026-05-01T10:00:00.000Z' } // older
      ]
    };
    // Must pick the July 29 date (8 days ago) rather than ignoring it!
    expect(resolveLastDonationDate(user, engagement)).toEqual('2026-07-29T10:00:00.000Z');
  });

  it('picks completedAt from engagement if it is more recent than profile date', () => {
    const user = { lastDonationDate: '2026-01-01T10:00:00.000Z' };
    const engagement = {
      donations: [
        { status: 'completed', completedAt: '2026-08-01T10:00:00.000Z' }
      ]
    };
    expect(resolveLastDonationDate(user, engagement)).toEqual('2026-08-01T10:00:00.000Z');
  });
});

describe('validateKycFile (Stream C3, KYC upload)', () => {
  it('accepts a valid JPG under 5MB', () => {
    expect(validateKycFile(makeFile({ type: 'image/jpeg', size: 1024 }))).toEqual({ valid: true, error: null });
  });

  it('accepts a valid PNG and PDF', () => {
    expect(validateKycFile(makeFile({ type: 'image/png' })).valid).toBe(true);
    expect(validateKycFile(makeFile({ type: 'application/pdf' })).valid).toBe(true);
  });

  it('HOSTILE: rejects a missing file', () => {
    expect(validateKycFile(null)).toEqual({ valid: false, error: "Please choose a file." });
  });

  it('HOSTILE: rejects an unsupported format', () => {
    const result = validateKycFile(makeFile({ type: 'application/zip' }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unsupported format/);
  });

  it('HOSTILE: rejects a file over 5MB', () => {
    const result = validateKycFile(makeFile({ size: 5 * 1024 * 1024 + 1 }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too large/);
  });

  it('HOSTILE: rejects an empty file', () => {
    const result = validateKycFile(makeFile({ size: 0 }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/);
  });

  it('accepts a file exactly at the 5MB boundary', () => {
    expect(validateKycFile(makeFile({ size: 5 * 1024 * 1024 })).valid).toBe(true);
  });
});
