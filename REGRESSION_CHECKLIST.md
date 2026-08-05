# REGRESSION CHECKLIST — Role Refactor

> **Purpose:** Every existing feature that must still work after the role refactor.
> **Usage:** Re-run after EVERY phase, not just at the end.
> **Last full pass:** (not yet run)

---

## Legend
- `[ ]` Not tested
- `[P]` Passed
- `[F]` **FAILED** — stop immediately, do not continue to next phase

---

## 1. Authentication & Login
- [ ] Hospital account can log in and reach hospital dashboard
- [ ] Donor account can log in and reach donor dashboard
- [ ] Admin account can log in and reach admin dashboard
- [ ] Logout clears session and redirects to login

## 2. Dashboard (Hospital)
- [ ] Dashboard loads with correct stats (active requests, low stock, incoming donors, total stock)
- [ ] Request trends chart renders
- [ ] Activity log loads and displays recent events
- [ ] "Place Emergency Request" quick action opens modal
- [ ] "Go to Inventory" quick action navigates to inventory view
- [ ] Compatibility chart button works

## 3. Emergency / Urgent Requests
- [ ] Urgent Request button (sidebar) opens emergency request modal
- [ ] Emergency request can be submitted with blood type, units, urgency
- [ ] Emergency request broadcasts to compatible donors
- [ ] Emergency request appears in My Requests list

## 4. My Requests
- [ ] Requests list loads with correct data
- [ ] Request timeline modal opens
- [ ] Request statuses display correctly (Open, Matching, Donor Assigned, Donor En Route, Resolved)
- [ ] Request can be cancelled by hospital

## 5. Chronic Patient Registry
- [ ] Chronic patients can be added
- [ ] Chronic patient list loads
- [ ] Chronic patients can be deleted

## 6. Incoming Donors
- [ ] Donor check-in via pass code (token lookup) works
- [ ] Scheduled booking confirm/decline works
- [ ] Donor reaction reporting works
- [ ] Donation intake modal opens and records blood collection
- [ ] Donor engagement modal opens

## 7. Inventory
- [ ] Inventory page loads with blood type cards
- [ ] Stock numbers display correctly (available, pending test, expired)
- [ ] **Add** button opens add stock modal and adds stock
- [ ] **Issue** button opens issue blood modal
- [ ] Issue blood requires crossmatch confirmation (hard block if unchecked)
- [ ] Issue blood requires requesting physician name (hard block if empty)
- [ ] **Remove** button opens remove stock modal and deducts stock
- [ ] **Thresh** button opens threshold editor and saves
- [ ] Expiry badges (red alert, amber warning) display correctly
- [ ] Inter-hospital transfer request works

## 8. Lab & Testing
- [ ] Lab pipeline loads with pending batches
- [ ] TTI screening entry works (set results for each marker)
- [ ] Crossmatch confirmation works
- [ ] Lab test resolution (clear / reject) works
- [ ] Lab certificate can be viewed/printed

## 9. Campaigns
- [ ] Campaign list loads
- [ ] Campaign can be created
- [ ] Campaign can be edited
- [ ] Campaign can be deleted

## 10. Settings
- [ ] Settings page loads with current hospital profile
- [ ] Hospital contact info can be updated and saved
- [ ] Notification preferences (SMS/WhatsApp toggles) work
- [ ] Notification history loads
- [ ] Send test notification works

## 11. Staff Roster
- [ ] Staff roster page loads (shows staff members or empty state)
- [ ] Add Staff Account modal opens with role checkboxes and PIN input
- [ ] Staff account creation works
- [ ] Staff quick-switcher (header badge) opens modal
- [ ] PIN verification works (correct PIN switches session)
- [ ] PIN lockout after 5 failed attempts works

## 12. Hemovigilance
- [ ] Hemovigilance view loads
- [ ] Hemovigilance report can be submitted
- [ ] Reports list displays

## 13. Forecasting
- [ ] Forecasting view loads
- [ ] Demand forecast can be generated

## 14. Myth-Busting
- [ ] Myth-busting view loads
- [ ] Article can be created and published

## 15. Certificates
- [ ] Certificates view loads
- [ ] Life Saver certificate can be issued
- [ ] Certificate can be printed

## 16. Notifications
- [ ] Hospital notification bell shows unread count
- [ ] Notifications panel opens and lists notifications
- [ ] Mark individual notification as read
- [ ] Mark all notifications as read

## 17. Search
- [ ] Hospital search bar returns results for requests, donors, inventory

## 18. Mobile Responsiveness
- [ ] Hamburger menu opens mobile drawer
- [ ] Mobile drawer navigation works
- [ ] Mobile drawer closes on overlay tap

## 19. Offline Banner
- [ ] Offline banner appears when disconnected
- [ ] Banner dismisses when reconnected

## 20. Activity Log
- [ ] Activity log loads on dashboard
- [ ] "View Full Log" link works
- [ ] "Clear All Logs" works
