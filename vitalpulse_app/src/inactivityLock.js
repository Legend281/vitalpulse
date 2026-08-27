/**
 * inactivityLock.js — Workstation Idle Timeout & Auto-Lockout
 * 
 * In busy hospital wards, multiple medical staff share the same workstation.
 * If a nurse, lab technician, or receptionist switches PIN session and walks away,
 * this module automatically clears the session after 15 minutes of inactivity,
 * preventing accidental actions under the wrong clinician's name.
 */

import { clearActiveStaffSession } from './roleGating.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const STAFF_SESSION_KEY = 'vitalpulse_active_staff';

let idleTimer = null;
let activeTimeoutMs = DEFAULT_TIMEOUT_MS;
let onLockCallback = null;
let isInitialized = false;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'click', 'scroll'];

function handleUserActivity() {
  if (!sessionStorage.getItem(STAFF_SESSION_KEY)) return;
  resetWorkstationTimer();
}

/**
 * Triggered when idle timeout expires
 */
function handleIdleTimeout() {
  const activeStaff = sessionStorage.getItem(STAFF_SESSION_KEY);
  if (!activeStaff) return;

  try {
    const staffData = JSON.parse(activeStaff);
    const staffName = staffData.name || 'Staff member';

    // Clear the active PIN session
    clearActiveStaffSession();

    // Trigger onLock callback if provided
    if (typeof onLockCallback === 'function') {
      onLockCallback({ staffName });
    }

    // Default notification if toast system is available
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast(`🔒 Workstation locked: Session for ${staffName} timed out after inactivity.`, 'info');
    }
  } catch (err) {
    clearActiveStaffSession();
  }
}

/**
 * Starts or restarts the inactivity timer
 */
export function resetWorkstationTimer() {
  if (idleTimer) clearTimeout(idleTimer);

  // Only start timer if there is an active staff session
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(STAFF_SESSION_KEY)) {
    idleTimer = setTimeout(handleIdleTimeout, activeTimeoutMs);
  }
}

/**
 * Stops the idle timer (e.g. on manual logout or session termination)
 */
export function stopWorkstationTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * Initializes workstation inactivity listener
 * 
 * @param {object} options
 * @param {number} [options.timeoutMinutes=15] - Timeout duration in minutes
 * @param {function} [options.onLock] - Callback invoked when workstation locks
 */
export function initWorkstationInactivityTimer(options = {}) {
  const minutes = options.timeoutMinutes || 15;
  activeTimeoutMs = minutes * 60 * 1000;
  if (options.onLock) onLockCallback = options.onLock;

  if (!isInitialized && typeof window !== 'undefined') {
    ACTIVITY_EVENTS.forEach(event => {
      window.addEventListener(event, handleUserActivity, { passive: true });
    });
    isInitialized = true;
  }

  resetWorkstationTimer();
}

/**
 * Checks if timer is currently listening
 */
export function isWorkstationTimerActive() {
  return idleTimer !== null;
}
