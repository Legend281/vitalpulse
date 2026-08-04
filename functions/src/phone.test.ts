import { describe, expect, it } from 'vitest';
import { normalizeCameroonPhone } from './phone';

describe('normalizeCameroonPhone', () => {
  it('normalizes +237-prefixed input', () => {
    expect(normalizeCameroonPhone('+237600000000')).toBe('+237600000000');
    expect(normalizeCameroonPhone('+237 600 000 000')).toBe('+237600000000');
  });

  it('normalizes 237-prefixed input with no plus', () => {
    expect(normalizeCameroonPhone('237600000000')).toBe('+237600000000');
  });

  it('normalizes a leading-zero national number', () => {
    expect(normalizeCameroonPhone('0600000000')).toBe('+237600000000');
  });

  it('normalizes a bare 9-digit national number', () => {
    expect(normalizeCameroonPhone('600000000')).toBe('+237600000000');
  });

  it('HOSTILE: rejects a number not starting with 6 (invalid CM mobile prefix)', () => {
    expect(normalizeCameroonPhone('700000000')).toBeNull();
  });

  it('HOSTILE: rejects a too-short number', () => {
    expect(normalizeCameroonPhone('60000')).toBeNull();
  });

  it('HOSTILE: rejects a too-long number', () => {
    expect(normalizeCameroonPhone('6000000000000')).toBeNull();
  });

  it('HOSTILE: rejects non-numeric input', () => {
    expect(normalizeCameroonPhone('not-a-phone')).toBeNull();
    expect(normalizeCameroonPhone('donor@example.com')).toBeNull();
  });

  it('HOSTILE: rejects an empty string', () => {
    expect(normalizeCameroonPhone('')).toBeNull();
  });
});
