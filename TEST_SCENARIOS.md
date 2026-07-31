# VitalPulse Test Scenarios

Manual test scenarios to verify the platform end-to-end.

---

## Scenario A: Emergency Blood Request (Full Cycle)

**Story:** A hospital needs O+ blood urgently for a patient. An emergency request is created, nearby compatible donors are notified, a donor responds and donates, the blood is tested, cleared into inventory, and issued to the patient.

### Prerequisites
- 1 Hospital account (verified)
- 1+ Donor account(s) with compatible blood type (O+ in this case)
- Both logged in on separate devices/browsers

---

### A1 — Hospital Creates Emergency Request

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 1 | Hospital logs in at `/login.html` | Dashboard loads with hospital name | |
| 2 | Click **"Urgent Request"** button (sidebar or dashboard quick action) | Urgent Request modal opens | |
| 3 | Fill in: Patient Blood Type = **O+**, Units Needed = **2**, Reason = **"Trauma patient, internal bleeding"**, set priority to **Emergency** | Fields populate correctly | |
| 4 | Click **Submit Request** | Modal closes. Toast/success notification appears. Request status shows **"Pending"** | |
| 5 | Navigate to **My Requests** view | New request appears in the list with O+, 2 units, Emergency priority | |

---

### A2 — Donor Receives Notification

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 6 | Switch to donor's browser (logged into a **compatible O+ donor account**) | Dashboard loads | |
| 7 | Check for notification (bell icon in header) | Notification badge appears with count | |
| 8 | Click notification icon | Dropdown shows the emergency request details | |
| 9 | Click notification or navigate to Requests view | Emergency request card visible: "O+ Needed — 2 units — Emergency" | |

---

### A3 — Donor Accepts & Travels

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 10 | Donor clicks **"Accept"** on the request | Status changes to **"Accepted"**. Hospital name and address shown to donor | |
| 11 | Navigate to **My Requests** tab in donor view | Request shows **"Accepted"** with hospital details and navigation option | |

---

### A4 — Hospital Seeks Donor Status

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 12 | Switch back to Hospital browser → **Incoming Donors** view | Donor appears in the list with **"Accepted — En Route"** status | |
| 13 | Click on the donor entry | Donor details expand: name (or anonymized ID), blood type, estimated arrival | |
| 14 | Go to **My Requests** → click the request | Request status updated: shows **"1 donor assigned"** | |

---

### A5 — Donor Arrives & Check-In

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 15 | Hospital clicks **"Check In"** or **"Mark Arrived"** on the donor | Status changes to **"On-Site — Screening"** | |
| 16 | Hospital fills health screening form (weight, hemoglobin, vitals) | Form validates inputs correctly | |
| 17 | Hospital clicks **"Begin Donation"** | Status changes to **"Donating"**. Timer or progress starts | |

---

### A6 — Donation Complete → Lab Pipeline

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 18 | Hospital marks donation as **"Complete"** | Status changes to **"In Lab"**. Blood unit created in Lab pipeline | |
| 19 | Navigate to **Lab & Testing** view | New entry visible: O+, **"Pending Screening"** | |
| 20 | Click the entry → **Run TTI Screening** | Screening modal opens with test panels (HIV, Hepatitis B/C, Syphilis) | |
| 21 | Mark all tests as **Negative** → Click **"Release"** | Status changes to **"Cleared & Released"**. Unit added to main inventory | |

---

### A7 — Blood Added to Inventory

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 22 | Navigate to **Inventory** view | New O+ unit visible with **"Available"** status. Total stock count updated | |
| 23 | Verify the dashboard stat cards | **Total Stock Units** count reflects the new addition | |

---

### A8 — Issue Blood to Patient

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 24 | In **Inventory**, click **"Issue"** on the O+ unit | Issue modal opens | |
| 25 | Enter patient details, select the original request, confirm | Unit status changes to **"Issued"**. Stock count decreases | |
| 26 | Go back to **My Requests** → click the original request | Full audit trail visible: Created → Accepted → Donor Arrived → Donated → Tested → Issued | |

---

### A9 — Donor Receives Recognition

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 27 | Switch to Donor browser → check notifications | Notification: **"Your donation has been tested and cleared!"** or **"You saved a life!"** | |
| 28 | Navigate to donor **Badges/Achievements** view | Donation count updated. Lives-impacted counter increments | |

---

**Scenario A Complete** ✅

---

## Scenario B: Critical Bug Fixes & Design Polish — Regression Validation

**Story:** Verify that all recently shipped production fixes and design polish items work correctly across donor, hospital, and public pages.

### Prerequisites
- 2 browsers/devices (Donor + Hospital) with valid logged-in accounts
- A second donor account with a different National ID for dedup testing

---

### B1 — 56-Day Server-Side Deferral Gate

When a donor accepts a request, the server checks that at least 56 days have passed since their last donation. This gate applies to both `acceptRequest` (hospital-facing) and `acceptPublicRequest` (public requests).

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 1 | Open Network tab (F12) before accepting a request | DevTools ready | |
| 2 | As a donor who donated **less than 56 days ago**, open an active request and click **Accept** | Request is **rejected client-side and server-side**. Toast error: *"You must wait at least 56 days…"* | |
| 3 | Verify in Network tab that the server response also rejects (status error or `{error: "…56 days…"}`) | The server-side gate also blocked it (not just the client) | |
| 4 | As a donor whose last donation was **56+ days ago** (or no prior donation), accept the same request | Acceptance succeeds. Status changes to **"Accepted"** | |

---

