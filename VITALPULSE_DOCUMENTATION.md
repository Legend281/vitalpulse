# VitalPulse: Comprehensive System Documentation

## 1. Executive Summary
**VitalPulse** is a mission-critical, real-time blood donation coordination system engineered specifically for the healthcare infrastructure of Cameroon. The system aims to bridge the critical gap between hospitals facing acute blood shortages and eligible, willing donors in the community. By digitizing blood inventory management and automating emergency donor matching, VitalPulse drastically reduces the time required to source life-saving blood.

## 2. System Architecture & Technology Stack
The application is architected as a lightweight, highly responsive Single Page Application (SPA) to ensure reliability even in areas with inconsistent internet connectivity. 

### 2.1 Repository Structure
The project root is split into two primary components:
- **`stitch_lifestream_cameroon_coordination_system/`**: The design system repository containing the Product Requirements Document (PRD) and high-fidelity HTML/CSS prototypes (e.g., modals, dashboards, login/signup flows).
- **`vitalpulse_app/`**: The live codebase powering the actual web application.

### 2.2 Tech Stack
- **Frontend Core:** HTML5, CSS3, Vanilla JavaScript (ESM Modules).
- **Bundler & Build Tool:** Vite (`vite.config.js`), configured for aggressive minification.
- **Styling:** Tailwind CSS v4 (`tailwind.config.js`). It utilizes a heavily customized healthcare theme token set (primary red `#af101a`, tertiary `#005f7b`) and plugins like `@tailwindcss/forms` and `@tailwindcss/container-queries`.
- **Data Visualization:** Chart.js (v4.5.1) for rendering analytics on dashboards.
- **Backend & Infrastructure:** Firebase Firestore (NoSQL) & Firebase Authentication v12.

---

## 3. Deep-Dive: Core Modules & User Interfaces

This section breaks down what each module contains, how it functions, and the specific views available to the user.

### 3.1. Authentication, Onboarding, & Session Management
**What it is:** The gateway to the application ensuring secure, role-specific access.
**How it functions:** 
- **Role-Based Access Control (RBAC):** Users are assigned one of three roles upon registration: `donor`, `hospital`, or `admin`.
- **Admin Secret Mechanism:** During signup, inputting the secret code `ADMIN2024` or using an email containing `admin@vitalpulse` automatically grants top-level `admin` rights.
- **Session Management:** Auth state is aggressively cached in `localStorage` under the key `vitalpulse_user` to prevent UI loading flickers, while `onAuthStateChanged` listens for real-time token changes in the background.
- **Protective Routing (`main.js`):** The frontend utilizes client-side guards on `DOMContentLoaded`. Unauthorized access to role-specific dashboards automatically redirects users to `login.html`.
- **Dynamic View Switching:** Navigation within dashboards (e.g., moving from "Overview" to "Inventory") is handled dynamically via DOM manipulation rather than actual page reloads, making the app feel instantaneous.

### 3.2. Donor Module (`donor.html`)
**What it is:** A personalized portal for blood donors to manage their readiness, track their impact, and respond to emergencies.
**Views & Features:**
- **Dashboard Overview:** Displays a welcoming hero section with a "Schedule Donation" action.
- **Availability Toggle:** A prominent, interactive toggle allows donors to instantly change their status (`isAvailable`). When toggled off, the matching engine ignores them, respecting their privacy and recovery time.
- **Impact Metrics (Pulse Points):** The dashboard gamifies and visualizes the donor's impact by displaying their exact Blood Type, Total Donations, "Lives Saved" count, and a Tier Progress tracker.
- **Eligibility Countdown:** A dynamic tracker that calculates when the donor is next eligible to donate based on their last donation date.
- **Emergency Alert Banner:** A highly visible, red alert box (`#emergencyAlert`) that reveals itself when a critical, geo-matched emergency occurs near the donor.
- **Real-Time Notification Center:** A dropdown menu tracks all incoming alerts and match requests (integrated with off-platform SMS/WhatsApp hooks).

### 3.3. Hospital Module (`hospital.html`)
**What it is:** The operational command center for medical facilities to manage blood stock and broadcast urgent needs.
**Views & Features:**
- **Dashboard / Overview:** Provides a high-level summary of system health: Active Requests, Low Stock Items, Incoming Donors, and Recent Activity.
- **Blood Inventory (`nav-inventory`):** Hospitals can log their current blood stock across all blood types.
  - *Expiration Tracking Engine:* The system automatically calculates the `expiresAt` timestamp for every batch. Units expiring within 30 days are flagged as `expiringSoon`, while units past their date are marked as `expiredUnits`. This prevents life-saving blood from going to waste.
- **My Requests (`nav-requests`):** A history log of all past and current emergency requests dispatched by the hospital.
- **Incoming Donors (`nav-donors`):** Tracks donors who have accepted an emergency request and are currently marked as "En Route".
- **Urgent Request Dispatcher:** A prominent button (`#btnUrgentRequest`) that opens a modal. The doctor specifies the required blood type, urgency level, and patient location. Submitting this form instantly triggers the Smart Auto-Matching algorithm in the background.
- **Campaigns & Settings:** Modules to manage hospital-specific blood drives and update licensing/contact details.

