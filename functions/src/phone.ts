/**
 * Cameroon mobile phone normalization — shared shape between this function and
 * vitalpulse_app/src/phone.js (client-side copy; Cloud Functions and the Vite app are
 * separate packages/runtimes, so this is duplicated by necessity, not oversight — kept
 * tiny and simple in both places specifically so drift is easy to spot and low-cost).
 *
 * Accepts +237XXXXXXXXX, 237XXXXXXXXX, 0XXXXXXXXX, or bare XXXXXXXXX and normalizes to
 * E.164 (+237XXXXXXXXX) if it's a valid Cameroon mobile number (9 digits starting with
 * 6, per the Sign Up mockup's "6XX XXX XXX" placeholder). Returns null if it doesn't
 * match that shape at all — callers treat null as "not a phone number."
 */
export function normalizeCameroonPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  let national: string;
  if (digits.startsWith('+237')) national = digits.slice(4);
  else if (digits.startsWith('237')) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;

  if (!/^6\d{8}$/.test(national)) return null;
  return `+237${national}`;
}
