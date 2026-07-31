# VitalPulse Security Remediation — Summary

**Branch:** `security`
**Last updated:** 2026-07-22
**Status:** Phase 0 (audit) and Phase 1 (kill the admin backdoor) complete and pushed to `origin/security`. Stopped here for the Security Lead's review before starting Phase 2.

This file is a plain-language recap of everything done so far. For full detail see `PHASE0_AUDIT.md` (findings) and `VitalPulse_Plan_Tracker.md` (line-item checklist against the Master Plan).

---

## Phase 0 — Audit (read-only)

Read all six reference documents in `docs/` and mapped the real app (`vitalpulse_app/`) against them. Key findings, written up in full in `PHASE0_AUDIT.md`:

- **Two live admin backdoors**, not one: a signup-time check granting `admin` to any email merely *containing* `admin@vitalpulse`, plus a second hardcoded-email check at login. A third, dead `ADMIN2024` secret-code check also shipped in the bundle (its form field no longer exists, but the string was still there).
- **No real permission checks anywhere** — not even frontend-only ones. A signed-in donor could browse straight to `/admin.html` and get the full admin dashboard, including console-callable functions (approve/reject hospitals, suspend/reactivate donors) with zero authorization inside them.
- **Every "privileged" action ran client-side**: hospital verification, donor suspension, inventory mutation, the audit log itself (freely writable by anyone), and "alert fan-out" (which didn't actually send anything — it just logged an SMS deep-link).
- **Schema mismatch**: the Master Plan's reference `firestore.rules`/tests assume a 6-role, per-blood-unit-lifecycle schema. The real app has 3 roles (`donor`/`hospital`/`admin`) and a much simpler aggregate-inventory model, no `bloodUnits`, no `public_requests`. Flagged for a decision rather than silently building against a fictional schema.
- No other secrets found in code or git history (only the non-secret-by-design Firebase web API key).
- Could not verify from the repo what Firestore rules are actually deployed today — no `firestore.rules` has ever been committed or deployed. Needs a manual console/CLI check.

## Phase 1 — Kill the admin backdoor

**Decision (asked, not assumed):** build the full 6-role custom-claims model now (per the Security Lead's choice), while keeping the existing Firestore `users.role` field as the simple 3-value string the frontend already reads for cosmetic dashboard routing. Custom claims are the real authority used by the new Cloud Functions (and will be used by Firestore rules in Phase 2).

**What was built:**

1. **Removed both backdoors.** Signup can now only ever create `donor`/`hospital` accounts; the hardcoded admin emails at login are gone.
2. **Hardened the dashboard router** (`main.js`) so a signed-in user is redirected to *their own* dashboard rather than being able to browse to another role's page. Explicitly documented as UI convenience only — not the security boundary.
3. **New Cloud Functions project** (`firebase.json`, `functions/`, TypeScript): implements `grantRole` and `revokeRole` as callable functions.
   - Auth + claims checked first, input validated with zod, no self-service elevation ever possible.
   - `system_admin` can grant/revoke any of the 6 roles; `hospital_admin` can only grant/revoke `hospital_staff`/`lab_tech` at their own hospital.
   - Every change revokes the target's refresh tokens and writes an audit event (actor UID, actor role, action, target, timestamp) to a new `auditLogs` collection — the start of a real, client-unwritable audit trail.
4. **`scripts/bootstrap-admin.ts`** — a one-off script, never deployed, that creates the very first `system_admin` using owner service-account credentials (solves the chicken-and-egg problem, since `grantRole` itself needs an existing `system_admin` to call it).
5. **Unit tests**: 44 tests across the authz logic, functions, and edge cases — all passing.

**Stress-testing pass** (done before anything was committed): adversarially re-read every branch of `grantRole`/`revokeRole` by hand and found two real issues, both fixed:
- A **suspended `system_admin` could bypass the suspension check entirely** when revoking a target that had no existing role — the check lived inside a code path that particular case skipped. Fixed by gating on the caller's own suspended/role status before ever touching the target.
- A **UID-existence oracle**: any authenticated caller (even a `donor`) could call `revokeRole` and tell, from the error returned, whether an arbitrary Firebase UID existed. Fixed by the same reordering.
- Also hardened the input schema to reject whitespace-only/whitespace-padded UIDs and hospital IDs, and made sure both functions log the actor's own role, not just their UID (per the audit-logging policy).

**Small follow-up fix (verified, not yet committed):** TypeScript 5.9 (what actually got installed) removed the legacy `moduleResolution: "node"` mode entirely. Both `functions/tsconfig.json` and `scripts/tsconfig.json` were updated to `"module"`/`"moduleResolution": "node16"`. Rebuilt and retested clean (44/44 tests still passing, zero typecheck errors) — awaiting the go-ahead to commit.

**Dependency audit:** initial install surfaced 1 critical + 1 high finding, both in `vitest`'s dev-only UI-server (path traversal / arbitrary file read) — fixed by bumping `vitest` to 4.1.10. Remaining: 10 moderate findings, all transitive through `firebase-admin`'s and `firebase-functions-test`'s own Google-maintained dependency chains (`uuid`, `ts-deepmerge`) — not fixable without an unverified major version bump, tracked under Policy 7's 30-day moderate-severity SLA, not a blocker.

## Committed & pushed

Five commits on `security`, already pushed to `origin/security`:

```
dd116d9 docs: update security plan tracker for Phase 1
6508aa4 chore: add one-off bootstrap-admin script
6278fce feat: add grantRole/revokeRole Cloud Functions for server-side role provisioning
25fbb06 fix: remove hardcoded admin backdoors, harden dashboard router
7294cd0 docs: add Phase 0 security audit
```

## What still needs the Security Lead directly

Nothing here can be done by the agent — all require real credentials, console access, or a judgment call:

1. **Audit and rotate existing admin accounts** — any account with `role: 'admin'` today could have been created through the backdoor while it was live.
2. **Approve (or decline) purging `ADMIN2024` from git history** via `git filter-repo` — a history rewrite, so it needs explicit sign-off before it happens.
3. **Actually run `scripts/bootstrap-admin.ts`** with a real downloaded service-account key and a real target email, to create the first `system_admin`.
4. **Verify the actually-deployed Firestore rules** on the `vitalpulse-fa458` Firebase project (console or `firebase firestore:rules:get`) — the repo has never had a deployed rules file, so today's real exposure is unknown from code alone.
5. Decide on the tsconfig fix commit (above) and whether to proceed to **Phase 2** (deny-by-default Firestore rules adapted to the real schema, plus the full emulator test suite).

There is also no admin UI yet to *call* `grantRole`/`revokeRole` — until Phase 3 adds one, they're only reachable via the Firebase console's function-test harness or a direct authenticated HTTPS call.
