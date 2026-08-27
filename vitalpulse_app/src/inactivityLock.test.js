import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initWorkstationInactivityTimer,
  resetWorkstationTimer,
  stopWorkstationTimer,
  isWorkstationTimerActive
} from './inactivityLock.js';

describe('Shared Workstation Inactivity Lockout', () => {
  const STAFF_KEY = 'vitalpulse_active_staff';

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    stopWorkstationTimer();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
    stopWorkstationTimer();
  });

  it('does not arm timer if no staff session is in sessionStorage', () => {
    initWorkstationInactivityTimer({ timeoutMinutes: 15 });
    expect(isWorkstationTimerActive()).toBe(false);
  });

  it('arms timer when an active staff session is present', () => {
    sessionStorage.setItem(STAFF_KEY, JSON.stringify({ uid: 's1', name: 'Nurse Joy', roles: ['nurse'] }));
    initWorkstationInactivityTimer({ timeoutMinutes: 15 });
    expect(isWorkstationTimerActive()).toBe(true);
  });

  it('clears active staff session and invokes onLock callback when timeout expires', () => {
    const onLockMock = vi.fn();
    sessionStorage.setItem(STAFF_KEY, JSON.stringify({ uid: 's1', name: 'Nurse Joy', roles: ['nurse'] }));

    initWorkstationInactivityTimer({ timeoutMinutes: 10, onLock: onLockMock });
    expect(isWorkstationTimerActive()).toBe(true);

    // Fast-forward 9 minutes — should not lock yet
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(sessionStorage.getItem(STAFF_KEY)).not.toBeNull();
    expect(onLockMock).not.toHaveBeenCalled();

    // Fast-forward remaining 1 minute + 1 second
    vi.advanceTimersByTime(1 * 60 * 1000 + 1000);
    expect(sessionStorage.getItem(STAFF_KEY)).toBeNull();
    expect(onLockMock).toHaveBeenCalledWith({ staffName: 'Nurse Joy' });
  });

  it('resets timer when user activity occurs before timeout', () => {
    const onLockMock = vi.fn();
    sessionStorage.setItem(STAFF_KEY, JSON.stringify({ uid: 's2', name: 'Lab Tech Sam', roles: ['lab_tech'] }));

    initWorkstationInactivityTimer({ timeoutMinutes: 10, onLock: onLockMock });

    // Advance 8 minutes
    vi.advanceTimersByTime(8 * 60 * 1000);

    // Simulate mousemove user activity
    window.dispatchEvent(new Event('mousemove'));

    // Advance another 8 minutes (16 minutes total from start, but only 8 min since mousemove)
    vi.advanceTimersByTime(8 * 60 * 1000);
    expect(sessionStorage.getItem(STAFF_KEY)).not.toBeNull();
    expect(onLockMock).not.toHaveBeenCalled();

    // Advance another 2 minutes and 1 second (10 minutes since mousemove)
    vi.advanceTimersByTime(2 * 60 * 1000 + 1000);
    expect(sessionStorage.getItem(STAFF_KEY)).toBeNull();
    expect(onLockMock).toHaveBeenCalledWith({ staffName: 'Lab Tech Sam' });
  });

  it('stopWorkstationTimer disarms pending timer', () => {
    sessionStorage.setItem(STAFF_KEY, JSON.stringify({ uid: 's3', name: 'Dr. John', roles: ['hospital_staff'] }));
    initWorkstationInactivityTimer({ timeoutMinutes: 5 });
    expect(isWorkstationTimerActive()).toBe(true);

    stopWorkstationTimer();
    expect(isWorkstationTimerActive()).toBe(false);

    vi.advanceTimersByTime(10 * 60 * 1000);
    // Session should still be present because timer was explicitly disarmed
    expect(sessionStorage.getItem(STAFF_KEY)).not.toBeNull();
  });
});
