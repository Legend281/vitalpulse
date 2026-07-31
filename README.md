# VitalPulse - Cameroon Blood Donation Coordination System
*Comprehensive Technical & Product Documentation*

## 1. Project Overview & Architecture
**VitalPulse** is a mission-critical, real-time coordination web application designed specifically for Cameroon's healthcare infrastructure. It connects verified hospitals, eligible blood donors, and urgent blood requests. 

The project is structured as a Single Page Application (SPA) driven by Vanilla JavaScript and ESM modules. It employs a **Firebase backend** for real-time capabilities and a **Vite/Tailwind** stack for a highly optimized, low-data frontend footprint.

### Repository Structure
The project root `BDMS` is split into two primary components:
1. **`stitch_lifestream_cameroon_coordination_system/`**: The design system repository containing the PRD (`project_prd_blood_donation_system.md`) and high-fidelity prototype folders including:
   - `admin_panel`, `donor_dashboard`, `donor_management`
   - `hospital_dashboard_1`, `hospital_dashboard_2`
   - `login_page`, `signup_page`, `vitalpulse_home_page`, `vitalis_cameroon`
   - Specific component designs like `new_batch_arrival_modal` and `urgent_request_modal`.
2. **`vitalpulse_app/`**: The live codebase.

---

## 2. Technical Stack Deep-Dive
- **Frontend Core:** HTML5, CSS3, Vanilla JavaScript.
- **Bundler:** Vite (configured in `vite.config.js`).
- **Styling:** Tailwind CSS v4.
  - The `tailwind.config.js` is highly customized for a healthcare theme. It defines specific color tokens like `primary` (`#af101a`), `primary-container` (`#d32f2f`), `secondary` (`#9f3f39`), `tertiary` (`#005f7b`), and surfaces (`#f9f9f9`).
  - It utilizes `@tailwindcss/forms` and `@tailwindcss/container-queries` plugins.
  - Fonts: *Manrope* for headlines, *Inter* for body text.
- **Database & Auth:** Firebase v12 (Firestore & Firebase Auth).
- **Data Visualization:** Chart.js (v4.5.1) for dashboard analytics.

---

## 3. Database Schema (Firestore Collections)

The application uses Firebase Firestore with the following core collections:

### A. `users`
Stores all account types (Donors, Hospitals, Admins).
- `uid` (Document ID)
- `email`: string
- `role`: string (`'donor'`, `'hospital'`, `'admin'`)
- `name`: string
- `city`: string (e.g., 'Yaoundé', 'Douala')
- `isVerified`: boolean (Donors default to true, Hospitals default to false pending admin approval)
- `emailVerified`: boolean
- **Donor Specific:** `bloodType`, `isAvailable` (boolean), `isSuspended` (boolean), `donations` (array fetched dynamically)
- **Hospital Specific:** `phone`, `licenseUrl` (Firebase Storage download URL of the license document uploaded at signup), `licenseFileName`, `rejected` (boolean)

### B. `requests`
Manages emergency blood requests.
- `status`: string (`'Open'`, `'Matching'`, `'Donor Assigned'`, `'Donor En Route'`)
- `isEmergency`: boolean
- `bloodType` or `type`: string (e.g., 'O-')
- `hospital` & `hospitalCity`: string
- `requestedAt`, `notifiedAt`, `enRouteAt`, `matchedAt`: ISO Strings
- `matchingDonorsNotified`: array of User IDs
- `matchedDonor`: User ID of the accepting donor

### C. `inventory`
Hospital blood stock management.
- Document ID format: `[Hospital_Name]_[BloodType]`
- `bloodType`: string
- `hospital`: string
- `unitsAvailable`, `unitsReserved`, `minimumThreshold`: numbers
- `batches`: array of objects containing `expiresAt` and `units`
- `lastUpdated`: ISO String

### D. `activity_logs`
Global audit trails for admin monitoring.
- `title`, `description`: string
- `type`: string (`'success'`, `'warning'`, `'info'`, `'error'`)
- `timestamp`: ISO String

