# Part 3 (Testing Strategy) — What's Required to Complete It

**Created:** 2026-07-25 · **Source:** compiled after the Part 3.1/3.2/3.3 work sessions — see `VitalPulse_Plan_Tracker.md` Part 3 and its "Part 3.1/3.2/3.3 completion notes" for full detail on what's already done.

**Purpose of this file:** a standing checklist of exactly what's still needed to fully close out Part 3, split by who/what has to supply it. Come back here before starting a new Part 3 session instead of re-deriving this from scratch.

---

## 1. A non-production Firebase project (the big one)

At minimum one dedicated project that isn't `vitalpulse-fa458` (production). Naming doesn't matter (`dev`, `staging`, whatever) — what matters is it's separate, per Master Plan Part 4's non-negotiable rule (synthetic data only, never real PHI).

Needs, once created:
- `firestore.rules` (+ `firestore.indexes.json`) deployed to it.
- A `hosting` block added to `firebase.json` (none exists yet — only `firestore`/`functions` are configured).
- Synthetic test accounts provisioned with real custom claims via `grantRole` (never real donor/patient data).
- `FIREBASE_SERVICE_ACCOUNT` + `FIREBASE_PROJECT_ID` secrets in GitHub "staging"/"production" Environments (the environments themselves also need creating — "production" needs required reviewers configured).
- A `STAGING_URL` / `PROD_URL` GitHub repo variable once hosting is live.

**Unblocks:** S1/S6/soak k6 load tests (Part 3.3), the DAST/ZAP scan (Part 3.2), and Part 4's staging deploy pipeline (`deploy-staging` → `post-deploy-smoke` jobs in `.github/workflows/ci-cd.yml`, currently gated off via `vars.STAGING_DEPLOY_ENABLED`).

## 2. Repo settings only the Security Lead can change (GitHub owner access)

- Branch protection on `main`: PR + 1 review; 2 reviews required for changes to `firestore.rules`, auth code, or Cloud Functions authz (Security Policy 8 §1).
- GitHub push protection (secret scanning).
- Dependabot/Renovate enabled.

## 3. Decisions only the Security Lead can make

- **Stale-ID-token-after-suspension mitigation** (found during the Part 3.2 abuse-case review, documented in `firestore.rules`'s `signedIn()` comment): `revokeRefreshTokens()` only blocks *future* token refreshes — a suspended user's already-cached ID token stays valid, and Firestore honors it (rules check signature+expiry, not revocation), for up to its ~1h natural expiry. Two options, not picked unilaterally:
  - (a) Route suspend-sensitive privileged actions through Cloud Functions using `verifyIdToken(token, checkRevoked=true)` — where Phase 3 is headed anyway.
  - (b) Have `signedIn()` also cross-check a live `users/{uid}.isSuspended` Firestore field via `get()` — closes the gap for direct client reads/writes too, at the cost of an extra read per rule evaluation (real cost/quota tradeoff at scale).

## 4. Things that need people, not code

- A manual penetration test (external tester, pre-launch + annual — Master Plan Part 3.2).
- OWASP ASVS L2 checklist sign-off (comes after the above are further along).

## 5. Firebase console access only the Security Lead has

- Quota headroom + billing/quota alerts verification.

## 6. Feature work that has to land before its own tests can mean anything (Phase 3 scope)

- `escalateStaleRequests` Cloud Function must exist before escalation-engine tests mean anything.
- `submitPublicRequest` Cloud Function/feature must exist before public-request-intake tests mean anything.
- MFA (Part 1.4) must be implemented before MFA tests mean anything.

---

## Already done, for reference (don't redo)

- Firestore Security Rules test suite: 81 tests (`firestore.rules.test.js`), including 17 abuse-case `list()`-IDOR tests added 2026-07-25 (found and fixed 2 real bugs: `donation_requests`/`donor_notifications` list rules didn't check `resource.data.donorId`).
- Cloud Functions tests: 44 tests (`functions/src/{roles,grantRole,revokeRole}.test.ts`).
- Matching-engine unit tests: 14 tests (`vitalpulse_app/src/db.test.js`), including a regression guard for the inverted blood-compatibility bug found in Part 4.
- Concurrency-correctness tests (S3/S5, no staging needed): 2 tests (`concurrency.rules.test.js`) — proved exactly-once-accept holds, and proved the inventory lost-update race is real (not fixed, flagged for Phase 3's `updateInventory` Cloud Function).
- SAST (Semgrep + ESLint security plugins) and `npm audit` for shipped code: live and blocking in CI.
- `k6-stress-tests.js`: rewritten against the real Firestore REST API + real schema (promoted from `vitalpulse_app/docs/` to repo root); S2/S4 removed as N/A (features don't exist) rather than faked.
- Coverage gates (90% authz / 80% overall) wired into `functions/vitest.config.ts` and CI.
