# PHASE 0 — Security Audit (read-only)

**Date:** 2026-07-21
**Scope:** `vitalpulse_app/` (the live Vite + Firebase app). The `stitch_lifestream_cameroon_coordination_system/` directory contains only static Stitch-generated design mockups (no JS logic, no Firebase calls) and is out of scope.
**Method:** Full read of `src/*.js`, all root HTML pages, `package.json`, git history (`git log -p --all`) for secrets, and cross-reference against `docs/VitalPulse_Security_Master_Plan.md`.

---

## 1. Project structure

- **Frontend:** Vanilla JS + Vite 8, Tailwind CSS 4, Chart.js. No framework (no React/Vue). Multi-page app: `index.html`, `login.html`, `signup.html`, `donor.html`, `hospital.html`, `admin.html`, `about.html`, each loading `src/main.js` as a shared ES module entry point (all page-specific logic is routed by `window.location.pathname` inside one file).
- **Firebase services used:** `firebase/app`, `firebase/auth` (email+password only — no phone/OTP, no MFA), `firebase/firestore` (client SDK, direct reads/writes from the browser). **No Cloud Functions, no Cloud Storage usage, no Firebase Hosting config, no App Check** anywhere in the repo.
- **Config files that do not exist:** `firebase.json`, `.firebaserc`, `firestore.rules` (a *reference* copy lives only under `vitalpulse_app/docs/firestore.rules` — it has never been adapted or deployed), `functions/`. There is **no CI workflow** (`.github/workflows/` does not exist).
- **Firebase project:** `vitalpulse-fa458` (from [firebase.js:6-11](../src/firebase.js#L6-L11)). This is a single project — no separate dev/staging/prod projects exist yet (Master Plan §4 requires three).
- **⚠️ Unknown and must be checked manually (not visible from the repo):** what Firestore Security Rules are actually deployed on `vitalpulse-fa458` right now. Since the app performs real writes successfully (per `VITALPULSE_DOCUMENTATION.md` and the code below) and no rules file has ever been committed, the deployed rules are either (a) still the Firebase-console default (`allow read, write: if request.time < <expiry>` "test mode," which is wide open to any client, or has already expired and locked everything), or (b) something manually typed into the console that we have no record of. **Action needed from you:** run `firebase firestore:rules:get --project vitalpulse-fa458` or check the Rules tab in console before Phase 2, so we know the actual current exposure, not just the theoretical one from the app code.

### Utility scripts (not security-relevant, noted for completeness)
`inject_script.cjs`, `inject-loader.cjs`, `replace_names.cjs`, `cleanup.cjs` — one-off build/text-processing scripts run manually against the HTML files. No secrets, no runtime relevance.

---

## 2. Auth & role model as it actually exists today

Firebase Authentication (email/password) is the only identity provider. Role is **not** a Firebase custom claim — it is a plain field (`role`) inside a Firestore document at `users/{uid}`, written by the client at signup and read back by the client at login/every page load.

- **Registration:** [auth.js:13-45](../src/auth.js#L13-L45) `registerUser()` — client passes whatever `role` string it wants directly into `setDoc(doc(db,'users',uid), { role, ... })`. There is no server-side validation of this value at all.
- **Login:** [auth.js:83-123](../src/auth.js#L83-L123) `loginUser()` reads `users/{uid}` and trusts its `role` field, with a client-side fallback to `'donor'` if the Firestore read fails (rules-lockout-safe default, at least).
- **Session:** role/user object is cached in `localStorage` (`vitalpulse_user`) and trusted by the whole app thereafter — trivially editable via devtools (`localStorage.setItem('vitalpulse_user', JSON.stringify({...,role:'admin'}))`) for anything that reads from the cache instead of live Firestore, e.g. all the `getCurrentUser()` call sites.
- **Route gating:** [main.js:25-32](../src/main.js#L25-L32) — the *only* check protecting `donor.html` / `hospital.html` / `admin.html` is **"is any user logged in,"** not **"does this user have the matching role."** A signed-in donor who types `/admin.html` into the address bar gets the full admin dashboard rendered, including calling `loadAdminDashboard()` ([main.js:1074](../src/main.js#L1074)) and having every `window.handleAdmin*` function (see §3) available in the console. There is no role-based redirect guard anywhere in the codebase — role is used only cosmetically, to pick which dashboard to redirect *to* right after login ([main.js:52-53](../src/main.js#L52-L53), [main.js:135-136](../src/main.js#L135-L136)).

This is **broader than Master Plan Finding 3.2** ("permission checks exist only on the frontend") — here there effectively is **no** permission check at all, frontend or otherwise, for which dashboard/role a signed-in user can reach.

---

## 3. Finding 3.1 — the hardcoded admin backdoor(s)

Two separate admin-grant paths exist, both in the **client bundle**, both trivially exploitable by anyone who can view page source / devtools:

1. **Dead secret-code path:** [main.js:113-117](../src/main.js#L113-L117)
   ```js
   const secretCode = document.getElementById('secretCode');
   if ((secretCode && secretCode.value === 'ADMIN2024') || (email && email.toLowerCase().includes('admin@vitalpulse'))) {
       role = 'admin';
   }
   ```
   `signup.html` no longer contains a `#secretCode` input (confirmed via grep — the only `role` inputs left are `#roleDonor` / `#roleHospital`, [signup.html:100](../signup.html#L100), [signup.html:105](../signup.html#L105)), so the `secretCode &&` guard is always `false` and this half is currently dead code. **The literal string `"ADMIN2024"` is still sitting in the shipped JS bundle** and would be usable again the instant anyone re-adds an `id="secretCode"` field to the page (or just calls the underlying logic directly) — it must still be purged.

2. **Live email-substring path (the actual exploitable backdoor today):** same line, `email.toLowerCase().includes('admin@vitalpulse')`. `.includes()`, not an exact match — **any email containing that substring anywhere** grants `role: 'admin'` at signup, e.g. `x.admin@vitalpulse.anything`, `notadmin@vitalpulse.co`, etc. Nothing stops an anonymous visitor from registering such an address right now and landing on `/admin.html` with a Firestore-persisted `role: 'admin'` document.

3. **A related, narrower backdoor at login:** [auth.js:106-108](../src/auth.js#L106-L108)
   ```js
   if (userEmail === 'admin@vitalpulse.cm' || userEmail === 'admin@vitalpulse.com') {
       role = 'admin';
   }
   ```
   This one is an exact match on two specific addresses, evaluated at every login regardless of what's stored in Firestore — meaning even if `users/{uid}.role` were fixed to `'donor'`, logging in with either of those two exact emails still elevates the *session* to admin. This must be removed too; it's the same class of bug and isn't mentioned by name in the Master Plan's 3.1 wording but is clearly the same finding.

**Net effect:** admin access today requires no invitation, no review, no Cloud Function, no custom claim — just choosing an email address at signup. This fully matches Master Plan §1.6 point 2 ("treat the secret as leaked... audit all existing admin accounts").

---

## 4. Finding 3.2 — every permission check is client-side (full inventory)

There is **no Cloud Functions project and no deployed custom Firestore rules**, so literally every authorization decision in the app — role assignment, dashboard access, whose data can be read, who can approve/suspend/verify — happens in browser JS and is enforced by nothing but the honesty of the client:

| Check | Location | What actually stops a hostile client |
|---|---|---|
| Who can sign up as `admin`/`hospital`/`donor` | [main.js:113-117](../src/main.js#L113-L117), [auth.js:20-31](../src/auth.js#L20-L31) | Nothing — role is a free-form string in the signup payload |
| Who can view `/admin.html`, `/hospital.html` | [main.js:25-32](../src/main.js#L25-L32) | Nothing — only checks "logged in," not role |
| Who can approve/reject a hospital (`window.handleAdminApprove/Reject`) | [main.js:1783-1799](../src/main.js#L1783-L1799) → [db.js:459-481](../src/db.js#L459-L481) `verifyHospital`/`rejectHospital` | Nothing — plain `window.*` functions, callable from devtools by any authenticated user, no role check inside `db.js` either |
| Who can suspend/reactivate a donor (`window.handleAdminSuspendUser/ReactivateUser`) | [main.js:2007-2023](../src/main.js#L2007-L2023) → [db.js:439-457](../src/db.js#L439-L457) | Same — no role check anywhere in the call chain |
| Who can edit *any* field of *any* user's profile document | [db.js:855-858](../src/db.js#L855-L858) `updateUserProfile(userId, updates)` | **Nothing at all** — takes an arbitrary `updates` object and calls `updateDoc` with no field allowlist. Every caller today happens to pass safe fields (name/city/phone/notifs/isAvailable/bloodType), but the function itself would just as happily accept `{ role: 'admin', isVerified: true }` if called directly from the console against one's own doc |
| Donor editing their own `bloodType` | [donor-dashboard.js:715-720](../src/donor-dashboard.js#L715-L720) | Self-reported by design in the current schema (no `bloodTypeSource` field exists at all — see §6 gap analysis) but still flows through the same unrestricted `updateUserProfile` |

None of this is a criticism of individual lines so much as a structural fact: **there is no server in this system today.** The Firestore client SDK *is* the backend.

---

## 5. Finding 3.3 — sensitive actions that run entirely on the client

All of the following are plain exported functions in [db.js](../src/db.js), executed from the browser, with the write itself, the "notification," and the audit-log entry all happening as unauthenticated-by-any-server browser code:

| Sensitive action | Function | Location | Notes |
|---|---|---|---|
| Emergency alert fan-out | `autoMatchDonors` | [db.js:286-342](../src/db.js#L286-L342) | Queries up to 30 matching donors and, in a client-side loop, calls `sendSmsNotification`/`sendWhatsAppNotification` for each. **These don't actually send anything** — they just write a `notification_log` doc containing an `sms:` / `wa.me` deep link ([db.js:1237-1281](../src/db.js#L1237-L1281)); no SMS gateway is integrated. So today's "fan-out" is even weaker than server-side-but-real — it's a logged link nobody dispatches unless a human clicks it. |
| Blood stock mutation | `updateInventoryStock`, `deductInventoryStock`, `issueBloodToPatient`, `setInventoryThreshold` | [db.js:593-657](../src/db.js#L593-L657), [db.js:1036-1071](../src/db.js#L1036-L1071), [db.js:977-1034](../src/db.js#L977-L1034), [db.js:659-683](../src/db.js#L659-L683) | Read-then-write (get, mutate in JS, `setDoc`/`updateDoc`) with **no transaction** — two concurrent mutations (Master Plan scenario S5) can race and lose an update. No status lifecycle enforcement — this is plain integer arithmetic on a document, not the `awaiting_test → cleared/rejected` unit model the Master Plan assumes (see gap analysis, §6) |
| Activity/audit logs | `logActivity` | [db.js:20-31](../src/db.js#L20-L31) | Writes to `activity_logs` directly from the client on almost every action. **Anyone can write, and read, arbitrary rows into what is supposed to be the audit trail** — there is no collection today that is even conceptually append-only/server-only |
| Request status transitions (accept/en-route/complete) | `acceptRequest`, `donorSetEnRoute`, `completeDonorArrival`, `completeDonationRequest`, `approveDonationRequest`, `rejectDonationRequest` | [db.js:93-168](../src/db.js#L93-L168), [db.js:757-818](../src/db.js#L757-L818), [db.js:920-946](../src/db.js#L920-L946) | No exactly-once guarantee (Master Plan scenario S3): two donors racing to "accept" the same request both hit the same `updateDoc`, last write wins, no transaction, no check that it's still `Open` before assigning |
| PHI-adjacent bulk export | `downloadCSVFromTable('adminUsersTableBody', 'VitalPulse_Donor_Directory')`, `...'VitalPulse_Emergency_Audit_Logs'` | [main.js:1620](../src/main.js#L1620), [main.js:1628](../src/main.js#L1628) | Client-side CSV export of the full donor directory and activity log, available to anyone who can reach `admin.html` (which, per §2, is anyone logged in). Not one of the three named findings but directly relevant to Policy 4 (Restricted-PHI export must be "approved, logged admin function only") |

---

## 6. Gap analysis vs. Master Plan Part 1 — schema mismatch, must be resolved before Phase 2

The Master Plan's reference `firestore.rules` and `firestore.rules.test.js` are written against a **six-role, per-hospital, blood-unit-lifecycle schema** that does not exist in the real app. The real app has a **much simpler three-role, no-blood-unit, no-hospitalId-scoping schema.** These are not small naming differences — they are different data models. Concretely:

| Master Plan assumes | Real app has | Resolution needed |
|---|---|---|
| 6 roles: `donor, hospital_staff, lab_tech, hospital_admin, system_admin, nbtp_viewer` | 3 roles: `donor, hospital, admin`, stored as a plain Firestore field, not a custom claim | **Proposal:** implement custom claims for the 3 real roles now (`donor`, `hospital`, `admin`) via `grantRole()`, and treat the 6-role split as a fast-follow migration once hospital-side staff differentiation is actually needed. Building all 6 roles today with no UI/workflow to use `hospital_staff` vs `lab_tech` vs `hospital_admin` would add unused complexity and untestable rule paths. Flagging for your sign-off before Phase 2. |
| `hospitalId` custom claim scoping all hospital-side reads/writes to one hospital | Hospital identity is just the `users` doc's own `uid`/`name` string; `requests`/`inventory`/`donation_requests` reference hospitals **by name string** (`hospital: hospitalName`), not by a stable `hospitalId` foreign key ([db.js:44-52](../src/db.js#L44-L52), [invDocId at db.js:510-512](../src/db.js#L510-L512)) | Rules need a `hospitalId` (or the hospital's own `uid`) claim, and every hospital-scoped write must carry that ID instead of a free-text name (free-text `hospital` name matching is itself a bug — two hospitals with the same display name would collide/leak). **Recommend:** add `hospitalId` = hospital user's own `uid` as the scoping key, keep `hospital` name as a display-only denormalized field. Flagging for your review. |
| `bloodUnits/{unitId}` documents with `status: awaiting_test\|cleared\|rejected\|...` lifecycle, cleared only by `lab_tech` | No `bloodUnits` collection at all — inventory is a single aggregate counter document per `hospital+bloodType` (`inventory/{hospital}_{bloodType}`) with a `batches` array, no per-unit test/clearance state | The real app has no untested-blood-safety problem to fix (Finding from §2.2 of the original findings doc) because it never modeled individual units — it only tracks aggregate counts. Recommend deferring the full unit-lifecycle model to a follow-up (would be a real product feature, not just a security fix) and, for now, scoping `updateInventory`'s Cloud Function to enforce non-negative counts + transactional writes on the aggregate doc. Flagging for your review. |
| `public_requests` — the only anonymous write path, with rate limiting | No public/anonymous request page exists in the app at all today (no code path calls Firestore without `auth.currentUser`) | `submitPublicRequest` Cloud Function and its rules section can be built ahead of the matching frontend feature, or deferred — your call, flagging for decision. |
| `reactionLogs`, `transfers`, `reviewQueue`, `nationalStats` collections | None of these exist | Defer — no frontend consumes them yet. |
| Audit logs client-unwritable | `activity_logs` is fully open to client `addDoc`/read today | Directly actionable now: this collection must become Cloud-Function-only in Phase 2/3 exactly as planned, no schema conflict here. |

**Recommendation for Phase 2:** adapt the reference `firestore.rules` down to the roles/collections that actually exist (`users`, `requests`, `inventory`, `donation_requests`, `activity_logs`, `donor_notifications`, `hospital_notifications`, `notification_log`, `campaigns`, `issuance_log`, `system_settings`), keep the deny-by-default shell and the ABAC *pattern* (hospital-scoping, field-level restriction, admin-only audit reads), and explicitly park the unit-lifecycle/`public_requests`/`nbtp_viewer`/transfers portions of the Master Plan as a documented "Phase 2.5 — schema evolution" follow-up rather than inventing fake collections just to satisfy the reference file. Will not proceed with that parking decision without your explicit sign-off since it's a deviation from the plan as written.

---

## 7. Full Firestore schema as it actually exists (from code, not docs)

| Collection | Written by (client, today) | Key fields observed |
|---|---|---|
| `users/{uid}` | `auth.js` (create), `db.js` (many updates) | `email, role('donor'\|'hospital'\|'admin'), name, city, phone, licenseUrl, isVerified, isSuspended, isAvailable, bloodType, emailVerified, rejected, points, tier, donationCount, badges, notificationPrefs, createdAt` |
| `requests/{id}` | `db.js: createEmergencyRequest, acceptRequest, donorSetEnRoute, completeDonorArrival, autoMatchDonors` | `status('Open'\|'Matching'\|'Donor Assigned'\|'Donor En Route'\|'Resolved'), isEmergency, bloodType, hospital, hospitalCity, requestedAt, matchedDonor, matchedAt, enRouteAt, resolvedAt, matchingDonorsNotified[], matchingDonorsCount, notifiedAt` |
| `inventory/{hospital}_{bloodType}` | `db.js: updateInventoryStock, deductInventoryStock, issueBloodToPatient, setInventoryThreshold` | `bloodType, hospital, unitsAvailable, unitsReserved, minimumThreshold, batches[{id,units,componentType,expiresAt,addedAt}], componentTotals, lastUpdated` |
| `donation_requests/{id}` | `db.js: submitDonationRequest, approveDonationRequest, rejectDonationRequest, completeDonationRequest, cancelDonationRequest` | `donorId, donorName, donorEmail, donorPhone, bloodType, units, preferredDate, preferredLocation, notes, status('pending'\|'approved'\|'rejected'\|'completed'\|'cancelled'), createdAt, updatedAt` |
| `activity_logs/{id}` | `db.js: logActivity` (called from nearly every mutation) | `title, description, type('success'\|'warning'\|'info'\|'error'), timestamp` |
| `donor_notifications/{id}` | `db.js: addDonorNotification` | `donorId, title, message, type, read, createdAt` |
| `hospital_notifications/{id}` | `db.js: addHospitalNotification` | `hospitalId, title, message, type, read, createdAt` |
| `notification_log/{id}` | `db.js: sendSmsNotification, sendWhatsAppNotification` | `channel('sms'\|'whatsapp'), recipient, message, link, status, sentAt` |
| `campaigns/{id}` | `db.js: createCampaign, updateCampaign, deleteCampaign, joinCampaign, leaveCampaign` | `title, status('planning'\|...), participants[{hospitalName,hospitalCity,joinedAt}], participantCount, createdAt, updatedAt` |
| `issuance_log/{id}` | `db.js: issueBloodToPatient` | `bloodType, units, patientName, patientId, ward, requestingDoctor, diagnosis, hospital, issuedAt` — **this is Restricted-PHI (patient identity + diagnosis) and today is written directly from the browser and readable via `fetchInventoryMovements`** |
| `system_settings/config` | `db.js: updateSystemSettings` | `criticalSupplySms, hospitalDigest, donorAlerts, autoMatchDonors, lowStockThreshold, emergencyBroadcastEnabled, registrationApprovalRequired` |

No `hospitalId`-scoped subcollections, no per-unit blood tracking, no `public_requests`, no audit collection distinct from `activity_logs`.

---

## 8. Other secrets scan (repo + full git history)

Ran `git log -p --all` over all source/HTML and grepped for API-key/secret/password/private-key patterns.

- **Found:** only the Firebase Web `apiKey` in [firebase.js:6](../src/firebase.js#L6) (`AIzaSyBWJIygZ5moqqgNvEv_v-oba0MvKllvPLg`) and the `"ADMIN2024"` string covered in §3. The Firebase Web API key is **not a secret by Firebase's own design** (it identifies the project, not a credential — access is governed by Security Rules/App Check, not by hiding this string) so it does not need rotation, only the admin code does.
- **Not found anywhere in history:** no `.env` files, no service-account JSON, no private keys, no other hardcoded passwords. `git log --diff-filter=A --name-only` across all commits shows no file matching `.env|serviceAccount|credentials|.pem|.key` was ever added.
- Git history is short (4 commits total on this branch's lineage: `5d04f2c`, `6ad1c48`, `6074996`, `dca5c08`) — a `git filter-repo` purge of the `ADMIN2024` string (Master Plan §1.6.3) is cheap and low-risk to do here since there's so little history to rewrite, but it is still a rewrite of shared history — **do not run it without your explicit go-ahead**, per your standing instruction to confirm before any destructive/history-rewriting git operation.

---

## 9. Summary of what Phase 1–3 must do (no new information, just the checklist this audit unblocks)

1. **Phase 1:** delete [main.js:113-117](../src/main.js#L113-L117) (both the dead `ADMIN2024` check and the live `admin@vitalpulse` substring check) and [auth.js:106-108](../src/auth.js#L106-L108) (the two hardcoded admin emails). Add real role-gating to the dashboard router at [main.js:25-32](../src/main.js#L25-L32) so it checks role, not just "logged in" — even before custom claims land, this closes the "any donor can browse to `/admin.html`" hole as defense in depth.
2. **Phase 2:** write rules against the real 10-collection schema in §7, not the Master Plan's 6-role/blood-unit schema, per the gap analysis in §6 (pending your sign-off on the proposed resolution).
3. **Phase 3:** move `verifyHospital`, `rejectHospital`, `suspendDonor`, `reactivateDonor`, `updateInventoryStock`/`deductInventoryStock`/`issueBloodToPatient`, `logActivity`, and the accept/en-route/complete request transitions into Cloud Functions; delete `updateUserProfile`'s unrestricted passthrough in favor of an allowlisted client update + a function for anything privileged.
4. **You, manually, before/alongside Phase 1:** check the actual deployed Firestore rules on `vitalpulse-fa458` (see §1) — we don't know today's real exposure from the repo alone. Also decide on the §6 schema-scope question so Phase 2 doesn't build against fictional collections.