### B2 — National ID: Signup Read + Duplicate Check

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 5 | Open `/signup.html` in incognito/private window | Signup form loads | |
| 6 | Scroll to the **National ID Card Number** field | Field is visible and labeled (e.g. "National ID Number (CNI)") | |
| 7 | Fill all fields and enter a National ID that already exists in the system (use a known donor's CNI). Submit | Signup is **rejected** with an error: *"A user with this National ID already exists"* (or similar). No account created | |
| 8 | Change the National ID to a unique value and submit | Account created successfully | |
| 9 | Log into an **existing donor account** → navigate to **Profile** view | Profile loads with current data | |
| 10 | In the CNI field, enter a National ID that belongs to a **different** existing donor and save | Save fails: *"National ID already in use"* | |
| 11 | Enter your own original CNI (or a new unique one) and save | Profile updates successfully | |

---

### B3 — Consistent Default Cities (Yaoundé)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 12 | Open `/signup.html` → find the **City** dropdown | Default selected city is **"Yaoundé"** | |
| 13 | Log into a **donor dashboard** → navigate to **Profile** edit | City field defaults to **"Yaoundé"** if empty | |
| 14 | Log into a **hospital dashboard** → check any city dropdown in request/inventory forms | Default is **"Yaoundé"** | |

---

### B4 — Hash-Based SPA Routing (Reload Persistence)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 15 | Log into **Donor dashboard** → navigate to **Badges** view | URL hash changes to `#badges` | |
| 16 | **Reload the page** (F5 / Ctrl+R) | Dashboard reloads and lands **directly on the Badges view** (not the default dashboard) | |
| 17 | Navigate to **History** view, then reload | Reload lands on **History** view | |
| 18 | Repeat steps 15–17 on the **Hospital dashboard** (switch sub-views and reload) | Each sub-view persists on reload | |
| 19 | Repeat on the **Admin dashboard** | Admin tabs also persist on reload | |

---

### B5 — Notification Pre-Fetch / Caching

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 20 | Log into Donor dashboard. Wait at least 30 seconds for the background poll | No action needed — poll runs automatically | |
| 21 | Click the bell icon | Notification panel opens **immediately** (no loading spinner), showing cached notifications | |
| 22 | Close the panel, trigger a brand-new notification (e.g. hospital creates a request for your blood type), wait for the poll, then click the bell | New notification appears in the panel. Any prior ones remain cached | |
| 23 | Repeat steps 20–22 on the **Hospital dashboard** | Hospital notification bell also shows cached data instantly | |

---

### B6 — Brand Polish: Blood-Hand Hero (Landing Page)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 24 | Open `index.html` (landing page) in a browser | Page loads | |
| 25 | Scroll to the hero section (top fold) | Right-side visual shows the **3D blood-hand image** (`blood_hand_3d.png`) — hands cupping a glowing blood drop. No Unsplash stock photo | |
| 26 | Hover over the image | Subtle scale-up effect (`hover:scale-[1.03]`) | |
| 27 | Verify the image loads correctly at various viewport widths (resize browser) | Image stays centered and cropped appropriately on mobile/tablet/desktop | |

---

### B7 — Dynamic Tier Emblem (Badges View)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 28 | Log into **Donor dashboard** → navigate to **Badges** view | Hero section loads | |
| 29 | Look at the emblem next to "Current tier" label | Emblem matches the donor's actual tier (e.g. Bronze → copper/orange gradient with shield icon, Silver → grey gradient with workspace_premium icon, Gold → gold gradient with stars icon, Platinum → light gradient with diamond icon) | |
| 30 | If possible, check with a donor account at a different tier level (or review the source code in `loadDonorBadges()` mapping) | Emblem gradient and icon change per tier — not a static gold emblem | |

---

### B8 — Badge Click Handlers & Certification Modal

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 31 | In the Badges view, click on any **unlocked** medal card | Card is clickable (`cursor: pointer` on hover). A **certification modal** slides in showing: medal name, description, verification date, "Verified by VitalPulse Network", and a unique certificate ID | |
| 32 | Click **"Got it!"** or click the backdrop | Modal closes | |
| 33 | Click on any **locked** medal card | **Locked** modal opens showing: medal name, description, progress requirement, "Not yet achieved", "Keep donating to unlock" | |
| 34 | Verify the locked card styling is visually distinct (dashed border, dimmed text, lock icon on the emblem, "Keep donating to unlock" hint text) | Locked cards look clearly different from unlocked ones | |

---

### B9 — Subpage Heroes (privacy & terms Pages)

| Step | Action | Expected Result | Pass/Fail |
|------|--------|----------------|-----------|
| 35 | Open `/privacy.html` | Page shows a **hero section** at the top with: breadcrumb (Home / Privacy Policy), shield icon, title "Privacy Policy", description text, and the amber "Draft policy" badge. A gradient background rounds the bottom corners | |
| 36 | Scroll below the hero | Content sections (1. What we collect, 2. How we use it, etc.) render normally | |
| 37 | Open `/terms.html` | Similar hero with gavel icon, breadcrumb, title "Terms of Service", and draft badge | |
| 38 | Verify both heroes match the design language used on the app's other subpages | Consistent colors, typography, spacing | |

---

**Scenario B Complete** ✅

---

Want me to write Scenario C next? Options:
- **C: Donor Self-Registration → Hospital Verification → First Donation**
- **D: Admin Verifies a New Hospital Account**
- **E: Blood Drive / Campaign — Hospital Creates Drive → Donors RSVP**
- **F: Inventory Management — Low Stock Alerts → Threshold Settings**
