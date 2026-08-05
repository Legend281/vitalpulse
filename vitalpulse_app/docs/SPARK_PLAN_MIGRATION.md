# VitalPulse — Spark Plan (No Cloud Functions) Migration Plan

**Status:** DRAFT — not yet implemented. Written after the Security Lead, informed of every
regression below, explicitly chose "full downgrade to $0 Spark" over staying on Blaze
(2026-08-04). This document is the record of that decision and the plan to execute it — it is
not authorization to start; implementation should still be reviewed section-by-section before
code changes ship, per this project's standing "no auth/rules changes without explicit review"
rule.

**Author's recommendation, restated once for the record:** staying on Blaze remains the safer
choice, and realistic cost at current scale is $0/month. This document exists because you asked
for it with full knowledge of that, not because I've changed my assessment.

---

## 1. Executive Summary

The request was framed as "just move KYC off Cloud Functions." The real scope is larger than
that, for one unavoidable platform fact: **Cloud Functions (2nd gen) require the Blaze plan to
exist at all — even a single trivial function.** There is no such thing as "keep three Cloud
Functions and drop the rest to save money"; the moment any Cloud Function is deployed, Blaze is
required, full stop. So reaching genuine $0/Spark means **every** Cloud Function in this app is
removed, not just the KYC-related ones:

- `grantRole`, `revokeRole`, `suspendUser`, `reactivateUser` (roles.ts)
- `onDonorSignUp`, `submitKYC`, `submitLivenessSelfie`, `verifyDonor`, `rejectDonorKyc` (kyc.ts)
- `addInventoryStock`, `deductInventoryStock`, `resolveLabTest`, `setInventoryThreshold`,
  `issueBloodToPatient` (inventory.ts)
- `checkPasswordBreach`, `resolveSignInIdentifier` (auth-onboarding utilities)
- `requestPasswordReset`, `checkPasswordResetToken`, `confirmPasswordReset` (passwordReset.ts —
  shipped today, would be reverted)

This plan covers all of it. Section 3 explains a design choice that keeps the *strongest* part
of the current model (who is an admin/hospital staff) nearly as safe as it is today, at zero
extra cost — because that part doesn't actually need to change to reach $0. The parts that
genuinely regress are itemized in Section 4, in full, as promised.

---

## 2. Non-Negotiable Platform Facts

These aren't design preferences — they're how Firebase is built, and no amount of clever rules
writing gets around them:

1. **Custom claims (`request.auth.token.role`, `.kycStatus`, `.hospitalId`, `.suspended`) can
   only ever be set via `admin.auth().setCustomUserClaims()`** — an Admin SDK call. There is no
   client-SDK method to set them, by design (this is precisely the boundary that stops a
   compromised browser from self-granting a role).
2. **Admin SDK calls do NOT require Blaze or Cloud Functions.** They require *some* trusted
   process holding real Google credentials (a service account key or `gcloud`/`firebase` CLI
   login) — that process can be a Cloud Function, or it can be a script run manually on your own
   laptop. `scripts/bootstrap-admin.ts` already proves this: it sets a custom claim from a local
   script today, on Spark, for free, and always has.
3. **Cloud Storage is available on Spark** with its own free tier (5 GB stored, 1 GB/day
   download) and does not require a Cloud Function to be written to — a client can upload
   directly to a `kyc/{uid}/...` path if Storage Rules allow it.
4. **Any code holding a secret (API key, etc.) cannot run in the browser.** Whatever calls
   Resend's email API needs that key; putting it in client JS means every visitor can read it
   out of the network tab or the bundled source and use it to send email as "Vital Pulse Team."
5. **Firestore document size is capped at 1 MiB.** ID-card photos and selfies cannot be stored
   as base64 inside a Firestore document field at realistic photo quality — they have to live in
   Cloud Storage regardless of which plan you're on.

---

## 3. Design Decision: Keep Role-Granting on Claims (via Local Scripts), Move Everything Else to Firestore Fields