### 3.4. Administrator Module (`admin.html`)
**What it is:** The global oversight, analytics, and governance portal meant for health ministry officials or platform owners.
**Views & Features:**
- **System Overview (`nav-overview`):** A macroscopic view of the entire nation's blood network. It displays Real-Time System Health metrics like total active requests across all hospitals.
- **Hospital Verification (`nav-verifications`):** For security, hospitals cannot join the network automatically. Admins use this view to review submitted hospital licenses and manually approve or reject network access.
- **User Management (`nav-users`):** Allows admins to search, suspend, or manage donor and hospital accounts.
- **Global Audit Trail (Request Logs & Donations):** Activity logs (`activity_logs` collection) record every critical action (logins, requests, inventory updates, successful donations) across the entire platform, ensuring total accountability.
- **Analytics & Blood Inventory (`nav-analytics`, `nav-inventory`):** Global charts and tables that aggregate blood stock levels from every hospital, allowing the government to see national shortages before they become critical.

---

## 4. The Core Engine: Smart Auto-Matching Logic (`src/db.js`)
The crown jewel of VitalPulse is its automated donor matching algorithm. When a hospital triggers an Emergency Request, here is exactly how the system functions:
1. **Compatibility Resolution:** The algorithm maps the requested blood type against medical compatibility charts (e.g., An `AB+` request matches with `A-`, `A+`, `B-`, `B+`, `AB-`, `AB+`, `O-`, `O+` donors).
2. **Geo-Filtering & Availability:** It queries the `users` collection for donors who:
   - Reside in the exact `city` as the requesting hospital.
   - Have their `isAvailable` flag set to `true`.
   - Have a compatible `bloodType`.
3. **Dispatch:** The system creates entries in the `donor_notifications` collection and triggers external hooks (`sendSmsNotification`, `sendWhatsAppNotification`) to alert the matched donors instantaneously.
4. **Donor Acceptance:** If a donor accepts the request on their dashboard, the request status shifts to `Donor En Route`, and the hospital is notified immediately.

## 5. Database Schema (Firestore)
VitalPulse utilizes a heavily denormalized NoSQL structure for rapid read operations.

### `users` Collection
- `uid` (String, Primary Key)
- `email` (String)
- `role` (String: `'donor'`, `'hospital'`, `'admin'`)
- `name`, `city` (Strings)
- `isVerified`, `emailVerified` (Booleans)
- **Donor Specific:** `bloodType`, `isAvailable`, `isSuspended`, `donations` (Array)
- **Hospital Specific:** `phone`, `licenseUrl` (Storage download URL of the license document uploaded at signup), `licenseFileName`, `rejected`

### `requests` Collection
- `status` (String: `'Open'`, `'Matching'`, `'Donor Assigned'`, `'Donor En Route'`)
- `isEmergency` (Boolean)
- `bloodType`, `hospital`, `hospitalCity` (Strings)
- `requestedAt`, `notifiedAt`, `enRouteAt`, `matchedAt` (ISO Timestamps)
- `matchingDonorsNotified` (Array of UIDs)
- `matchedDonor` (UID)

### `inventory` Collection
- Document ID Format: `[Hospital_Name]_[BloodType]`
- `bloodType`, `hospital` (Strings)
- `unitsAvailable`, `unitsReserved`, `minimumThreshold` (Numbers)
- `batches` (Array of Objects: `{ expiresAt: ISOString, units: Integer }`)
- `lastUpdated` (ISO Timestamp)

### `activity_logs` Collection
- `title`, `description` (Strings)
- `type` (String: `'success'`, `'warning'`, `'info'`, `'error'`)
- `timestamp` (ISO Timestamp)

### `donor_notifications` & `hospital_notifications` Collections
- `donorId` / `hospitalId` (UID Reference)
- `title`, `message` (Strings)
- `type` (String: `'info'`, `'error'`, `'success'`)
- `read` (Boolean)

## 6. Resilience & Offline Handling
To combat network instability in developing regions, the application implements a graceful degradation system.
- **Safety Timeouts (`main.js`):** A 20-second timeout monitors Firebase data fetches. 
- **Fallback UI:** If the network drops during a data fetch, the UI replaces loading spinners with a graceful "Could not load data" message via `showFallbackError()`. It also wires basic UI interactions (like opening donation modals) so the app remains partially functional offline or during network issues.

## 7. Development & Deployment Guide
To run VitalPulse locally:
1. Ensure Node.js is installed.
2. Navigate to the `vitalpulse_app` directory.
3. Run `npm install` to resolve dependencies.
4. Run `npm run dev` to start the Vite development server.
5. For production builds, utilize `npm run build` to generate the optimized `dist/` folder.
6. Preview the build with `npm run preview`.
