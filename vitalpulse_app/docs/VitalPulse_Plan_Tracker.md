# VitalPulse Security Plan — Progress Tracker

**Tracks:** `VitalPulse_Security_Master_Plan.md`
**Branch:** `security`
**Last updated:** 2026-07-23

> **How this stays current:** Markdown can't run code, so this isn't script-automated — it's a living checklist that gets updated in this same conversation/session workflow every time a task from the Master Plan is completed and committed on the `security` branch. Check an item, and I'll flip its `[ ]` to `[x]` and update the progress table below in the same commit as the work.

---

## Progress Summary

| Part | Section | Done / Total | Status |
|---|---|---|---|
| 1 | Access Control Architecture (RBAC/ABAC/IAM) | 13 / 41 | In progress (Phase 2 done; +3 items found in Part 2/3 reviews). **Recounted directly from the file 2026-07-25 — corrects a drifted running total that had said 36; nothing about actual completion changed, just the arithmetic.** |
| 2 | Security & Governance Policy Suite | 13 / 13 | Reviewed & content-complete 2026-07-24; formal sign-off pending (Part 5 gate) |
| 3 | Testing Strategy (module/security/stress) | 8 / 24 | In progress — matching-engine tests, abuse-case tests (partial), S3/S5 concurrency-correctness verified via emulator (2026-07-25); escalation/public-request/S1-S2-S4-S6/soak blocked on Phase 3 or staging infra |
| 4 | CI/CD Pipeline Security Gates | 6 / 11 | PR-time gates live and green 2026-07-24; staging/production gated off pending infra |
| 5 | Pre-Deployment Go-Live Checklist | 0 / 21 | Not started |
| — | Companion deliverable files | 5 / 5 | Drafted (content quality varies by phase) |
| **Total** | | **45 / 115** | **39%** |

