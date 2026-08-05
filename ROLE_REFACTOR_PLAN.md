# ROLE REFACTOR PLAN — Living Document

> **Branch:** `feature/role-based-hospital-dashboard`
> **Revert point:** Tag `pre-role-refactor-backup` on `main` (commit `a392e3f`)
> **Last updated:** 2026-08-05 01:17 WAT

---

## 1. Confirmed Sidebar Items (from actual code)

| # | Nav ID | Label | HTML Element ID | Your Spec Role Mapping |
|---|--------|-------|-----------------|------------------------|
| 1 | `dashboard` | Dashboard | `nav-dashboard` | All roles |
| 2 | `lab` | Lab & Testing | `nav-lab` | lab_tech, hospital_admin |
| 3 | `requests` | My Requests | `nav-requests` | nurse, hospital_admin |
| 4 | `inventory` | Inventory | `nav-inventory` | nurse (view-only), lab_tech, hospital_admin |
| 5 | `donors` | Incoming Donors | `nav-donors` | reception, nurse, hospital_admin |
| 6 | `campaigns` | Campaigns | `nav-campaigns` | hospital_admin |
| 7 | `settings` | Settings | `nav-settings` | hospital_admin |
| 8 | `staff` | Staff Roster | `nav-staff` | hospital_admin |
| 9 | `hemovigilance` | Hemovigilance | `nav-hemovigilance` | nurse, lab_tech, hospital_admin |
| 10 | `forecasting` | Forecasting | `nav-forecasting` | hospital_admin |
| 11 | `mythbusting` | Myth-Busting | `nav-mythbusting` | hospital_admin |
| 12 | `certificates` | Certificates | `nav-certificates` | hospital_admin |

### Non-Sidebar Elements

| Element | HTML ID | Role Mapping |
|---------|---------|--------------|
| Urgent Request (sidebar button) | `btnUrgentRequest` | nurse, hospital_admin |
| Dashboard "Place Emergency Request" card | (inline in view-dashboard) | nurse, hospital_admin |

### Inventory Button-Level Gating (rendered in `main.js` ~L1465)

| Button | `window.` Function | Allowed Roles |
|--------|---------------------|---------------|
| Add | `openHospitalAddStock(type)` | lab_tech, hospital_admin |
| Issue | `openHospitalIssueBlood(type, stock)` | lab_tech, hospital_admin (+ crossmatch gate, + requestingPhysicianName — ADDITIVE, never replacement) |
| Remove | `openHospitalRemoveStock(type)` | hospital_admin ONLY |
| Thresh | `openHospitalSetThreshold(type)` | hospital_admin ONLY |
| Request Transfer | `openTransferModal(hospitalName)` | hospital_admin ONLY |

**Discrepancy:** No differences found between the prompt's mapping and actual sidebar/button code.

---

## 2. Implementation Order & Status

### Phase 0: Safety Setup
- [x] Tag `pre-role-refactor-backup` on main
- [x] Create branch `feature/role-based-hospital-dashboard`
- [x] Populate `ROLE_REFACTOR_PLAN.md` (this file)
- [x] Create `REGRESSION_CHECKLIST.md`
- **Status: DONE**

### Phase 1: Build the Shared Permission System (no UI changes)
- [x] Fix `auth.js` to store `claims.roles` array in localStorage
- [x] Create `vitalpulse_app/src/roleGating.js` with frontend `hasAnyRole`
  - Checks `sessionStorage` active staff session first (PIN switcher)
  - Falls back to hospital account's own claims
- [x] Write backend unit tests for `hasAnyRole` in `roles.test.ts` — **12 new tests, 28 total**
- [x] Write frontend unit tests for `hasAnyRole` in `roleGating.test.js` — **29 tests**
- [x] Commit `0535675`
- [x] Update this file
- **Status: DONE ✅** (361 total tests passing: 239 backend + 122 frontend)

### Phase 2: Simplest Pages (single-role-gated, low risk)
- [x] Staff Roster → hospital_admin only — **VERIFIED ✅** (commit `db1ca42`)
- [x] Settings → hospital_admin only — **VERIFIED ✅** (commit `669df40`)
- [x] Campaigns → hospital_admin only — **VERIFIED ✅** (commit `51c7d41`)
- [x] Forecasting → hospital_admin only — **VERIFIED ✅** (commit `6181980`)
- [x] Myth-Busting → hospital_admin only — **VERIFIED ✅** (commit `6181980`)
- [x] Certificates → hospital_admin only — **VERIFIED ✅** (commit `6181980`)
- **Status: DONE ✅** (373 total tests passing: 239 backend + 134 frontend)

