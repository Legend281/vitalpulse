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

Want me to write Scenario B next? Options:
- **B: Donor Self-Registration → Hospital Verification → First Donation**
- **C: Admin Verifies a New Hospital Account**
- **D: Blood Drive / Campaign — Hospital Creates Drive → Donors RSVP**
- **E: Inventory Management — Low Stock Alerts → Threshold Settings**
