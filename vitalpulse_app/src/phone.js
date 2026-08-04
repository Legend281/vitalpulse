// Cameroon mobile phone normalization — shared shape with functions/src/phone.ts
// (Cloud Functions and this Vite app are separate packages/runtimes, so this is
// duplicated by necessity, not oversight — kept tiny and identical in both places
// specifically so drift is easy to spot and low-cost).
//
// Accepts +237XXXXXXXXX, 237XXXXXXXXX, 0XXXXXXXXX, or bare XXXXXXXXX and normalizes to
// E.164 (+237XXXXXXXXX) if it's a valid Cameroon mobile number (9 digits starting with
// 6, per the Sign Up mockup's "6XX XXX XXX" placeholder). Returns null if it doesn't
// match that shape at all.
export function normalizeCameroonPhone(raw) {
    const digits = (raw || '').replace(/[^\d+]/g, '');
    let national;
    if (digits.startsWith('+237')) national = digits.slice(4);
    else if (digits.startsWith('237')) national = digits.slice(3);
    else if (digits.startsWith('0')) national = digits.slice(1);
    else national = digits;

    if (!/^6\d{8}$/.test(national)) return null;
    return `+237${national}`;
}

// Formats a 9-digit national number as "6XX XXX XXX" for display while typing.
export function formatCameroonNationalNumber(digitsOnly) {
    const d = (digitsOnly || '').replace(/\D/g, '').slice(0, 9);
    return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join(' ');
}
