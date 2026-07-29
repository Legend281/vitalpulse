# VitalPulse — Findings Doc Gap Audit

A line-by-line check of the 24 concrete recommendations in *VitalPulse: Findings, Flaws, and Recommendations* against the actual codebase (grep + read, not memory). The security section (§3 of that document) was excluded per request — everything below covers clinical safety, matching, access, donor/hospital/admin features, and Cameroon-fit items only.

**Summary: 10 Done · 11 Partial · 3 Missing** (out of 24)

Most "Partial" items are not half-written code — they're a fully working backend function in `db.js` with no button or nav entry pointing at it in the UI. That's the same bug shape as the Phase 3 tabs (Hemovigilance/Forecasting/Myth-Busting/Certificates) that got wired up earlier.

---

## §2 — Blood safety & clinical data model

### 1. Health screening before a donor can donate — **PARTIAL**
- `donor-dashboard.js:1436` — `SCREENING_QUESTIONS` (6 topics: illness, medication, low iron, pregnancy, malaria-area travel, recent tattoo/piercing) gates the "Next" button at `:1504`.
- **Gap:** only gates the self-booking wizard. The plain "available to donate" toggle (`:739`) bypasses it entirely, and a "yes" answer sets `screeningPassed:false` for hospital review rather than blocking submission outright.

### 2. "Waiting for Lab Test" / "Cleared" / "Rejected" per blood unit — **DONE**
- `db.js:1096–1110` — `computeInventoryAggregates()` splits batches by `testStatus`.
- `db.js:1926,1935` — deduction logic excludes non-cleared batches.
- Not cosmetic: `unitsAvailable` genuinely excludes anything not marked Cleared.

### 3. Self-Reported vs. Lab-Verified blood type — **DONE**
- `auth.js:66` — `bloodTypeSource: 'self-reported'` set at signup.
- `hospital.html:1665` — "Confirmed Blood Type" field on donation intake → `db.js:1509` `recordDonationIntake`.
- `donor-dashboard.js:1243` — badge shown on donor dashboard, derived from completed donations rather than overwriting the profile (this is deliberate, documented in the code).

### 4. Blood tracked by component (whole blood / red cells / plasma / platelets) — **DONE**
- `db.js:1098` — `componentType` per batch.
- `db.js:767–800` — reversed ABO compatibility table for plasma (the AB↔O reversal the doc specifically flags is implemented correctly).
- `db.js:821` — component-specific shelf life.

---

## §4 — Matching engine

### 5. Radius matching instead of exact city-name string match — **DONE**
- `db.js:646` — `calculateDistanceKm` (haversine formula).
- `db.js:684,706–717` — 25km/50km radius depending on urgency. City name is now only a secondary signal, not the gate.

### 6. Hospital-to-hospital blood transfer — **PARTIAL**
- `db.js:3023` — `createBloodTransferRequest` / `dispatchBloodTransfer`, fully built.
- **Gap:** `hospital.html:2250` has a `newTransferModal` with no trigger button anywhere in the file, and `main.js` has zero references to either function. Pure stub.

---

## §5–6 — Public access & direct requests

### 7. No-login request using patient details directly — **DONE**
- `public-request.html` collects hospital, city, blood type, component, urgency, required phone + relationship, optional document upload → `db.js:2585` `submitPublicRequest`.

### 8. Public "I Am a Patient" page for hospitals not yet on VitalPulse — **PARTIAL**
- Same form as #7 handles this: shadow-hospital creation (`db.js:2602`), admin triage queue (`admin.html:1211`), hospital auto-notify on match (`db.js:2900`).
- **Gap vs. spec:** no ward/department field, no device geolocation (city dropdown only), and no three-tier "Unverified / Document Attached / Hospital-Confirmed" label — real statuses are Pending Review / Broadcasting / Track A / Track B instead.

---

## §7 — Donor side

### 9. Donor reaction log after donating (dizziness, fainting) — **MISSING**
- No matches anywhere for vasovagal / dizziness / fainting / "donor reaction."
- Distinct from Hemovigilance, which covers the *patient receiving* blood, not the donor giving it.

### 10. Myth-busting shown to donors (not just authored by hospitals) — **DONE**
- `donor.html:684` `view-mythhub` → `donor-dashboard.js:1898` `loadMythHubView()`.
- Certificates are donor-facing too: `donor.html:714`, `donor-dashboard.js:1956`.

---

## §9 — Admin / national oversight

### 11. National view combining safety data across all hospitals — **MISSING**
- Zero matches for "hemovigilance" or "reaction" anywhere in `admin.html`. The hemovigilance feature (`main.js:323`) is hospital-scoped only — each hospital sees only its own reports.

### 12. National view of testing status (cleared / waiting / rejected) — **PARTIAL**
- `admin.html:799–813` — the stat tiles already exist (`analyticsUnitsPendingTest`, `analyticsUnitsRejected`).
- **Gap:** `loadAnalyticsDashboard()` in `main.js` never references either element ID — they're permanently stuck on "–". The chart canvas IDs in that same function also don't match the ones actually in `admin.html`, so this whole analytics wiring pass looks incomplete, not just this one stat.

---

## §10 — Cameroon fit

