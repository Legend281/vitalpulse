import { isPasswordValid } from './passwordPolicy';
import { normalizeCameroonPhone } from './phone';

/**
 * F1 (Stream F, donor UI/VitalPulse_Plan_Tracker.md) — extracted out of main.js's inline
 * signup-form wiring so the confirm-match check and the "is this form submittable" gate are
 * real, independently unit-testable functions, the same way password/phone validation already
 * are (passwordPolicy.js / phone.js). Behavior is unchanged from the inline version this
 * replaces — pure extraction, not a rule change.
 */

export function passwordsMatch(password, confirmPassword) {
  return Boolean(confirmPassword) && confirmPassword === password;
}

/**
 * Mirrors the field set Sign Up actually requires per role: bloodType is donor-only (hospital
 * accounts have no equivalent required field here — hospital verification happens on a
 * later KYC-style step, not at signup).
 */
export function isSignupFormValid({ role, fullName, email, city, termsChecked, phone, password, confirmPassword, bloodType }) {
  const phoneValid = Boolean(normalizeCameroonPhone(phone || ''));
  const passwordValid = isPasswordValid(password || '');
  const confirmValid = passwordsMatch(password, confirmPassword);
  const bloodTypeValid = role !== 'donor' || Boolean(bloodType);

  return Boolean(
    (fullName || '').trim() &&
    (email || '').trim() &&
    (city || '').trim() &&
    termsChecked &&
    phoneValid &&
    passwordValid &&
    confirmValid &&
    bloodTypeValid
  );
}