Fact #2 above means role-granting doesn't actually have to change to hit $0 — `grantRole`,
`revokeRole`, `suspendUser`, `reactivateUser` can become small local CLI scripts (same pattern as
`bootstrap-admin.ts`, run by you from your own machine with a downloaded service account key)
instead of deployed Cloud Functions. This is a deliberate choice, not what the original proposal
described (which implied moving role data to Firestore fields too) — I'm recommending against
that specific part because it buys nothing (role grants are already rare, admin-initiated
actions, exactly what a local script is good for) while giving up real security (a Firestore
`users/{uid}.role` field is a much softer boundary than a claim, since it lives in a document a
poorly-written rule could accidentally let someone touch).

**What this preserves:** `firestore.rules`'s `role()`, `isSystemAdmin()`, `isHospitalRole()`,
`canManageStock()`, `sameHospital()` helpers (lines 55–73 today) stay **completely unchanged**.
Every rule that currently trusts a claim keeps trusting that same claim. This is the single
biggest risk-reducer available in this migration, and it's free.

**What has to change regardless:** `donors/{uid}.kycStatus` (checked via
`isKycEligible()`/`get()` already, not a claim, so unaffected) and the *frequent*,
interactively-driven operations — KYC submission/review, inventory, blood issuance, password
reset — which can't reasonably be turned into "run a script by hand" workflows since they happen
continuously, in response to a form submit, a document upload, or an admin clicking a button in
a live dashboard.

---

## 4. Full Risk & Regression Register

Every regression this migration introduces, so it's a fully informed decision — not a table I'd
write if the answer were "stay on Blaze."