### Phase 3: Moderate Pages (role-gated + backend confirmation)
- [x] Lab & Testing → lab_tech, hospital_admin — **VERIFIED ✅** (commit `f8786ac`)
- [x] My Requests + Chronic Patient Registry → nurse, hospital_admin — **VERIFIED ✅** (commit `f8786ac`)
- [x] Hemovigilance → nurse, lab_tech, hospital_admin — **VERIFIED ✅** (commit `f8786ac`)
- [x] Incoming Donors → reception, nurse, hospital_admin — **VERIFIED ✅** (commit `f8786ac`)
- [x] Dashboard "Place Emergency Request" quick action → nurse, hospital_admin — **VERIFIED ✅** (commit `f8786ac`)
- **Status: DONE ✅** (377 total tests passing: 239 backend + 138 frontend)

### Phase 4: Inventory (most complex — last)
- [ ] Page-level visibility (nurse view-only, lab_tech + hospital_admin full) — NOT STARTED
- [ ] Button-level gating (Add/Issue/Remove/Thresh/Transfer) — NOT STARTED
- [ ] Backend role tightening (see Known Risks #1) — NOT STARTED
- [ ] Per-role manual test — NOT STARTED
- [ ] Full regression — NOT STARTED
- **Status: NOT STARTED**

### Phase 5: Legacy Account Protection
- [ ] Confirm legacy accounts see full dashboard unchanged — NOT STARTED
- [ ] Add test case — NOT STARTED
- **Status: NOT STARTED**

### Phase 6: Final Sign-Off
- [ ] Full regression pass — NOT STARTED
- [ ] Summary written — NOT STARTED
- [ ] Await explicit merge approval — NOT STARTED
- **Status: NOT STARTED**

---

## 3. Known Risks

### Risk #1: `STOCK_MANAGER_ROLES` is too broad for the new spec

**File:** `functions/src/inventory.ts` line 78
**Current:** `STOCK_MANAGER_ROLES = ['nurse', 'hospital_staff', 'hospital_admin', 'system_admin']`
**Problem:** The new spec says nurse should be **view-only** on Inventory — no Add, no Remove, no stock mutation. But the backend currently allows `nurse` to call `addInventoryStockHandler` and `deductInventoryStockHandler`.
**Resolution:** In Phase 4, tighten `STOCK_MANAGER_ROLES` to remove `nurse`. Must verify this doesn't break any existing nurse workflow that actually uses these functions today.
**When:** Phase 4 only — do NOT change this prematurely.

### Risk #2: `auth.js` only stores single `role` string, not `roles` array

**File:** `vitalpulse_app/src/auth.js` line 300
**Current:** `role: claims.role || role` — stores only the legacy single-role claim.
**Problem:** Multi-role staff (e.g., `['nurse', 'lab_tech']`) will be evaluated against only one role on the frontend.
**Resolution:** Phase 1 — store `claims.roles` alongside `claims.role` in the localStorage blob.

### Risk #3: Shared device PIN switcher must not persist across tabs/sessions

**Design decision (confirmed by user):** Store active staff session in `sessionStorage`, not `localStorage`. This means:
- Closing the tab/browser clears the active staff session (correct for shared devices)
- The hospital account's own claims remain in `localStorage` as fallback
- Frontend `hasAnyRole` checks `sessionStorage` first, `localStorage` second

### Risk #4: Legacy accounts must not be broken by role gating

**Design decision (confirmed by user):** Any hospital account without a `roles` array and no PIN-switched staff session must see the full combined dashboard unchanged, per the 30-day migration grace period. Phase 5 specifically tests this.

---

## 4. Backend Functions That Need Role Confirmation (Phase 3-4)

| Cloud Function | Current Role Enforcement | Spec Role | Phase |
|---------------|-------------------------|-----------|-------|
| `addInventoryStockHandler` | `STOCK_MANAGER_ROLES` (includes nurse) | lab_tech, hospital_admin | Phase 4 — **TIGHTEN** |
| `deductInventoryStockHandler` | `STOCK_MANAGER_ROLES` (includes nurse) | lab_tech, hospital_admin | Phase 4 — **TIGHTEN** |
| `setInventoryThresholdHandler` | `STOCK_MANAGER_ROLES` (includes nurse) | hospital_admin ONLY | Phase 4 — **TIGHTEN** |
| `issueBloodToPatientHandler` | `ISSUANCE_ROLES` (lab_tech, hospital_admin, system_admin) | lab_tech, hospital_admin | Phase 4 — CONFIRM OK |
| `resolveLabTestHandler` | `LAB_RESOLVER_ROLES` (lab_tech, hospital_admin, system_admin) | lab_tech, hospital_admin | Phase 3 — CONFIRM OK |
| `createStaffAccount` | hospital_admin, system_admin | hospital_admin | Phase 2 — CONFIRM OK |
