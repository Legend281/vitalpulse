import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn()),
}));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('./auth', () => ({ getCurrentUser: vi.fn(), sendPasswordReset: vi.fn(), hashNationalId: vi.fn() }));

import { validateKycFile } from './donor-dashboard.js';

function makeFile({ type = 'image/jpeg', size = 1024, name = 'id.jpg' } = {}) {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

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