| # | Regression | Concrete failure scenario | Severity |
|---|---|---|---|
| R1 | `donors/{uid}.kycStatus` becomes a plain Firestore field instead of a claim. The write is still restricted to system_admin by rules, but this is a materially softer boundary than a Cloud Function — **the entire guarantee now depends on every relevant rule being airtight, forever**, with no server-side backstop. One missed `unchangedExcept()` field-lock in a future rules edit (by anyone, at any point) and a donor can set their own `kycStatus` to `'verified'` directly from devtools and immediately start accepting real blood-donation requests with zero identity verification. | A donor calls `updateDoc(doc(db,'donors',myUid),{kycStatus:'verified'})` from the browser console. If the field-lock rule has any gap, this succeeds. | **Critical** — this is the exact vulnerability class Stream G/D of this project were built to close. |
| R2 | KYC document/selfie **upload validation** (file size, MIME type, base64 decoding, 5 MB cap) currently runs server-side in `submitKYC`/`submitLivenessSelfie` before anything touches Storage. Moving to direct client upload means this validation can only be enforced via Storage Rules (`request.resource.size`, `request.resource.contentType`) — real, but a narrower surface than a full zod schema + decoded-byte-length check. A malformed or oversized upload that a rule doesn't anticipate could land in Storage. | An attacker crafts a request that satisfies the Storage Rule's declared content-type/size check but contains different actual bytes (rules can check declared metadata, not decode/inspect file contents the way the current Cloud Function does). | Medium |
| R3 | Camera-only liveness capture (no gallery picker) is currently enforced **twice** — client UI (no file input exists in the KYC-liveness markup) and server-side (`mimeType` locked to `image/jpeg` in the Cloud Function, closing the gap if someone bypasses the UI). Removing the Cloud Function removes the server-side half; only the client-side UI restriction remains, which is bypassable by anyone calling the Storage SDK directly instead of clicking through the form. | Someone uploads a gallery photo as a "liveness selfie" via direct Storage SDK calls, bypassing the camera-only UI entirely. | Medium |
| R4 | `verifyDonor` currently refuses to approve a donor unless **both** the identity document and liveness selfie are actually on file — a real, tested guard closing a gap where an admin could otherwise approve someone with zero evidence submitted. Re-implemented as a Firestore rule, this becomes "the write is only allowed if `resource.data.kycDocRef != null && resource.data.livenessSelfieRef != null`" — expressible, but every future change to the KYC data model has to remember to keep this rule in sync by hand, with no shared, tested TypeScript function backing it. | A future rules edit changes a field name and silently breaks this guard without anyone noticing, since there's no compiled type-checking across rules and app code the way there is between `kyc.ts` and `schemas.ts` today. | Medium |
| R5 | **Inventory stock mutation and blood issuance lose transactional server enforcement.** `addInventoryStock`/`deductInventoryStock`/`issueBloodToPatient` currently run inside Firestore transactions on the server, and `issueBloodToPatient` specifically deducts *only* from batches whose `testStatus == 'Cleared'` — untested/rejected blood can never leave the building, per this project's stated non-negotiable rule. Firestore Rules can validate a document's *before/after* shape on a single write, but cannot express "read the batches array, filter to Cleared ones, recompute the deduction, reject if it doesn't match" with the same rigor a transaction + typed function can. This is the single hardest piece to safely port to rules-only and carries direct patient-safety consequences if it's gotten wrong. | A rules gap or a buggy client computation deducts from an untested batch, or two hospital staff issue against the same units concurrently with no transaction to serialize them (double-issuance). | **Critical** |
| R6 | `issueBloodToPatient` is also the only path that writes `issuance_log`, a Restricted-PHI collection (patient name, diagnosis, ward, doctor). Moving this to a client-side write means that PHI now transits and is authored directly by the hospital's browser session rather than a server function whose write shape is validated by zod — a narrower but real reduction in defense-in-depth for the app's most sensitive data. | Malformed or excessive PHI fields get written because a rule's shape-check is less rigorous than a zod schema was. | High |
| R7 | **`resolveSignInIdentifier` (phone → email lookup for sign-in) cannot be safely ported.** It exists specifically because an unauthenticated client can't query `users` by phone under deny-by-default rules — the Cloud Function bypasses rules via the Admin SDK. Without it, either (a) phone-based sign-in is dropped entirely (email/username login only), or (b) rules open up an unauthenticated, filtered read on `users` by phone number, which turns the phone field into an enumeration oracle (anyone can probe whether a given phone number has an account). Neither option is free. | (b): an attacker scripts requests probing thousands of Cameroonian phone numbers to build a list of who has a VitalPulse account — a real PII exposure for a health-adjacent app. | High if (b) is chosen; feature-loss (no severity, just a product decision) if (a) is chosen |
| R8 | **Password reset reverts to Firebase Auth's built-in flow** — the custom 30-minute expiry and "Vital Pulse Team" sender identity shipped earlier today (commit `5d78949`) are undone. Links go back to Firebase's fixed ~1hr oobCode expiry with no meaningful sender branding. | None security-critical — this is a feature reversion, not a vulnerability, but it directly undoes an explicit requirement from two conversations ago. | Low (functionality loss, not a security hole) |
| R9 | `checkPasswordBreach`'s HIBP k-anonymity proxy can move to a **direct client fetch** (HIBP's range endpoint needs no secret key and is commonly called client-side) — this one is actually a wash, not a regression, noted here so it's not missed in the replacement table below. | — | None |
| R10 | Every rule that used to read a free, token-embedded claim now needs a `get()` lookup against Firestore instead (e.g. `donors/{uid}.kycStatus` already works this way; `users/{uid}.suspended` would need to if suspension moves off claims too — see open question in Section 8). Each `get()` inside a rule evaluation counts as an extra document read against your Firestore quota. At current scale this is immaterial (well within Spark's free 50K reads/day), but it's a real, non-zero operational cost that scales with traffic, unlike claims which cost nothing to check. | — | Low at current scale |

---

## 5. Data Model Changes

| Field | Today | After migration |
|---|---|---|
| `role` | Custom claim (`request.auth.token.role`) | **Unchanged** — stays a claim, set by local scripts (Section 9) |
| `hospitalId` | Custom claim | **Unchanged** — stays a claim |
| `suspended` | Custom claim | **Unchanged** — stays a claim (see open question, Section 8, on the existing token-revocation gap already documented in `firestore.rules`) |
| `donors/{uid}.kycStatus` | Firestore field (already — `isKycEligible()` already does a `get()`, not a claim read) | Unchanged shape; the *writer* changes from "Cloud Function via Admin SDK" to "client write, gated by rules requiring the caller be `isSystemAdmin()`" |
| `donors/{uid}.kycDocRef` / `kycDocBackRef` / `livenessSelfieRef` | Firestore field, written by Cloud Function after a successful Storage upload | Written directly by the donor's own client after their own direct Storage upload succeeds — rule must restrict this write to the doc's own owner, only while `kycStatus == 'pending'` |
| `inventory/{id}.batches[]` | Mutated via Cloud Function transaction | Mutated via client `runTransaction()`, validated by rules on write (see R5 — this is the piece needing the most rules-engineering care) |
| `passwordResetTokens/{uid}` | Firestore collection, Cloud-Function-only | **Removed entirely** — reverting to Firebase Auth's built-in oobCode flow (no app-side token storage needed) |

---

## 6. Firestore Rules Changes, By Collection

- **`users/{uid}`** — no change to the role/suspended checks (still claims). Add: nothing new
  needed here.
- **`donors/{uid}`** — currently `allow write: if false` (Cloud Function only). Becomes:
  - Donor (owner) may create/update `kycDocType`, `kycDocRef`, `kycDocBackRef`,
    `livenessSelfieRef`, `kycSubmittedAt`, `livenessSubmittedAt` **only** while
    `resource.data.kycStatus == 'pending'`, and may **never** touch `kycStatus` or
    `kycRejectionReason` themselves (`unchangedExcept()` lock, mirroring the pattern already
    used elsewhere in this file).
  - `isSystemAdmin()` may update `kycStatus` and `kycRejectionReason` on any donor's doc, and
    **only** when `resource.data.kycDocRef != null && resource.data.livenessSelfieRef != null`
    if setting `kycStatus == 'verified'` (porting R4's guard into the rule itself).
- **`adminQueue/{id}`** — currently Cloud-Function-only. Either becomes writable by the donor
  (create) + admin (update status) directly, or is dropped in favor of admin.html querying
  `donors` where `kycStatus == 'pending'` directly (simpler; recommended — removes a collection
  that has to be kept in sync with `donors` by hand).
- **`inventory/{id}`** — currently Cloud-Function-only. Becomes writable by `canManageStock()`
  scoped to `sameHospital()`, with the hardest part of this whole migration: expressing "only
  `Cleared` batches may be decremented, and the deducted total must exactly match the requested
  units" as a rule comparing `resource.data.batches` to `request.resource.data.batches`. This
  needs a dedicated design pass and heavy rules-test coverage before it ships — flagged as its
  own follow-up, not something to rubber-stamp into this document.
- **`issuance_log/{id}`** — currently Cloud-Function-only (also the same transaction as the
  inventory deduction, which rules cannot express atomically across two collections the way a
  server transaction can — this is a second, separate risk on top of R5/R6: the inventory
  deduction and the issuance-log write become **two separate client writes**, not one atomic
  transaction, meaning a failure between them could deduct stock without a matching log entry,
  or vice versa).
- **`passwordResetTokens/{uid}`** — deleted entirely, rule removed.

---

## 7. Storage Rules Changes

`storage.rules`'s existing `kyc/{uid}/{fileName}` rule (`allow read: if isSystemAdmin();
allow write: if false`) becomes:

```
match /kyc/{uid}/{fileName} {
  allow read: if isOwner(uid) || isSystemAdmin();
  allow write: if isOwner(uid)
    && request.resource.size < 5 * 1024 * 1024
    && request.resource.contentType.matches('image/jpeg|image/png|application/pdf');
}
```

Losing relative to today: no server-side decoded-byte-length check (R2), no way to enforce
"liveness selfies must be exactly `image/jpeg`, identity docs may be jpeg/png/pdf" as two
different rules for the same path pattern without either a stricter path convention (e.g.
`kyc/{uid}/liveness_*` vs `kyc/{uid}/id_*`, matched separately) or accepting the looser combined
rule above (R3).

---

## 8. Cloud Function → Replacement Mapping

| Function | Replacement | Where the logic moves | Residual risk |
|---|---|---|---|
| `grantRole` / `revokeRole` | Local CLI script (extend `bootstrap-admin.ts` into a small family: `grant-role.ts`, `revoke-role.ts`) | Your own machine, run manually, same as today's admin bootstrap | None — unchanged security model |
| `suspendUser` / `reactivateUser` | Local CLI script, same pattern | Your own machine | **Open question, not yet decided**: the existing `firestore.rules` comment already documents that even today's Cloud-Function version of this has a known gap (a suspended user's still-live ID token isn't retroactively revoked, works for up to ~1hr). Moving to a local script doesn't make this worse, but doesn't fix it either — flagging so it isn't mistaken for a new regression introduced by this migration. |
| `onDonorSignUp` | Client writes `users/{uid}` + `donors/{uid}` directly, immediately after `createUserWithEmailAndPassword` | `auth.js` | Low — this was always closer to "bootstrap my own new account" than a privileged action; rules already need to allow a user to create their own `users/{uid}` doc once at signup with a fixed initial shape |
| `submitKYC` / `submitLivenessSelfie` | Client uploads directly to Storage, then writes the resulting path to their own `donors/{uid}` doc | `donor-dashboard.js` | R2, R3 |
| `verifyDonor` / `rejectDonorKyc` | Admin client writes `donors/{uid}.kycStatus` directly | `main.js` (admin.html) | R1, R4 |
| `addInventoryStock` / `deductInventoryStock` / `resolveLabTest` / `setInventoryThreshold` / `issueBloodToPatient` | Client `runTransaction()` against `inventory`, validated by rules | `db.js` (hospital-side) | R5, R6 |
| `checkPasswordBreach` | Direct client `fetch()` to HIBP's public range API | `auth.js` / signup flow | None (R9 — this one's free) |
| `resolveSignInIdentifier` | **Unresolved — needs your decision, see R7.** Either drop phone-based login, or accept the enumeration exposure of an unauthenticated phone-lookup rule. | — | R7 |
| `requestPasswordReset` / `checkPasswordResetToken` / `confirmPasswordReset` | Revert to Firebase Auth's built-in `sendPasswordResetEmail` / `confirmPasswordReset` (client SDK calls this app used before today) | `auth.js` (revert to yesterday's version) | R8 |

---

## 9. Admin Tooling Changes

- Extend `scripts/bootstrap-admin.ts`'s pattern into `scripts/grant-role.ts`,
  `scripts/revoke-role.ts`, `scripts/suspend-user.ts`, `scripts/reactivate-user.ts` — same
  prerequisites (service account key, run locally, `--yes` confirmation flag, audit log write),
  same safety posture as the existing script.
- These become your only way to promote a hospital account, create another admin, or suspend
  someone — no more doing it from a web UI. Worth deciding up front whether that operational
  friction is acceptable for how often these actions actually happen.

---

## 10. Client Code Changes (file-by-file)

| File | Change |
|---|---|
| `vitalpulse_app/src/auth.js` | Revert password-reset section to Firebase's built-in calls (undo today's `sendPasswordReset`/`verifyResetCode`/`confirmReset` rewiring); `sendVerificationEmailToUser` unaffected (already built-in); add direct HIBP fetch for breach-checking; `onDonorSignUp` logic inlined into the registration flow as direct Firestore writes |
| `vitalpulse_app/src/donor-dashboard.js` | KYC submit/liveness handlers switch from `httpsCallable` to `uploadBytes`/`updateDoc` |
| `vitalpulse_app/src/main.js` | Admin KYC approve/reject buttons switch from `httpsCallable` to `updateDoc`; `resolveSignInEmail` removed or reworked per R7's decision |
| `vitalpulse_app/src/db.js` | Inventory functions (`addInventoryStock` etc.) reimplemented as direct `runTransaction()` calls instead of `httpsCallable` wrappers |
| `functions/` | Entire directory becomes unused — either deleted or kept dormant/undeployed as reference. Recommend keeping it in git history (already committed) but removing from the active build/deploy path, not deleting outright, in case Blaze is reconsidered later. |
| `firebase.json` | Remove the `functions` block entirely (or leave it — an undeployed config block is harmless, but `firebase deploy` should never be run with `--only functions` again once this migration ships, since there'd be nothing valid to deploy) |

---

## 11. Testing Plan

- `firestore.rules.test.js` / `concurrency.rules.test.js` — every test currently asserting
  `assertFails` on a direct client write to `donors/kycStatus`, `adminQueue`, `inventory`, or
  `issuance_log` needs to flip to `assertSucceeds` for the newly-authorized caller shapes, and
  gain new `assertFails` cases for every caller shape that must still be denied (donor writing
  their own `kycStatus`, wrong-hospital staff writing another hospital's inventory, etc.). This
  is the highest-value testing investment in the whole migration — R1/R5's entire safety
  argument rests on these tests being exhaustive.
- `functions/src/*.test.ts` — all 9 test files (199 tests) become dead code for functions that
  no longer exist. Recommend deleting them alongside their source files rather than leaving
  stale tests for undeployed code.
- New: rules tests specifically exercising the "untested blood never issuable" guarantee (R5) —
  today this is covered by `inventory.test.ts`'s unit tests against the Cloud Function; there is
  currently **no equivalent rules-emulator test** for this guarantee, because it never needed
  one. This is new test-writing work, not a port of existing tests.

---

## 12. Rollout Order

Because this touches live authentication and money-adjacent (blood supply) logic, sequence
matters:

1. Ship the new Firestore/Storage rules **alongside** the still-live Cloud Functions first (both
   paths valid simultaneously), fully tested, before touching any client code.
2. Migrate client code collection-by-collection (KYC first — lowest blast radius — then roles
   via local scripts, then inventory last, since R5/R6 are the highest-risk piece and should
   have the most runway).
3. Only after every client code path is confirmed working against the new rules: remove the
   Cloud Functions from `functions/src/index.ts` exports and stop deploying `functions`.
4. Downgrade to Spark **last**, only once nothing depends on Cloud Functions anymore — don't
   downgrade first and debug against a broken deploy.

## 13. Rollback Plan

Keep `functions/` and today's Cloud-Function-based rules in git history (already true — this is
committed on the `security` branch). Rolling back means re-deploying `functions` (requires
Blaze again) and reverting the rules/client changes in a single coordinated commit, not a
piecemeal one — a half-migrated state (some writes going through rules, rules still expecting a
Cloud Function to have run first) is the most dangerous state to be caught in.

## 14. Explicitly Unresolved, Needs Your Decision Before Implementation Starts

- **R7** — drop phone-based sign-in, or accept the phone-enumeration exposure?
- **R5/R6's transaction design** — the inventory/issuance rules need a dedicated design pass;
  this document identifies the risk but does not yet contain a concrete, ready-to-implement
  rules expression for it.
- Whether `adminQueue` is kept (kept in sync by hand) or dropped in favor of querying `donors`
  directly (Section 6 recommends dropping it).

---

## 15. Security Lead Sign-off

This plan is not implemented until each item below is explicitly acknowledged:

- [ ] R1–R10 above are understood and accepted as real, permanent regressions versus the
      current Blaze/Cloud-Functions architecture.
- [ ] R7's phone-sign-in decision is made.
- [ ] R5/R6's inventory transaction design is reviewed and approved before that piece is built
      (not bundled into a single "just ship it" pass with everything else).
- [ ] Go-ahead given to begin Section 12's rollout, starting with rules-only changes (no client
      code changes) as step 1.
