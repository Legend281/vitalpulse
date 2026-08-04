import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readLoginFailureState,
  recordLoginFailure,
  clearLoginFailures,
  isLockedOut,
  shouldShowAttemptsWarning,
  lockoutSecondsRemaining,
  LOGIN_WARNING_THRESHOLD,
  LOGIN_LOCKOUT_THRESHOLD,
  recordAttemptedIdentifier,
  hasAttemptedIdentifier,
} from './loginAttempts';

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});
afterEach(() => vi.useRealTimers());

describe('loginAttempts', () => {
  it('starts at zero with no failures recorded', () => {
    const state = readLoginFailureState();
    expect(state).toEqual({ count: 0, lockedUntil: null });
    expect(isLockedOut(state)).toBe(false);
    expect(shouldShowAttemptsWarning(state)).toBe(false);
  });

  it('increments the failure count on each call', () => {
    recordLoginFailure();
    recordLoginFailure();
    const state = recordLoginFailure();
    expect(state.count).toBe(3);
  });

  it('shows the warning once the threshold is reached, not before', () => {
    for (let i = 0; i < LOGIN_WARNING_THRESHOLD - 1; i++) recordLoginFailure();
    expect(shouldShowAttemptsWarning(readLoginFailureState())).toBe(false);

    const state = recordLoginFailure();
    expect(state.count).toBe(LOGIN_WARNING_THRESHOLD);
    expect(shouldShowAttemptsWarning(state)).toBe(true);
  });

  it('locks out once the lockout threshold is reached', () => {
    let state;
    for (let i = 0; i < LOGIN_LOCKOUT_THRESHOLD; i++) state = recordLoginFailure();
    expect(state.count).toBe(LOGIN_LOCKOUT_THRESHOLD);
    expect(isLockedOut(state)).toBe(true);
    expect(lockoutSecondsRemaining(state)).toBeGreaterThan(0);
  });

  it('does not lock out below the threshold', () => {
    let state;
    for (let i = 0; i < LOGIN_LOCKOUT_THRESHOLD - 1; i++) state = recordLoginFailure();
    expect(isLockedOut(state)).toBe(false);
    expect(lockoutSecondsRemaining(state)).toBe(0);
  });

  it('lockout expires after its duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let state;
    for (let i = 0; i < LOGIN_LOCKOUT_THRESHOLD; i++) state = recordLoginFailure();
    expect(isLockedOut(state)).toBe(true);

    vi.setSystemTime(31_000);
    expect(isLockedOut(state)).toBe(false);
    expect(lockoutSecondsRemaining(state)).toBe(0);
  });

  it('clearLoginFailures resets the counter entirely (successful login)', () => {
    recordLoginFailure();
    recordLoginFailure();
    clearLoginFailures();
    expect(readLoginFailureState()).toEqual({ count: 0, lockedUntil: null });
  });

  it('is resilient to corrupted localStorage content', () => {
    localStorage.setItem('vitalpulse_login_failures', 'not-json{{{');
    expect(readLoginFailureState()).toEqual({ count: 0, lockedUntil: null });
  });
});

describe('attempted-identifier gate (Forgot Password)', () => {
  it('HOSTILE: an identifier that was never tried is not "attempted"', () => {
    expect(hasAttemptedIdentifier('nobody@example.com')).toBe(false);
  });

  it('marks an identifier as attempted once recorded', () => {
    recordAttemptedIdentifier('donor@example.com');
    expect(hasAttemptedIdentifier('donor@example.com')).toBe(true);
  });

  it('email matching is case- and whitespace-insensitive', () => {
    recordAttemptedIdentifier('  Donor@Example.com  ');
    expect(hasAttemptedIdentifier('donor@example.com')).toBe(true);
    expect(hasAttemptedIdentifier('DONOR@EXAMPLE.COM')).toBe(true);
  });

  it('phone numbers match regardless of formatting, via normalizeCameroonPhone', () => {
    recordAttemptedIdentifier('6 71 23 45 67');
    expect(hasAttemptedIdentifier('+237671234567')).toBe(true);
    expect(hasAttemptedIdentifier('671234567')).toBe(true);
  });

  it('HOSTILE: blank/whitespace-only input is never recorded or matched', () => {
    recordAttemptedIdentifier('   ');
    expect(hasAttemptedIdentifier('')).toBe(false);
    expect(hasAttemptedIdentifier('   ')).toBe(false);
  });

  it('is resilient to corrupted localStorage content', () => {
    localStorage.setItem('vitalpulse_attempted_identifiers', 'not-json{{{');
    expect(hasAttemptedIdentifier('donor@example.com')).toBe(false);
    expect(() => recordAttemptedIdentifier('donor@example.com')).not.toThrow();
  });

  it('caps the stored list, dropping the oldest identifiers first', () => {
    for (let i = 0; i < 30; i++) recordAttemptedIdentifier(`donor${i}@example.com`);
    expect(hasAttemptedIdentifier('donor0@example.com')).toBe(false);
    expect(hasAttemptedIdentifier('donor29@example.com')).toBe(true);
  });
});
