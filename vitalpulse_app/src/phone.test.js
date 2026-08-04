import { describe, expect, it } from 'vitest';
import { normalizeCameroonPhone, formatCameroonNationalNumber } from './phone';

describe('normalizeCameroonPhone', () => {
  it('normalizes every accepted input shape to the same E.164 value', () => {
    for (const input of ['+237600000000', '+237 600 000 000', '237600000000', '0600000000', '600000000', '600 000 000']) {
      expect(normalizeCameroonPhone(input)).toBe('+237600000000');
    }
  });

  it('HOSTILE: rejects a number not starting with 6', () => expect(normalizeCameroonPhone('700000000')).toBeNull());
  it('HOSTILE: rejects a too-short number', () => expect(normalizeCameroonPhone('60000')).toBeNull());
  it('HOSTILE: rejects a too-long number', () => expect(normalizeCameroonPhone('6000000000000')).toBeNull());
  it('HOSTILE: rejects non-numeric input', () => expect(normalizeCameroonPhone('donor@example.com')).toBeNull());
  it('HOSTILE: rejects empty/undefined input', () => {
    expect(normalizeCameroonPhone('')).toBeNull();
    expect(normalizeCameroonPhone(undefined)).toBeNull();
  });
});

describe('formatCameroonNationalNumber', () => {
  it('groups digits as 3-3-3', () => expect(formatCameroonNationalNumber('600000000')).toBe('600 000 000'));
  it('handles partial input while typing', () => {
    expect(formatCameroonNationalNumber('6')).toBe('6');
    expect(formatCameroonNationalNumber('600')).toBe('600');
    expect(formatCameroonNationalNumber('6000')).toBe('600 0');
  });
  it('strips non-digit characters and truncates past 9 digits', () => {
    expect(formatCameroonNationalNumber('600-000-000-999')).toBe('600 000 000');
  });
});
