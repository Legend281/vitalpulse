import { describe, expect, it } from 'vitest';
import { passwordsMatch, isSignupFormValid } from './signupValidation';

describe('passwordsMatch', () => {
  it('is true when both fields are identical and non-empty', () => {
    expect(passwordsMatch('Str0ng!Pass', 'Str0ng!Pass')).toBe(true);
  });

  it('is false when confirm is empty (no "confirm your password" state with a false-positive match)', () => {
    expect(passwordsMatch('Str0ng!Pass', '')).toBe(false);
  });

  it('is false on any mismatch', () => {
    expect(passwordsMatch('Str0ng!Pass', 'Str0ng!Pas')).toBe(false);
  });
});

describe('isSignupFormValid', () => {
  const validDonor = {
    role: 'donor',
    fullName: 'Mai Brandon',
    email: 'mai@example.com',
    city: 'Douala',
    termsChecked: true,
    phone: '600000000',
    password: 'Str0ng!Pass',
    confirmPassword: 'Str0ng!Pass',
    bloodType: 'O+',
  };

  it('is true for a fully valid donor submission', () => {
    expect(isSignupFormValid(validDonor)).toBe(true);
  });

  it('is true for a valid government hospital submission without a license file', () => {
    expect(isSignupFormValid({ ...validDonor, role: 'hospital', bloodType: '', hospitalType: 'government', hasLicenseFile: false })).toBe(true);
  });

  it('requires license file for private hospital but exempts government hospital', () => {
    expect(isSignupFormValid({ ...validDonor, role: 'hospital', bloodType: '', hospitalType: 'private', hasLicenseFile: false })).toBe(false);
    expect(isSignupFormValid({ ...validDonor, role: 'hospital', bloodType: '', hospitalType: 'private', hasLicenseFile: true })).toBe(true);
    expect(isSignupFormValid({ ...validDonor, role: 'hospital', bloodType: '', hospitalType: 'government', hasLicenseFile: false })).toBe(true);
  });

  it.each([
    ['fullName', ''],
    ['fullName', '   '],
    ['email', ''],
    ['city', ''],
  ])('is false when %s is blank/whitespace-only', (field, value) => {
    expect(isSignupFormValid({ ...validDonor, [field]: value })).toBe(false);
  });

  it('is false when terms are unchecked', () => {
    expect(isSignupFormValid({ ...validDonor, termsChecked: false })).toBe(false);
  });

  it('is false for an invalid Cameroon phone number', () => {
    expect(isSignupFormValid({ ...validDonor, phone: '700000000' })).toBe(false);
    expect(isSignupFormValid({ ...validDonor, phone: '' })).toBe(false);
  });

  it('is false for a password under the 8-char floor', () => {
    expect(isSignupFormValid({ ...validDonor, password: 'Sh0rt!', confirmPassword: 'Sh0rt!' })).toBe(false);
  });

  it('is false when confirm password does not match', () => {
    expect(isSignupFormValid({ ...validDonor, confirmPassword: 'Different1!' })).toBe(false);
  });

  it('is false when confirm password is empty', () => {
    expect(isSignupFormValid({ ...validDonor, confirmPassword: '' })).toBe(false);
  });

  it('HOSTILE: tolerates undefined/missing optional-looking fields without throwing', () => {
    expect(() => isSignupFormValid({})).not.toThrow();
    expect(isSignupFormValid({})).toBe(false);
  });
});
