// Sign Up password strength UI (Stream C2.2/C2.3) + "suggest strong password" (C2.5).
// The 4 criteria match "Sign Up - Account Details.png" exactly. The only HARD submit
// gate is the length floor decided for B8 (8 characters, donor UI/VitalPulse_Plan_Tracker.md
// Stream B8) — the other three are shown as encouragement (green check when met) but
// don't block submission, matching the mockup's own state (2 of 4 checked, Confirm
// Password already accepted).
const CRITERIA = [
  { key: 'minLength', label: 'Min. 8 characters', test: (p) => p.length >= 8 },
  { key: 'hasNumber', label: 'At least one number', test: (p) => /\d/.test(p) },
  { key: 'hasUppercase', label: 'Uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { key: 'hasSpecial', label: 'Special character', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export function evaluatePasswordCriteria(password) {
  const pw = password || '';
  const results = {};
  for (const c of CRITERIA) results[c.key] = c.test(pw);
  return results;
}

// 0-4, one point per criterion met — drives the 4-segment strength bar.
export function passwordStrengthScore(password) {
  const results = evaluatePasswordCriteria(password);
  return Object.values(results).filter(Boolean).length;
}

export function isPasswordValid(password) {
  return evaluatePasswordCriteria(password).minLength;
}

function secureRandomInt(maxExclusive) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % maxExclusive;
}

// Excludes visually-ambiguous characters (0/O, 1/l/I) — same spirit as the rest of this
// app's donor-facing text, kept easy to read/retype if the donor ever needs to.
const SUGGEST_POOLS = [
  'abcdefghijkmnopqrstuvwxyz',
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  '23456789',
  '!@#$%^&*-_=+',
];

export function suggestStrongPassword(length = 14) {
  const all = SUGGEST_POOLS.join('');
  const pick = (pool) => pool[secureRandomInt(pool.length)];
  const chars = SUGGEST_POOLS.map(pick); // guarantee one of each class
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