### E. Notifications (`donor_notifications` & `hospital_notifications`)
- `donorId` / `hospitalId`: User ID reference
- `title`, `message`: string
- `type`: string (`'info'`, `'error'`, `'success'`)
- `read`: boolean

---

## 4. Authentication Flow (`src/auth.js`)
- Uses `createUserWithEmailAndPassword` and `signInWithEmailAndPassword`.
- **Role Assignment:** Roles are assigned during signup. 
  - *Secret Mechanism:* Signing up with the secret code `ADMIN2024` or using an email containing `admin@vitalpulse` automatically grants the `admin` role.
- **Verification:** `sendEmailVerification` is sent asynchronously upon registration. A UI banner persists on the donor dashboard until the user clicks the verification link.
- **Session Management:** Auth state is cached in `localStorage` under the key `vitalpulse_user` to prevent loading flickers, while `onAuthStateChanged` listens for real-time token changes.

---

## 5. Core Engine & Logic (`src/db.js`)

### Smart Auto-Matching Logic
When a hospital creates an emergency request (`createEmergencyRequest`), the system immediately triggers `autoMatchDonors()`.
1. **Compatibility Check:** Uses explicit blood type mapping (e.g., `AB+` can receive from `A-`, `A+`, `B-`, `B+`, `AB-`, `AB+`, `O-`, `O+`).
2. **Filtering:** Queries the `users` collection for role `donor`, `isAvailable == true`, matching `city`, and compatible `bloodType`.
3. **Notification:** It writes to `donor_notifications` and invokes SMS/WhatsApp integrations (`sendSmsNotification`, `sendWhatsAppNotification`) informing donors of the emergency.

### Inventory Lifecycle
- Fetches inventory globally or per hospital (`fetchInventory`).
- Automatically calculates expiring units: Iterates through batch objects. If `daysLeft < 0`, marks as `expiredUnits`. If `daysLeft <= 30`, marks as `expiringSoon`.
- Fallbacks: If a hospital doesn't have an inventory document for a specific blood type, the system generates an `emptyInventoryType` object with 0 units.

---

## 6. Frontend Routing & Application State (`src/main.js`)
- **Protective Routing:** Validates routes on `DOMContentLoaded`. If a user attempts to access `/donor.html`, `/hospital.html`, or `/admin.html` without a `currentUser` object, they are immediately redirected to `/login.html`.
- **Hydration:** Based on `currentUser.role`, the system injects specific logic:
  - Initializes specialized dashboards (`loadDonorDashboard()`, `loadHospitalDashboard()`, `loadAdminDashboard()`).
  - Mounts specific interactive components (e.g., `initDonorDonationFlow()`).
- **Resilience / Fallback System:** `main.js` implements a 20-second safety timeout. If Firebase fails to load data (spinners are still active), `showFallbackError()` is triggered. It replaces spinners with a graceful "Could not load data" message and wires basic UI interactions (like opening donation modals) so the app remains partially functional offline or during network issues.

---

## 7. User Interfaces (Pages)
1. **`index.html` (Landing Page):** Features a complex hero section with CSS animations (`animate-pulse-slow`), blurred gradient backgrounds, trust badges, and primary Call-To-Action buttons leading to the login/signup flow.
2. **`signup.html` & `login.html`:** Form implementations with strict error handling (mapping Firebase error codes like `auth/weak-password` to user-friendly messages).
3. **Dashboards (`donor.html`, `hospital.html`, `admin.html`):** Role-specific Single Page Applications. The navigation between sub-views (e.g., from "Overview" to "History") is handled dynamically via DOM manipulation (`switchDonorView()`) rather than actual page reloads.

---

## 8. Development & Build Commands
- **Install dependencies:** `npm install`
- **Run Development Server:** `npm run dev`
- **Build for Production:** `npm run build`
- **Preview Production Build:** `npm run preview`
