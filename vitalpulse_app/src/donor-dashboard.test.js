import { describe, expect, it, vi } from 'vitest';

// donor-dashboard.js no longer calls firebase/functions itself (KYC moved off Cloud
// Functions per donor UI/KYC_fix.md), but it imports from ./db, which still does at module
// load time for other Cloud Functions (suspendUser, roles, etc.) — this mock is for that
// transitive import, not for anything in this file directly.
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn()),
}));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('./auth', () => ({ getCurrentUser: vi.fn(), sendPasswordReset: vi.fn(), hashNationalId: vi.fn() }));

import { validateKycFile, resolveLastDonationDate, getEligibilityInfo, BLOOD_COMPATIBILITY_DATA } from './donor-dashboard.js';

function makeFile({ type = 'image/jpeg', size = 1024, name = 'id.jpg' } = {}) {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

describe('getEligibilityInfo (56-Day WHO Interval Calculation)', () => {
  it('returns eligible when no prior donation exists', () => {
    const res = getEligibilityInfo(null);
    expect(res.eligible).toBe(true);
    expect(res.daysUntil).toBe(0);
    expect(res.label).toBe('Eligible');
  });

  it('returns eligible when donation was more than 56 days ago', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const res = getEligibilityInfo(sixtyDaysAgo);
    expect(res.eligible).toBe(true);
    expect(res.daysUntil).toBe(0);
    expect(res.label).toBe('Eligible');
  });

  it('returns ineligible with accurate countdown when donation was 20 days ago', () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const res = getEligibilityInfo(twentyDaysAgo);
    expect(res.eligible).toBe(false);
    expect(res.daysUntil).toBe(36);
    expect(res.label).toBe('36 days');
  });
});

describe('BLOOD_COMPATIBILITY_DATA (Transfusion Matrix for Cameroon)', () => {
  it('has all 8 clinical blood types defined', () => {
    const types = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
    types.forEach(bt => {
      expect(BLOOD_COMPATIBILITY_DATA[bt]).toBeDefined();
      expect(BLOOD_COMPATIBILITY_DATA[bt].give.length).toBeGreaterThan(0);
      expect(BLOOD_COMPATIBILITY_DATA[bt].receive.length).toBeGreaterThan(0);
    });
  });

  it('verifies O- is the universal red cell donor (can give to all 8 groups)', () => {
    expect(BLOOD_COMPATIBILITY_DATA['O-'].give).toEqual(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']);
  });

  it('verifies AB+ is the universal receiver (can receive from all 8 groups)', () => {
    expect(BLOOD_COMPATIBILITY_DATA['AB+'].receive).toEqual(
      expect.arrayContaining(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'])
    );
    expect(BLOOD_COMPATIBILITY_DATA['AB+'].receive.length).toBe(8);
  });
});

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

describe('validateKycFile (donor UI/KYC_fix.md, KYC upload)', () => {
  it('accepts a valid JPG under 5MB', () => {
    expect(validateKycFile(makeFile({ type: 'image/jpeg', size: 1024 }))).toEqual({ valid: true, error: null });
  });

  it('accepts a valid PNG', () => {
    expect(validateKycFile(makeFile({ type: 'image/png' })).valid).toBe(true);
  });

  it('HOSTILE: rejects a missing file', () => {
    expect(validateKycFile(null)).toEqual({ valid: false, error: "Please choose a file." });
  });

  it('HOSTILE: rejects PDF — no longer accepted (canvas-based compression can only resize a raster image, not render a PDF page)', () => {
    const result = validateKycFile(makeFile({ type: 'application/pdf' }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unsupported format/);
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
