import { describe, expect, it } from 'vitest';
import { evaluatePasswordCriteria, passwordStrengthScore, isPasswordValid, suggestStrongPassword } from './passwordPolicy';

describe('evaluatePasswordCriteria', () => {
  it('flags every criterion false for an empty password', () => {
    expect(evaluatePasswordCriteria('')).toEqual({
      minLength: false, hasNumber: false, hasUppercase: false, hasSpecial: false,
    });
  });

  it('flags every criterion true for a password meeting all four', () => {
    expect(evaluatePasswordCriteria('Str0ng!Pass')).toEqual({
      minLength: true, hasNumber: true, hasUppercase: true, hasSpecial: true,
    });
  });

  it('evaluates each criterion independently', () => {
    expect(evaluatePasswordCriteria('alllowercase123')).toMatchObject({ minLength: true, hasNumber: true, hasUppercase: false, hasSpecial: false });
    expect(evaluatePasswordCriteria('short1A!')).toMatchObject({ minLength: true });
    expect(evaluatePasswordCriteria('short')).toMatchObject({ minLength: false });
  });
});

describe('passwordStrengthScore', () => {
  it('scores 0 for empty and 4 for a password meeting every criterion', () => {
    expect(passwordStrengthScore('')).toBe(0);
    expect(passwordStrengthScore('Str0ng!Pass')).toBe(4);
  });

  it('scores partial credit', () => {
    expect(passwordStrengthScore('alllowercase')).toBe(1); // length only
    expect(passwordStrengthScore('alllowercase1')).toBe(2); // length + number
  });
});

describe('isPasswordValid', () => {
  it('is the length floor only (B8: min 8 chars) — other criteria are encouragement, not gates', () => {
    expect(isPasswordValid('alllowercase')).toBe(true); // 8+ chars, no number/upper/special
    expect(isPasswordValid('short1A!')).toBe(true); // exactly 8
    expect(isPasswordValid('Sh0rt!')).toBe(false); // under 8, even with all other criteria met
  });
});

describe('suggestStrongPassword', () => {
  it('generates a password of the requested length', () => {
    expect(suggestStrongPassword(14)).toHaveLength(14);
    expect(suggestStrongPassword(20)).toHaveLength(20);
  });

  it('always meets all four criteria (deterministically guarantees one char per class)', () => {
    for (let i = 0; i < 25; i++) {
      const pw = suggestStrongPassword();
      expect(evaluatePasswordCriteria(pw)).toEqual({ minLength: true, hasNumber: true, hasUppercase: true, hasSpecial: true });
    }
  });

  it('does not generate visually-ambiguous characters (0/O/1/l/I)', () => {
    for (let i = 0; i < 25; i++) {
      expect(suggestStrongPassword()).not.toMatch(/[01OIl]/);
    }
  });

  it('is not deterministic across calls', () => {
    const passwords = new Set(Array.from({ length: 10 }, () => suggestStrongPassword()));
    expect(passwords.size).toBe(10);
  });
});