### 13. French language support — **PARTIAL**
- `i18n.js:1–107` — roughly 52 keys × 2 languages, covering generic UI chrome (nav labels, buttons, statuses) only.
- **Gap:** no coverage for screening questions, myth articles, forecast copy, hemovigilance labels, the public-request form, or onboarding text.

### 14. Offline-first support (queue actions, sync on reconnect) — **MISSING**
- `firebase.js` has no `enableIndexedDbPersistence` / `persistentLocalCache` config.
- No "queued" or "pending sync" state anywhere in the UI.

> **Not formally audited, but worth flagging:** SMS-based registration for donors without smartphones. The source document itself frames this as "a future improvement, consider" rather than a current requirement — still missing, but explicitly low-priority in the doc's own words.

---

## §18 — New feature ideas

### 15. Timed escalation for unanswered urgent requests — **DONE**
- `db.js:2784` — `escalatePublicRequest` widens the search radius 25km → 50km → 999km and flags admin at the final level.
- `public-request.html:335` — client-side timer fires escalation checks at 5/10/15 minutes after a Track A submission.

### 16. Live "donor is on the way" tracking — **PARTIAL**
- "Donor En Route" exists only as a status string (`hospital.html:821`), set manually via a `confirm()` dialog (`donor-dashboard.js:1362`).
- **Gap:** no map library anywhere in the app (zero matches for Leaflet/Mapbox/Google Maps). The only "map" is a static decorative city-dot illustration, not a live tracker.

### 17. Fast-track category for childbirth bleeding emergencies — **DONE**
- `public-request.html:75` — "Maternal Hemorrhage" option.
- `db.js:2593` — grants instant Track A broadcast for Maternal Hemorrhage/Trauma + Critical urgency + a trusted phone number.

### 18. Full timestamped blood-unit lifecycle (donated → tested → cleared → issued → transfused) — **PARTIAL**
- `db.js:2109` — `fetchInventoryMovements` exists and renders (`main.js:3868`).
- **Gap:** only pulls from 3 activity-log title types (Inventory Update / Stock Removed / Blood Issued). Lab clearance/rejection events (`db.js:1299`) and donation-intake events aren't included, so it's a partial stock-change feed, not a complete per-unit trace.

---

## §19 — Further feature ideas

### 19. Recurring-patient registry (sickle cell, thalassemia) — **PARTIAL**
- `db.js:3183` — `saveChronicPatient` / `fetchChronicPatients` / `deleteChronicPatient`, fully built.
- `hospital.html:2321` — full "add patient" modal markup already exists.
- **Gap:** zero references to any of it in `main.js`. Same unwired-stub pattern as the transfer modal.

### 20. Check nearby hospitals' existing stock, not just live donors — **PARTIAL**
- `db.js:2975` — `checkNetworkInventory` is fully and correctly implemented.
- **Gap:** zero callers anywhere — not invoked from `createEmergencyRequest` or any UI.

### 21. Public "Verified Hospital" trust badge — **DONE**
- `donor-dashboard.js:1567` — "Verified hospital" badge/icon shown when picking a donation center; list filtered to `isVerified === true` (`:1516`).

### 22. Post-donation care reminders — **PARTIAL**
- `db.js:3471` — `createCareReminders` defined, but zero callers — never triggered when a donation is marked complete.
- `fetchCareReminders` / `dismissCareReminder` **are** wired and displayed (`donor-dashboard.js:1824,1885`), so the display half works — nothing ever seeds the data.

### 23. "Trusted Regular Donor" tier weighted by the matching engine — **PARTIAL**
- `db.js:2153` — `computeDonorEngagement` computes Bronze/Silver/Gold/Platinum tiers and badges.
- **Gap:** `autoMatchDonors` (`db.js:660`) ranks purely by blood type + radius + availability — tier is never used to prioritize who gets matched first.

### 24. Distance/travel-time shown, no payment handling — **DONE**
- `db.js:718` — `matchedDistanceKm` computed during matching.
- Shown to donors (`donor-dashboard.js:353`) and hospitals (`hospital.html:863`) as "~X km away." Purely informational, exactly as the document specifies — no payment integration anywhere.

> **Not code deliverables:** §9.2 (structuring data so it could connect to Cameroon's National Blood Transfusion Program someday) and §19.6 (building a relationship with Blood Track / HERO Cameroon) are both explicitly framed in the source document as positioning and outreach work, not features to build.

---

## Suggested starting order

Cheapest-to-value first — these are working backend code with no UI path to reach them yet, so each one is small:

1. **Wire the chronic/recurring-patient registry (#19).** All three `db.js` functions and the full modal already exist — this needs a nav entry and a render function, not new logic.
2. **Wire post-donation care reminders (#22) and the hospital-transfer modal (#6).** Both are one missing function call away from working — call `createCareReminders` when a donation completes; add a button that calls the existing transfer functions.
3. **Fix the admin analytics ID mismatch (#12).** The national testing-status tiles are already sitting in the HTML — `loadAnalyticsDashboard()` just needs to target the right element and canvas IDs.

After those, the three genuinely-missing items (#9 donor reaction log, #11 national safety view, #14 offline-first) are real new builds and worth discussing scope on before starting.
