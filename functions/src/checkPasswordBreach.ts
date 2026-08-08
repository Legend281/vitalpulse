import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { checkPasswordBreachSchema } from './schemas';

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

/**
 * checkPasswordBreach — Stream B8 ("breach screening ON"), Auth & Onboarding workstream.
 * Proxies a k-anonymity range query to the "Have I Been Pwned" Pwned Passwords API so
 * Stream C's Sign Up flow can reject known-compromised passwords before account creation.
 *
 * SECURITY DESIGN — READ BEFORE CHANGING: this function NEVER receives a password or a
 * full password hash, only a 5-character SHA-1 prefix. This is required, not a style
 * choice: this workstream's own guardrail (donor UI/VitalPulse_Plan_Tracker.md,
 * GUARDRAILS #4) states "Password is never stored, logged, or passed to any function —
 * Firebase Auth owns it entirely." Sending the raw password, or even its full hash, to
 * any Cloud Function — logged request bodies, Cloud Functions' own access logs, etc. —
 * would violate that directly. The client (Stream C, not yet built) must:
 *   1. Compute SHA-1(password) with Web Crypto, entirely client-side — mirrors the
 *      pattern vitalpulse_app/src/auth.js already uses for hashNationalId (SHA-256 there;
 *      SHA-1 here only because that's the hash HIBP's range API is keyed on — SHA-1's
 *      weakness as a general-purpose hash is irrelevant to this specific k-anonymity
 *      lookup, which only needs a stable, well-known hash to match a public breach corpus).
 *   2. Split the hex digest into a 5-char prefix and 35-char suffix.
 *   3. Call this function with ONLY the prefix.
 *   4. Locally check whether ITS suffix appears in the returned list — that comparison
 *      can only happen client-side, since the full hash/suffix never leaves the browser.
 *
 * UNAUTHENTICATED BY NECESSITY, FLAGGED: called before createUserWithEmailAndPassword,
 * i.e. before any Firebase Auth session exists — there is no request.auth to gate on.
 * This is the only function in this codebase with no auth check. Residual risk, not
 * silently ignored: without Firebase App Check (not configured anywhere in this project
 * yet — PHASE0_AUDIT.md §10) or a rate limiter, this is an open proxy to HIBP's public API
 * paid for by our own Functions quota. Recommend enforcing App Check on this function
 * specifically once Master Plan 1.7's App Check rollout happens.
 *
 * FAILS OPEN, FLAGGED: if HIBP is unreachable or errors, this returns an empty (non-
 * matching) list rather than throwing — a signup should never be blocked because a
 * third-party API had an outage. Breach screening degrades to "unknown," not "deny."
 * `degraded: true` in the response lets the client show "couldn't verify, proceeding"
 * rather than silently pretending the check succeeded.
 */
export async function checkPasswordBreachHandler(request: CallableRequest) {
  const parsed = checkPasswordBreachSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid checkPasswordBreach payload.', parsed.error.flatten());
  }
  const { prefix } = parsed.data;

  let response: Response;
  try {
    response = await fetch(`${HIBP_RANGE_URL}${prefix.toUpperCase()}`, {
      headers: {
        // HIBP pads the response with decoy suffixes so response size alone can't leak
        // whether a match occurred; harmless to pass through to the client as-is.
        'Add-Padding': 'true',
      },
    });
  } catch {
    return { suffixes: [] as string[], degraded: true };
  }
  if (!response.ok) {
    return { suffixes: [] as string[], degraded: true };
  }

  const text = await response.text();
  const suffixes = text
    .split('\n')
    .map((line) => line.split(':')[0]?.trim())
    .filter((s): s is string => Boolean(s));

  return { suffixes, degraded: false };
}

export const checkPasswordBreach = onCall({ cors: true }, checkPasswordBreachHandler);