**Phase status (per the Security Lead's phase ordering, not the Master Plan's part numbering):**
- Phase 0 (Audit) — done, see `PHASE0_AUDIT.md`.
- Phase 1 (Kill the admin backdoor) — code + full local history purge done (reflog/gc completed 2026-07-23), pending Security Lead review and two remaining manual account-side actions (force-push to origin, bootstrap-admin.ts execution, admin account audit — see 1.6 below). See "Phase 1 completion notes" below.
- Phase 2 (Deny-by-default Firestore rules + emulator tests) — done, pending Security Lead review. See "Phase 2 completion notes" below.
- Phase 3 (Privileged actions to Cloud Functions) — not started (grantRole/revokeRole from Phase 1 are the first two; the rest — dispatchEmergencyAlert, updateInventory, writeAudit's remaining callers, submitPublicRequest, escalateStaleRequests, plus the Restricted-PHI export function found below — are still open).
- Phase 4 (CI/CD pipeline) — PR-time gates installed and green 2026-07-24, at the Security Lead's explicit direction, done out of the strict 0→4 order (Phase 3 is still open). Staging/production stages are not live yet. See "Part 4 completion notes" below.
- **Master Plan Part 2 (Security & Governance Policy Suite)** — this doesn't have a number in the Security Lead's Phase 0–4 ordering above; done at the Security Lead's explicit direction on 2026-07-24 as a parallel track, not as a substitute for starting Phase 3. See "Part 2 completion notes" below.
- **Scope note carried forward:** Phase 4 was also done ahead of Phase 3 at the Security Lead's explicit instruction ("now move to part 4"). Flagging again here, as with Part 2, so the ordering deviation reads as intentional rather than the agent skipping ahead unprompted. Phase 3 (Cloud Functions) is still the next item in the original strict ordering and Phase 2 is still awaiting review.

---

## PART 1 — Access Control Architecture (RBAC + ABAC + IAM)

### 1.2 RBAC — Role model
- [x] Define six roles as Firebase custom claims schema (`donor`, `hospital_staff`, `lab_tech`, `hospital_admin`, `system_admin`, `nbtp_viewer`) — `functions/src/roles.ts`. Note: the Firestore `users.role` field the frontend reads stays the pre-existing 3-value string (`donor`/`hospital`/`admin`) for routing only; the 6-role claim is the real authority. See PHASE0_AUDIT.md §6.
- [ ] Enforce separation of duties: `hospital_staff` cannot clear/reject units — **N/A to the real schema** (no `bloodUnits` collection/lifecycle exists; parked as Phase 2.5 schema evolution, see PHASE0_AUDIT.md §6)
- [x] Enforce separation of duties: `lab_tech` cannot create requests or edit stock directly — `firestore.rules` `canManageStock()` helper excludes `lab_tech` from `requests`/`inventory`/`issuance_log` creates/updates; `lab_tech` retains read access. Tested in `firestore.rules.test.js`.
- [x] Enforce separation of duties: `hospital_admin` cannot self-verify own hospital — `firestore.rules` restricts `isVerified`/`verifiedAt` changes on any `users` doc to `system_admin` only, with no exception for the hospital's own `hospital_admin`. Tested.
- [x] Enforce: no role can write audit logs directly (Cloud Functions only) — `firestore.rules` denies client writes to both `auditLogs` (Phase 1) and the legacy `activity_logs` (Phase 2). Tested.

### 1.3 ABAC — Attribute model
- [x] Subject attributes in custom claims: `role`, `hospitalId`, `suspended` — all three read directly from `request.auth.token` in `firestore.rules`. `region` not implemented (no `nbtp_viewer` regional-scoping need yet; flagged, not blocking).
- [ ] Resource attributes on documents: partially adapted — `hospital.verified` (`users.isVerified`) is enforced; `bloodUnit.status`, `request.verificationLabel`, `request.category`, `donor.bloodTypeSource` do not exist in the real schema (no bloodUnits/public_requests/category workflow) — parked as Phase 2.5.
- [x] Rule: hospital-role reads only own-hospital data — adapted to the real schema: `hospital_staff`/`lab_tech`/`hospital_admin` scoped to their own `hospitalId` for `requests`, `inventory`, `issuance_log`, `hospital_notifications` via `sameHospital()`. `system_admin` retains cross-hospital oversight. Tested, including cross-hospital hostile cases.
- [ ] Rule: lab_tech updates only `status` field, own hospital, legal transitions only — **N/A**, no bloodUnits lifecycle in the real schema (parked, Phase 2.5)
- [ ] Rule: only `status == 'cleared'` units are visible to matching engine — **N/A**, no bloodUnits collection (parked, Phase 2.5)
- [x] Rule: donor reads/updates only own profile; cannot edit privilege fields — adapted: donor self-updates any field on their own `users` doc EXCEPT `role`/`isVerified`/`isSuspended`/`rejected`/`email`/`verifiedAt`/`statusChangedAt`. (`bloodTypeSource`/`livesSaved`/eligibility fields don't exist in the real schema.) Tested, including self-elevation hostile cases.
- [ ] Rule: anonymous users can only create in `public_requests` with validated schema — **N/A**, no `public_requests` collection/feature exists in the real app yet (parked, Phase 2.5 — PHASE0_AUDIT.md §6 confirms no anonymous Firestore write path exists today)
- [ ] Rule: `system_admin` abuse-queue actions always logged with actor UID + timestamp — partial: role-grant actions are logged via `writeAudit` (Phase 1); no `reviewQueue`/abuse-queue collection exists in the real schema yet (parked, Phase 2.5)

### 1.4 IAM — Identity lifecycle
- [ ] Sign-in methods: email/password + phone OTP
- [ ] Password policy: min 12 chars, breach-list screened, rate-limited
- [ ] MFA mandatory for `hospital_admin`, `system_admin`, `lab_tech`
- [x] `grantRole()` callable Cloud Function (server-only privileged role assignment) — `functions/src/grantRole.ts`
- [x] Session management: `revokeRefreshTokens` on every role change/revocation (1h ID token expiry is the Firebase Auth default, unconfigured) — `functions/src/grantRole.ts`, `functions/src/revokeRole.ts`
- [ ] **Found during Part 3.2 abuse-case review, 2026-07-25 — needs your decision:** `revokeRefreshTokens` only blocks *future* token refreshes; a suspended user's already-cached ID token stays valid (and Firestore honors it — rules check signature+expiry, not revocation) for up to its ~1h natural expiry. Two mitigation options documented inline in `firestore.rules`'s `signedIn()` comment: (a) route suspend-sensitive privileged actions through Cloud Functions using `verifyIdToken(token, checkRevoked=true)` — where Phase 3 is headed anyway; (b) have `signedIn()` also cross-check a live `users/{uid}.isSuspended` Firestore field via `get()` — closes the gap for direct client reads/writes too, at the cost of an extra read per rule evaluation. Not picked unilaterally since (b) has a real cost/quota tradeoff at scale.
- [ ] Account recovery: verified reset + system_admin review for privileged roles
- [ ] Offboarding: `suspended` claim kill-switch is implemented and enforced in `canGrant`/`revokeRole` (`functions/src/roles.ts`, `functions/src/revokeRole.ts`) — quarterly access review export is not built
- [ ] Cloud Functions run under dedicated least-privilege service accounts

### 1.5 Privileged operations moved server-side
- [ ] `dispatchEmergencyAlert` Cloud Function
- [ ] `updateInventory` Cloud Function
- [x] `writeAudit` internal function (append-only) — `functions/src/audit.ts`. Writes to a new `auditLogs` collection; the legacy client-writable `activity_logs` collection is now locked to `write: if false` in `firestore.rules` (Phase 2) — `logActivity()` calls across the app fail silently (already try/caught) until Phase 3 gives it a proper Cloud-Function-backed replacement.
- [x] `grantRole` / `revokeRole` Cloud Functions — `functions/src/grantRole.ts`, `functions/src/revokeRole.ts`, unit-tested in `functions/src/{grantRole,revokeRole,roles}.test.ts`
- [ ] `escalateStaleRequests` scheduled function
- [ ] `submitPublicRequest` Cloud Function
- [x] `deactivateHospital`/`reactivateHospital` Cloud Functions — **DONE 2026-08-01.** Replaced the dead client-side `deactivateHospital`/`reactivateHospital` (db.js, which only wrote the cosmetic `isActive` field — a "deactivated" hospital's staff kept full access because the `suspended` claim was never touched). `functions/src/hospitalStatus.ts` (`setHospitalActiveHandler`): system_admin-only, zod-validated (`hospitalStatusSchema`), verifies the target is a real hospital account, then flips the kill-switch claim for EVERY account scoped to that `hospitalId` (staff + the hospital's own account), revoking refresh tokens on each; mirrors `isActive`/`statusChangedAt` on the users doc; audits with `staffAffected` count. **Individual suspensions survive reactivation**: deactivation stamps `hospitalSuspendedAt` on each staff claim; reactivation only clears `suspended` for marker-carrying accounts (individually suspended staff, no marker, stay suspended). Paginated `listUsers` traversal. UI: Deactivate/Reactivate buttons in the admin hospital list (main.js), "Deactivated" badge, plain-language confirm dialogs. Tests: 15 function tests (`hospitalStatus.test.ts`, 100% stmts/funcs), 2 app tests (`db.test.js`). Functions 76/76, app 21/21, lint/typecheck/build green. **Note for Security Lead review:** reactivating does not restore staff who were suspended individually while the hospital was down; also the hospital's own admin account is deactivated along with staff (that account must be reactivated with the hospital).
- [ ] `requestTransfer` / `approveTransfer` Cloud Functions
- [ ] Restricted-PHI export function (donor directory + `issuance_log`/audit CSV exports) — required by Security Policy 4 ("exports only via approved, logged admin function"); today `admin.html`'s CSV export (`downloadCSVFromTable`, `main.js:1620`/`1628`) is a plain unauthenticated client-side download with no audit entry. Surfaced during the Part 2 policy review, 2026-07-24 — not previously tracked.
- [x] `suspendUser`/`reactivateUser` Cloud Functions (replacing `db.js`'s client-side `suspendDonor`/`reactivateDonor`, still called directly from `admin.html`) — **DONE 2026-08-01 (Phase 3 kickoff).** `functions/src/suspendUser.ts` (`setUserSuspensionHandler` exported as `suspendUser` + `reactivateUser`): system_admin-only, zod-validated (`suspendUserSchema` in `functions/src/schemas.ts`), preserves role/hospitalId claims while flipping the `suspended` kill-switch claim, revokes refresh tokens, mirrors `isSuspended`/`isAvailable`/`statusChangedAt` onto the users doc via Admin SDK (`set` with merge, so it works for claim-only users), and writes the authoritative `auditLogs` event (actor, previousSuspended, reason). Caller gated BEFORE target resolution (no UID existence oracle, same closure as `revokeRole`); self-service blocked. Client `db.js` `suspendDonor`/`reactivateDonor` now call the callables via `httpsCallable` (`firebase/functions`) and never touch the users doc directly. Rules tests in root `firestore.rules.test.js` converted from "GAP pinned" to permanent guarantee: no client write path to suspension fields for ANY caller. Tests: 16 new function tests (`functions/src/suspendUser.test.ts`, 100% stmts/funcs on the handler), 2 new app tests (`db.test.js`, assert callable called + `updateDoc` never) — functions 60/60, app 19/19, typecheck + lint + build green. Remaining follow-up: `verifyHospital`/`rejectHospital` (already whitelist-compatible, not affected), then Phase 3 continues with `dispatchEmergencyAlert`, `updateInventory`, etc.

### 1.6 Remediate hardcoded admin secret
- [x] Remove secret + sign-up branch from code — `vitalpulse_app/src/main.js` (dead `ADMIN2024` check + live `admin@vitalpulse` email-substring backdoor removed), `vitalpulse_app/src/auth.js` (hardcoded `admin@vitalpulse.cm`/`.com` login backdoor removed)
- [ ] Audit and rotate all existing admin accounts — **manual, Security Lead**, not started
- [x] Purge secret from local git history — done with `git filter-branch` (no python/`git-filter-repo` available in this environment) on 2026-07-23. Rewrote `auth.js`/`main.js` blob content in every historical commit on both `main` and `security` (local refs), plus scrubbed the commit message of `fix: remove hardcoded admin backdoors...` which had quoted the raw strings. Verified: `git log <branch> -p` on both branches shows zero remaining occurrences of `ADMIN2024` / `admin@vitalpulse` in application source or commit messages. Left untouched: narrative mentions in `PHASE0_AUDIT.md`, `VitalPulse_Plan_Tracker.md`, `README.md`, `VITALPULSE_DOCUMENTATION.md` — these describe the fixed finding in prose (standard audit-trail practice), not an exploitable value. Final local cleanup (`git reflog expire --all` + `git gc --prune=now`) completed 2026-07-23 with your explicit go-ahead — confirmed via `git fsck` and a full object scan that the secret no longer exists anywhere in the local `.git` store. **Not yet done:**
  - Force-push of the rewritten `main`/`security` to `origin` — GitHub's copy is untouched; you said you'd do this yourself. Important: your local `origin/*` tracking refs currently show the rewritten commits too (filter-branch relabeled them), but that's local-only bookkeeping — a `git fetch` before you push will snap them back to the old remote history. Every other clone/fork must re-clone or hard-reset after you push, or they'll resurrect the old history on their next push.
  - Add gitleaks to CI — deferred to Phase 4 (CI/CD pipeline), not part of this rewrite.
- [ ] Bootstrap first `system_admin` via one-off owner-credential script — script is written and ready (`scripts/bootstrap-admin.ts`) but has not been run yet; running it is a manual Security Lead action (confirmed still pending 2026-07-23)

### 1.7 Additional hardening layers
- [ ] Firebase App Check (Play Integrity / reCAPTCHA Enterprise)
- [ ] Rate limiting on `submitPublicRequest` + auth endpoints
- [ ] Cloud Armor / hosting-level protections
- [ ] Field-level privacy for disease-test results
- [ ] Encryption/HTTPS-only, no PHI in URLs/logs/push payloads
- [ ] Daily Firestore backups to locked GCS bucket, 35-day retention, restore-tested

---

## PART 2 — Security & Governance Policy Suite (13 policies)

**Status:** all 13 reviewed against the real Phase 0–2 implementation on 2026-07-24 (content-complete, technically accurate to what's actually built or explicitly flagged as forward-looking where it isn't). Checked off here means *drafted and reviewed*, not *approved* — formal sign-off is a separate Part 5 go-live gate ("All 13 policies approved and version-controlled"). See "Part 2 completion notes" below for what each review changed and the full punch list of items only the Security Lead can close out.

- [x] 1. Information Security Policy (master)
- [x] 2. Access Control Policy
- [x] 3. Data Protection & Privacy Policy (bilingual EN/FR) — English drafted; **French translation still outstanding**
- [x] 4. Data Classification & Handling Policy
- [x] 5. Audit Logging & Monitoring Policy
- [x] 6. Incident Response & Breach Notification Policy
- [x] 7. Vulnerability & Patch Management Policy
- [x] 8. Secure Development Policy (SDLC)
- [x] 9. Business Continuity & Disaster Recovery Policy
- [x] 10. Acceptable Use Policy
- [x] 11. Third-Party & Vendor Security Policy
- [x] 12. Data Retention & Disposal Policy
- [x] 13. Anti-Abuse & Trust Policy

---

## PART 3 — Testing Strategy

### 3.1 Module (unit) testing
- [x] Firestore Security Rules test suite (`@firebase/rules-unit-testing` + Emulator) — `firestore.rules.test.js`, 81 tests (64 from Phase 2 + 17 abuse-case tests added 2026-07-25, see Part 3.2), run via `npm run test:rules` (`firebase emulators:exec --only firestore`). Confirmed passing 2026-07-25 (local Java-based emulator was intermittently flaky on this machine — crashes/timeouts on rapid relaunch, plus stale-process port conflicts — but the suite itself is consistently green; see Phase 2 / Part 3.2 completion notes).
- [x] Cloud Functions tests (Vitest, mocked Admin SDK — not `firebase-functions-test` specifically) — `functions/src/{roles,grantRole,revokeRole}.test.ts`, 44 tests (Phase 1)
- [x] Matching engine unit tests (blood-type compatibility; no radius exists to test) — `vitalpulse_app/src/db.test.js`, 14 tests via Vitest + jsdom, covering `getCompatibleBloodTypes`, `findMatchingDonors`, `autoMatchDonors`, `fetchMatchedRequestsForDonor`. Includes a named regression guard for the inverted-direction compatibility bug fixed in Part 4, and documents (without silently changing) two real gaps: there is no geographic radius matching anywhere in the app — despite the Master Plan's "radius matching" wording — matching is exact-city-string equality only; and `fetchMatchedRequestsForDonor`'s `location` parameter is accepted but never applied as a filter. Wired into `npm run test:unit` (root) and the CI `unit-tests` job.
- [ ] Escalation engine tests (timers, radius widening, fast-track)
- [ ] Public request intake tests (schema, rate limit, labeling)
- [~] Auth/IAM flow tests (grant/revoke, claim propagation, token revocation, MFA) — grant/revoke, claim propagation, and token revocation already covered by `functions/src/{roles,grantRole,revokeRole}.test.ts` (Phase 1); MFA has no tests because MFA itself isn't implemented yet (Part 1.4 gap)
- [ ] Frontend role-based UI tests (defense-in-depth only)
- [x] Coverage gates enforced in CI: 90%+ rules/authz, 80%+ overall — wired into `functions/vitest.config.ts` and `.github/workflows/ci-cd.yml`'s `unit-tests` job (Part 4, 2026-07-24); currently passing
- [x] Full rules test matrix (collection × role × action, incl. hostile cases) — all 10 real collections covered in `firestore.rules.test.js`, including cross-hospital, self-elevation, double-accept, and separation-of-duties hostile cases

### 3.2 Security testing
- [x] SAST (Semgrep + ESLint security plugins) on every PR — live in `.github/workflows/ci-cd.yml`'s `sast`/`lint-and-types` jobs (Part 4, 2026-07-24)
- [~] Dependency scanning (`npm audit` + Dependabot/Renovate) — `npm audit` live in CI for shipped code (Part 4); Dependabot/Renovate bot config itself not set up — needs you (repo settings)
- [~] Secret scanning (gitleaks in CI + GitHub push protection) — gitleaks live in CI (Part 4); GitHub push protection is a separate repo setting, not yet enabled — needs you
- [ ] DAST (OWASP ZAP baseline scan vs staging) — job written in CI, gated off pending staging infra (Part 4 notes)
- [~] Abuse-case scripted tests (fake requests, IDOR, token replay, App Check bypass) — 2026-07-25: IDOR-via-`list()` scripted against the emulator, `firestore.rules.test.js` +17 tests. **Found and fixed two real, exploitable bugs** (donor could enumerate every other donor's `donation_requests`/`donor_notifications` via an unfiltered list query — `list()` rules didn't check `resource.data.donorId` the way `get()` did) and **found one not-yet-fixed bug** (admin's suspend/reactivate-donor flow is already broken by the Phase 2 rules, documented with failing-as-expected tests, real fix is Part 1.5's new `suspendUser`/`reactivateUser` item). Token replay after suspension analyzed and documented as a real platform limitation (not testable via `@firebase/rules-unit-testing`'s synthetic auth context — would need a dual Auth+Firestore emulator integration test using real ID tokens; not attempted this pass) — see new Part 1.4 item. Fake-requests and App Check bypass remain N/A: no `public_requests` feature and no App Check exist yet.
- [ ] Manual penetration test (pre-launch + annual)
- [ ] OWASP ASVS L2 checklist signed off

### 3.3 Stress & load testing (k6)

**Status, honestly:** this section cannot be fully "completed" right now — genuine k6 load/throughput testing needs a real deployed target, and the only Firebase project that exists is production (`vitalpulse-fa458`, PHASE0_AUDIT.md §1). Running load tests against it would risk disrupting real emergency requests, which is exactly why Master Plan Part 4 requires separate dev/staging/prod projects in the first place — not done here, not something to do unilaterally. What *is* done: the two scenarios that are actually about correctness under concurrency (S3, S5), not raw throughput, have been verified for real against the local Firestore emulator, with no staging infrastructure needed. See "Part 3.3 completion notes" below for the full reasoning.

- [~] S1 — Mass-casualty spike — script rewritten against the real schema/Firestore REST API (`k6-stress-tests.js`, repo root); not run — needs a staging project + synthetic test accounts, neither exists yet
- [ ] S2 — Public page surge (0→500 RPS) — **N/A, removed from the script rather than faked:** no public/anonymous request feature exists in the app at all (PHASE0_AUDIT.md §6)
- [x] S3 — Donor response stampede (exactly-once accept) — **the actual safety property verified for real**, `concurrency.rules.test.js`, against the local Firestore emulator: 10 donors race to accept the same request concurrently, exactly 1 succeeds, 9 are rejected by the rule's own precondition check. Throughput/latency under 500 concurrent donors (the k6 load-testing half of this scenario) still needs staging.
- [ ] S4 — Escalation storm — **N/A, removed from the script rather than faked:** no escalation engine/scheduled function exists yet (Part 1.5, Phase 3)
- [x] S5 — Inventory consistency (concurrent mutations) — **verified, and it's a real, confirmed bug, not a pass:** `concurrency.rules.test.js` reproduces `deductInventoryStock`'s exact non-transactional read-modify-write logic and proves concurrent deducts silently lose updates (PHASE0_AUDIT.md §5's suspicion, now demonstrated). Not fixed here — real fix is Part 1.5's `updateInventory` Cloud Function using a Firestore transaction.
- [ ] S6 — Degraded network (2G/high-latency) — scaffolding/documentation only in `k6-stress-tests.js`'s header; needs a real deployed target to mean anything, not attempted
- [ ] Soak test (24h steady load) — needs a real deployed target (24h against the local emulator tells you nothing about production Firebase behavior); not attempted
- [ ] Firebase quota headroom + billing/quota alerts verified — Firebase console only, needs the Security Lead

---

## PART 4 — CI/CD Pipeline Security Gates

**Status:** `.github/workflows/ci-cd.yml` is installed and live as of 2026-07-24. Every gate through `build` runs for real on every PR/push and was verified green locally end-to-end before committing (lint 0 errors, typecheck clean, build succeeds, functions unit tests 44/44, rules tests 64/64). The staging/production stages below `build` are wired to the full pipeline shape but gated off (`vars.STAGING_DEPLOY_ENABLED`, unset) because the infrastructure they need doesn't exist yet — see "Part 4 completion notes" below for the full punch list.

- [x] Lint + typecheck stage — ESLint (flat config, `eslint.config.mjs`, includes `eslint-plugin-security` per Part 3.2) + `tsc --noEmit` across `functions/` and `scripts/`
- [x] Secret scan (gitleaks) — blocking
- [x] SAST (Semgrep) — blocking on high (community rulesets; no `SEMGREP_APP_TOKEN` configured yet — optional upgrade, not required to run)
- [x] Dependency audit — blocking on critical/high for shipped code (`vitalpulse_app`, `functions`, `scripts`); root devDependency tooling audit is informational-only, see completion notes
- [x] Unit tests + coverage gates — blocking; 90% authz-file / 80% overall thresholds wired into `functions/vitest.config.ts`, currently passing (93.82% stmts / 85% branches / 85.71% funcs overall)
- [x] Firestore Rules tests (emulator) — blocking, 83/83 passing (81 rules + 2 concurrency, as of Part 3.3, 2026-07-25)
- [ ] Staging deploy pipeline (rules → functions → hosting order) — job written, gated off pending staging infra
- [ ] ZAP baseline scan on staging — blocking on high — job written, gated off pending a staging URL
- [ ] Smoke k6 load test on merge — job written, gated off pending staging infra; `k6-stress-tests.js` itself is no longer the blocker — already adapted to the real schema and promoted from `docs/` to repo root (Part 3.3, 2026-07-25)
- [ ] Production release gate: tag + manual approval + auto-rollback on failed smoke — job written, gated off pending production infra
- [ ] GitHub branch protection: PR + 1 review required on `main`; 2 reviews required for changes to `firestore.rules`, auth code, or Cloud Functions authz — required by Security Policy 8 §1; not yet a live repo setting (this is a repo-settings change, not something in the workflow YAML — needs you). Surfaced during the Part 2 policy review, 2026-07-24.

**All 5 remaining items above are blocked on the exact same two things: a non-production Firebase project (staging deploy, ZAP, smoke k6, production release gate) and GitHub repo settings only the Security Lead can change (branch protection). See `Part3_Completion_Requirements.md` §1/§2 — the prerequisites are identical to what's blocking the rest of Part 3.3. There is no further CI/CD code to write until those exist.**

---

## PART 5 — Pre-Deployment Go-Live Checklist

**Security**
- [ ] Hardcoded admin secret removed from code AND git history; admin accounts audited/rotated
- [ ] Firestore rules deny-by-default verified; full rules test suite green
- [ ] All privileged writes only via Cloud Functions; direct-write attempts denied in staging
- [ ] MFA enforced for all privileged roles; token revocation on suspension verified
- [ ] App Check enforced on Firestore, Functions, Storage
- [ ] Rate limiting live on public request intake + auth endpoints
- [ ] Audit logging live, append-only, alerting configured
- [ ] Pen test complete; all critical/high findings closed
- [ ] ZAP + ASVS L2 checklist signed off

**Compliance & policy**
- [ ] All 13 policies approved and version-controlled; privileged users acknowledged AUP
- [ ] Bilingual (EN/FR) privacy notice + consent flows live
- [ ] Data-processing records + Firebase/Google DPA on file
- [ ] Incident response plan tested with one tabletop exercise
- [ ] Breach notification contacts confirmed (ANTIC / ministry / partners)

**Reliability**
- [ ] All k6 scenarios S1–S6 + soak passed on staging
- [ ] Backups running; one restore drill completed
- [ ] Quota + billing alerts configured; error monitoring with on-call alerting
- [ ] Rollback rehearsed once end-to-end

**Operational**
- [ ] Domain + TLS, security headers (CSP, HSTS) on hosting
- [ ] security@ disclosure contact published
- [ ] Runbooks written: alert fan-out failure, escalation-engine failure, Firestore outage degraded mode

---

## Companion Deliverable Files

- [x] `VitalPulse_Security_Policies.md` — full policy texts, reviewed against the real Phase 0–2 implementation 2026-07-24 (Part 2 work); formal approval still pending, see "Part 2 completion notes" below
- [x] `firestore.rules` — reference implementation exists in `vitalpulse_app/docs/`; the REAL, deployed-schema implementation is now at repo root (`firestore.rules`, Phase 2)
- [x] `firestore.rules.test.js` — starter exists in `vitalpulse_app/docs/`; the REAL test suite (81 tests: 64 from Phase 2 + 17 abuse-case tests, Part 3.2, 2026-07-25) is now at repo root (`firestore.rules.test.js`)
- [x] `ci-cd-pipeline.yml` — drafted reference in `vitalpulse_app/docs/`; the real, installed workflow is now at `.github/workflows/ci-cd.yml` (Phase 4, 2026-07-24) — PR-time gates live, staging/production gated off pending infra
- [x] `k6-stress-tests.js` — aspirational-schema draft exists in `vitalpulse_app/docs/`; the real, schema-accurate version is now at repo root (Part 3.3, 2026-07-25) — targets Firestore's REST API directly (the real app has no custom REST backend), S2/S4 removed as N/A rather than faked; not yet run against staging (none exists). S3/S5's actual correctness properties are separately verified via `concurrency.rules.test.js` (2 tests) against the local emulator, no staging needed.
- [x] `Part3_Completion_Requirements.md` (new, 2026-07-25) — standing checklist of exactly what's still needed to fully close Part 3, split by who/what supplies it (Firebase dev/staging project, GitHub repo settings, Security Lead decisions, pen test, Phase 3 feature work). Read this before starting a new Part 3 session instead of re-deriving it.

---

## Change Log

| Date | Change |
|---|---|
| 2026-08-01 | **Hospital deactivation is now real.** `deactivateHospital`/`reactivateHospital` Cloud Functions (`functions/src/hospitalStatus.ts`): system_admin-only, verifies the target is a hospital account, flips the `suspended` kill-switch claim on every account scoped to that `hospitalId` (staff + the hospital's own account) with token revocation, stamps `hospitalSuspendedAt` so reactivation only lifts hospital-wide suspensions (individual suspensions survive), mirrors `isActive`, audits with `staffAffected`. Admin hospital list now has Deactivate/Reactivate buttons + "Deactivated" badge (main.js). Replaced the old dead-code client writes in db.js. 15 function + 2 app tests; functions 76/76, app 21/21, all gates green locally. |
| 2026-08-01 | **Phase 3 kickoff — suspension is now server-only.** New `suspendUser`/`reactivateUser` Cloud Functions (`functions/src/suspendUser.ts`): system_admin-only, zod-validated, flips the `suspended` claim + revokes refresh tokens + mirrors the users doc + writes the auditLogs event in one server-side unit. Client `db.js` `suspendDonor`/`reactivateDonor` rewired to callables (first `httpsCallable` usage in the app); direct client writes to `isSuspended`/`isAvailable` stay permanently denied by rules (root `firestore.rules.test.js` GAP block converted to a permanent-guarantee block). 16 new function tests + 2 new app tests; functions 60/60, app 19/19, lint/typecheck/build green. |
| 2026-08-01 | **CI fully green** — first pipeline run to pass every blocking gate (secret-scan, dependency-audit, sast, lint-and-types, unit-tests 17/17, **rules-tests 90/90 emulator tests** incl. S5 concurrency, build). Fixed along the way: functions lockfile regenerated with npm 11 (npm ci gate was failing on missing `@emnapi/*` resolved entries), `npm audit fix` (app 0 vulns; functions/scripts moderate-only), and a real rules hole the new test caught — self-write of `isActive` on `users` was allowed (hospital could silently deactivate itself off the verified network); now blocked. Staging/prod deploy, integration, DAST, and load-test jobs remain gated off pending staging infra (`STAGING_DEPLOY_ENABLED`). |
| 2026-08-01 | **Critical fixes batch (Security Lead's "fix this first" list):** (1) `receiveBloodTransfer` rewritten as a single `runTransaction` (was read→compute→updateDoc outside any transaction, and queried a non-existent `hospitalName` field on batch-model inventory docs — transfers never moved real stock). S5 concurrency test now mirrors the shipped transactional pattern and asserts the exact final count (10 = 20 − 10, plus a mixed add/deduct case). (2) Staged `firestore.rules` migration-readiness reconciliation: `requests`/`public_requests`/`donation_requests` update whitelists now match the REAL client write shapes (donor self-assign `checkInToken`/`donorScreeningPassed`; `Broadcasting`→`Donor Assigned` for public requests; `donationCompletedAt` not `donationCompleteAt`; `cancelledBy`/`cancellationReason`; full `recordDonationIntake` payload; `Issued`/`labResolvedAt`; admin broadcast `type`-only), `users` whitelist + `rejectedAt`/`isActive`, `inventory` rule split (create stamps own hospitalId; update scopes on resource + tolerates partial `minimumThreshold` updates), `blood_transfers`/`shadow_hospitals`/`hemovigilance`/`demand_forecasts`/`myth_articles` create-vs-update splits, +15 missing collection blocks. (3) LIVE `vitalpulse_app/firestore.rules`: IDOR closures (`donation_requests`, `donor_notifications`, `hospital_notifications`, `admin_notifications`, `activity_logs`) and `isAuth()` now cross-checks the live `users.isSuspended` field (closes the stale-ID-token gap for direct client access; costs an extra read per rule evaluation). (4) Client now stamps `hospitalId` on requests/inventory writes so the claims rules can scope. (5) **Medically significant UI bug fixed:** the compatibility modal's "Receives from" grid called `getCompatibleBloodTypes` (donate-to semantics, db.js:877) — an O- patient was shown "can receive from all 8 types"; now uses `getCompatibleDonorTypes` (the inverse). Reconciled the security branch's `db.test.js` (written against its receives-from semantics) to main's two-function model — 17/17 unit tests pass; added the `autoMatchDonors` missing-city guard. Tests updated: +12 rules tests. Rules tests themselves still only run in CI (no local Java/emulator). |
| 2026-07-31 | **Correction to Phase 1 record:** the hardcoded admin backdoors were removed on the `security` branch only (`1dfad6d`); main's working tree was never fixed — `ADMIN2024` + `admin@vitalpulse` email-substring grants were still live in `main.js:213` and the `admin@vitalpulse.cm`/`.com` overrides still in `auth.js`. Detected during the security→main merge (2026-07-31) and now removed from main (`fix: remove hardcoded admin backdoors...`). Admin access is now exclusively via Firestore `users/{uid}.role`. Remaining follow-up: audit existing accounts granted admin via the removed substring checks (pending Security Lead). |
| 2026-07-31 | Merged `security` branch into `main` (surgical merge, no shared history): adopted the branch's new assets — Cloud Functions (`grantRole`/`revokeRole`), `scripts/` (bootstrap/backfill), deny-by-default `firestore.rules` (staged at root, **NOT deployed** — requires the claims migration), emulator rules test suite, k6 scripts, ESLint config, CI/CD pipeline; kept main's newer app code. ESLint gate fixed to 0 errors (incl. 2 latent runtime bugs). `vitalpulse_app/.env` untracked and re-ignored (never pushed). |
| 2026-07-21 | Tracker created from Master Plan v1.0 |
| 2026-07-21 | Phase 0 audit completed — `vitalpulse_app/docs/PHASE0_AUDIT.md` |
| 2026-07-22 | Phase 1 completed pending Security Lead review — see "Phase 1 completion notes" below |
| 2026-07-23 | Purged `ADMIN2024`/`admin@vitalpulse` from local git history (`main` + `security`, via `git filter-branch`) per Security Lead go-ahead. Re-verified functions test suite (44/44 passing) and typecheck clean. Three items confirmed still pending directly with the Security Lead: reflog/gc finalization go-ahead, force-push to `origin`, `bootstrap-admin.ts` execution, and admin-account audit/rotation. See updated "Phase 1 completion notes" below. |
| 2026-07-23 | Completed final local git-history cleanup (`reflog expire` + `gc --prune=now`) with Security Lead go-ahead — old tainted objects confirmed unreachable/pruned locally. |
| 2026-07-24 | Phase 2 completed pending Security Lead review — real-schema `firestore.rules` + `firestore.rules.test.js` (64 tests) + hospitalId migration. See "Phase 2 completion notes" below. |
| 2026-07-24 | Master Plan Part 2 (13-policy suite) reviewed against the real Phase 0–2 implementation, at the Security Lead's direction. Two untracked gaps surfaced and added to Part 1.5/Part 4. See "Part 2 completion notes" below. |
| 2026-07-24 | Master Plan Part 4 (CI/CD pipeline) installed at `.github/workflows/ci-cd.yml`, at the Security Lead's direction. PR-time gates verified green locally end-to-end; found and fixed several real, pre-existing bugs while turning on lint for the first time, including one medically-significant inverted blood-compatibility display bug. See "Part 4 completion notes" below. |
| 2026-07-25 | Part 3.1 "Matching engine unit tests" closed: stood up Vitest + jsdom for `vitalpulse_app` (didn't exist before — no frontend test tooling at all), wrote 14 tests for `getCompatibleBloodTypes`/`findMatchingDonors`/`autoMatchDonors`/`fetchMatchedRequestsForDonor`, wired into `npm run test:unit` and CI. Chosen over other Part 3 starting points (abuse-case tests, escalation/public-request test scaffolding) per the Security Lead's explicit choice, since it's directly actionable now and guards the exact code where Part 4 found a medically-significant bug. |
| 2026-07-25 | Part 3.2 abuse-case scripted testing (partial): added 17 `list()`-level IDOR tests to `firestore.rules.test.js` (64→81). Found and fixed two real, exploitable bugs (`donation_requests`/`donor_notifications` list rules let any donor enumerate every other donor's records). Found and documented (not fixed) that `admin.html`'s suspend/reactivate-donor flow is already broken by the Phase 2 rules, and that it never touched the real access-control claim to begin with — new Part 1.5 item. Analyzed and documented the stale-ID-token-after-suspension platform limitation — new Part 1.4 item. See "Part 3.2 completion notes" below. |
| 2026-07-25 | Part 3.3 (k6 stress/load testing) addressed as far as honestly possible without a staging environment: rewrote `k6-stress-tests.js` against the real Firestore-REST-API architecture (promoted from `vitalpulse_app/docs/` to repo root), removed S2/S4 as N/A rather than faking non-existent features, and — separately — actually verified S3 (exactly-once accept) and S5 (inventory consistency) for real against the local Firestore emulator in new `concurrency.rules.test.js` (2 tests, no staging needed). S5 confirms a real, known, unfixed lost-update bug. S1/S6/soak/quota remain blocked on staging infrastructure or Security Lead console access — not run, not faked. Also recounted every checkbox in this document directly from the file (`grep`/`awk`) after finding the running Part 1 total had drifted (36 vs. the actual 41) — corrected the Progress Summary to the verified count. |

## Part 3.3 completion notes (2026-07-25) — stress & load testing

**Why this can't just be "completed" on request:** the Master Plan's S1–S6 scenarios are k6 *load* tests — they need an HTTP target to hammer with hundreds of concurrent requests. The only Firebase project that exists today is production (`vitalpulse-fa458`). Running load scenarios against it would mean firing synthetic mass-casualty traffic and inventory mutations at the real database backing whatever emergency requests are live at the time — precisely the risk Master Plan Part 4's separate dev/staging/prod requirement exists to prevent (not done yet, see Part 4 notes). So this pass split the work into what's genuinely safe to do without that infrastructure, and was explicit about what still isn't.

**Done — the k6 script itself, made honest:** `vitalpulse_app/docs/k6-stress-tests.js` (the untouched Master Plan draft) assumed a custom REST backend — `/api/requests`, `/api/public-requests`, `/api/requests/{id}/accept`, `/api/inventory/mutate`, even a `/test-support/token` endpoint — none of which exist. The real app has no REST API of its own; the browser talks to Firestore directly via the client SDK (PHASE0_AUDIT.md §1). Rewrote it from scratch at repo root (`k6-stress-tests.js`) to hit Firestore's *own* REST API directly (typed `fields` value encoding and all), against the real `requests`/`inventory` collections:
- **S1 (mass-casualty spike):** adapted, ready to run once a staging project + synthetic test accounts exist. Not run.
- **S2 (public page surge):** removed, not faked — there is no public/anonymous request feature anywhere in the app (PHASE0_AUDIT.md §6). Re-add once `submitPublicRequest` ships.
- **S4 (escalation storm):** removed, not faked — no escalation engine or scheduled function exists yet (Part 1.5, Phase 3 work).
- **S6 (degraded network) / soak:** left as documented scaffolding only. Both need a real deployed target to mean anything — throttling or running 24h against the local emulator wouldn't measure anything about actual Firebase infrastructure behavior.
- Every removed/blocked scenario is explained in the script's own header comment, not silently dropped.

**Done — the part that's actually about correctness, not infrastructure:** S3 and S5, read closely, aren't really "can the server handle load" questions — they're "does the safety invariant hold when N clients race" questions, which is a property of the rules/client code and is safely testable against the local Firestore emulator with zero staging infrastructure. New file `concurrency.rules.test.js` (wired into `npm run test:rules` via `vitest.rules.config.js`):
- **S3 — donor stampede:** 10 different donor identities concurrently `updateDoc` the same `Open` request to accept it. Result: **exactly 1 succeeds, 9 are rejected** — Firestore serializes concurrent writes to one document and evaluates the rule's `resource.data.status == 'Open'` precondition against the real, current server state each time, so only the write that lands while it's still `Open` can pass. This is the actual mechanism providing the "exactly-once" guarantee; now there's a test proving it, not just an assumption.
- **S5 — inventory contention:** reproduces `deductInventoryStock`'s exact real logic (read `unitsAvailable` via `getDoc`, compute the new absolute value, `updateDoc` it — no transaction) and fires 10 of these concurrently against a shared inventory doc starting at 20 units. Result: **the final count is higher than the correct `20 - 10 = 10`** — confirming the lost-update race PHASE0_AUDIT.md §5 already suspected is real, not hypothetical. Deliberately not fixed here (that's Part 1.5's `updateInventory` Cloud Function, which needs an actual Firestore transaction) — the test is written so it will start failing (in the good way) once that fix lands, with a comment saying so.
- Initial version of both tests had a bug in the test harness itself (reading final state back via a second `withSecurityRulesDisabled` call, which doesn't reliably see the prior write) — fixed by reading back through a normal authenticated context instead, which the rules already permit for both cases.

**Verified:** `npm run test:rules` green at 83/83 (81 rules + 2 concurrency). Lint clean on all new/changed files.

**Also found while doing this:** the tracker's own running totals had drifted — recomputed every checkbox directly from the file with `awk` rather than trusting incremental arithmetic across many edits, and found Part 1's total was actually 41 items, not the 36 the Progress Summary said. Corrected. Nothing about actual completion status changed, only the arithmetic — flagging this so a future session doesn't inherit a silently-wrong baseline.

**Not done / needs you directly:** a real staging Firebase project (or at minimum a dedicated non-production target) before S1/S3/S5 can actually be load-tested rather than correctness-tested; S6 and the soak test have no meaningful path without one either; Firebase quota headroom and billing/quota alerts are console-only and need your access.

## Part 3.2 completion notes (2026-07-25) — abuse-case scripted tests

**What this covered, concretely:** every existing rules test used `getDoc`/`setDoc`/`updateDoc`/`deleteDoc` on a *known document ID* — none exercised Firestore's `list()` rule evaluation, which is a genuinely different code path from `get()`. A `list` rule that doesn't reference `resource.data` grants the query unconditionally regardless of what the `get` rule for the same collection says. This review specifically went looking for that mismatch across all 10 collections.

**Two real, exploitable bugs found and fixed in `firestore.rules`:**
- `donation_requests` and `donor_notifications` both had `allow list: if isSystemAdmin() || isHospitalRole() || isDonor();` (or the `donor_notifications` equivalent) — no `resource.data.donorId` check, unlike their `get` rules. Any authenticated donor could run an **unfiltered** `getDocs(collection(db,'donation_requests'))` and receive **every donor's** donation history (blood type, preferred date/location, notes) or **every donor's** notification content (emergency-alert text, which can include hospital name, urgency, notes). The code comments claimed "donor client always queries where(donorId==self)" — true for the two real call sites (`fetchDonationRequestsForDonor`, `fetchDonorNotifications` in `db.js`, both verified), but nothing in the *rule* enforced it, so a hostile client bypassing the app entirely (devtools, a scripted client) could just omit the filter.
- Fixed by adding `resource.data.donorId == request.auth.uid` to both `list` rules, matching their `get` rules exactly. Verified the app's own two call sites already filter by `donorId==self`, so this is a pure tightening with no legitimate-flow impact.
- Added 6 regression tests confirming the fix (own-data list succeeds; unfiltered list denied; probing another donor's ID via an explicit `where` filter also denied) for both collections.
- Added 9 more regression tests for `requests`/`inventory`/`hospital_notifications`/`issuance_log` — these were **already correctly scoped** (their `list` rules do reference `resource.data.hospitalId`), but had zero test coverage of `list()` specifically before this. Pure regression insurance: a future rules edit during Phase 2.5 schema evolution could silently reintroduce this exact bug class and the old suite would never notice, since it never touched `list()` at all.

**One real bug found and documented, not fixed here (Phase 3 scope):** `db.js`'s `suspendDonor`/`reactivateDonor` — still wired to `admin.html`'s suspend/reactivate buttons — write `{isSuspended, isAvailable, statusChangedAt}` in one `updateDoc`. The `system_admin` privileged-update rule whitelists `['isVerified','isSuspended','rejected','verifiedAt','statusChangedAt']` — **`isAvailable` isn't in it**, so this exact write is rejected outright for any caller, including `system_admin`, the moment these rules are deployed. Added two tests proving the current code's exact write shape fails against the current rules (`assertFails`, not `assertSucceeds` — these pin the *current broken state*, so they'll need updating once Part 1.5's new `suspendUser`/`reactivateUser` Cloud Function replaces this flow). Deliberately did **not** just widen the whitelist to include `isAvailable` — that would silence the symptom while leaving the real problem untouched: this flow never calls `revokeRole`, so even a "fixed" version would only ever update a cosmetic Firestore field, not the custom claim `signedIn()` actually checks. A donor "suspended" this way today keeps full Firestore access indefinitely. `verifyHospital`/`rejectHospital` write only whitelisted fields and don't have this problem.

**One platform-level limitation analyzed and documented, not tested here:** "token replay after suspension" (Master Plan 3.2's own phrase). Confirmed via code reading (not a live exploit demo) that `revokeRefreshTokens()` only blocks *future* token refreshes — Firestore's rule evaluation checks a token's signature and expiry, not its revocation status, so a user's already-cached ID token keeps whatever access it was minted with for up to its ~1h natural lifetime, regardless of `suspended` being set server-side in the meantime. This is **not testable** with `@firebase/rules-unit-testing` (its `authenticatedContext(uid, claims)` fabricates claims directly — there's no real token lifecycle to replay). A real test would need the Auth emulator + real client-SDK sign-in to mint a genuine ID token, then reuse it after suspending server-side — a materially different, heavier integration-test harness than anything in this repo today. Documented the mechanism and two mitigation options directly in `firestore.rules`'s `signedIn()` comment and as a new Part 1.4 tracker item, rather than either building a rushed/fragile test or leaving it unmentioned.

**Verified:** full suite (`firestore.rules.test.js`) at 81/81 passing after all changes (64 original + 17 new). Lint clean on the modified test file.

**Not done — Part 3.2 remains partial:** DAST (ZAP), the manual pen test, and the ASVS L2 checklist are untouched — DAST needs staging infra (Part 4), the other two need people/sign-off, not code. "Fake requests" and "App Check bypass" abuse-cases remain correctly N/A (neither feature exists yet).

## Part 3.1 completion notes (2026-07-25) — matching engine unit tests

**Scope decision, asked and answered:** Part 3 spans module tests, security tests (SAST/DAST/pen test/ASVS), and k6 stress scenarios — fundamentally different kinds of work, some blocked on Phase 3 features that don't exist (escalation engine, public request intake), some needing infra (staging for DAST/k6) or people (pen tester) I don't have. Asked the Security Lead where to start; chose matching-engine unit tests over abuse-case scripted tests or writing test scaffolding for unbuilt features.

**Done:**
- **`vitalpulse_app/vitest.config.js`** (new) + `vitest`/`jsdom` devDependencies + a `test` script — this app had zero test tooling before this (Part 3.1 previously listed "Frontend role-based UI tests" as not-started because nothing existed to run them). `jsdom` is required because `db.js` has a module-level `window.smsLink = ...` assignment that throws under a plain Node environment.
- **`vitalpulse_app/src/db.test.js`** (new, 14 tests) — mocks `./firebase` and the `firebase/firestore`/`firebase/auth` SDKs (no real network/Auth-SDK-in-Node concerns) and tests the real exported functions:
  - `getCompatibleBloodTypes` — full 8-type ABO/Rh matrix, exhaustively checked against real compatibility facts, plus the fallback-to-self behavior for an unrecognized type.
  - A dedicated **regression-guard block for the inverted-compatibility bug fixed in Part 4** — pins the correct "donates to" derivation (`allTypes.filter(t => getCompatibleBloodTypes(t).includes(type))`) so that bug class can't silently return.
  - `findMatchingDonors` — verifies the Firestore query filters (role/compatible-types/availability/exact-city) and documents that `radiusKm` has zero effect — there is **no geographic radius matching anywhere in the real app**, despite the Master Plan and this tracker item's own name saying "radius"; matching is exact-city-string equality only (PHASE0_AUDIT.md §6). Renamed the tracker checklist line to stop implying radius matching exists.
  - `autoMatchDonors` (the actual alert fan-out engine) — the missing-field guard clause, suspended-donor exclusion, and that `matchingDonorsNotified`/`matchingDonorsCount` are only stamped when donors actually match.
  - `fetchMatchedRequestsForDonor` — documents, without silently changing, that its `location` parameter is accepted but never used to filter — a donor's "matched requests" feed shows every compatible open request nationwide today. Flagged as a possible product gap, not fixed, since it's unclear whether that's intentional (a national browse view) or an oversight.
- Wired into `npm run test:unit` (root) and the CI `unit-tests` job (`.github/workflows/ci-cd.yml`) alongside the Cloud Functions tests. Verified end-to-end: lint clean, build clean, 44 functions tests + 14 frontend tests all passing.

**Not done — Part 3 remains mostly open:** escalation-engine and public-request-intake tests are still blocked on Phase 3 (those Cloud Functions don't exist yet); frontend role-based UI tests (beyond this matching-engine slice), abuse-case scripted tests, the manual pen test, the ASVS L2 checklist, and all six k6 stress scenarios are untouched. See Part 3 checklist above for the full remaining list.

## Part 4 completion notes (2026-07-24)

**Why this took more than copying the reference YAML:** the drafted `ci-cd-pipeline.yml` assumed tooling that didn't exist yet — no ESLint config anywhere in the repo, no orchestration scripts at the root, no coverage thresholds, and a single Firebase project with no staging/production separation (PHASE0_AUDIT.md §1). Installing the pipeline meant building the tooling underneath it first, then verifying every gate actually goes green locally before committing a workflow that claims to gate merges — installing something that would just be red on the first PR isn't "installed with all gates green," it's the same gap with different paperwork.

**Done:**
- **`eslint.config.mjs`** (new, repo root) — ESLint 9+ flat config covering `vitalpulse_app/src` (browser JS), `functions/src` + `scripts` (TypeScript via `typescript-eslint`), and the one-off `.cjs` build scripts. Includes `eslint-plugin-security` so the lint gate also covers Part 3.2's "SAST: Semgrep + ESLint security plugins" requirement, not just Semgrep alone. `vitalpulse_app/docs/**` (Master Plan reference/draft files, not live code) is excluded from lint scope.
- **Root `package.json`** renamed from the leftover `vitalpulse-rules-tests` to `vitalpulse` and given real orchestration scripts: `lint`, `typecheck` (fans out to `functions/` + `scripts/`), `build` (delegates to `vitalpulse_app`), `test:unit`. `scripts/package.json` gained a `typecheck` script (was missing entirely — operator scripts had no type-checking gate before this).
- **`functions/vitest.config.ts`** — added the coverage thresholds Part 3.1 already called for but never wired in: 90% on `grantRole.ts`/`revokeRole.ts`/`roles.ts`, 80% global. Added `@vitest/coverage-v8` and a `test:coverage` script. Currently passing (93.82% stmts, 85% branches, 85.71% funcs, 100% on the three authz files' statements/lines).
- **`.github/workflows/ci-cd.yml`** (new) — the live GitHub Actions workflow. `secret-scan`, `lint-and-types`, `sast`, `dependency-audit`, `unit-tests`, `rules-tests`, `build` all run for real on every PR/push and were verified green locally before committing. `deploy-staging` → `post-deploy-smoke` are written to the full Master Plan shape but gated behind `vars.STAGING_DEPLOY_ENABLED` (unset today, so skipped rather than red) — see "Not done" below for what has to exist before flipping that on.
- **Fixed real, pre-existing bugs that turning on lint for the first time surfaced** (none of these were introduced by this change — ESLint's `no-undef`/`no-func-assign` caught genuine defects already in the shipped app):
  1. **Medically significant:** the hospital dashboard's "Blood Compatibility Guide" modal (`initCompatibilityGuideModal`, `main.js`) had its donor/recipient directions inverted. `getCompatibleBloodTypes(X)` returns "types X can receive from," but the "Donates to" grid was using that function's result directly instead of inverting it — e.g. it would have shown O- (the universal donor) as only donating to O-, instead of to all 8 types. The "Receives from" grid then crashed (`ReferenceError`) reading a variable (`canDonateTo`) that belonged to a different closure entirely, because of what looks like a copy-paste mixup between the two grid-building blocks. Fixed both: donor grid now correctly computes `allTypes.filter(t => getCompatibleBloodTypes(t).includes(type))`, recipient grid now reads its own `canReceiveFrom`. Verified against real compatibility facts (O- donates to all 8; AB+ donates only to AB+) by hand before committing.
  2. `deductInventoryStock` (`db.js`) — after correctly updating the inventory document, the function fell through into ~40 lines of dead code building a `timeline` array (checking `data.status`/`data.matchedAt`, fields that belong to `requests` docs, not `inventory` docs) that referenced an undeclared `timeline` variable. Every call to `deductInventoryStock` threw `ReferenceError` after its real work was already done, silently breaking the caller's promise chain. The block was leftover/duplicated from the request-timeline feature, which is correctly implemented independently in `main.js`'s `window.openRequestTimeline`. Removed the dead block; the function now returns cleanly.
  3. `fetchInventoryMovements` (`db.js`) called two functions, `fetchHospitalActivityLogs` and `fetchIssuanceLogs`, that were never defined anywhere — this hospital "inventory movement history" feature (`main.js:3843`) was completely broken, throwing on every open. Implemented both: `fetchIssuanceLogs` queries `issuance_log` by the real `hospital` field (exact match, same pattern as `fetchHospitalRequests`); `fetchHospitalActivityLogs` is a best-effort text match, because `activity_logs` has no hospital field at all in the real schema (PHASE0_AUDIT.md §7) — a precise fix would need a schema change (stamping hospital identity onto every `logActivity` call), which is out of scope here and noted inline in the code.
  4. `auth.js`'s `onAuthChange` assigned to an undeclared `currentUser` (module-level `let currentUser = null` was missing). Currently dead code — nothing imports `onAuthChange` — so this bug has never fired in production, but it's now correct.
  5. A dead `switchView('settings')` call in the shared notification dropdown (`initNotificationSystem`) referenced a `switchView` that's scoped inside two other, unrelated functions — removed; the dropdown now just closes, matching what actually happened before (the call always threw and did nothing). Not re-wired to a working destination because I couldn't verify a correct target across all three dashboards without a browser session — flagging rather than guessing.
  6. Two harmless-but-real `no-useless-escape` findings (`<\/script>` in two generated print-window template strings in `main.js`) — the escape has no effect in a `.js` module (only matters inside literal inline `<script>` HTML), removed.
  - Tuned two ESLint rules rather than rewriting working code: `no-func-assign` off for `main.js` (it deliberately monkey-patches `loadHospitalDashboard`/`loadHospitalSettings` — intentional, not a bug) and `no-useless-assignment` off for `main.js` (harmless `let x = ''` before an exhaustive if/else-if/else chain, a pre-existing style pattern used ~6 times).
- **Ran `npm audit fix` for `vitalpulse_app`** (non-forced — a fix was available without breaking changes): resolved 4 high + 1 critical (vite, websocket-driver transitive). Verified build still succeeds after the bump. `functions` and `scripts` have moderate-only findings (don't fail the `--audit-level=high` gate). Root's devDependency tree (firebase-tools' transitive `google-gax`/`teeny-request`/`retry-request`/`uuid`) has 2 high + 2 critical with **no non-forced fix available** — kept as an informational, non-blocking check in the workflow rather than either lying about it being clean or redding out every future PR over CI/dev-only tooling. Flagged below for your call.

**Not done / needs you directly:**
- **Risk-acceptance decision on the root devDependency audit** (2 high + 2 critical, transitive via `firebase-tools`, dev/CI tooling only — never shipped to a user). Either accept the risk in writing with an expiry per Policy 1, or force-upgrade `firebase-tools` and re-verify nothing breaks (I did not attempt this — `--force` fixes here are more likely to break the Firestore emulator/deploy tooling than the vitalpulse_app vite bump was).
- **GitHub branch protection** on `main` (PR + 1 review; 2 reviews for `firestore.rules`/auth/authz changes, per Security Policy 8 §1) — a repo settings change, not something in the workflow YAML; didn't do this without your confirmation since it affects how every future PR merges.
- **Everything needed to flip `vars.STAGING_DEPLOY_ENABLED` to `'true'`:** a real staging Firebase project (today there's only `vitalpulse-fa458`), a `hosting` block in `firebase.json` (none exists), `FIREBASE_SERVICE_ACCOUNT`/`FIREBASE_PROJECT_ID` secrets in "staging"/"production" GitHub Environments (environments themselves also don't exist yet — "production" needs required reviewers configured), `vars.STAGING_URL`/`vars.PROD_URL`, `k6-stress-tests.js` adapted to the real schema and promoted from `vitalpulse_app/docs/` to the repo root (Part 3.3 work — same situation `firestore.rules` was in pre-Phase 2), and `test:integration`/`test:smoke` npm scripts (don't exist yet).
- **Gitleaks license note:** `gitleaks-action@v2` is free for personal-account repos (this one, `github.com/Legend281/vitalpulse`) but requires a `GITLEAKS_LICENSE` secret if this ever moves to a GitHub organization — noted as a comment in the workflow.
- **No automated test coverage for the `vitalpulse_app` frontend** (`db.js`/`main.js`/`auth.js`) — the bug fixes above were verified by hand-tracing logic and confirming the production build still compiles cleanly, not by a test suite, because none exists yet for the frontend (already tracked as not-started in Part 3.1). Worth prioritizing given what turning on lint alone just found.

## Part 2 completion notes (2026-07-24)

**Why this needed a review, not just a checkbox:** `VitalPulse_Security_Policies.md` already existed as a full v1.0 draft, but — like the Master Plan's reference `firestore.rules` before Phase 2 — it was written against the Master Plan's idealized system (6 roles, per-unit blood lifecycle, a public request page), not the real app `PHASE0_AUDIT.md` found. Rubber-stamping it would have shipped a governance document that misdescribes reality to hospitals/ministry/partners who read it later. This pass read the real implementation state (PHASE0_AUDIT.md + the Phase 1/2 completion notes above) and reconciled the text against it, the same way Phase 2 reconciled the reference rules file.

**Done — `vitalpulse_app/docs/VitalPulse_Security_Policies.md`:**
- Added a "Review & Adoption Status" block right after the header, summarizing what's confirmed factually true today, what's reframed as forward-looking, and what's still bracketed pending the Security Lead.
- **Confirmed accurate, no change needed:** Policy 2 §§2/5 (server-side enforcement, separation of duties — live since Phase 2); Policy 5 §3 (append-only audit logs, no client write path — true since Phase 2 locked both `auditLogs` and the legacy `activity_logs`).
- **Reframed three places that described non-existent features as current fact**, per PHASE0_AUDIT.md §6 (no `public_requests` page, no per-unit `bloodUnits` lifecycle exist in the real app): Policy 3 §3's collected-fields list, the blood-unit-traceability row in Policy 12's retention table, and Policy 13's entire scope (it governs the public request page) — each now explicitly marked "forward-looking/reserved, not current behavior" rather than silently left to imply otherwise.
- **Two real planning gaps surfaced and added to the tracker** (not fixed in code — that's Phase 3/4 work, just no longer invisible):
  1. Policy 4 requires Restricted-PHI exports go only through an "approved, logged admin function." Today's admin dashboard CSV export (`downloadCSVFromTable`, `main.js:1620`/`1628` — donor directory + `issuance_log`) is a plain unauthenticated client-side download with no audit trail (PHASE0_AUDIT.md §5), and no Cloud Function in Part 1.5 covered closing this. Added as a new Part 1.5 checklist item.
  2. Policy 8 §1's "2 reviewers required for `firestore.rules`/auth/authz changes" isn't a live GitHub branch-protection setting on this repo yet. Added as a new Part 4 checklist item so it isn't forgotten once Phase 4 stands up CI/CD.
- Bumped the policy doc header to "Version 1.1 — reviewed ... pending Security Lead sign-off."

**Not done / needs you directly (bracketed placeholders left as-is, not invented):**
- Real contact addresses for `[security@vitalpulse]` (Policies 6, 7, 10) and `[privacy@vitalpulse]` (Policy 3).
- The actual `[ANTIC / ministry contact]` name/channel (Policy 6).
- Real names for the Incident Commander deputy and Communications owner (Policy 6).
- French translation of Policy 3's bilingual consent language — only English exists so far.
- The formal approval signatures at the end of the document — this is intentionally not something I sign on your behalf; it's tracked separately as a Part 5 go-live gate ("All 13 policies approved and version-controlled").

**Scope note:** this was done as a parallel track at your explicit request, not as the next item in the Phase 0–4 ordering — Phase 3 (privileged actions to Cloud Functions) is still the next phase-ordered item and Phase 2 is still awaiting your review. Flagging so this doesn't read as skipping ahead unintentionally.

## Phase 2 completion notes (2026-07-24)

**The core decision this phase turned on:** `vitalpulse_app/docs/firestore.rules` (the Master Plan's reference file) is written against a 6-role, `bloodUnits`-lifecycle, `public_requests`-having schema that doesn't exist in the real app (PHASE0_AUDIT.md §6 flagged this explicitly and refused to proceed without your sign-off). With your go-ahead (schema scope → real schema; hospital scoping → migrate to real `hospitalId` now; claims backfill → you'll re-provision manually; live deployed-rules check → still pending on your side), Phase 2 built rules against what's actually running today, not the aspirational model.

**Done:**
- **`firestore.rules`** (repo root — this is the real, deployed-schema implementation; the `vitalpulse_app/docs/` copy remains the untouched Master Plan reference/starter). Deny-by-default, custom-claims-only authority (`role`/`hospitalId`/`suspended` from the token — the legacy Firestore `users.role` field is never read for authorization), covering all 10 real collections (`users`, `requests`, `inventory`, `donation_requests`, `activity_logs`, `donor_notifications`, `hospital_notifications`, `notification_log`, `issuance_log`, `campaigns`, `system_settings`, plus Phase 1's `auditLogs`).
- **hospitalId migration**: hospital-owned collections (`requests`, `inventory`, `issuance_log`) now carry a `hospitalId` field (= the hospital account's own `uid`, matching the existing convention already used by `hospital_notifications`), enforced in rules against the caller's `hospitalId` claim. Required updating `vitalpulse_app/src/db.js` (`updateInventoryStock`, `setInventoryThreshold`, `issueBloodToPatient`, `deductInventoryStock`) and 9 call sites in `main.js` to stamp it — including one non-obvious case: the admin "Add Stock for any hospital" modal picks a hospital by name from a dropdown, so the dropdown option now also carries `data-hospitalId` (sourced from the existing `fetchAllHospitals()` call) so the admin flow stamps the *real* target hospital's ID, not just its display name.
- **`scripts/backfill-hospital-ids.ts`** — one-off, manual, dry-run-by-default script (same safety pattern as `bootstrap-admin.ts`) to backfill `hospitalId` onto documents written before this migration, by matching each doc's `hospital` name string to a `users` account. Reports (does not guess at) name collisions or zero-matches. **Not yet run** — needs you, real service-account credentials, same as bootstrap-admin.
- **Separation of duties enforced** (Master Plan 1.2, now meaningful since Phase 1's 6-role claim model is live): `lab_tech` can read hospital-side data but is blocked from creating `requests` or writing `inventory`/`issuance_log` directly — a new `canManageStock()` rule helper excludes it. `hospital_admin` cannot self-verify their own hospital under any circumstance (only `system_admin` can flip `isVerified`).
- **Closed a Finding-3.2 gap Phase 1 didn't touch**: `registerUser()` in `auth.js` still accepted any client-supplied `role` string at signup (Phase 1 only removed the two hardcoded `'admin'` backdoor paths, not the general unrestricted-role problem). Rules now enforce self-signup can only ever declare `role: 'donor'` or `role: 'hospital'`.
- **`firestore.rules.test.js`** (repo root, real schema) — 64 tests via `@firebase/rules-unit-testing` + the Firestore emulator, covering every collection × the relevant roles × the relevant actions, including hostile cases: cross-hospital reads/writes, self-role-elevation, double-accept race on a request, lab_tech stock/request creation, hospital self-verification, donor impersonation, activity_logs/auditLogs client-write attempts, and a claims-less signed-in user (the actual state of every account today) being denied everywhere except what an explicit rule grants.
- **Caught and fixed two real bugs while writing this**: (1) an operator-precedence bug where `A || B && C` parsed as `A || (B && C)` instead of the intended `(A || B) && C`, silently exempting `system_admin`/hospital-role creators from the field-validation half of two rules; (2) direct field access on custom claims (`request.auth.token.suspended`) throws a hard evaluation error when the key is absent rather than returning undefined — which is the actual state of every production account today (no one has been through `grantRole` yet). Switched all claim reads to `.get(key, default)`.
- **Caught a deny-by-default gap via the test suite itself**: `users`/`campaigns`/`system_settings`/`notification_log` originally allowed any `signedIn()` user through, which — since `signedIn()` doesn't require a role claim — meant a claims-less account (every account today) still had some access. Added a `hasRole()` gate requiring an actual provisioned role and applied it consistently.
- **`firebase.json`** now has a `firestore` block (rules + indexes paths); added `.firebaserc` (project `vitalpulse-fa458`) and `firestore.indexes.json` (composite indexes for the multi-field queries already in `db.js` — donor/hospital notification feeds, donation request status feed, blood-type+status request lookup, hospital directory lookups, donor matching query).
- Confirmed the app still builds clean (`npm run build` in `vitalpulse_app/`) after the `db.js`/`main.js` changes.

**Deliberately parked as "Phase 2.5 schema evolution"** (flagged per PHASE0_AUDIT.md §6, not silently dropped): the Master Plan's per-unit `bloodUnits` lifecycle (`awaiting_test`/`cleared`/`rejected`), `public_requests` (no anonymous-write feature exists in the app at all today), `transfers`, `reviewQueue`, `nationalStats` — none of these collections exist in the real app. When/if these features get built, their rules sections from the reference file can be adapted in.

**Environment note:** the local Firestore emulator (Java-based, via `firebase-tools`) was intermittently unstable on this machine — crashed with Windows access violations and timed out on cold starts several times across repeated back-to-back runs. This is emulator/environment flakiness, not a rules defect: the suite reached a clean 60/60 pass before the `lab_tech` separation-of-duties change, and a clean 64/64 pass after it (both fully confirmed, not assumed).

**Not done / needs you directly:**
- Check the actual Firestore rules currently deployed on `vitalpulse-fa458` (console or `firebase firestore:rules:get`) — confirmed still not checked (PHASE0_AUDIT.md §1 flagged this as unknown; these new rules haven't been deployed yet either).
- Deploy `firestore.rules` + `firestore.indexes.json` to the real project (`firebase deploy --only firestore`) — not done; needs your review and go-ahead given the Security Policies require 2 reviewers for `firestore.rules` changes.
- Run `scripts/backfill-hospital-ids.ts` against production data (after deploying the new rules, or hospital staff will not see their own pre-migration `requests`/`inventory`/`issuance_log` documents).
- No App Check yet, so nothing stops a non-app client from calling Firestore directly with a stolen/forged ID token that happens to carry no useful claims — deny-by-default rules are the real backstop here, which is exactly what this phase built.

## Phase 1 completion notes (2026-07-23, supersedes 2026-07-22 notes below)

**New since 2026-07-22:**
- Re-ran the full Cloud Functions test suite (`npm test` in `functions/`) and `npm run typecheck` from scratch as an independent sanity check before touching anything: **44/44 tests pass, typecheck clean.**
- Re-confirmed via `git log -S` that the live application source (`auth.js`, `main.js`) was clean in the current working tree, but the leaked strings (`ADMIN2024`, `admin@vitalpulse.cm`/`.com`, and the bare `admin@vitalpulse` substring used in the `.includes()` check) were still present in **git history** — both branches, several commits.
- With your explicit go-ahead, purged them from local history using `git filter-branch` (no `git-filter-repo`/Python available in this environment, so used git's built-in tool instead — first attempt with `--tree-filter` hung on this repo's large `node_modules` trees and was safely aborted with no ref changes; second attempt with `--index-filter` worked in ~25s; a corrective third pass fixed a regex gap and scrubbed the one commit message that had quoted the raw strings). Took local safety backups before starting; the true pre-rewrite commits are only recoverable now via `git reflog` until it's expired.
- Verified with `git log <branch> -p` on both `main` and `security` (not `--all`, to exclude filter-branch's own internal backup refs): **zero remaining occurrences** of either string in application source or commit messages on either branch.
- Deliberately left the strings in place in `PHASE0_AUDIT.md`, `VitalPulse_Plan_Tracker.md`, `README.md`, `VITALPULSE_DOCUMENTATION.md` — these are prose descriptions of the finding (standard incident-documentation practice), not a working exploit value once the source is clean. Flagging this scoping choice rather than assuming it's obviously correct — say the word if you want those scrubbed too.

**Update 2026-07-23 (later same day):** final local pruning (`git reflog expire --expire=now --all && git gc --prune=now --aggressive`) completed with your explicit go-ahead. Verified via `git fsck --full --unreachable` (no dangling objects) and a full object scan across every blob in the repo (zero remaining occurrences of `ADMIN2024`/`admin@vitalpulse`). This item is done.

**Still blocked on you directly:**
1. **Force-push `main` and `security` to `origin`** — GitHub's copy is completely untouched by any of this; it still has the original tainted history. You said you'd do this yourself. Important: your local `origin/main`/`origin/security` remote-tracking refs currently show the rewritten commits too (filter-branch relabeled them), but that's just local bookkeeping — the *real* remote on GitHub hasn't changed. The next `git fetch` will silently snap those tracking refs back to the old (unrewritten) remote history unless the force-push happens first. Anyone else with a clone/fork must re-clone or hard-reset to the new history after you push, or they'll resurrect the old commits the next time they push.
2. **Run `scripts/bootstrap-admin.ts`** — confirmed still pending; needs a real service-account key and target email, neither of which I have or should have.
3. **Admin account audit/rotation** in the Firebase console — confirmed still pending; needs your production access.

## Phase 1 completion notes (2026-07-22, historical)

**Done:**
- Removed both live admin backdoors: the `admin@vitalpulse` email-substring check at signup (`main.js`) and the two hardcoded admin emails at login (`auth.js`). The dead `ADMIN2024` secret-code string is also gone from the bundle.
- Added role-based gating to the dashboard router (`main.js`) as defense in depth — a signed-in donor can no longer simply browse to `/admin.html`. This is UI convenience only; it is not the security boundary.
- Stood up the Cloud Functions project (`firebase.json`, `functions/`) with the full 6-role model (`functions/src/roles.ts`) per the Security Lead's decision to build the complete Master Plan role set now rather than the app's current 3 roles.
- Implemented `grantRole` and `revokeRole` as callable Cloud Functions (`functions/src/grantRole.ts`, `functions/src/revokeRole.ts`): auth+claims checked first, zod-validated input, no self-service elevation, `hospital_admin` scoped to their own hospital and to `hospital_staff`/`lab_tech` only, `system_admin` unrestricted, refresh tokens revoked on every change, every change audited via the new `writeAudit` helper (`functions/src/audit.ts`) into an `auditLogs` collection.
- Unit tests cover every authz branch (`functions/src/roles.test.ts`, `grantRole.test.ts`, `revokeRole.test.ts`), including hostile cases (self-grant, cross-hospital grant, privilege escalation attempts, suspended caller, revoking a role the caller couldn't have granted).
- Wrote `scripts/bootstrap-admin.ts` — the one-off, never-deployed script that creates the first `system_admin` via owner service-account credentials, since `grantRole` itself requires an existing `system_admin` caller.

**Deliberate scope decision (flagged, not silently made):** the Security Lead chose to implement the full 6-role model now even though today's frontend/Firestore schema only distinguishes 3 roles (`donor`/`hospital`/`admin`). Resolution: custom claims are the real 6-role authority used by `grantRole`/`revokeRole` (and will be used by Firestore rules in Phase 2 and by Cloud Functions in Phase 3); the Firestore `users.role` field stays the pre-existing 3-value string the frontend reads for cosmetic dashboard routing only (`hospital_admin`/`hospital_staff`/`lab_tech` all still mean "go to `hospital.html`"; `system_admin`/`nbtp_viewer` both mean "go to `admin.html`"). Phase 3 will need to decide how/whether the Firestore `users` doc itself starts recording the granular role for UI purposes (e.g. hospital-side staff lists) — not resolved yet, no action needed until then.

**Not done / needs the Security Lead directly (see chat summary for full detail):**
- Auditing and rotating existing admin accounts.
- Purging the `ADMIN2024` string from git history (`git filter-repo`) — needs explicit go-ahead, it rewrites shared history.
- Actually running `bootstrap-admin.ts` (requires a real service-account key and a real target email — cannot be done by the agent).
- No UI yet calls `grantRole`/`revokeRole` — until Phase 3 adds an admin-panel control, invoking them requires the Firebase console's function test harness or a direct authenticated HTTPS call.
