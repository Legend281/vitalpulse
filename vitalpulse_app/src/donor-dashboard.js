import { getCurrentUser, sendPasswordReset, hashNationalId } from './auth';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import {
  fetchMatchedRequestsForDonor,
  fetchPublicRequestsForDonor,
  acceptPublicRequest,
  fetchActiveRequests,
  fetchAllCampaigns,
  donorJoinCampaign,
  donorLeaveCampaign,
  fetchDonorCampaignInterest,
  fetchAllDonors,
  fetchAllHospitals,
  fetchDonationRequestsForDonor,
  submitDonationRequest,
  computeDonorEngagement,
  updateUserProfile,
  acceptRequest as acceptRequestDb,
  donorSetEnRoute as donorSetEnRouteDb,
  donorCancelAssignedRequest as donorCancelAssignedRequestDb,
  checkInDonor as checkInDonorDb,
  getCompatibleBloodTypes,
  getBloodTypeDisplayInfo,
  logActivity,
  fetchDonorNotifications,
  fetchUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  CITY_COORDINATES,
  fetchCareReminders,
  dismissCareReminder,
  fetchMythArticles,
  likeMythArticle,
  fetchLifeSaverCertificates,
  updateDonorLiveLocation,
  getCoordinatesForLocation,
  calculateDistanceKm,
  subscribeToDonorJourneys,
} from './db';
import { captureUserLocation } from './location';
import L from 'leaflet';

// XSS-safety helper for interpolating user-controlled strings (hospital names, cities, etc.)
// into innerHTML template strings.
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let donorNavigationInitialized = false;
let _allRequests = [];
let _selectedCity = null;
let _feedExpanded = false; // dashboard requests feed: false = show first 5, true = show all
// Cached eligibility (56-day rule), refreshed on every dashboard load. Used to gate the
// schedule/accept actions instantly without an extra Firestore read on each click. The
// hospital check-in + server-side guard are the authoritative backstops.
let _donorEligibilityCache = null;
window._filterCity = (city) => {
  _selectedCity = city;
  const user = getCurrentUser();
  if (!user) return;
  // Re-filter in place from data already fetched — no need to reload the whole dashboard
  // (refetch engagement, requests, hospitals) just to switch which city is highlighted.
  _centersVisibleCount = 5;
  _feedExpanded = false; // a different city is a different list — collapse back to the first 5
  renderCityChips(user);
  renderFilteredFeed();
  renderCentersList();
  const donorCoords = getCoordinatesForLocation(user.city, user.lat, user.lng);
  renderNearbyMap(donorCoords);
};

// Inline onclick handlers — always available even if init code fails
window.getCurrentUser = getCurrentUser;
window.markAllNotificationsRead = markAllNotificationsRead;
window.markNotificationRead = markNotificationRead;
// Open the donation wizard already pointed at a specific hospital — used by the dashboard's
// "Nearby Donation Centers" cards so browsing → choosing → donating is one continuous flow.
window.openDonationModalForHospital = (hospitalName) => {
  _preselectedCenter = hospitalName || null;
  window.openDonationModal();
};

window.openDonationModal = async () => {
  const modal = document.getElementById('donationModal');
  if (!modal) return;
  // Gate: don't even open the scheduling wizard if the donor isn't eligible yet.
  if (!await warnIfIneligible()) { _preselectedCenter = null; return; }
  // Carry a pre-selected hospital through if one was chosen from a donation-center card; the
  // donor still does the health screening first, but step 2 arrives already answered.
  _selectedCenter = _preselectedCenter || null;
  _preselectedCenter = null;
  _centerPickerCount = 8;
  _donationStep = 1;
  _screeningAnswers = {};
  _donationHospitals = null;
  renderScreeningQuestions();
  loadDonationHospitals();
  const hospitalSearch = document.getElementById('donationHospitalSearch');
  if (hospitalSearch) hospitalSearch.value = '';
  showDonationStep(1);
  const dateInput = document.getElementById('donationDate');
  if (dateInput) {
    dateInput.value = '';
    dateInput.min = new Date().toISOString().split('T')[0];
  }
  const notesInput = document.getElementById('donationNotes');
  if (notesInput) notesInput.value = '';
  modal.classList.remove('hidden');
  modal.classList.add('flex');
};
window.closeDonationModal = () => {
  const modal = document.getElementById('donationModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
};

export function switchDonorView(view) {
  window.scrollTo(0, 0);
  // Leaving the Requests view? Drop its real-time listener so it doesn't keep running (and
  // billing reads) in the background. loadDonorRequests re-subscribes when they return.
  if (view !== 'requests') teardownDonorJourneys();
  const views = ['dashboard', 'requests', 'badges', 'profile', 'care-reminders', 'mythhub', 'certificates'];
  views.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) { el.classList.add('hidden'); el.classList.remove('block'); }
  });
  const active = document.getElementById('view-' + view);
  if (active) { active.classList.remove('hidden'); active.classList.add('block'); }

  document.querySelectorAll('.donor-mobile-nav').forEach(btn => {
    btn.classList.remove('text-primary');
    btn.classList.add('text-on-surface-variant');
    const icon = btn.querySelector('.material-symbols-outlined');
    if (icon) icon.style.fontVariationSettings = "'FILL' 0";
  });
  // querySelectorAll, not querySelector — the desktop header tabs and the mobile bottom nav
  // both use .donor-mobile-nav with the same data-view values, so both need highlighting,
  // not just whichever happens to come first in the DOM.
  document.querySelectorAll(`.donor-mobile-nav[data-view="${view}"]`).forEach(activeNav => {
    activeNav.classList.remove('text-on-surface-variant');
    activeNav.classList.add('text-primary');
    const icon = activeNav.querySelector('.material-symbols-outlined');
    if (icon) icon.style.fontVariationSettings = "'FILL' 1";
  });

  switch (view) {
    case 'dashboard': loadDonorDashboard(); break;
    case 'requests': loadDonorRequests(); break;
    case 'badges': loadDonorBadges(); break;
    case 'profile': loadDonorProfile(); break;
    case 'care-reminders': loadCareRemindersView(); break;
    case 'mythhub': loadMythHubView(); break;
    case 'certificates': loadCertificatesView(); break;
  }
}

export function initDonorNavigation() {
  if (donorNavigationInitialized) return;

  document.querySelectorAll('.donor-mobile-nav').forEach(btn => {
    btn.addEventListener('click', () => switchDonorView(btn.dataset.view));
  });

  // "Centers" isn't a separate view — it's a section within the dashboard — so this jumps
  // there instead, switching to the dashboard first if the donor is somewhere else. Both the
  // header tab and the "Find Donation Center" quick action trigger the same jump.
  const jumpToCenters = () => {
    const jump = () => document.getElementById('donationCentersSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (document.getElementById('view-dashboard')?.classList.contains('hidden')) {
      switchDonorView('dashboard');
      setTimeout(jump, 150);
    } else {
      jump();
    }
  };
  document.getElementById('btnNavCenters')?.addEventListener('click', jumpToCenters);
  document.getElementById('btnQuickFindCenters')?.addEventListener('click', jumpToCenters);

  // ---- Mobile nav drawer (hamburger) — the mobile navigation hub, replacing the old fixed
  // bottom bar. Slides in from the left; closes on backdrop, close button, or picking a link. ----
  const drawer = document.getElementById('mobileNavDrawer');
  const drawerPanel = document.getElementById('mobileNavPanel');
  const drawerBackdrop = document.getElementById('mobileNavBackdrop');
  const openDrawer = () => {
    if (!drawer) return;
    drawer.classList.remove('hidden');
    requestAnimationFrame(() => {
      drawerPanel?.classList.remove('-translate-x-full');
      drawerBackdrop?.classList.remove('opacity-0');
    });
    document.body.style.overflow = 'hidden'; // lock background scroll while open
  };
  const closeMobileDrawer = () => {
    if (!drawer || drawer.classList.contains('hidden')) return;
    drawerPanel?.classList.add('-translate-x-full');
    drawerBackdrop?.classList.add('opacity-0');
    document.body.style.overflow = '';
    setTimeout(() => drawer.classList.add('hidden'), 300); // wait out the slide-out transition
  };
  document.getElementById('btnMobileMenu')?.addEventListener('click', openDrawer);
  document.getElementById('btnMobileMenuClose')?.addEventListener('click', closeMobileDrawer);
  drawerBackdrop?.addEventListener('click', closeMobileDrawer);
  document.getElementById('btnNavCentersMobile')?.addEventListener('click', () => { closeMobileDrawer(); jumpToCenters(); });
  // Close the drawer after any destination/action is chosen — except the theme toggle, so the
  // donor can see the theme flip before the drawer slides away.
  drawerPanel?.querySelectorAll('.donor-mobile-nav, [data-action="switch-view"], .logout-btn, [onclick]').forEach(btn => {
    if (btn.hasAttribute('data-theme-toggle')) return;
    btn.addEventListener('click', () => closeMobileDrawer());
  });
  // Populate the drawer's account header.
  const drawerUser = getCurrentUser();
  const drawerInitials = (drawerUser?.name || drawerUser?.email || 'D').trim().split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase();
  const dInit = document.getElementById('donorDrawerInitials'); if (dInit) dInit.textContent = drawerInitials || 'D';
  const dName = document.getElementById('donorDrawerName'); if (dName) dName.textContent = drawerUser?.name || drawerUser?.email?.split('@')[0] || 'Donor';
  const dEmail = document.getElementById('donorDrawerEmail'); if (dEmail) dEmail.textContent = drawerUser?.email || '';

  document.querySelectorAll('[data-open-donation-history]').forEach(el => {
    el.addEventListener('click', () => {
      const modal = document.getElementById('myDonationsModal');
      if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
      loadDonorDonations();
    });
  });
  document.getElementById('btnDonorProfile')?.addEventListener('click', () => switchDonorView('profile'));

  // Account dropdown — replaces the old chevron-that-was-secretly-a-logout-button.
  const menuBtn = document.getElementById('btnDonorAccountMenu');
  const menuPanel = document.getElementById('donorAccountMenu');
  const menuChevron = document.getElementById('donorAccountMenuChevron');
  const closeAccountMenu = () => {
    menuPanel?.classList.add('hidden');
    if (menuChevron) menuChevron.style.transform = '';
  };
  if (menuBtn && menuPanel) {
    const cu = getCurrentUser();
    const nameEl = document.getElementById('donorMenuName');
    const emailEl = document.getElementById('donorMenuEmail');
    if (nameEl) nameEl.textContent = cu?.name || cu?.email?.split('@')[0] || 'Donor';
    if (emailEl) emailEl.textContent = cu?.email || '';

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !menuPanel.classList.contains('hidden');
      if (isOpen) { closeAccountMenu(); return; }
      menuPanel.classList.remove('hidden');
      if (menuChevron) menuChevron.style.transform = 'rotate(180deg)';
    });
    menuPanel.addEventListener('click', closeAccountMenu);
    document.addEventListener('click', (e) => {
      if (!menuPanel.classList.contains('hidden') && !menuPanel.contains(e.target) && e.target !== menuBtn) closeAccountMenu();
    });
  }

  document.querySelectorAll('[data-action="switch-view"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;
      if (target) switchDonorView(target);
    });
  });

  // Notification bell: show notification panel
  const notifBtn = document.getElementById('btnDonorNotifications');
  if (notifBtn) {
    notifBtn.addEventListener('click', async () => {
      const currentUser = getCurrentUser();
      if (!currentUser) return;
      try {
        const notifications = await fetchDonorNotifications(currentUser.uid, 10);
        const unreadCount = await fetchUnreadNotificationCount(currentUser.uid);
        const badge = document.getElementById('donorNotifBadge');
        if (badge) {
          if (unreadCount > 0) {
            badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
            badge.classList.remove('hidden');
            badge.classList.add('flex');
          } else {
            badge.classList.add('hidden');
            badge.classList.remove('flex');
          }
        }
        if (notifications.length === 0) {
          showToast('No notifications yet. When blood requests match your type, you will be notified here.');
        } else {
          const panel = document.createElement('div');
          panel.id = 'donorNotifPanel';
          panel.className = 'fixed inset-0 z-50 flex items-end sm:items-start sm:justify-end sm:pt-16 sm:pr-4';
          panel.innerHTML = `
            <div class="absolute inset-0 bg-black/30" onclick="document.getElementById('donorNotifPanel')?.remove()"></div>
            <div class="relative bg-surface-container-lowest border border-outline-variant/20 w-full sm:w-96 max-h-[70vh] rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col">
              <div class="flex items-center justify-between px-5 py-4 border-b border-outline-variant/15 shrink-0">
                <h3 class="font-black text-on-surface flex items-center gap-2">
                  <span class="material-symbols-outlined text-primary">notifications</span>
                  Notifications
                </h3>
                <div class="flex items-center gap-2">
                  ${unreadCount > 0 ? `<button onclick="(async () => { const currentUser = getCurrentUser(); if(currentUser){await markAllNotificationsRead(currentUser.uid); document.getElementById('donorNotifPanel')?.remove(); const badge = document.getElementById('donorNotifBadge'); if(badge){badge.classList.add('hidden'); badge.classList.remove('flex');}} })()" class="text-[10px] font-bold text-primary hover:underline">Mark all read</button>` : ''}
                  <button onclick="document.getElementById('donorNotifPanel')?.remove()" class="w-7 h-7 rounded-full bg-surface-container-low flex items-center justify-center hover:bg-surface-container text-on-surface-variant transition-colors">
                    <span class="material-symbols-outlined text-sm">close</span>
                  </button>
                </div>
              </div>
              <div class="overflow-y-auto flex-1 p-3 space-y-1">
                ${notifications.map(n => {
                  const icons = { 'error': 'emergency', 'success': 'check_circle', 'info': 'info', 'warning': 'warning' };
                  const colors = { 'error': 'text-error', 'success': 'text-success', 'info': 'text-tertiary', 'warning': 'text-warning' };
                  const c = colors[n.type] || colors.info;
                  const icon = icons[n.type] || icons.info;
                  return `
                    <div class="flex items-start gap-3 p-3 rounded-xl ${n.read ? 'opacity-60' : 'bg-surface-container-low'} hover:bg-surface-container-low transition-colors cursor-pointer" onclick="${!n.read ? `(async () => { await markNotificationRead('${n.id}'); this.classList.remove('bg-surface-container-low'); this.classList.add('opacity-60'); })()` : ''}">
                      <span class="material-symbols-outlined text-sm mt-0.5 ${c}">${icon}</span>
                      <div class="min-w-0 flex-1">
                        <p class="text-xs font-bold text-on-surface">${esc(n.title)}</p>
                        <p class="text-[11px] text-on-surface-variant mt-0.5 line-clamp-2">${esc(n.message)}</p>
                        <p class="text-[9px] text-on-surface-variant/70 mt-1">${new Date(n.createdAt).toLocaleString()}</p>
                      </div>
                      ${!n.read ? '<span class="w-2 h-2 rounded-full bg-primary shrink-0 mt-1"></span>' : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `;
          document.body.appendChild(panel);
        }
      } catch (e) {
        showToast('No new notifications');
      }
    });
  }

  // Start notification polling (every 30 seconds)
  const pollNotifCount = async () => {
    const cu = getCurrentUser();
    if (!cu) return;
    try {
      const unreadCount = await fetchUnreadNotificationCount(cu.uid);
      const badge = document.getElementById('donorNotifBadge');
      if (badge) {
        if (unreadCount > 0) {
          badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
          badge.classList.remove('hidden');
          badge.classList.add('flex');
        } else {
          badge.classList.add('hidden');
          badge.classList.remove('flex');
        }
      }
    } catch (e) { /* silent */ }
  };
  pollNotifCount();
  setInterval(pollNotifCount, 30000);

  donorNavigationInitialized = true;
}

function getTimeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getEligibilityInfo(lastDonationDate) {
  if (!lastDonationDate) return { eligible: true, daysUntil: 0, label: 'Eligible', color: 'text-success', barPct: 100 };
  const last = new Date(lastDonationDate);
  const next = new Date(last);
  next.setDate(next.getDate() + 56);
  const now = new Date();
  if (now >= next) return { eligible: true, daysUntil: 0, label: 'Eligible', color: 'text-success', barPct: 100 };
  const diffMs = next - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const totalDays = 56;
  const elapsed = totalDays - diffDays;
  const pct = Math.min(100, Math.round((elapsed / totalDays) * 100));
  return { eligible: false, daysUntil: diffDays, label: `${diffDays} days`, color: 'text-warning', barPct: pct };
}

// --- Eligibility gate (56-day rule) ---------------------------------------------------------
// Blocks scheduling/accepting a donation when the donor donated too recently. Uses the cached
// eligibility (default: allow, so a not-yet-loaded dashboard or a transient read failure never
// wrongly blocks a legitimate donor — the hospital check-in + server guard are the backstops).
function isDonorEligibleNow() {
  return !_donorEligibilityCache || _donorEligibilityCache.eligible !== false;
}
async function warnIfIneligible() {
  if (isDonorEligibleNow()) return true;
  const d = _donorEligibilityCache?.daysUntil || 0;
  await window.vpAlert({
    type: 'warning',
    title: 'Not eligible to donate yet',
    message: `For your safety, donors must wait 56 days between whole-blood donations. You can donate again in ${d} day${d === 1 ? '' : 's'}.`,
    confirmText: 'Got it',
  });
  return false;
}

function renderFilteredFeed() {
  const feedEl = document.getElementById('requestsFeed');
  if (!feedEl) return;
  const currentUser = getCurrentUser();

  // Donors who signed up without knowing their blood type can never be matched to a
  // specific-type request (there's no medically safe way to guess), so tell them why
  // the feed is empty instead of showing a generic "no requests" message forever.
  if (!currentUser?.bloodType || currentUser.bloodType === 'Unknown') {
    feedEl.innerHTML = `<div class="flex flex-col items-center text-center py-10 text-on-surface-variant bg-surface-container-lowest border border-outline-variant/20 rounded-2xl shadow-sm px-6">
      <div class="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-3">
        <span class="material-symbols-outlined text-2xl">bloodtype</span>
      </div>
      <p class="font-bold text-on-surface text-sm">Add your blood type to see matching requests</p>
      <p class="text-xs mt-1.5 max-w-xs">We can't match you to blood requests until we know your blood type.</p>
      <button data-action="switch-view" data-view="profile" class="press-scale mt-3.5 inline-flex items-center gap-1 px-4 py-2 rounded-xl bg-primary text-on-primary font-bold text-xs shadow-sm shadow-primary/20 hover:opacity-90 transition-opacity cursor-pointer">Update profile <span class="material-symbols-outlined text-xs">arrow_forward</span></button>
    </div>`;
    feedEl.querySelector('[data-action="switch-view"]')?.addEventListener('click', () => switchDonorView('profile'));
    return;
  }

  const isBusy = currentUser.isAvailable === false;

  const filtered = _selectedCity
    ? _allRequests.filter(r => (r.city === _selectedCity || r.preferredLocation === _selectedCity))
    : _allRequests;
  if (filtered.length === 0) {
    feedEl.innerHTML = `<div class="flex flex-col items-center text-center py-10 text-on-surface-variant bg-surface-container-lowest border border-outline-variant/20 rounded-2xl shadow-sm px-6">
      <div class="w-14 h-14 rounded-full ${_selectedCity ? 'bg-warning-container/40 text-warning' : 'bg-success-container/40 text-success'} flex items-center justify-center mb-3">
        <span class="material-symbols-outlined text-2xl">${_selectedCity ? 'search_off' : 'check_circle'}</span>
      </div>
      <p class="font-bold text-on-surface">${_selectedCity ? 'No requests in ' + _selectedCity : 'All caught up!'}</p>
      <p class="text-sm mt-1 max-w-xs">${_selectedCity ? 'There are currently no blood requests for this city. Try a different location.' : 'There are no nearby blood requests right now. Check back soon or browse donation centers to schedule a donation.'}</p>
    </div>`;
    return;
  }
  // Show the first 5 by default; "View all" reveals the rest in place. This keeps the
  // dashboard short when a donor wakes to a big feed (e.g. 30 requests) but still lets them
  // browse every one without leaving the page. The underlying list is capped at 50 upstream.
  const INITIAL_FEED = 5;
  const shownRequests = _feedExpanded ? filtered : filtered.slice(0, INITIAL_FEED);
  // Accepting is blocked while Busy OR while inside the 56-day deferral window.
  const ineligible = !isDonorEligibleNow();
  const acceptBlocked = isBusy || ineligible;
  const deferralPct = _donorEligibilityCache?.barPct || 0;
  const deferralDays = _donorEligibilityCache?.daysUntil || 0;
  const blockBanner = isBusy
    ? `<div class="flex items-center gap-2.5 bg-warning-container/50 border border-warning/30 text-on-warning-container text-xs font-semibold px-4 py-3 rounded-xl shadow-sm">
         <span class="material-symbols-outlined text-base shrink-0">info</span>
         <span>You're marked <strong>Busy</strong> — accepting requests is paused. <button data-action="switch-view" data-view="dashboard" class="underline font-bold hover:no-underline cursor-pointer">Toggle availability →</button></span>
       </div>`
    : ineligible
    ? `<div class="bg-surface-container-lowest border border-outline-variant/20 rounded-2xl shadow-sm overflow-hidden">
         <div class="flex items-start gap-3 p-4 pb-3">
           <div class="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
             <span class="material-symbols-outlined text-lg">schedule</span>
           </div>
           <div class="min-w-0 flex-1">
             <p class="font-bold text-sm text-on-surface">56-day deferral active</p>
             <p class="text-xs text-on-surface-variant mt-0.5">You can donate again in <strong>${deferralDays} day${deferralDays === 1 ? '' : 's'}</strong>. Accepting is disabled until then.</p>
           </div>
         </div>
         <div class="h-1.5 bg-surface-container-high mx-4 mb-4 rounded-full overflow-hidden">
           <div class="h-full bg-primary/20 rounded-full" style="width:${deferralPct}%"></div>
         </div>
       </div>`
    : '';
  feedEl.innerHTML = blockBanner + shownRequests.map(req => {
    const isCritical = req.urgency === 'critical' || req.urgency === 'Critical';
    const isPublic = Boolean(req.isPublicRequest);
    const isCentralCommand = (req.hospital === 'Central Command' || req.hospitalName === 'Central Command' || req.systemWide === true);
    const publicBadge = isPublic ? `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-800 border border-amber-200">Public Emergency</span>` : '';
    // Trust label for no-login public requests — never blocks the request, just tells the
    // donor how much soft evidence backs it (see submitPublicRequest's verificationLevel).
    const verificationStyle = {
      'Hospital-Confirmed': 'bg-emerald-100 text-emerald-800',
      'Document Attached': 'bg-blue-100 text-blue-800',
      'Unverified': 'bg-slate-100 text-slate-600',
    };
    const docBadge = isPublic && req.verificationLevel
      ? `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold ${verificationStyle[req.verificationLevel] || 'bg-slate-100 text-slate-600'}">${req.verificationLevel}</span>`
      : '';

    // Details the hospital entered for donors — previously hidden. Shown so the donor can
    // decide with real context (how much is needed, which component, how urgent, where to go)
    // instead of just a hospital name. Patient/clinical fields were stripped server-side.
    const bt = req.bloodType || req.type || '?';
    const btDisplay = bt.replace('+', '+').replace('-', '−');
    const units = req.units || 1;
    const component = req.componentType || 'Whole Blood';
    const componentShort = component === 'PRBC' ? 'PRBC' : component === 'Plasma' ? 'Plasma' : component === 'Platelets' ? 'PLT' : '';
    const notes = (req.notes || '').trim();
    const pickup = (req.pickupLocation || '').trim();
    const urgency = (req.urgency || '').toLowerCase();
    const urgencyBadge = urgency === 'critical'
      ? '<span class="px-1.5 py-1 rounded text-[9px] font-black uppercase tracking-wider bg-error text-on-error shadow-sm">Critical</span>'
      : urgency === 'urgent'
      ? '<span class="px-1.5 py-1 rounded text-[9px] font-black uppercase tracking-wider bg-warning-container text-on-warning-container border border-warning/30">Urgent</span>'
      : '';
    const distanceStr = req.distanceKm ? req.distanceKm + ' km' : (req.distance || req.city || 'Local');
    const systemWideTag = isCentralCommand
      ? '<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">System-wide</span>'
      : '';

    // Full-text message used as the card's main tagline — always shown when present
    const tagline = notes && !pickup
      ? `<p class="text-xs text-on-surface-variant/90 mt-2 line-clamp-2">${esc(notes)}</p>`
      : notes
      ? `<p class="text-xs text-on-surface-variant/90 mt-2 line-clamp-2">${esc(notes)}</p>`
      : '';

    return `
    <div class="relative hover-lift group bg-surface-container-lowest rounded-2xl border ${isCritical ? 'border-error/20' : 'border-outline-variant/20'} shadow-sm overflow-hidden" style="transition: box-shadow 200ms var(--ease-out-strong);">
      ${isCritical ? '<div class="absolute left-0 top-0 bottom-0 w-1 bg-error"></div>' : ''}
      <div class="p-3.5 ${isCritical ? 'pl-[18px]' : ''}">
        <div class="flex items-start gap-3">
          <div class="flex flex-col items-center justify-center size-15 min-w-[60px] rounded-2xl ${isCritical ? 'bg-gradient-to-br from-error via-error/90 to-error-container text-on-error shadow-md shadow-error/20' : 'bg-primary/10 text-primary'} font-black shrink-0 shadow-xs">
            <span class="text-2xl font-black font-headline leading-none tracking-tight">${btDisplay}</span>
            ${componentShort ? `<span class="text-[7px] font-bold uppercase tracking-wider mt-0.5 ${isCritical ? 'text-on-error/80' : 'text-primary/70'}">${esc(componentShort)}</span>` : ''}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 flex-wrap">
              <p class="font-extrabold text-sm text-on-surface truncate max-w-[160px]">${esc(req.hospital || req.hospitalName)}</p>
              ${urgencyBadge}
            </div>
            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-on-surface-variant mt-1.5">
              <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">location_on</span>${distanceStr}</span>
              <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">water_drop</span>${units} unit${units > 1 ? 's' : ''}</span>
              <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">science</span>${esc(component)}</span>
            </div>
            ${tagline}
            <div class="flex items-center gap-1.5 mt-2 flex-wrap">
              ${publicBadge}${systemWideTag}${docBadge}
            </div>
          </div>
        </div>
        <div class="mt-3 flex items-center gap-2">
          <div class="flex-1 min-w-0">
            ${pickup ? `<p class="text-[10px] text-on-surface-variant inline-flex items-center gap-1"><span class="material-symbols-outlined text-[11px]">meeting_room</span>Pickup: ${esc(pickup)}</p>` : ''}
          </div>
          <button ${acceptBlocked ? `disabled title="${ineligible ? 'Deferral active — ' + deferralDays + ' days remaining' : 'Toggle availability first'}"` : `onclick="window.donorAcceptRequest('${req.id}', '${currentUser?.uid || ''}', ${isPublic})"`} class="press-scale shrink-0 px-5 py-2.5 rounded-xl font-extrabold text-xs shadow-sm ${acceptBlocked ? 'bg-surface-container-high text-on-surface-variant opacity-50 cursor-not-allowed' : 'bg-primary text-on-primary hover:opacity-90 shadow-primary/25 cursor-pointer'}" style="transition: opacity 160ms ease;">${acceptBlocked ? 'Unavailable' : 'Accept'}</button>
        </div>
      </div>
    </div>`;
  }).join('');
  if (filtered.length > INITIAL_FEED) {
    const remaining = filtered.length - INITIAL_FEED;
    feedEl.innerHTML += _feedExpanded
      ? `<button id="feedToggleBtn" class="press-scale w-full flex items-center justify-center gap-1 text-center text-on-surface-variant hover:text-on-surface font-bold text-sm py-2.5 cursor-pointer"><span class="material-symbols-outlined text-base">expand_less</span> Show less</button>`
      : `<button id="feedToggleBtn" class="press-scale w-full flex items-center justify-center gap-1 text-center text-primary hover:underline font-bold text-sm py-2.5 cursor-pointer">View all ${filtered.length} requests <span class="material-symbols-outlined text-base">expand_more</span></button>`;
    feedEl.querySelector('#feedToggleBtn')?.addEventListener('click', () => {
      const collapsing = _feedExpanded;
      _feedExpanded = !_feedExpanded;
      renderFilteredFeed();
      // When collapsing a long list, bring the feed heading back into view so the page
      // doesn't leave the donor stranded far down the page.
      if (collapsing) feedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  feedEl.querySelector('[data-action="switch-view"]')?.addEventListener('click', () => switchDonorView('dashboard'));
}

// Real hospital photos exist for exactly two named hospitals (Buea Regional, the Yaoundé
// Regional pictured in hospital_moundi.png) — everywhere else gets an honest icon card instead
// of a fabricated/reused photo. Distance is computed from real coordinates (donor's city/GPS
// vs. hospital's city/stored coords) via the same helpers the matching engine uses.
let nearbyMapInstance = null;
let _donationCenters = [];
let _centersVisibleCount = 5;
let nearbyTabsInitialized = false;
let _allCentersSearch = '';
let _allCentersCity = null;
let _allCentersWired = false;

// The full, searchable + city-filterable hospital directory (opened from "View all" on the
// dashboard's Nearby Donation Centers). Scales to any number of hospitals — search narrows by
// name/city, chips filter by city, and each row starts a donation at that hospital.
window.openAllCentersModal = () => {
  const modal = document.getElementById('allCentersModal');
  if (!modal) return;
  _allCentersSearch = '';
  _allCentersCity = null;
  const search = document.getElementById('allCentersSearch');
  if (search) search.value = '';
  if (!_allCentersWired) {
    _allCentersWired = true;
    search?.addEventListener('input', () => { _allCentersSearch = search.value; renderAllCentersList(); });
  }
  renderAllCentersCityChips();
  renderAllCentersList();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
};
window.closeAllCentersModal = () => {
  const modal = document.getElementById('allCentersModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
};

function renderAllCentersCityChips() {
  const row = document.getElementById('allCentersCityRow');
  if (!row) return;
  const cities = Array.from(new Set(_donationCenters.map(h => h.city).filter(Boolean))).sort();
  const chip = (label, value, active) => `<button data-city="${value === null ? '' : esc(value)}" class="press-scale shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors cursor-pointer ${active ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant/25 hover:text-on-surface'}">${label}</button>`;
  row.innerHTML = chip('All cities', null, !_allCentersCity) + cities.map(c => chip(c, c, _allCentersCity === c)).join('');
  row.querySelectorAll('[data-city]').forEach(btn => btn.addEventListener('click', () => {
    _allCentersCity = btn.dataset.city || null;
    renderAllCentersCityChips();
    renderAllCentersList();
  }));
}

function renderAllCentersList() {
  const listEl = document.getElementById('allCentersList');
  const countEl = document.getElementById('allCentersCount');
  if (!listEl) return;
  if (countEl) countEl.textContent = _donationCenters.length;
  const q = _allCentersSearch.toLowerCase().trim();
  const list = _donationCenters.filter(h =>
    (!_allCentersCity || h.city === _allCentersCity) &&
    (!q || (h.name || '').toLowerCase().includes(q) || (h.city || '').toLowerCase().includes(q))
  );
  if (list.length === 0) {
    listEl.innerHTML = `<div class="flex flex-col items-center justify-center py-12 text-on-surface-variant"><span class="material-symbols-outlined text-4xl mb-2">search_off</span><p class="text-sm font-bold text-on-surface">No hospitals found</p><p class="text-xs mt-1">Try a different name or city</p></div>`;
    return;
  }
  listEl.innerHTML = list.map(h => {
    const photo = photoForHospital(h.name);
    return `
    <button type="button" data-donate-center="${esc(h.name)}" class="press-scale w-full flex items-center gap-3 bg-surface-container-lowest hover:bg-surface-container-low border border-outline-variant/20 rounded-2xl p-3 text-left cursor-pointer transition-colors">
      ${photo
        ? `<img src="${photo}" alt="${esc(h.name)}" class="w-12 h-12 rounded-xl object-cover shrink-0"/>`
        : `<span class="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-xl">local_hospital</span></span>`}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <p class="text-sm font-bold text-on-surface truncate">${esc(h.name)}</p>
          <span class="material-symbols-outlined text-primary text-[15px]" style="font-variation-settings:'FILL' 1" title="Verified hospital">verified</span>
        </div>
        <p class="text-xs text-on-surface-variant truncate">${esc(h.city || 'Cameroon')}${h.distanceKm != null ? ' · ~' + h.distanceKm + ' km away' : ''}</p>
      </div>
      <span class="inline-flex items-center gap-0.5 text-[11px] font-bold text-primary shrink-0">Donate <span class="material-symbols-outlined text-sm">arrow_forward</span></span>
    </button>`;
  }).join('');
  listEl.querySelectorAll('[data-donate-center]').forEach(btn => btn.addEventListener('click', () => {
    window.closeAllCentersModal();
    window.openDonationModalForHospital(btn.dataset.donateCenter);
  }));
}

// Matched by the hospital's actual name, not city — each photo depicts one specific real
// building, so reusing it for every other hospital in the same city would misrepresent them.
function photoForHospital(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('buea regional')) return '/assets/hospital_buea.png';
  if (n.includes('yaound') && (n.includes('regional') || n.includes('hôpital') || n.includes('hopital'))) return '/assets/hospital_moundi.png';
  return null;
}

function renderCentersList() {
  const listEl = document.getElementById('donationCentersList');
  if (!listEl) return;
  const filtered = _selectedCity ? _donationCenters.filter(h => h.city === _selectedCity) : _donationCenters;
  const shown = filtered.slice(0, _centersVisibleCount);

  if (shown.length === 0) {
    listEl.innerHTML = `<div class="flex flex-col items-center text-center py-10 text-on-surface-variant bg-surface-container-lowest border border-outline-variant/20 rounded-2xl shadow-sm px-6">
      <div class="w-14 h-14 rounded-full bg-tertiary/10 text-tertiary flex items-center justify-center mb-3">
        <span class="material-symbols-outlined text-2xl">local_hospital</span>
      </div>
      <p class="font-bold text-on-surface text-sm">${_selectedCity ? `No donation centers in ${_selectedCity} yet` : 'No registered donation centers'}</p>
      <p class="text-xs mt-1.5 max-w-xs">${_selectedCity ? 'There are no registered donation centers in this city yet. Try a different location or check back later.' : 'There are no registered hospitals in your area yet. Check back as the network grows.'}</p>
    </div>`;
    return;
  }
  // Each card is a button: tapping it opens the donation wizard already pointed at that
  // hospital, so "browse the network → pick where to donate" is one flow.
  const cards = shown.map(h => {
    const photo = photoForHospital(h.name);
    return `
    <button type="button" data-donate-center="${esc(h.name)}" class="hover-lift press-scale w-full flex items-center gap-3 bg-surface-container-lowest border border-outline-variant/20 rounded-2xl p-3.5 shadow-sm text-left cursor-pointer">
      ${photo
        ? `<img src="${photo}" alt="${esc(h.name)}" class="w-16 h-16 rounded-xl object-cover shrink-0 shadow-xs"/>`
        : `<span class="w-16 h-16 rounded-xl bg-tertiary/10 text-tertiary flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-2xl">local_hospital</span></span>`
      }
      <div class="min-w-0 flex-1">
        <p class="text-sm font-bold text-on-surface truncate">${esc(h.name)}</p>
        <p class="text-xs text-on-surface-variant truncate mt-0.5">${esc(h.city || 'Cameroon')}</p>
        <span class="inline-flex items-center gap-1 mt-1.5 text-[10px] font-bold text-tertiary group-hover:underline">Donate here <span class="material-symbols-outlined text-xs">arrow_forward</span></span>
      </div>
      ${h.distanceKm != null ? `<span class="text-xs font-black text-tertiary shrink-0 self-start bg-tertiary/5 px-2 py-0.5 rounded-lg">${h.distanceKm} km</span>` : ''}
    </button>`;
  }).join('');
  // "View all" opens the full searchable/filterable directory modal (not an in-place expand),
  // so a 50+ hospital network is actually browsable by name or city.
  const totalCount = _donationCenters.length;
  const viewAllBtn = filtered.length > shown.length || totalCount > shown.length
    ? `<button id="btnViewAllCenters" class="press-scale w-full flex items-center justify-center gap-1 text-center text-xs font-bold text-primary hover:underline py-1.5 cursor-pointer">View all ${totalCount} centers <span class="material-symbols-outlined text-sm">arrow_forward</span></button>`
    : '';
  listEl.innerHTML = cards + viewAllBtn;
  listEl.querySelectorAll('[data-donate-center]').forEach(btn => {
    btn.addEventListener('click', () => window.openDonationModalForHospital(btn.dataset.donateCenter));
  });
  document.getElementById('btnViewAllCenters')?.addEventListener('click', () => window.openAllCentersModal());
}

// The city chip row replaces the old schematic Cameroon-outline map, which duplicated the real
// Leaflet map below it. One real map now serves both lists; chips just filter + re-center it.
function renderCityChips(currentUser) {
  const rowEl = document.getElementById('cityChipRow');
  if (!rowEl) return;
  const cities = ['Yaoundé', 'Douala', 'Bamenda', 'Buea', 'Limbe', 'Bafoussam', 'Garoua'];
  const chip = (label, value, isActive) => `
    <button class="press-scale shrink-0 px-3.5 py-1.5 rounded-full text-xs font-bold border transition-all cursor-pointer ${isActive ? 'bg-primary text-on-primary border-primary shadow-sm shadow-primary/20' : 'bg-surface-container-low text-on-surface-variant border-transparent hover:bg-surface-container hover:text-on-surface'}" data-city="${value || ''}">
      ${isActive ? `<span class="material-symbols-outlined text-[11px] align-middle -mt-0.5 mr-0.5">check</span>` : ''}${label}
    </button>
  `;
  rowEl.innerHTML = chip('All Cameroon', '', !_selectedCity) + cities.map(c => chip(c, c, _selectedCity === c)).join('');
  rowEl.querySelectorAll('[data-city]').forEach(btn => {
    btn.addEventListener('click', () => window._filterCity(btn.dataset.city || null));
  });
}

// Tabs switch which list is visible beside the shared map. Bound once — rebinding on every
// dashboard reload would stack duplicate listeners since these use addEventListener.
function initNearbyTabs() {
  if (nearbyTabsInitialized) return;
  nearbyTabsInitialized = true;
  const tabRequests = document.getElementById('tabBtnRequests');
  const tabCenters = document.getElementById('tabBtnCenters');
  const feedEl = document.getElementById('requestsFeed');
  const centersEl = document.getElementById('donationCentersList');
  const viewAllTop = document.getElementById('btnViewAllRequestsTop');
  const setActive = (tab) => {
    const isReq = tab === 'requests';
    tabRequests.className = `press-scale px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${isReq ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant'}`;
    tabCenters.className = `press-scale px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${!isReq ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant'}`;
    feedEl?.classList.toggle('hidden', !isReq);
    centersEl?.classList.toggle('hidden', isReq);
    viewAllTop?.classList.toggle('hidden', !isReq);
  };
  tabRequests?.addEventListener('click', () => setActive('requests'));
  tabCenters?.addEventListener('click', () => setActive('centers'));
  setActive('requests');
}

// One real map shared by blood requests and donation centers — donor (red), requests
// (amber/red-if-critical), and centers (green) all plotted together with a legend, instead of
// two separate maps stacked on the page.
function renderNearbyMap(donorCoords) {
  const mapEl = document.getElementById('nearbyMap');
  if (!mapEl || !window.L) return;
  if (nearbyMapInstance) { nearbyMapInstance.remove(); nearbyMapInstance = null; }

  const selectedCoords = _selectedCity ? CITY_COORDINATES[_selectedCity.toLowerCase()] : null;
  const center = selectedCoords || donorCoords || { lat: 3.848, lon: 11.5021 }; // Yaoundé fallback
  const zoom = selectedCoords ? 11 : 7;

  const map = L.map(mapEl, { zoomControl: false, attributionControl: false }).setView([center.lat, center.lon], zoom);
  // Light, muted basemap (not the saturated default OSM green/tan) so the map blends
  // with the app's warm palette instead of reading as a bolted-on generic widget.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 18, subdomains: 'abcd' }).addTo(map);

  if (donorCoords) {
    L.circleMarker([donorCoords.lat, donorCoords.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#af101a', fillOpacity: 1 })
      .addTo(map).bindTooltip('You are here');
  }
  _donationCenters.forEach(h => {
    if (!h.coords) return;
    L.circleMarker([h.coords.lat, h.coords.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#1e8e3e', fillOpacity: 1 })
      .addTo(map).bindTooltip(esc(h.name));
  });
  _allRequests.forEach(r => {
    if (!r.coords) return;
    const isCritical = r.urgency === 'critical' || r.urgency === 'Critical';
    L.circleMarker([r.coords.lat, r.coords.lon], { radius: isCritical ? 7 : 5, color: '#fff', weight: 2, fillColor: isCritical ? '#c62828' : '#e08a00', fillOpacity: 1 })
      .addTo(map).bindTooltip(esc(`${r.bloodType || r.type || 'Blood'} needed${r.hospital ? ' • ' + r.hospital : ''}`));
  });
  nearbyMapInstance = map;
}

async function loadDonationCenters() {
  const currentUser = getCurrentUser();
  const donorCoords = getCoordinatesForLocation(currentUser?.city, currentUser?.lat, currentUser?.lng);
  try {
    const hospitals = await fetchAllHospitals();
    _donationCenters = hospitals.map(h => {
      const coords = getCoordinatesForLocation(h.city, h.lat, h.lng);
      const distanceKm = (donorCoords && coords) ? calculateDistanceKm(donorCoords.lat, donorCoords.lon, coords.lat, coords.lon) : null;
      return { ...h, coords, distanceKm };
    }).sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
    _centersVisibleCount = Math.min(5, _donationCenters.length);
    renderCentersList();
  } catch (e) {
    console.error('Failed to load donation centers:', e);
    _donationCenters = [];
    const listEl = document.getElementById('donationCentersList');
    if (listEl) listEl.innerHTML = '<p class="text-sm text-error text-center py-6">Failed to load donation centers.</p>';
  }
  // Render the shared map regardless of whether the hospital fetch succeeded, so donor +
  // request markers still show even if donation centers failed to load.
  renderNearbyMap(donorCoords);
}

function clearDonorLoadingStates() {
  const loaders = [
    'donorTierProgress', 'donorEligibilityBar', 'requestsFeed',
    'donorBadgesSummary', 'donorCampaigns', 'donationCentersList',
    'donorRecentActivity', 'donorRequestsList', 'badgesFullView',
  ];
  loaders.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.querySelector('.animate-spin')) {
      el.innerHTML = '';
    }
  });
}

function showDonorErrorState(el) {
  if (el && !el.innerHTML.trim()) {
    el.innerHTML = '<div class="flex items-center justify-center py-4 text-on-surface-variant"><span class="text-sm">Could not load data.</span></div>';
  }
}

export async function loadDonorDashboard() {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  try {
    const engagement = await computeDonorEngagement(currentUser.uid).catch(() => null);

    // getCoordinatesForLocation lowercases/normalizes the city name before looking it up in
    // CITY_COORDINATES — a raw CITY_COORDINATES[currentUser.city] index (the old code here)
    // silently fails for any city stored with capitalization, which is the normal case.
    const donorCoords = getCoordinatesForLocation(currentUser.city, currentUser.lat, currentUser.lng) || CITY_COORDINATES['buea'];
    const donorLat = donorCoords?.lat;
    const donorLng = donorCoords?.lon;

    const [matchedRequests, publicRequests] = await Promise.all([
      fetchMatchedRequestsForDonor(currentUser.bloodType, currentUser.city).catch(() => []),
      fetchPublicRequestsForDonor(donorLat, donorLng, currentUser.bloodType).catch(() => [])
    ]);

    // Hospital requests only carry a city, not exact coordinates, so distance/position is
    // estimated city-to-city (same approach used for the Donation Centers list) rather than
    // fabricated. `coords` is kept on each request so the shared "Near You" map can plot it.
    const activeRequests = matchedRequests.map(r => {
      const reqCoords = getCoordinatesForLocation(r.city, r.lat, r.lng);
      const distanceKm = (donorLat && donorLng && reqCoords)
        ? Math.round(calculateDistanceKm(donorLat, donorLng, reqCoords.lat, reqCoords.lon))
        : null;
      return { ...r, coords: reqCoords, distanceKm };
    });

    const taggedPublic = (publicRequests || []).map(pr => ({
      ...pr,
      isPublicRequest: true,
      hospital: pr.hospitalName,
      requestedAt: pr.createdAt,
      coords: (pr.cityLat && pr.cityLng) ? { lat: pr.cityLat, lon: pr.cityLng } : getCoordinatesForLocation(pr.city),
    }));

    _allRequests = [...activeRequests, ...taggedPublic];

    const firstName = (currentUser.name || currentUser.email?.split('@')[0] || 'Mai').split(' ')[0];
    const city = currentUser.city || 'Buea';
    const bloodType = currentUser.bloodType || 'B+';
    const bloodInfo = getBloodTypeDisplayInfo(bloodType);

    // Dynamic Header & Welcome Name
    const welcomeNameEl = document.getElementById('donorWelcomeName');
    if (welcomeNameEl) welcomeNameEl.textContent = firstName;

    const navNameEl = document.getElementById('donorNavName');
    if (navNameEl) navNameEl.textContent = firstName;

    const initialsEl = document.getElementById('donorUserInitials');
    if (initialsEl) initialsEl.textContent = firstName.slice(0, 2).toUpperCase();

    // Hero welcome message
    const heroMsgEl = document.getElementById('donorHeroMessage');
    if (heroMsgEl) {
      heroMsgEl.textContent = "Your single donation can save lives. Together, we can build a healthier Cameroon.";
    }

    // Blood type card elements
    const bloodValEl = document.getElementById('donorBloodTypeVal');
    if (bloodValEl) bloodValEl.textContent = bloodType;

    const bloodLabelEl = document.getElementById('donorBloodTypeLabel');
    if (bloodLabelEl) bloodLabelEl.textContent = bloodInfo.label || 'Common';

    // Stats
    if (engagement) {
      const statDonations = document.getElementById('statDonations');
      if (statDonations) statDonations.textContent = engagement.donationCount;

      // Bare number — the "up to N Lives" phrasing lives in the surrounding hero copy now,
      // not baked into this element, so it can be reused inline without duplicating "up to".
      const livesCount = engagement.totalUnits > 0 ? engagement.totalUnits * 3 : 3;
      const statLivesSavedText = document.getElementById('statLivesSavedText');
      if (statLivesSavedText) statLivesSavedText.textContent = livesCount;

      const statLivesSaved = document.getElementById('statLivesSaved');
      if (statLivesSaved) statLivesSaved.textContent = engagement.totalUnits * 3;

      const statPoints = document.getElementById('statPoints');
      if (statPoints) statPoints.textContent = engagement.points;

      const statRank = document.getElementById('statRank');
      if (statRank) statRank.textContent = engagement.tier;

      const lastDonation = engagement.donations
        .filter(d => d.status === 'completed')
        .sort((a, b) => new Date(b.completedAt || b.preferredDate || 0) - new Date(a.completedAt || a.preferredDate || 0));
      const last = lastDonation[0];
      const lastDonationText = document.getElementById('statLastDonation');
      if (lastDonationText) {
        const lastDate = last?.completedAt || last?.preferredDate;
        lastDonationText.textContent = lastDate
          ? new Date(lastDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : 'Never';
      }

      // Tier progress
      const tierEl = document.getElementById('donorTierProgress');
      if (tierEl) {
        const pct = engagement.nextTier ? Math.min(100, engagement.nextTierProgress) : 100;
        tierEl.innerHTML = `
          <div class="flex items-center gap-4">
            <div class="w-11 h-11 rounded-xl bg-gradient-to-br from-warning to-[#8a4c00] flex items-center justify-center shadow-sm shadow-warning/30 shrink-0">
              <span class="material-symbols-outlined text-white text-xl">${engagement.tierIcon}</span>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex justify-between items-center mb-1.5">
                <span class="font-black font-headline text-lg text-on-surface tracking-tight">${engagement.tier} Tier</span>
                <span class="text-xs font-bold text-warning">${engagement.points} pts</span>
              </div>
              ${engagement.nextTier ? `
              <div class="flex justify-between text-[10px] font-bold text-on-surface-variant mb-1">
                <span>${engagement.tier}</span>
                <span>Next: ${engagement.nextTier}</span>
              </div>
              <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                <div class="h-full bg-gradient-to-r from-primary to-[#7a0c14] rounded-full" style="width: ${pct}%; transition: width 500ms var(--ease-out-strong);"></div>
              </div>
              <p class="text-[10px] text-on-surface-variant mt-1.5 font-medium">${Math.max(1, getNextTierDonationsNeeded(engagement))} more donation${engagement.donationCount >= 4 ? 's' : ''} to reach ${engagement.nextTier}!</p>
              ` : '<p class="text-xs text-success font-bold">Max tier reached!</p>'}
            </div>
          </div>
          <div class="flex gap-3 mt-5 pt-4 border-t border-outline-variant/15">
            <div class="flex-1 text-center">
              <p class="text-2xl font-black font-headline text-primary tracking-tight">${engagement.donationCount}</p>
              <p class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Donations</p>
            </div>
            <div class="flex-1 text-center border-x border-outline-variant/15">
              <p class="text-2xl font-black font-headline text-success tracking-tight">${engagement.totalUnits * 3}</p>
              <p class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Lives Saved</p>
            </div>
            <div class="flex-1 text-center">
              <p class="text-2xl font-black font-headline text-on-surface tracking-tight">${engagement.points}</p>
              <p class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Points</p>
            </div>
          </div>
        `;
      }
    }

    // Eligibility countdown
    const eligEl = document.getElementById('donorEligibilityBar');
    if (eligEl && engagement) {
      const sorted = engagement.donations
        .filter(d => d.status === 'completed')
        .sort((a, b) => new Date(b.completedAt || b.preferredDate || 0) - new Date(a.completedAt || a.preferredDate || 0));
      const lastDonationDate = sorted[0]?.completedAt || sorted[0]?.preferredDate || null;
      const elig = getEligibilityInfo(lastDonationDate);
      _donorEligibilityCache = elig; // cache for the schedule/accept eligibility gate
      eligEl.innerHTML = `
        <div class="flex items-center justify-between mb-3">
          <span class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">Eligibility Status</span>
          <span class="text-sm font-black ${elig.color}">${elig.label}</span>
        </div>
        <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
          <div class="h-full ${elig.eligible ? 'bg-success' : 'bg-warning'} rounded-full" style="width: ${elig.barPct}%; transition: width 500ms var(--ease-out-strong);"></div>
        </div>
        <p class="text-[11px] text-on-surface-variant mt-2 font-medium">${elig.eligible ? 'You are eligible to donate now!' : `Next donation available in ${elig.daysUntil} days (56-day deferral period)`}</p>
      `;

      // Same elig data, shown as the quick-glance stat card at the top of the dashboard.
      const quickStatEl = document.getElementById('donorEligibilityQuickStat');
      if (quickStatEl) quickStatEl.textContent = elig.eligible ? 'Eligible' : `${elig.daysUntil}d`;
      const quickTagEl = document.getElementById('donorEligibilityQuickTag');
      if (quickTagEl) quickTagEl.textContent = elig.eligible ? 'You can donate now' : 'Almost there';

      // Hero live status pill — green pulse when eligible, amber countdown otherwise.
      const heroPill = document.getElementById('donorHeroStatusPill');
      if (heroPill) {
        const dot = elig.eligible ? 'bg-success' : 'bg-warning';
        const ping = elig.eligible ? 'bg-success/60' : 'bg-warning/60';
        const text = elig.eligible ? 'Eligible to donate now' : `Next donation in ${elig.daysUntil} day${elig.daysUntil === 1 ? '' : 's'}`;
        heroPill.innerHTML = `<span class="relative flex w-2 h-2"><span class="absolute inline-flex w-full h-full rounded-full ${ping} animate-ping"></span><span class="relative inline-flex w-2 h-2 rounded-full ${dot}"></span></span><span class="text-xs font-bold text-on-surface">${text}</span>`;
      }

      // Donation Journey — four real milestones rendered as a connected timeline (numbered
      // nodes joined by a rail, completed ones filled + checked) with a progress summary.
      const journeyEl = document.getElementById('donorJourneyChecklist');
      if (journeyEl) {
        const steps = [
          { label: 'Profile Completed', done: !!(currentUser.name && currentUser.bloodType && currentUser.bloodType !== 'Unknown' && currentUser.city) },
          { label: 'Availability Updated', done: !!currentUser.lastAvailabilityScreeningAt },
          { label: 'Eligible to Donate', done: elig.eligible },
          { label: 'Make Your First Donation', done: engagement.donationCount > 0 },
        ];
        const doneCount = steps.filter(s => s.done).length;
        const pct = Math.round((doneCount / steps.length) * 100);
        journeyEl.innerHTML = `
          <div class="flex items-center justify-between mb-3">
            <span class="text-[11px] font-bold text-on-surface-variant">${doneCount} of ${steps.length} complete</span>
            <span class="text-[11px] font-black text-primary">${pct}%</span>
          </div>
          <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden mb-4">
            <div class="h-full bg-success rounded-full" style="width:${pct}%; transition: width 500ms var(--ease-out-strong);"></div>
          </div>
          <div class="relative">
            <div class="absolute left-[11px] top-3 bottom-3 w-0.5 bg-outline-variant/25"></div>
            <div class="space-y-3.5">
              ${steps.map((s, i) => `
                <div class="relative flex items-center gap-3">
                  <span class="relative z-10 w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${s.done ? 'bg-success text-on-success' : 'bg-surface-container border-2 border-outline-variant/40 text-on-surface-variant'}">
                    ${s.done
                      ? `<span class="material-symbols-outlined" style="font-size:15px;font-variation-settings:'FILL' 1">check</span>`
                      : `<span class="text-[10px] font-black">${i + 1}</span>`}
                  </span>
                  <span class="text-sm font-bold ${s.done ? 'text-on-surface' : 'text-on-surface-variant'}">${s.label}</span>
                  ${s.done ? '' : '<span class="ml-auto text-[9px] font-bold text-on-surface-variant/50 uppercase tracking-wider">To do</span>'}
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }
    }

    // Badges summary
    const badgesEl = document.getElementById('donorBadgesSummary');
    if (badgesEl && engagement) {
      if (engagement.badges.length === 0) {
        badgesEl.innerHTML = '<p class="text-sm text-on-surface-variant text-center py-4">Complete your first donation to earn badges!</p>';
      } else {
        badgesEl.innerHTML = `
          <div class="flex flex-wrap gap-2">
            ${engagement.badges.slice(0, 6).map(b => `
              <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-full" style="background-color: ${b.color}15;">
                <span class="material-symbols-outlined text-sm" style="color: ${b.color}">${b.icon}</span>
                <span class="text-[10px] font-bold" style="color: ${b.color}">${b.name}</span>
              </div>
            `).join('')}
          </div>
          <button onclick="switchDonorView('badges')" class="press-scale mt-3 text-xs font-bold text-primary hover:underline cursor-pointer">View all badges →</button>
        `;
      }
    }

    // Handle null engagement — clear remaining loading spinners
    if (!engagement) {
      clearDonorLoadingStates();
    }

    // Emergency alert — check both hospital requests and public requests for critical urgency
    const isCriticalUrgency = (r) => r.urgency === 'critical' || r.urgency === 'Critical';
    const criticalRequest = activeRequests.find(isCriticalUrgency)
        || taggedPublic.find(isCriticalUrgency);
    const alertEl = document.getElementById('emergencyAlert');
    if (alertEl) {
      if (criticalRequest) {
        alertEl.classList.remove('hidden');
        alertEl.classList.add('flex');
        document.getElementById('emergencyBloodType').textContent = criticalRequest.bloodType || criticalRequest.type || '?';
        document.getElementById('emergencyHospital').textContent = `${criticalRequest.city || 'Yaoundé'} • ${criticalRequest.hospital}`;
        document.getElementById('emergencyTime').textContent = getTimeAgo(criticalRequest.requestedAt);
        const units = criticalRequest.units || 1;
        document.getElementById('emergencyUnits').textContent = `${units} unit${units === 1 ? '' : 's'} needed`;
        const distanceWrap = document.getElementById('emergencyDistanceWrap');
        if (criticalRequest.distanceKm != null) {
          document.getElementById('emergencyDistance').textContent = `${criticalRequest.distanceKm} km away`;
          distanceWrap.classList.remove('hidden');
        } else {
          distanceWrap.classList.add('hidden');
        }
        document.getElementById('emergencyRespondBtn').onclick = () => {
          window.donorAcceptRequest(criticalRequest.id, currentUser.uid, !!criticalRequest.isPublicRequest);
        };
      } else {
        alertEl.classList.add('hidden');
        alertEl.classList.remove('flex');
      }
    }

    renderFilteredFeed();
    loadDonationCenters();

    // Recent activity
    const activityEl = document.getElementById('donorRecentActivity');
    if (activityEl && engagement) {
      const recent = engagement.donations.slice(0, 5);
      if (recent.length === 0) {
        activityEl.innerHTML = '<div class="flex items-center justify-center py-8 text-on-surface-variant"><p class="text-sm">No activity yet</p></div>';
      } else {
        activityEl.innerHTML = recent.map(d => {
          const isNew = d.status === 'pending';
          const dotColor = isNew ? 'bg-primary' : 'bg-outline-variant';
          const statusLabels = { 'completed': 'Donation Completed', 'approved': 'Donation Approved', 'rejected': 'Donation Rejected', 'cancelled': 'Cancelled', 'pending': 'Request Submitted' };
          return `
          <div class="flex gap-3">
            <div class="size-2 mt-1.5 ${dotColor} rounded-full shrink-0"></div>
            <div class="flex flex-col gap-0.5 min-w-0">
              <p class="text-sm font-bold text-on-surface leading-tight">${statusLabels[d.status] || d.status}</p>
              <p class="text-xs text-on-surface-variant truncate">${d.bloodType} • ${d.units || 1} unit${(d.units || 1) > 1 ? 's' : ''} at ${d.preferredLocation || '—'}</p>
              <span class="text-[10px] font-medium text-on-surface-variant/70">${d.preferredDate ? new Date(d.preferredDate).toLocaleDateString() : ''}</span>
            </div>
          </div>
          `;
        }).join('');
      }
    }

    // Active campaigns
    const campaignsEl = document.getElementById('donorCampaigns');
    if (campaignsEl) {
      try {
        const [campaigns, myInterest] = await Promise.all([
          fetchAllCampaigns(),
          fetchDonorCampaignInterest(currentUser.uid).catch(() => [])
        ]);
        const active = campaigns.filter(c => c.status === 'active').slice(0, 3);
        if (active.length === 0) {
          campaignsEl.innerHTML = '<p class="text-sm text-on-surface-variant text-center py-4">No active campaigns</p>';
        } else {
          campaignsEl.innerHTML = active.map(c => {
            const pct = c.targetUnits ? Math.round((c.unitsCollected || 0) / c.targetUnits * 100) : 0;
            const isInterested = myInterest.some(d => d.campaignId === c.id);
            return `
            <div class="bg-surface-container-lowest p-4 rounded-xl border border-outline-variant/20">
              <div class="flex justify-between items-start mb-2 gap-2">
                <h4 class="font-bold text-sm text-on-surface">${esc(c.title)}</h4>
                <span class="text-[10px] font-bold text-success bg-success-container/40 px-2 py-0.5 rounded-full shrink-0">Active</span>
              </div>
              <p class="text-xs text-on-surface-variant mb-3">${esc(c.location || '')}</p>
              <div class="flex justify-between text-xs font-bold text-on-surface mb-1">
                <span>${c.unitsCollected || 0} / ${c.targetUnits || 0} units</span>
                <span class="text-primary">${pct}%</span>
              </div>
              <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden mb-3">
                <div class="h-full bg-gradient-to-r from-primary to-[#7a0c14] rounded-full" style="width: ${pct}%"></div>
              </div>
              <button type="button" data-campaign-interest="${c.id}" data-interested="${isInterested}"
                class="press-scale w-full flex items-center justify-center gap-1.5 text-xs font-bold py-2 rounded-lg transition-colors cursor-pointer ${isInterested ? 'bg-success-container/40 text-on-success-container hover:bg-success-container/60' : 'bg-primary text-on-primary hover:opacity-90'}">
                ${isInterested ? '<span class="material-symbols-outlined text-sm">check_circle</span> Interested — tap to leave' : "I'm Interested"}
              </button>
            </div>
            `;
          }).join('');

          campaignsEl.querySelectorAll('[data-campaign-interest]').forEach(btn => {
            btn.addEventListener('click', async () => {
              const campaignId = btn.dataset.campaignInterest;
              const currentlyInterested = btn.dataset.interested === 'true';
              const campaign = active.find(c => c.id === campaignId);
              btn.disabled = true;
              try {
                if (currentlyInterested) {
                  await donorLeaveCampaign(campaignId, currentUser.uid);
                  showToast('Removed from campaign interest.');
                } else {
                  await donorJoinCampaign(campaignId, currentUser.uid, currentUser.name || currentUser.email?.split('@')[0] || 'Donor', campaign?.title || '');
                  showToast("You're marked as interested in this campaign!");
                }
                loadDonorDashboard();
              } catch (err) {
                console.error('Failed to update campaign interest:', err);
                showToast(err.message?.includes('Already registered') ? err.message : 'Failed to update. Please try again.', 'error');
                btn.disabled = false;
              }
            });
          });
        }
      } catch (e) {
        campaignsEl.innerHTML = '';
      }
    }

    // City quick-filter chips (replaces the old schematic Cameroon outline map — one real
    // map is shared by both lists now, see renderNearbyMap, called once hospitals are in).
    renderCityChips(currentUser);
    initNearbyTabs();

    // Availability toggle
    const track = document.getElementById('availabilityTrack');
    const thumb = document.getElementById('availabilityThumb');
    const statusLabel = document.getElementById('donorStatusLabel');
    if (track && thumb && statusLabel) {
      const isAvail = currentUser.isAvailable !== false;
      track.className = `relative inline-block w-12 h-6 transition duration-200 ease-in rounded-full ${isAvail ? 'bg-emerald-500' : 'bg-slate-300'}`;
      thumb.className = `absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${isAvail ? 'translate-x-6' : ''}`;
      statusLabel.textContent = isAvail ? 'Available' : 'Busy';
      const applyAvailabilityState = async (newState, extra = {}) => {
        try {
          await updateUserProfile(currentUser.uid, { isAvailable: newState, ...extra });
          currentUser.isAvailable = newState;
          localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser }));
          track.className = `relative inline-block w-12 h-6 transition duration-200 ease-in rounded-full ${newState ? 'bg-emerald-500' : 'bg-slate-300'}`;
          thumb.className = `absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${newState ? 'translate-x-6' : ''}`;
          statusLabel.textContent = newState ? 'Available' : 'Busy';
        } catch (e) { console.error('Failed to update availability:', e); }
      };
      const toggleEl = document.getElementById('availabilityToggle');
      if (toggleEl) {
        toggleEl.onclick = () => {
          const newState = !(currentUser.isAvailable !== false);
          if (newState) {
            // Going available is what makes a donor a matching candidate — require a fresh
            // health screening before it takes effect. Going unavailable never needs one.
            initAvailabilityScreeningModal();
            openAvailabilityScreeningModal(() => applyAvailabilityState(true, { lastAvailabilityScreeningAt: new Date().toISOString() }));
          } else {
            applyAvailabilityState(false);
          }
        };
      }
    }
  } catch (e) {
    console.error('Failed to load donor dashboard:', e);
    ['donorTierProgress', 'donorEligibilityBar', 'requestsFeed',
     'donorBadgesSummary', 'donorCampaigns', 'donationCentersList',
     'donorRecentActivity'].forEach(id => showDonorErrorState(document.getElementById(id)));
  }
}

function getNextTierDonationsNeeded(engagement) {
  if (!engagement.nextTier) return 0;
  const map = { 'Silver': 5, 'Gold': 10, 'Platinum': 20 };
  const needed = map[engagement.nextTier] || 5;
  return Math.max(1, needed - engagement.donationCount);
}


let _currentReqFilter = 'all';
window.filterDonorRequests = (filterType) => {
  _currentReqFilter = filterType;
  const filterBtns = {
    all: 'btnFilterReqAll',
    active: 'btnFilterReqActive',
    public: 'btnFilterReqPublic',
    completed: 'btnFilterReqCompleted'
  };
  Object.keys(filterBtns).forEach(k => {
    const btn = document.getElementById(filterBtns[k]);
    if (btn) {
      if (k === filterType) {
        btn.className = 'px-4 py-2 rounded-xl text-xs font-bold transition-all bg-primary text-on-primary shadow-sm cursor-pointer shrink-0';
      } else {
        btn.className = 'px-4 py-2 rounded-xl text-xs font-bold transition-all bg-surface-container-lowest text-on-surface-variant hover:text-on-surface border border-outline-variant/20 hover:bg-surface-container-low cursor-pointer shrink-0';
      }
    }
  });
  // Re-render from the already-subscribed cache — no need to re-fetch/re-subscribe on a filter change.
  renderDonorRequestsList();
};

// Live-journey state. The active journeys come from a real-time Firestore listener (see
// subscribeToDonorJourneys) so status changes — the donor's own AND the hospital's — appear
// instantly, no refresh. Past scheduled donations are static and fetched once per view entry.
let _donorJourneysUnsub = null;
let _activeJourneys = [];
let _pastDonations = [];
let _enRouteTrackingId = null; // request we're currently sharing live location for

const JOURNEY_STEPS = [
  { label: 'Accepted', icon: 'how_to_reg' },
  { label: 'En Route', icon: 'directions_car' },
  { label: 'Check-In', icon: 'badge' },
  { label: 'Blood Drawn', icon: 'water_drop' },
  { label: 'Lab Cleared', icon: 'science' },
  { label: 'Life Saved', icon: 'favorite' },
];
function journeyStepNum(status) {
  const map = {
    'Donor Assigned': 1, 'pending': 1, 'approved': 1,
    'Donor En Route': 2,
    'Checked In': 3,
    'Donation Complete': 4, 'completed': 4,
    'Lab Cleared': 5, 'Lab Rejected': 5,
    'Issued': 6, 'Resolved': 6, 'Completed': 6,
  };
  return map[status] || 1;
}

// Start/stop live GPS sharing based on the current en-route journey, only reacting to an
// actual change so a re-render from the listener doesn't restart the watch every tick.
function reconcileLiveLocationSharing() {
  const enRoute = _activeJourneys.find(r => r.status === 'Donor En Route');
  if (enRoute && _enRouteTrackingId !== enRoute.id) {
    _enRouteTrackingId = enRoute.id;
    startLiveLocationSharing(enRoute.id, !!enRoute.isPublicRequest);
  } else if (!enRoute && _enRouteTrackingId) {
    _enRouteTrackingId = null;
    stopLiveLocationSharing();
  }
}

async function loadDonorRequests() {
  const container = document.getElementById('donorRequestsList');
  if (!container) return;
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  // Past scheduled donations — static, fetched once when the view is opened.
  try {
    const engagement = await computeDonorEngagement(currentUser.uid);
    _pastDonations = engagement?.donations?.filter(d => d.status === 'approved' || d.status === 'completed') || [];
  } catch (e) { _pastDonations = []; }

  // Live active journeys — subscribe once; each snapshot re-renders and reconciles tracking.
  if (!_donorJourneysUnsub) {
    _donorJourneysUnsub = subscribeToDonorJourneys(currentUser.uid, (journeys) => {
      _activeJourneys = journeys;
      reconcileLiveLocationSharing();
      renderDonorRequestsList();
    });
  }
  renderDonorRequestsList();
}

// Torn down by switchDonorView when the donor leaves the Requests view.
function teardownDonorJourneys() {
  if (_donorJourneysUnsub) { _donorJourneysUnsub(); _donorJourneysUnsub = null; }
}

function renderDonorJourneyCard(r) {
  const currentUser = getCurrentUser();
  const stepNum = journeyStepNum(r.status);
  const N = JOURNEY_STEPS.length;
  const isComplete = stepNum >= N || r.status === 'Completed' || r.status === 'Issued' || r.status === 'Resolved';
  const cell = 100 / N, edge = cell / 2;
  const progressW = Math.max(0, Math.min(stepNum, N) - 1) * cell;

  const updated = r.updatedAt || r.lastStatusAt || r.enRouteAt || r.requestedAt || r.createdAt;
  const liveBadge = isComplete
    ? `<span class="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-success bg-success-container/50 px-2.5 py-1 rounded-full"><span class="material-symbols-outlined" style="font-size:13px;font-variation-settings:'FILL' 1">verified</span> Completed</span>`
    : `<span class="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-primary bg-primary/10 px-2.5 py-1 rounded-full"><span class="relative flex w-1.5 h-1.5"><span class="absolute inline-flex w-full h-full rounded-full bg-primary opacity-60 animate-ping"></span><span class="relative inline-flex w-1.5 h-1.5 rounded-full bg-primary"></span></span> Live</span>`;

  const publicBadge = r.isPublicRequest ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-warning-container/50 text-on-warning-container border border-warning/25">Public</span>` : '';
  const passCode = r.checkInToken ? `<span class="inline-flex items-center gap-1.5 text-[11px] font-mono font-black text-success bg-success-container/40 border border-success/25 px-2.5 py-1 rounded-lg"><span class="material-symbols-outlined" style="font-size:14px">qr_code_2</span> ${esc(r.checkInToken)}</span>` : '';

  // Where to go + who to call, plus what's needed — the pickup details the hospital entered.
  // Most useful once you've accepted, so they live on the journey card (not the browse feed).
  const units = r.units || 1;
  const component = r.componentType || 'Whole Blood';
  const pickup = (r.pickupLocation || '').trim();
  const phone = (r.contactPhone || '').trim();
  const detailItem = (icon, label, value) => `
    <div class="flex items-center gap-2 min-w-0">
      <span class="material-symbols-outlined text-[15px] text-on-surface-variant shrink-0">${icon}</span>
      <span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider shrink-0">${label}</span>
      <span class="text-xs font-bold text-on-surface truncate">${value}</span>
    </div>`;
  const detailsBlock = `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 bg-surface-container-low/60 rounded-2xl p-3.5 border border-outline-variant/15">
      ${detailItem('water_drop', 'Need', `${units} unit${units > 1 ? 's' : ''} · ${esc(component)}`)}
      ${pickup ? detailItem('meeting_room', 'Pickup', esc(pickup)) : ''}
      ${phone ? `<a href="tel:${esc(phone.replace(/\s+/g, ''))}" class="press-scale flex items-center gap-2 min-w-0 hover:text-primary"><span class="material-symbols-outlined text-[15px] text-primary shrink-0">call</span><span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider shrink-0">Desk</span><span class="text-xs font-bold text-primary truncate">${esc(phone)}</span></a>` : ''}
    </div>`;

  let actions = '';
  if (r.status === 'Donor Assigned') {
    actions = `
      <button onclick="window.donorCancelRequest('${r.id}')" class="press-scale text-[11px] font-bold text-on-surface-variant hover:text-error bg-surface-container-low hover:bg-error-container/40 px-3 py-2.5 rounded-xl transition-colors flex items-center gap-1 cursor-pointer"><span class="material-symbols-outlined text-xs">close</span> Withdraw</button>
      <button onclick="window.donorMarkEnRoute('${r.id}', '${currentUser?.uid || ''}', ${!!r.isPublicRequest})" class="press-scale text-xs font-extrabold text-on-primary bg-primary hover:opacity-90 px-4 py-2.5 rounded-xl shadow-sm shadow-primary/20 transition-opacity flex items-center gap-1.5 cursor-pointer"><span class="material-symbols-outlined text-sm">directions_car</span> Start Trip</button>`;
  } else if (r.status === 'Donor En Route') {
    actions = `
      <button onclick="window.donorCancelRequest('${r.id}')" class="press-scale text-[11px] font-bold text-on-surface-variant hover:text-error bg-surface-container-low hover:bg-error-container/40 px-3 py-2.5 rounded-xl transition-colors flex items-center gap-1 cursor-pointer"><span class="material-symbols-outlined text-xs">close</span> Withdraw</button>
      <button onclick="window.donorCheckIn('${r.id}')" class="press-scale text-xs font-extrabold text-on-success bg-success hover:opacity-90 px-4 py-2.5 rounded-xl shadow-sm shadow-success/20 transition-opacity flex items-center gap-1.5 cursor-pointer"><span class="material-symbols-outlined text-sm">badge</span> Arrived &amp; Check In</button>`;
  } else {
    actions = `<span class="text-xs font-extrabold ${isComplete ? 'text-success' : 'text-on-surface'} px-1">${esc(r.status)}</span>`;
  }

  const nodes = JOURNEY_STEPS.map((s, idx) => {
    const i = idx + 1;
    const done = i < stepNum;
    const current = i === stepNum && !isComplete;
    const isFinalDone = i === N && isComplete;
    const nodeCls = isFinalDone ? 'bg-success text-on-success'
      : (done || (i <= stepNum)) ? 'bg-primary text-on-primary'
      : 'bg-surface-container-high text-on-surface-variant';
    const labelCls = current ? 'text-primary' : (done || isFinalDone || i < stepNum) ? 'text-on-surface' : 'text-on-surface-variant/50';
    return `
      <div class="relative z-10 flex flex-col items-center gap-1.5" style="width:${cell}%">
        <span class="relative w-8 h-8 rounded-full flex items-center justify-center shadow-sm ${nodeCls}">
          ${current ? '<span class="absolute inset-0 rounded-full bg-primary/40 animate-ping"></span>' : ''}
          <span class="material-symbols-outlined relative" style="font-size:16px;font-variation-settings:'FILL' 1">${done ? 'check' : s.icon}</span>
        </span>
        <span class="text-[9px] font-bold text-center leading-tight ${labelCls}">${s.label}</span>
      </div>`;
  }).join('');

  return `
  <div class="hover-lift bg-surface-container-lowest p-5 md:p-6 rounded-3xl border border-outline-variant/20 shadow-sm space-y-5">
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-3.5 min-w-0">
        <span class="w-14 h-14 rounded-2xl bg-error-container/50 text-error flex items-center justify-center font-black text-xl shrink-0 border border-error/20 font-headline">${esc(r.bloodType || r.type || '?')}</span>
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <p class="font-extrabold text-base text-on-surface truncate">${esc(r.hospital || r.hospitalName || 'Hospital')}</p>
            ${publicBadge}
          </div>
          <div class="flex items-center gap-2 mt-1 text-xs text-on-surface-variant font-medium">
            ${liveBadge}
            <span class="truncate">${esc(r.city || 'Cameroon')}${r.matchedDistanceKm ? ' · ~' + r.matchedDistanceKm + ' km' : ''}</span>
            ${updated ? `<span class="text-on-surface-variant/60">· updated ${getTimeAgo(updated)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">${actions}</div>
    </div>

    <!-- Live 6-step journey stepper: filled/checked = done, pulsing = current, hollow = upcoming -->
    <div class="bg-surface-container-low rounded-2xl p-4 pt-5 border border-outline-variant/15">
      <div class="relative">
        <div class="absolute top-4 h-0.5 bg-surface-container-high" style="left:${edge}%; right:${edge}%"></div>
        <div class="absolute top-4 h-0.5 ${isComplete ? 'bg-success' : 'bg-primary'} transition-all duration-500" style="left:${edge}%; width:${progressW}%"></div>
        <div class="relative flex justify-between">${nodes}</div>
      </div>
    </div>

    ${detailsBlock}

    ${passCode ? `<div class="flex items-center gap-2 flex-wrap"><span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Reception pass code</span>${passCode}</div>` : ''}
  </div>`;
}

function renderDonorRequestsList() {
  const container = document.getElementById('donorRequestsList');
  if (!container) return;

  let journeys = [..._activeJourneys];
  if (_currentReqFilter === 'active') {
    journeys = journeys.filter(r => r.status === 'Donor Assigned' || r.status === 'Donor En Route' || r.status === 'Checked In');
  } else if (_currentReqFilter === 'public') {
    journeys = journeys.filter(r => r.isPublicRequest);
  } else if (_currentReqFilter === 'completed') {
    journeys = journeys.filter(r => r.status === 'Completed' || r.status === 'Issued' || r.status === 'Resolved');
  }
  const showPast = _pastDonations.length > 0 && (_currentReqFilter === 'all' || _currentReqFilter === 'completed');

  if (journeys.length === 0 && !showPast) {
    container.innerHTML = '<div class="flex flex-col items-center justify-center py-16 text-on-surface-variant bg-surface-container-lowest border border-outline-variant/20 rounded-3xl shadow-sm"><span class="material-symbols-outlined text-5xl mb-3 text-primary">bloodtype</span><p class="text-base font-bold text-on-surface">No matching requests found</p><p class="text-xs text-on-surface-variant mt-1">Check back soon or explore emergency broadcasts on your dashboard.</p></div>';
    return;
  }

  let html = '';
  if (journeys.length > 0) {
    html += `<div class="flex items-center gap-2 mb-3">
      <span class="material-symbols-outlined text-primary text-xl">route</span>
      <h3 class="font-black text-lg text-on-surface">Active Donation Journeys</h3>
      <span class="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-primary bg-primary/10 px-2.5 py-1 rounded-full"><span class="relative flex w-1.5 h-1.5"><span class="absolute inline-flex w-full h-full rounded-full bg-primary opacity-60 animate-ping"></span><span class="relative inline-flex w-1.5 h-1.5 rounded-full bg-primary"></span></span> Live</span>
    </div>`;
    html += `<div class="space-y-4">${journeys.map(renderDonorJourneyCard).join('')}</div>`;
  }

  if (showPast) {
    const st = {
      'pending': 'bg-warning-container/50 text-on-warning-container border-warning/25',
      'approved': 'bg-success-container/50 text-on-success-container border-success/25',
      'completed': 'bg-tertiary-container/40 text-on-tertiary-container border-tertiary/25',
      'rejected': 'bg-error-container/50 text-error border-error/25',
      'cancelled': 'bg-surface-container text-on-surface-variant border-outline-variant/20',
    };
    html += `<div class="flex items-center gap-2 mt-6 mb-3"><span class="material-symbols-outlined text-warning text-xl">history</span><h3 class="font-black text-lg text-on-surface">Past Scheduled Donations</h3></div>`;
    html += `<div class="space-y-2">` + _pastDonations.map(d => {
      const sc = st[d.status] || st.pending;
      return `
      <div class="bg-surface-container-lowest p-4 rounded-2xl border border-outline-variant/20 flex items-center justify-between gap-3 hover:shadow-sm transition-all">
        <div class="flex items-center gap-3.5 min-w-0">
          <span class="w-11 h-11 rounded-xl bg-error-container/40 text-error flex items-center justify-center font-black text-base shrink-0 font-headline">${esc(d.bloodType || '?')}</span>
          <div class="min-w-0">
            <p class="font-extrabold text-sm text-on-surface truncate">${d.units || 1} Unit${(d.units || 1) > 1 ? 's' : ''} Scheduled</p>
            <p class="text-xs text-on-surface-variant font-medium truncate">${esc(d.preferredLocation || '—')} · ${d.preferredDate ? new Date(d.preferredDate).toLocaleDateString() : '—'}</p>
          </div>
        </div>
        <span class="text-[10px] font-extrabold px-3 py-1 rounded-full border ${sc} uppercase tracking-wider shrink-0">${esc(d.status)}</span>
      </div>`;
    }).join('') + `</div>`;
  }

  container.innerHTML = html;
}

async function loadDonorBadges() {
  const container = document.getElementById('badgesFullView');
  if (!container) return;

  const currentUser = getCurrentUser();
  if (!currentUser) return;

  try {
    const engagement = await computeDonorEngagement(currentUser.uid);
    const donationCount = engagement?.donationCount || 0;
    const totalUnits = engagement?.totalUnits || 0;
    const bloodType = currentUser.bloodType || 'O+';

    // Update Top Tier Hero Stats
    const tierTitle = document.getElementById('donorBadgeTierTitle');
    if (tierTitle && engagement) tierTitle.textContent = `${engagement.tier} Donor`;

    const pointsSummary = document.getElementById('donorBadgePointsSummary');
    if (pointsSummary && engagement) pointsSummary.textContent = `${engagement.points} Pulse Points`;

    // Master Catalog of 3D Achievement Medals
    const masterBadges = [
      {
        id: 'first_donation',
        name: 'First Donation',
        desc: 'Completed your very first blood donation',
        icon: 'favorite',
        unlocked: donationCount >= 1,
        progress: Math.min(100, (donationCount / 1) * 100),
        reqText: '1 donation required',
        gradient: 'from-rose-500 via-red-600 to-red-800',
        ringColor: 'border-rose-300',
        glowColor: 'shadow-rose-500/30',
        badgeBg: 'bg-rose-500',
      },
      {
        id: 'regular_donor',
        name: 'Regular Donor',
        desc: 'Completed 5 life-saving blood donations',
        icon: 'repeat',
        unlocked: donationCount >= 5,
        progress: Math.min(100, (donationCount / 5) * 100),
        reqText: `${donationCount}/5 donations`,
        gradient: 'from-purple-500 via-purple-600 to-indigo-800',
        ringColor: 'border-purple-300',
        glowColor: 'shadow-purple-500/30',
        badgeBg: 'bg-purple-600',
      },
      {
        id: 'life_saver',
        name: 'Life Saver',
        desc: 'Reached 10 donations milestone',
        icon: 'stars',
        unlocked: donationCount >= 10,
        progress: Math.min(100, (donationCount / 10) * 100),
        reqText: `${donationCount}/10 donations`,
        gradient: 'from-amber-400 via-yellow-500 to-amber-700',
        ringColor: 'border-yellow-200',
        glowColor: 'shadow-amber-500/40',
        badgeBg: 'bg-amber-500',
      },
      {
        id: 'guardian_angel',
        name: 'Guardian Angel',
        desc: 'Elite status achieved with 20+ blood donations',
        icon: 'shield',
        unlocked: donationCount >= 20,
        progress: Math.min(100, (donationCount / 20) * 100),
        reqText: `${donationCount}/20 donations`,
        gradient: 'from-teal-400 via-teal-600 to-emerald-800',
        ringColor: 'border-teal-200',
        glowColor: 'shadow-teal-500/30',
        badgeBg: 'bg-teal-600',
      },
      {
        id: 'generous_heart',
        name: 'Generous Heart',
        desc: 'Donated 15+ total blood units to local blood banks',
        icon: 'volunteer_activism',
        unlocked: totalUnits >= 15,
        progress: Math.min(100, (totalUnits / 15) * 100),
        reqText: `${totalUnits}/15 units donated`,
        gradient: 'from-orange-400 via-amber-500 to-orange-700',
        ringColor: 'border-orange-200',
        glowColor: 'shadow-orange-500/30',
        badgeBg: 'bg-orange-500',
      },
      {
        id: 'universal_donor',
        name: 'Universal Donor',
        desc: 'O- Negative universal donor with 3+ active donations',
        icon: 'public',
        unlocked: bloodType === 'O-' && donationCount >= 3,
        progress: bloodType === 'O-' ? Math.min(100, (donationCount / 3) * 100) : 0,
        reqText: bloodType === 'O-' ? `${donationCount}/3 O- donations` : 'O- Blood type required',
        gradient: 'from-emerald-400 via-emerald-600 to-green-800',
        ringColor: 'border-emerald-200',
        glowColor: 'shadow-emerald-500/30',
        badgeBg: 'bg-emerald-600',
      },
    ];

    container.innerHTML = masterBadges.map(b => {
      if (b.unlocked) {
        return `
          <div class="relative bg-surface-container-lowest border border-outline-variant/25 rounded-3xl p-6 shadow-md hover:shadow-xl transition-all duration-300 overflow-hidden group">
            <div class="absolute -top-12 -right-12 w-28 h-28 rounded-full bg-gradient-to-br ${b.gradient} opacity-10 blur-xl pointer-events-none"></div>

            <div class="flex items-start justify-between gap-3 mb-4">
              <!-- 3D Metallic Emblem Shield -->
              <div class="relative w-16 h-16 rounded-2xl bg-gradient-to-tr ${b.gradient} flex items-center justify-center shadow-xl ${b.glowColor} shrink-0 border-2 ${b.ringColor} group-hover:scale-105 transition-transform">
                <div class="absolute inset-0 bg-white/20 rounded-2xl blur-xs"></div>
                <span class="material-symbols-outlined text-3xl text-white relative z-10" style="font-variation-settings: 'FILL' 1;">${b.icon}</span>
              </div>
              <span class="inline-flex items-center gap-1 bg-emerald-500/15 text-emerald-700 text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-wider border border-emerald-500/30">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                UNLOCKED
              </span>
            </div>

            <div class="space-y-1">
              <h3 class="font-extrabold text-base text-on-surface tracking-tight">${b.name}</h3>
              <p class="text-xs text-on-surface-variant leading-relaxed">${b.desc}</p>
            </div>

            <div class="mt-4 pt-3 border-t border-outline-variant/15 flex items-center justify-between text-[11px] font-bold text-emerald-600">
              <span>Achieved & Verified</span>
              <span class="material-symbols-outlined text-sm">verified</span>
            </div>
          </div>
        `;
      } else {
        return `
          <div class="relative bg-surface-container-lowest/60 border border-outline-variant/15 rounded-3xl p-6 shadow-xs opacity-80 hover:opacity-100 transition-all duration-300 overflow-hidden">
            <div class="flex items-start justify-between gap-3 mb-4">
              <!-- Metallic Steel Locked Emblem -->
              <div class="relative w-16 h-16 rounded-2xl bg-gradient-to-tr from-slate-400 via-slate-500 to-slate-700 flex items-center justify-center shadow-inner shrink-0 border-2 border-slate-300/40">
                <span class="material-symbols-outlined text-3xl text-slate-200">${b.icon}</span>
                <div class="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-slate-800 text-white flex items-center justify-center shadow-md">
                  <span class="material-symbols-outlined text-xs">lock</span>
                </div>
              </div>
              <span class="bg-surface-container text-on-surface-variant text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider">
                LOCKED
              </span>
            </div>

            <div class="space-y-1">
              <h3 class="font-bold text-base text-on-surface/80 tracking-tight">${b.name}</h3>
              <p class="text-xs text-on-surface-variant/80 leading-relaxed">${b.desc}</p>
            </div>

            <div class="mt-4 space-y-1.5">
              <div class="flex justify-between text-[10px] font-bold text-on-surface-variant">
                <span>Progress</span>
                <span>${b.reqText}</span>
              </div>
              <div class="h-2 w-full bg-surface-container-high rounded-full overflow-hidden">
                <div class="h-full bg-slate-400 rounded-full transition-all duration-500" style="width: ${b.progress}%"></div>
              </div>
            </div>
          </div>
        `;
      }
    }).join('');
  } catch (e) {
    console.error('Failed to load badges:', e);
    container.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load badges.</div>';
  }
}

async function loadDonorProfile() {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  const nameVal = currentUser.name || currentUser.email?.split('@')[0] || 'Donor';
  const headerNameEl = document.getElementById('donorProfileHeaderName');
  if (headerNameEl) headerNameEl.textContent = nameVal;

  const headerEmailEl = document.getElementById('donorProfileHeaderEmail');
  if (headerEmailEl) headerEmailEl.textContent = currentUser.email || '—';

  const initialsEl = document.getElementById('donorProfileInitials');
  if (initialsEl) initialsEl.textContent = nameVal.slice(0, 2).toUpperCase();

  document.getElementById('donorProfileName').value = currentUser.name || '';
  document.getElementById('donorProfileEmail').value = currentUser.email || '';
  document.getElementById('donorProfileBloodType').value = currentUser.bloodType || 'O+';
  document.getElementById('donorProfileCity').value = currentUser.city || '';
  document.getElementById('donorProfilePhone').value = currentUser.phone || '';

  if (document.getElementById('donorEmergencyContactName')) {
    document.getElementById('donorEmergencyContactName').value = currentUser.emergencyContactName || '';
  }
  if (document.getElementById('donorEmergencyContactPhone')) {
    document.getElementById('donorEmergencyContactPhone').value = currentUser.emergencyContactPhone || '';
  }
  if (document.getElementById('donorProfileNationalId')) {
    document.getElementById('donorProfileNationalId').placeholder = currentUser.cniHash
      ? `CNI Hashed (${currentUser.cniHash.slice(0, 12)}...)`
      : 'Enter National ID (Hashed with SHA-256 for privacy)';
  }

  const cniBadge = document.getElementById('donorCniStatusBadge');
  if (cniBadge) {
    if (currentUser.cniHash) {
      cniBadge.textContent = '🛡️ CNI Verified (SHA-256)';
      cniBadge.className = 'text-[9px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200/50';
    } else {
      cniBadge.textContent = '⚠️ CNI Unverified';
      cniBadge.className = 'text-[9px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200/50';
    }
  }

  renderBloodTypeSourceBadge(currentUser);

  const form = document.getElementById('donorProfileForm');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      btn.innerHTML = 'Saving...';
      btn.disabled = true;
      try {
        const updateData = {
          name: document.getElementById('donorProfileName').value,
          bloodType: document.getElementById('donorProfileBloodType').value,
          city: document.getElementById('donorProfileCity').value,
          phone: document.getElementById('donorProfilePhone').value,
          emergencyContactName: document.getElementById('donorEmergencyContactName')?.value || '',
          emergencyContactPhone: document.getElementById('donorEmergencyContactPhone')?.value || '',
        };

        const newNatId = document.getElementById('donorProfileNationalId')?.value;
        if (newNatId && newNatId.trim()) {
          const hashed = await hashNationalId(newNatId);
          if (hashed) {
            updateData.cniHash = hashed;
            updateData.isCniVerified = true;
          }
        }

        await updateUserProfile(currentUser.uid, updateData);
        const updated = { ...currentUser, ...updateData };
        localStorage.setItem('vitalpulse_user', JSON.stringify(updated));
        showToast('Profile and emergency contact settings saved!');
      } catch (err) {
        console.error('Failed to save profile:', err);
        showToast('Failed to save profile.', 'error');
      } finally {
        btn.innerHTML = 'Save Profile Changes';
        btn.disabled = false;
      }
    };
  }

  const notifSms = document.getElementById('donorNotifSms');
  const notifWhatsapp = document.getElementById('donorNotifWhatsapp');
  if (notifSms) {
    notifSms.checked = currentUser.notifSms !== false;
    notifSms.onchange = async () => {
      try {
        await updateUserProfile(currentUser.uid, { notifSms: notifSms.checked });
        showToast(notifSms.checked ? 'SMS notifications enabled' : 'SMS notifications disabled');
      } catch (err) {
        console.error('Failed to update SMS preference:', err);
        showToast('Failed to save preference.', 'error');
      }
    };
  }
  if (notifWhatsapp) {
    notifWhatsapp.checked = currentUser.notifWhatsapp === true;
    notifWhatsapp.onchange = async () => {
      try {
        await updateUserProfile(currentUser.uid, { notifWhatsapp: notifWhatsapp.checked });
        showToast(notifWhatsapp.checked ? 'WhatsApp notifications enabled' : 'WhatsApp notifications disabled');
      } catch (err) {
        console.error('Failed to update WhatsApp preference:', err);
        showToast('Failed to save preference.', 'error');
      }
    };
  }

  const changePasswordBtn = document.getElementById('btnDonorChangePassword');
  if (changePasswordBtn) {
    changePasswordBtn.onclick = async () => {
      if (!currentUser?.email) return;
      changePasswordBtn.disabled = true;
      const originalText = changePasswordBtn.textContent;
      changePasswordBtn.textContent = 'Sending...';
      try {
        await sendPasswordReset(currentUser.email);
        showToast(`Password reset link sent to ${currentUser.email}`);
      } catch (err) {
        console.error('Failed to send password reset:', err);
        showToast('Failed to send reset email. Please try again.', 'error');
      } finally {
        changePasswordBtn.disabled = false;
        changePasswordBtn.textContent = originalText;
      }
    };
  }
}

// A donor's blood type is self-reported at signup with no lab check behind it. It only becomes
// "Lab-Verified" once a hospital records an actual lab-confirmed type during donation intake
// (see recordDonationIntake in db.js). That confirmation lives on the donation record itself
// rather than being written back onto the donor's own profile — a hospital session doesn't have
// permission to edit another user's account, and a type correction is exactly the kind of change
// that should go through a reviewed step rather than a silent background write.
async function renderBloodTypeSourceBadge(currentUser) {
  const badge = document.getElementById('donorBloodTypeSourceBadge');
  const mismatchNote = document.getElementById('donorBloodTypeMismatchNote');
  if (!badge) return;

  let labConfirmed = null;
  try {
    const donations = await fetchDonationRequestsForDonor(currentUser.uid);
    const verified = donations
      .filter(d => d.status === 'completed' && d.labConfirmedBloodType)
      .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
    if (verified.length > 0) labConfirmed = verified[0].labConfirmedBloodType;
  } catch (e) {
    console.warn('Failed to check lab-verified blood type:', e);
  }

  if (labConfirmed) {
    badge.textContent = 'Lab-Verified';
    badge.className = 'text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700';
    if (mismatchNote) {
      if (labConfirmed !== (currentUser.bloodType || '')) {
        mismatchNote.textContent = `Your last donation was lab-confirmed as ${labConfirmed}, which differs from the type on file here. Please contact hospital staff to update your profile.`;
        mismatchNote.classList.remove('hidden');
      } else {
        mismatchNote.classList.add('hidden');
      }
    }
  } else {
    badge.textContent = 'Self-Reported';
    badge.className = 'text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-700';
    if (mismatchNote) mismatchNote.classList.add('hidden');
  }
}

// Toast = the transient dark pill for quick confirmations; the pill stays a neutral inverse
// surface and only the icon carries the semantic color, which reads cleaner than a fully
// colored pill for every little message.
const TOAST_STYLES = {
  success: { icon: 'check_circle', color: 'text-emerald-400' },
  error: { icon: 'error', color: 'text-red-400' },
  warning: { icon: 'warning', color: 'text-amber-400' },
  info: { icon: 'info', color: 'text-sky-400' },
};
function showToast(message, type = 'success') {
  const toast = document.getElementById('successToast');
  const msgEl = document.getElementById('toastMessage');
  const iconEl = document.getElementById('toastIcon');
  if (!toast || !msgEl) return;
  const style = TOAST_STYLES[type] || TOAST_STYLES.success;
  msgEl.textContent = message;
  if (iconEl) { iconEl.textContent = style.icon; iconEl.className = `material-symbols-outlined text-lg ${style.color}`; }
  toast.classList.remove('opacity-0', 'translate-y-20');
  toast.classList.add('opacity-100', 'translate-y-0');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove('opacity-100', 'translate-y-0');
    toast.classList.add('opacity-0', 'translate-y-20');
  }, 3200);
}

// Professional alert/confirm modal — a promise-based replacement for the browser's alert()
// and confirm(). vpAlert() shows an icon + title + message with one or two actions and
// resolves to true (confirm) / false (cancel/dismiss). vpConfirm() is the two-button shorthand.
const VP_ALERT_STYLES = {
  info: { icon: 'info', wrap: 'bg-tertiary/12 text-tertiary' },
  success: { icon: 'check_circle', wrap: 'bg-success/12 text-success' },
  warning: { icon: 'warning', wrap: 'bg-warning/15 text-warning' },
  error: { icon: 'error', wrap: 'bg-error/12 text-error' },
  question: { icon: 'help', wrap: 'bg-primary/12 text-primary' },
};
window.vpAlert = (opts = {}) => new Promise((resolve) => {
  const { type = 'info', title = '', message = '', confirmText = 'OK', cancelText = null, danger = false } = opts;
  const modal = document.getElementById('vpAlertModal');
  if (!modal) { resolve(window.confirm(message || title)); return; } // graceful fallback
  const s = VP_ALERT_STYLES[type] || VP_ALERT_STYLES.info;
  const iconWrap = document.getElementById('vpAlertIconWrap');
  const titleEl = document.getElementById('vpAlertTitle');
  const msgEl = document.getElementById('vpAlertMessage');
  const confirmBtn = document.getElementById('vpAlertConfirm');
  const cancelBtn = document.getElementById('vpAlertCancel');
  const backdrop = document.getElementById('vpAlertBackdrop');

  iconWrap.className = 'w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 ' + s.wrap;
  document.getElementById('vpAlertIcon').textContent = s.icon;
  titleEl.textContent = title;
  titleEl.classList.toggle('hidden', !title);
  msgEl.textContent = message;
  msgEl.classList.toggle('hidden', !message);
  confirmBtn.textContent = confirmText;
  confirmBtn.className = 'press-scale flex-1 py-3 rounded-2xl font-extrabold text-sm transition-opacity cursor-pointer ' + (danger ? 'bg-error hover:opacity-90 text-on-error' : 'bg-primary hover:opacity-90 text-on-primary');
  if (cancelText) { cancelBtn.textContent = cancelText; cancelBtn.classList.remove('hidden'); }
  else { cancelBtn.classList.add('hidden'); }

  const finish = (result) => {
    modal.classList.add('hidden'); modal.classList.remove('flex');
    confirmBtn.onclick = null; cancelBtn.onclick = null; backdrop.onclick = null;
    document.removeEventListener('keydown', onKey);
    resolve(result);
  };
  const onKey = (e) => { if (e.key === 'Escape') finish(false); else if (e.key === 'Enter') finish(true); };
  confirmBtn.onclick = () => finish(true);
  cancelBtn.onclick = () => finish(false);
  backdrop.onclick = () => finish(false);
  document.addEventListener('keydown', onKey);
  modal.classList.remove('hidden'); modal.classList.add('flex');
  confirmBtn.focus();
});
window.vpConfirm = (message, opts = {}) => window.vpAlert({
  type: opts.danger ? 'warning' : 'question',
  title: opts.title || 'Please confirm',
  message,
  confirmText: opts.confirmText || 'Confirm',
  cancelText: opts.cancelText || 'Cancel',
  danger: !!opts.danger,
});

// A lightweight, single-screen health check before a donor commits to an emergency request —
// kept fast (one click) since this is the time-critical path, but still captures the same kind
// of pre-donation safety signal the fuller "Schedule a Donation" screening does. Both accept
// entry points (the requests feed and the emergency alert banner) go through this modal instead
// of accepting immediately, so hospital staff know to double-check a flagged donor on arrival.
let _pendingAcceptRequest = null;

function openAcceptScreeningModal(requestId, donorId, isPublic = false) {
  _pendingAcceptRequest = { requestId, donorId, isPublic };
  const modal = document.getElementById('acceptScreeningModal');
  if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
}

function closeAcceptScreeningModal() {
  _pendingAcceptRequest = null;
  const modal = document.getElementById('acceptScreeningModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

async function finalizeAcceptRequest(screeningPassed) {
  if (!_pendingAcceptRequest) return;
  const { requestId, donorId, isPublic } = _pendingAcceptRequest;
  closeAcceptScreeningModal();
  try {
    if (isPublic) {
      const res = await acceptPublicRequest(requestId, donorId, { screeningPassed });
      showToast(`Public request accepted! Pass Code: ${res.checkInToken}`);
    } else {
      await acceptRequestDb(requestId, donorId, { screeningPassed });
      showToast(screeningPassed
        ? 'Request accepted! The hospital will be notified.'
        : 'Request accepted — please mention your health-check answer to hospital staff on arrival.');
    }
    loadDonorDashboard();
  } catch (err) {
    console.error('Failed to accept request:', err);
    showToast(err.message || 'Failed to accept request. Please try again.', 'error');
    loadDonorDashboard();
  }
}

let acceptScreeningModalWired = false;
function initAcceptScreeningModal() {
  if (acceptScreeningModalWired) return;
  acceptScreeningModalWired = true;
  const backdrop = document.getElementById('acceptScreeningBackdrop');
  const cancelBtn = document.getElementById('acceptScreeningCancelBtn');
  const clearBtn = document.getElementById('acceptScreeningClearBtn');
  const flagBtn = document.getElementById('acceptScreeningFlagBtn');
  if (backdrop) backdrop.addEventListener('click', closeAcceptScreeningModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeAcceptScreeningModal);
  if (clearBtn) clearBtn.addEventListener('click', () => finalizeAcceptRequest(true));
  if (flagBtn) flagBtn.addEventListener('click', () => finalizeAcceptRequest(false));
}

// Gates the "go available" side of the availability toggle — going available is what makes
// a donor a matching candidate at all, so it needs the same kind of health check the accept
// flow already has. Going unavailable never needs one (it can only make you a safer default).
let _pendingAvailabilityConfirm = null;

function openAvailabilityScreeningModal(onConfirm) {
  _pendingAvailabilityConfirm = onConfirm;
  const modal = document.getElementById('availabilityScreeningModal');
  if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
}

function closeAvailabilityScreeningModal() {
  _pendingAvailabilityConfirm = null;
  const modal = document.getElementById('availabilityScreeningModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

let availabilityScreeningModalWired = false;
function initAvailabilityScreeningModal() {
  if (availabilityScreeningModalWired) return;
  availabilityScreeningModalWired = true;
  const backdrop = document.getElementById('availabilityScreeningBackdrop');
  const cancelBtn = document.getElementById('availabilityScreeningCancelBtn');
  const confirmBtn = document.getElementById('availabilityScreeningConfirmBtn');
  if (backdrop) backdrop.addEventListener('click', closeAvailabilityScreeningModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeAvailabilityScreeningModal);
  if (confirmBtn) confirmBtn.addEventListener('click', async () => {
    const onConfirm = _pendingAvailabilityConfirm;
    closeAvailabilityScreeningModal();
    if (onConfirm) await onConfirm();
  });
}

window.donorAcceptRequest = async (requestId, donorId, isPublic = false) => {
  // Gate: block accepting an emergency request when the donor isn't eligible yet.
  if (!await warnIfIneligible()) return;
  initAcceptScreeningModal();
  openAcceptScreeningModal(requestId, donorId, isPublic);
};

// Live position sharing while "Donor En Route" — a plain watchPosition loop, throttled so
// it writes at most once every 20s (or on a 100m+ move) rather than on every GPS tick, since
// each update is a Firestore write. Only one request can be tracked at a time (matches the
// "one active donation at a time" lock already enforced server-side in acceptRequest).
let _liveTrackingWatchId = null;
let _liveTrackingLastWrite = 0;
let _liveTrackingLastCoords = null;

function distanceMetersApprox(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function startLiveLocationSharing(requestId, isPublic) {
  stopLiveLocationSharing();
  if (!navigator.geolocation || !window.isSecureContext) return;

  _liveTrackingWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const now = Date.now();
      const movedFar = !_liveTrackingLastCoords || distanceMetersApprox(_liveTrackingLastCoords.lat, _liveTrackingLastCoords.lng, lat, lng) >= 100;
      if (now - _liveTrackingLastWrite < 20000 && !movedFar) return;
      _liveTrackingLastWrite = now;
      _liveTrackingLastCoords = { lat, lng };
      updateDonorLiveLocation(requestId, isPublic, lat, lng).catch(() => {});
    },
    (err) => console.warn('Live location watch error:', err.message),
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

function stopLiveLocationSharing() {
  if (_liveTrackingWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(_liveTrackingWatchId);
  }
  _liveTrackingWatchId = null;
  _liveTrackingLastWrite = 0;
  _liveTrackingLastCoords = null;
}

window.donorMarkEnRoute = async (requestId, donorId, isPublic = false) => {
  if (!await window.vpConfirm('Your live location will be shared with the hospital until you check in, so they can prepare for your arrival.', { title: 'Start your trip?', confirmText: 'Start Trip' })) return;
  try {
    await donorSetEnRouteDb(requestId, donorId);
    // Set the tracking id so the journeys listener's reconcile step doesn't restart the watch.
    _enRouteTrackingId = requestId;
    startLiveLocationSharing(requestId, isPublic);
    showToast('You are now marked as en route! The hospital has been notified.');
    loadDonorDashboard();
  } catch (err) {
    console.error('Failed to set en route:', err);
    showToast('Failed to update status. Please try again.', 'error');
  }
};

window.donorCancelRequest = async (requestId) => {
  const currentUser = getCurrentUser();
  if (!currentUser) return;
  if (!await window.vpConfirm('This request will be reopened for other donors. This action cannot be undone.', { title: 'Withdraw from this donation?', confirmText: 'Withdraw', danger: true })) return;
  try {
    _enRouteTrackingId = null;
    stopLiveLocationSharing();
    await donorCancelAssignedRequestDb(requestId, currentUser.uid);
    showToast('You have withdrawn from this request. It is now open for other donors.');
    loadDonorDashboard();
  } catch (err) {
    console.error('Failed to withdraw from request:', err);
    showToast('Failed to withdraw. Please try again.', 'error');
  }
};

window.donorCheckIn = async (requestId) => {
  if (!await window.vpConfirm('Confirm you have arrived at the hospital reception and are ready to donate.', { title: 'Check in now?', confirmText: 'Check In' })) return;
  try {
    _enRouteTrackingId = null;
    stopLiveLocationSharing();
    await checkInDonorDb(requestId);
    showToast('Checked in successfully! Proceed to the donation room.');
    loadDonorDashboard();
  } catch (err) {
    console.error('Check-in failed:', err);
    showToast(err.message || 'Check-in failed. Please try again.', 'error');
  }
};

window.enableLiveGpsLocation = async () => {
  const currentUser = getCurrentUser();
  if (!currentUser) return;
  const statusEl = document.getElementById('gpsStatusText');
  if (statusEl) statusEl.textContent = 'Locating...';
  try {
    const loc = await captureUserLocation(currentUser.city || 'Yaoundé');
    if (loc.source === 'gps') {
      await updateUserProfile(currentUser.uid, { lat: loc.lat, lng: loc.lng, locationSource: 'gps' });
      const updated = { ...currentUser, lat: loc.lat, lng: loc.lng, locationSource: 'gps' };
      localStorage.setItem('vitalpulse_user', JSON.stringify(updated));
      showToast(`Live GPS Enabled! (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`);
      if (statusEl) statusEl.textContent = `GPS Active (${loc.lat.toFixed(2)}, ${loc.lng.toFixed(2)})`;
      loadDonorDashboard();
    } else {
      const msg = loc.reason && loc.reason.includes('HTTPS')
        ? `Browser requires HTTPS or localhost for live GPS. Fallback active for ${currentUser.city || 'Yaoundé'}.`
        : `Using city coordinates for ${currentUser.city || 'Yaoundé'}.`;
      showToast(msg, 'warning');
      if (statusEl) statusEl.textContent = `City: ${currentUser.city || 'Yaoundé'}`;
    }
  } catch (e) {
    console.error('GPS capture failed:', e);
    showToast('Could not retrieve GPS location.', 'error');
    if (statusEl) statusEl.textContent = 'Enable Live GPS Location';
  }
};

// Donation flow — a 3-step wizard: (1) health screening, (2) choose a hospital, (3) pick a date.
let _donationStep = 1;
let _selectedCenter = null;
let _donationHospitals = null; // fetched fresh each time the modal opens
let _centerPickerCount = 8;    // how many hospitals the step-2 picker shows before "Show more"
let _preselectedCenter = null; // a hospital chosen from the dashboard "Donate here" cards

// Short pre-donation health screen — each question is worded so "Yes" is the concerning
// answer. This doesn't medically clear or block anyone (that's the hospital's job at intake),
// it just surfaces obvious unsafe situations before a donor commits, per basic blood-bank
// screening practice.
const SCREENING_QUESTIONS = [
  { id: 'illness', label: 'Have you felt unwell or had a fever in the last 2 weeks?', icon: 'sick' },
  { id: 'medication', label: 'Are you currently taking antibiotics or other medication?', icon: 'medication' },
  { id: 'pregnancy', label: 'Are you pregnant, or did you give birth in the last 6 weeks?', icon: 'pregnant_woman' },
  { id: 'malariaTravel', label: 'Have you traveled to a malaria-risk area in the last month?', icon: 'flight_takeoff' },
  { id: 'tattooPiercing', label: 'Did you get a new tattoo or piercing in the last 4 months?', icon: 'draw' },
  { id: 'lowIron', label: 'Do you know your iron/hemoglobin level to be low?', icon: 'water_drop' },
];
let _screeningAnswers = {};

function renderScreeningQuestions() {
  const container = document.getElementById('donationScreeningQuestions');
  if (!container) return;
  container.innerHTML = SCREENING_QUESTIONS.map((q, i) => `
    <div class="flex items-center justify-between gap-3 py-2.5 ${i > 0 ? 'border-t border-outline-variant/15' : ''}" data-screening-row="${q.id}">
      <div class="flex items-center gap-2.5 flex-1 min-w-0">
        <div class="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[16px] text-on-surface-variant">${q.icon}</span>
        </div>
        <p class="text-xs font-semibold text-on-surface leading-snug">${q.label}</p>
      </div>
      <div class="flex items-center gap-1 bg-surface-container-high rounded-full p-0.5 shrink-0">
        <button type="button" data-screening-answer="${q.id}:yes" class="screening-answer-btn px-3 py-1.5 rounded-full text-[11px] font-bold text-on-surface-variant transition-colors duration-200 cursor-pointer">Yes</button>
        <button type="button" data-screening-answer="${q.id}:no" class="screening-answer-btn px-3 py-1.5 rounded-full text-[11px] font-bold text-on-surface-variant transition-colors duration-200 cursor-pointer">No</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.screening-answer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const [id, answer] = btn.dataset.screeningAnswer.split(':');
      _screeningAnswers[id] = answer === 'yes';
      const row = container.querySelector(`[data-screening-row="${id}"]`);
      row.querySelectorAll('.screening-answer-btn').forEach(b => {
        const isSelected = b === btn;
        const isYes = b.dataset.screeningAnswer.endsWith(':yes');
        // "Yes" to a screening question flags a possible deferral (error/red); "No" is the
        // all-clear (success/green). Both token-based so they read correctly in dark mode.
        b.className = 'screening-answer-btn px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors duration-200 cursor-pointer ' +
          (isSelected
            ? (isYes ? 'bg-error text-on-error shadow-sm' : 'bg-success text-on-success shadow-sm')
            : 'text-on-surface-variant');
      });
      updateScreeningProgress();
    });
  });
  updateScreeningProgress();
}

function getScreeningFlags() {
  return SCREENING_QUESTIONS.filter(q => _screeningAnswers[q.id] === true).map(q => q.id);
}

function updateScreeningProgress() {
  const answeredCount = SCREENING_QUESTIONS.filter(q => typeof _screeningAnswers[q.id] === 'boolean').length;
  const progressBadge = document.getElementById('donationScreeningProgress');
  if (progressBadge) {
    progressBadge.textContent = `${answeredCount}/${SCREENING_QUESTIONS.length}`;
    progressBadge.className = 'text-[10px] font-bold shadow-sm px-2 py-1 rounded-full shrink-0 bg-surface-container-lowest ' +
      (answeredCount === SCREENING_QUESTIONS.length ? 'text-success' : 'text-warning');
  }

  const warning = document.getElementById('donationScreeningWarning');
  const flags = getScreeningFlags();
  if (warning) {
    if (flags.length > 0) { warning.classList.remove('hidden'); warning.classList.add('flex'); }
    else { warning.classList.add('hidden'); warning.classList.remove('flex'); }
  }

  const nextBtn = document.getElementById('donationNextBtn');
  if (nextBtn && _donationStep === 1) nextBtn.disabled = answeredCount < SCREENING_QUESTIONS.length;
}

// Real, verified hospitals from the system — replaces the old hardcoded fake center list,
// which broke down the moment there was more than a handful of hospitals (and didn't even
// correspond to real hospital accounts). Fetched fresh each time the modal opens so a
// newly-verified hospital shows up without a page reload.
async function loadDonationHospitals() {
  const list = document.getElementById('donationCenterList');
  if (list) list.innerHTML = `<div class="flex items-center justify-center py-10 text-on-surface-variant"><span class="material-symbols-outlined animate-spin text-lg mr-2">sync</span><span class="text-sm font-medium">Loading hospitals...</span></div>`;
  try {
    const all = await fetchAllHospitals();
    _donationHospitals = all.filter(h => h.isVerified === true && h.isActive !== false);
  } catch (e) {
    console.warn('Failed to load hospitals:', e);
    _donationHospitals = [];
  }
  renderDonationCenters();
}

function renderDonationCenters(searchTerm = '') {
  const list = document.getElementById('donationCenterList');
  if (!list) return;
  const hospitals = _donationHospitals || [];

  if (hospitals.length === 0) {
    list.innerHTML = `<div class="flex flex-col items-center justify-center py-10 text-on-surface-variant"><span class="material-symbols-outlined text-3xl mb-2">local_hospital</span><p class="text-sm font-medium">No verified hospitals available yet</p></div>`;
    return;
  }

  const currentUser = getCurrentUser();
  const donorCity = (currentUser?.city || '').toLowerCase().trim();
  const q = searchTerm.toLowerCase().trim();

  let filtered = hospitals.filter(h =>
    !q || (h.name || '').toLowerCase().includes(q) || (h.city || '').toLowerCase().includes(q)
  );

  // Donor's own city first, alphabetical within each group — helps once the list is long.
  filtered = filtered.sort((a, b) => {
    const aNear = (a.city || '').toLowerCase() === donorCity ? 0 : 1;
    const bNear = (b.city || '').toLowerCase() === donorCity ? 0 : 1;
    if (aNear !== bNear) return aNear - bNear;
    return (a.name || '').localeCompare(b.name || '');
  });

  if (filtered.length === 0) {
    list.innerHTML = `<div class="flex flex-col items-center justify-center py-10 text-on-surface-variant"><span class="material-symbols-outlined text-3xl mb-2">search_off</span><p class="text-sm font-medium">No hospitals match "${esc(searchTerm)}"</p><p class="text-xs mt-1">Try a different name or city</p></div>`;
    return;
  }

  // Paginate so a 50-hospital (or larger) network doesn't render every card at once. Search
  // narrows first; "Show more" reveals the next batch. Tokenized colors so it fits the theme
  // and works in dark mode (was hardcoded teal/slate).
  const shown = filtered.slice(0, _centerPickerCount);
  const cards = shown.map(h => {
    const isNear = (h.city || '').toLowerCase() === donorCity && donorCity;
    const isSelected = _selectedCenter === h.name;
    return `
    <button type="button" data-center="${esc(h.name)}"
      class="donation-center-btn press-scale w-full flex items-center gap-3 p-3.5 rounded-xl border-2 ${isSelected ? 'border-primary bg-primary/8' : 'border-outline-variant/25'} hover:border-primary/50 hover:bg-primary/5 transition-colors duration-200 text-left cursor-pointer">
      <div class="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-xl">local_hospital</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5">
          <p class="font-bold text-sm text-on-surface truncate">${esc(h.name)}</p>
          <span class="material-symbols-outlined text-primary text-[15px]" title="Verified hospital" style="font-variation-settings:'FILL' 1">verified</span>
        </div>
        <p class="text-xs text-on-surface-variant">${esc(h.city || 'Unknown city')}</p>
      </div>
      ${isSelected ? '<span class="material-symbols-outlined text-primary shrink-0">check_circle</span>' : (isNear ? '<span class="text-[9px] font-bold text-primary bg-primary/10 px-2 py-1 rounded-full shrink-0">Near you</span>' : '')}
    </button>
  `;
  }).join('');
  const moreCount = filtered.length - shown.length;
  const moreBtn = moreCount > 0
    ? `<button type="button" id="centerPickerMore" class="press-scale w-full text-center text-primary font-bold text-xs py-2.5 hover:underline cursor-pointer">Show ${Math.min(8, moreCount)} more of ${filtered.length} hospitals</button>`
    : '';
  list.innerHTML = cards + moreBtn;

  list.querySelectorAll('.donation-center-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _selectedCenter = btn.dataset.center;
      renderDonationCenters(document.getElementById('donationHospitalSearch')?.value || '');
      const nextBtn = document.getElementById('donationNextBtn');
      if (nextBtn && _donationStep === 2) nextBtn.disabled = false;
    });
  });
  list.querySelector('#centerPickerMore')?.addEventListener('click', () => {
    _centerPickerCount += 8;
    renderDonationCenters(document.getElementById('donationHospitalSearch')?.value || '');
  });
}

// A small helper for the 3 circle+bar indicators in the modal header — keeps
// showDonationStep readable instead of repeating this per step.
function setStepIndicator(circleEl, labelEl, state) {
  if (!circleEl) return;
  if (state === 'done') {
    circleEl.className = 'w-7 h-7 rounded-full bg-primary text-on-primary flex items-center justify-center text-xs font-black shrink-0';
    circleEl.innerHTML = '<span class="material-symbols-outlined text-sm">check</span>';
  } else if (state === 'active') {
    circleEl.className = 'w-7 h-7 rounded-full bg-primary text-on-primary flex items-center justify-center text-xs font-black shrink-0 shadow-sm';
  } else {
    circleEl.className = 'w-7 h-7 rounded-full bg-surface-container-high text-on-surface-variant flex items-center justify-center text-xs font-black shrink-0';
  }
  if (labelEl) labelEl.className = `text-[10px] font-bold hidden sm:inline ${state === 'pending' ? 'text-on-surface-variant/60' : 'text-on-surface'}`;
}

function showDonationStep(step) {
  _donationStep = step;
  const panels = { 1: document.getElementById('donationStep1'), 2: document.getElementById('donationStep2'), 3: document.getElementById('donationStep3') };
  Object.entries(panels).forEach(([n, el]) => {
    if (!el) return;
    if (Number(n) === step) { el.classList.remove('hidden'); } else { el.classList.add('hidden'); }
  });

  const backBtn = document.getElementById('donationBackBtn');
  const nextBtn = document.getElementById('donationNextBtn');
  const confirmBtn = document.getElementById('donationConfirmBtn');
  const progress1 = document.getElementById('donationStepProgress1');
  const progress2 = document.getElementById('donationStepProgress2');
  const s1Circle = document.querySelector('#donationStep1Indicator > div');
  const s1Label = document.querySelector('#donationStep1Indicator > span');
  const s2Circle = document.getElementById('donationStep2Circle');
  const s2Label = document.getElementById('donationStep2Label');
  const s3Circle = document.getElementById('donationStep3Circle');
  const s3Label = document.getElementById('donationStep3Label');

  backBtn.classList.toggle('hidden', step === 1);
  nextBtn.classList.toggle('hidden', step === 3);
  confirmBtn.classList.toggle('hidden', step !== 3);

  setStepIndicator(s1Circle, s1Label, step > 1 ? 'done' : 'active');
  setStepIndicator(s2Circle, s2Label, step > 2 ? 'done' : step === 2 ? 'active' : 'pending');
  setStepIndicator(s3Circle, s3Label, step === 3 ? 'active' : 'pending');
  if (progress1) progress1.style.width = step > 1 ? '100%' : '0%';
  if (progress2) progress2.style.width = step > 2 ? '100%' : '0%';

  if (step === 1) {
    updateScreeningProgress();
  } else if (step === 2) {
    nextBtn.disabled = !_selectedCenter;
  } else if (step === 3) {
    const summary = document.getElementById('donationSummary');
    if (summary && _selectedCenter) {
      summary.classList.remove('hidden');
      document.getElementById('donationSummaryCenter').textContent = _selectedCenter;
      const dateVal = document.getElementById('donationDate').value;
      document.getElementById('donationSummaryDate').textContent = dateVal
        ? new Date(dateVal + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
        : 'Pick a date above';
    }
  }
}

window._donationNextStep = () => {
  if (_donationStep === 1 && !document.getElementById('donationNextBtn').disabled) showDonationStep(2);
  else if (_donationStep === 2 && _selectedCenter) showDonationStep(3);
};

window._donationPrevStep = () => {
  if (_donationStep > 1) showDonationStep(_donationStep - 1);
};

window._donationConfirm = async () => {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  // Final eligibility backstop at the commit point (in case state changed since opening).
  if (!await warnIfIneligible()) { closeDonationModal(); return; }

  const dateInput = document.getElementById('donationDate');
  if (!dateInput || !dateInput.value) {
    showToast('Please pick a date');
    return;
  }

  const confirmBtn = document.getElementById('donationConfirmBtn');
  confirmBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin mr-1">sync</span> Confirming...';
  confirmBtn.disabled = true;

  try {
    const screeningFlags = getScreeningFlags();
    await submitDonationRequest(currentUser.uid, {
      donorId: currentUser.uid,
      donorName: currentUser.name || currentUser.email?.split('@')[0] || 'Donor',
      donorEmail: currentUser.email,
      donorPhone: currentUser.phone || null,
      bloodType: currentUser.bloodType || 'O+',
      units: 1,
      preferredDate: dateInput.value,
      preferredLocation: _selectedCenter,
      notes: document.getElementById('donationNotes').value,
      screeningAnswers: { ..._screeningAnswers },
      screeningFlags,
      screeningPassed: screeningFlags.length === 0,
    });
    closeDonationModal();
    showToast('Donation scheduled!');
    loadDonorDashboard();
    loadDonorDonations();
  } catch (err) {
    console.error('Failed to submit donation:', err);
    showToast('Failed to schedule. Please try again.');
  } finally {
    confirmBtn.innerHTML = 'Confirm donation';
    confirmBtn.disabled = false;
  }
};

export function initDonorDonationFlow() {
  const backdrop = document.getElementById('donationBackdrop');

  if (backdrop) backdrop.addEventListener('click', () => window.closeDonationModal());

  const dateInput = document.getElementById('donationDate');
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      const summaryDate = document.getElementById('donationSummaryDate');
      if (summaryDate && dateInput.value) {
        summaryDate.textContent = new Date(dateInput.value + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      }
    });
  }

  const hospitalSearch = document.getElementById('donationHospitalSearch');
  if (hospitalSearch) {
    // A new search is a new result set — reset pagination to the first batch each keystroke.
    hospitalSearch.addEventListener('input', () => { _centerPickerCount = 8; renderDonationCenters(hospitalSearch.value); });
  }

  initMyDonationsModal();
}

function initMyDonationsModal() {
  const modal = document.getElementById('myDonationsModal');
  const backdrop = document.getElementById('myDonationsBackdrop');
  const closeBtn = document.getElementById('btnCloseMyDonations');

  const openModal = async () => {
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      await loadDonorDonations();
    }
  };
  const closeModal = () => {
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
  };

  if (backdrop) backdrop.addEventListener('click', closeModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
}

export async function loadDonorDonations() {
  const listEl = document.getElementById('myDonationsList');
  if (!listEl) return;

  const currentUser = getCurrentUser();
  if (!currentUser) {
    listEl.innerHTML = '<p class="text-center text-on-surface-variant py-4 text-xs font-bold">Please log in to view history.</p>';
    return;
  }

  try {
    const donations = await fetchDonationRequestsForDonor(currentUser.uid);
    if (donations.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-12 space-y-3">
          <div class="w-16 h-16 rounded-full bg-surface-container-low text-on-surface-variant/40 mx-auto flex items-center justify-center">
            <span class="material-symbols-outlined text-3xl">receipt_long</span>
          </div>
          <p class="text-xs font-bold text-on-surface-variant">No donation history recorded yet</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = donations.map(d => {
      const statusBadges = {
        'pending': 'bg-amber-500/15 text-amber-700 border-amber-500/30',
        'approved': 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
        'rejected': 'bg-rose-500/15 text-rose-700 border-rose-500/30',
        'completed': 'bg-blue-500/15 text-blue-700 border-blue-500/30',
        'cancelled': 'bg-surface-container text-on-surface-variant border-outline-variant/30',
      };
      const sc = statusBadges[d.status] || statusBadges['pending'];
      const date = d.preferredDate ? new Date(d.preferredDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date not set';
      
      return `
      <div class="p-4 bg-surface-container-low/60 rounded-2xl border border-outline-variant/20 hover:border-outline-variant/40 transition-all space-y-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-primary to-rose-500 text-white flex items-center justify-center font-black text-sm shadow-sm shrink-0">
              ${d.bloodType || 'O+'}
            </div>
            <div>
              <p class="font-extrabold text-sm text-on-surface">${d.units || 1} Unit${(d.units || 1) > 1 ? 's' : ''} Blood Gift</p>
              <p class="text-[11px] font-medium text-on-surface-variant flex items-center gap-1 mt-0.5">
                <span class="material-symbols-outlined text-xs text-primary">location_on</span>
                ${d.preferredLocation || 'Hospital Center'}
              </p>
            </div>
          </div>
          <span class="px-2.5 py-1 ${sc} text-[10px] font-black rounded-full uppercase tracking-wider border">${d.status}</span>
        </div>
        <div class="pt-2 border-t border-outline-variant/10 flex items-center justify-between text-[11px] text-on-surface-variant font-medium">
          <span class="flex items-center gap-1"><span class="material-symbols-outlined text-xs">calendar_today</span> ${date}</span>
          ${d.labConfirmedBloodType ? `<span class="text-emerald-600 font-bold flex items-center gap-1"><span class="material-symbols-outlined text-xs">verified</span> Lab Verified (${d.labConfirmedBloodType})</span>` : ''}
        </div>
      </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load donations:', err);
    listEl.innerHTML = '<p class="text-center text-error py-4">Failed to load.</p>';
  }
}

// Make switchDonorView globally accessible for inline onclick handlers
window.switchDonorView = switchDonorView;
// ============================================
// PHASE 3: CARE REMINDERS VIEW
// ============================================

async function loadCareRemindersView() {
  const container = document.getElementById('careRemindersContent');
  if (!container) return;
  const currentUser = getCurrentUser();
  if (!currentUser) {
    container.innerHTML = '<div class="text-center py-12 text-on-surface-variant"><p class="text-sm font-bold">Please log in to view care reminders.</p></div>';
    return;
  }

  try {
    const reminders = await fetchCareReminders(currentUser.uid);
    if (reminders.length === 0) {
      container.innerHTML = '<div class="text-center py-16 space-y-4"><div class="w-20 h-20 rounded-full bg-emerald-50 text-emerald-400 mx-auto flex items-center justify-center"><span class="material-symbols-outlined text-4xl">favorite</span></div><h3 class="font-bold text-lg text-on-surface">No Care Reminders Yet</h3><p class="text-sm text-on-surface-variant max-w-sm mx-auto">After your next blood donation, you will receive personalized care reminders here to help you recover quickly and safely.</p><button onclick="window.openDonationModal()" class="inline-flex items-center gap-2 bg-gradient-to-r from-primary to-rose-600 text-white font-bold text-xs px-6 py-3 rounded-2xl shadow-md hover:opacity-90 cursor-pointer"><span class="material-symbols-outlined text-sm">event_available</span> Schedule a Donation</button></div>';
      return;
    }

    const categoryIcons = {
      immediate: { icon: 'water_drop', color: 'text-blue-600 bg-blue-50', label: 'Immediate' },
      nutrition: { icon: 'restaurant', color: 'text-amber-600 bg-amber-50', label: 'Nutrition' },
      aftercare: { icon: 'healing', color: 'text-emerald-600 bg-emerald-50', label: 'Aftercare' },
      schedule: { icon: 'event_available', color: 'text-purple-600 bg-purple-50', label: 'Schedule' },
    };

    const activeReminders = reminders.filter(r => !r.dismissed);
    const dismissedReminders = reminders.filter(r => r.dismissed);

    let html = '<div class="space-y-4">';
    if (activeReminders.length > 0) {
      html += '<h3 class="text-xs font-bold text-on-surface-variant uppercase tracking-widest px-1">Active Reminders (' + activeReminders.length + ')</h3>';
      html += '<div class="space-y-3">';
      activeReminders.forEach(r => {
        const cat = categoryIcons[r.category] || categoryIcons.immediate;
        const isOverdue = new Date(r.dueDate) < new Date();
        html += '<div class="bg-surface-container-lowest p-5 rounded-2xl border border-outline-variant/20 shadow-sm hover:shadow-md transition-all space-y-3">';
        html += '<div class="flex items-start justify-between gap-3"><div class="flex items-start gap-3.5">';
        html += '<div class="w-11 h-11 rounded-xl ' + cat.color + ' flex items-center justify-center shrink-0 shadow-sm"><span class="material-symbols-outlined text-xl">' + (r.icon || cat.icon) + '</span></div>';
        html += '<div class="space-y-1"><div class="flex items-center gap-2 flex-wrap">';
        html += '<h4 class="font-extrabold text-sm text-on-surface">' + esc(r.title) + '</h4>';
        html += '<span class="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ' + cat.color + '">' + cat.label + '</span>';
        if (isOverdue) html += '<span class="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-red-50 text-red-600">Overdue</span>';
        html += '</div>';
        html += '<p class="text-xs text-on-surface-variant leading-relaxed font-medium">' + esc(r.message) + '</p>';
        html += '<p class="text-[10px] text-on-surface-variant/60 flex items-center gap-1 mt-1"><span class="material-symbols-outlined text-xs">schedule</span>';
        html += r.dueDate ? 'Due: ' + new Date(r.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        html += r.hospitalName ? ' &#8226; ' + esc(r.hospitalName) : '';
        html += '</p></div></div></div>';
        html += '<div class="flex justify-end"><button onclick="window.dismissReminder(\'' + r.id + '\')" class="inline-flex items-center gap-1.5 text-[11px] font-bold text-on-surface-variant hover:text-primary bg-surface-container-low hover:bg-primary/10 px-3.5 py-2 rounded-xl transition-colors cursor-pointer"><span class="material-symbols-outlined text-xs">check_circle</span> Acknowledged</button></div>';
        html += '</div>';
      });
      html += '</div>';
    }

    if (dismissedReminders.length > 0) {
      html += '<details class="group"><summary class="cursor-pointer text-xs font-bold text-on-surface-variant/60 hover:text-on-surface-variant px-1 py-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-sm group-open:rotate-90 transition-transform">chevron_right</span>Completed Reminders (' + dismissedReminders.length + ')</summary>';
      html += '<div class="space-y-2 mt-2">';
      dismissedReminders.slice(0, 5).forEach(r => {
        html += '<div class="bg-surface-container-low/50 p-3.5 rounded-xl border border-outline-variant/10 flex items-center gap-3 opacity-60"><span class="material-symbols-outlined text-sm text-success">check_circle</span><div class="flex-1 min-w-0"><p class="text-xs font-bold text-on-surface truncate">' + esc(r.title) + '</p><p class="text-[10px] text-on-surface-variant/60">' + esc((r.message || '').substring(0, 80)) + '...</p></div></div>';
      });
      html += '</div></details>';
    }

    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    console.error('Failed to load care reminders:', e);
    container.innerHTML = '<div class="text-center py-12 text-error"><p class="text-sm font-bold">Failed to load care reminders.</p></div>';
  }
}

window.dismissReminder = async (reminderId) => {
  try {
    await dismissCareReminder(reminderId);
    showToast('Reminder acknowledged!');
    loadCareRemindersView();
  } catch (e) {
    showToast('Failed to update reminder.', 'error');
  }
};


// ============================================
// PHASE 3: DONOR MYTH-BUSTING HUB
// ============================================

async function loadMythHubView() {
  const container = document.getElementById('mythHubContent');
  if (!container) return;

  try {
    const articles = await fetchMythArticles();
    if (articles.length === 0) {
      container.innerHTML = '<div class="text-center py-16 space-y-4"><div class="w-20 h-20 rounded-full bg-purple-50 text-purple-400 mx-auto flex items-center justify-center"><span class="material-symbols-outlined text-4xl">psychology</span></div><h3 class="font-bold text-lg text-on-surface">Myth-Busting Hub Coming Soon</h3><p class="text-sm text-on-surface-variant max-w-sm mx-auto">Hospital partners are preparing educational content to debunk common blood donation myths. Check back soon!</p></div>';
      return;
    }

    const categoryColors = {
      health: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
      safety: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
      process: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
      general: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
    };

    let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-5">';
    articles.forEach(a => {
      const cat = categoryColors[a.category] || categoryColors.general;
      html += '<div class="bg-surface-container-lowest rounded-2xl border border-outline-variant/20 overflow-hidden shadow-sm hover:shadow-lg transition-all group">';
      html += '<div class="p-5 space-y-4">';
      html += '<div class="flex items-start justify-between gap-2"><span class="text-[9px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full ' + cat.bg + ' ' + cat.text + ' border ' + cat.border + '">' + esc(a.category || 'general') + '</span>';
      if (a.authorName) html += '<span class="text-[10px] text-on-surface-variant/60">by ' + esc(a.authorName) + '</span>';
      html += '</div>';
      html += '<div class="bg-red-50/70 border border-red-200/50 rounded-xl p-4 space-y-2"><div class="flex items-center gap-2"><span class="material-symbols-outlined text-red-500 text-lg">cancel</span><span class="text-[10px] font-extrabold text-red-600 uppercase tracking-widest">MYTH</span></div><p class="text-sm font-bold text-red-800 leading-relaxed">' + esc(a.myth) + '</p></div>';
      html += '<div class="bg-emerald-50/70 border border-emerald-200/50 rounded-xl p-4 space-y-2"><div class="flex items-center gap-2"><span class="material-symbols-outlined text-emerald-600 text-lg">check_circle</span><span class="text-[10px] font-extrabold text-emerald-700 uppercase tracking-widest">FACT</span></div><p class="text-sm font-semibold text-emerald-900 leading-relaxed">' + esc(a.fact) + '</p></div>';
      if (a.title) html += '<h4 class="text-xs font-extrabold text-on-surface">' + esc(a.title) + '</h4>';
      html += '</div>';
      html += '<div class="px-5 py-3 border-t border-outline-variant/10 flex items-center justify-between bg-surface-container-low/30">';
      html += '<button onclick="window.handleLikeMyth(\'' + a.id + '\')" class="inline-flex items-center gap-1.5 text-[11px] font-bold text-on-surface-variant hover:text-primary transition-colors cursor-pointer px-3 py-1.5 rounded-lg hover:bg-primary/5"><span class="material-symbols-outlined text-sm">thumb_up</span>Helpful (' + (a.likes || 0) + ')</button>';
      html += '<span class="text-[10px] text-on-surface-variant/40">' + (a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '') + '</span>';
      html += '</div></div>';
    });
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    console.error('Failed to load myth hub:', e);
    container.innerHTML = '<div class="text-center py-12 text-error"><p class="text-sm font-bold">Failed to load articles.</p></div>';
  }
}

window.handleLikeMyth = async (articleId) => {
  try {
    await likeMythArticle(articleId, true);
    showToast('Thanks for your feedback!');
    loadMythHubView();
  } catch (e) {
    showToast('Failed to record feedback.', 'error');
  }
};


// ============================================
// PHASE 3: LIFE SAVER CERTIFICATES (DONOR VIEW)
// ============================================

async function loadCertificatesView() {
  const container = document.getElementById('certificatesContent');
  if (!container) return;
  const currentUser = getCurrentUser();
  if (!currentUser) {
    container.innerHTML = '<div class="text-center py-12 text-on-surface-variant"><p class="text-sm font-bold">Please log in to view certificates.</p></div>';
    return;
  }

  try {
    const certs = await fetchLifeSaverCertificates(currentUser.uid);
    if (certs.length === 0) {
      container.innerHTML = '<div class="text-center py-16 space-y-4"><div class="w-20 h-20 rounded-full bg-amber-50 text-amber-400 mx-auto flex items-center justify-center"><span class="material-symbols-outlined text-4xl">workspace_premium</span></div><h3 class="font-bold text-lg text-on-surface">No Certificates Yet</h3><p class="text-sm text-on-surface-variant max-w-sm mx-auto">Complete life-saving blood donations to earn official VitalPulse Life Saver Certificates from your hospital partners.</p><button onclick="window.openDonationModal()" class="inline-flex items-center gap-2 bg-gradient-to-r from-primary to-rose-600 text-white font-bold text-xs px-6 py-3 rounded-2xl shadow-md hover:opacity-90 cursor-pointer"><span class="material-symbols-outlined text-sm">event_available</span> Schedule a Donation</button></div>';
      return;
    }

    let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-5">';
    certs.forEach(c => {
      html += '<div class="bg-surface-container-lowest rounded-2xl border-2 border-amber-200/50 overflow-hidden shadow-sm hover:shadow-lg transition-all group">';
      html += '<div class="relative bg-gradient-to-br from-amber-50 via-yellow-50 to-orange-50 p-6 text-center space-y-3">';
      html += '<div class="absolute top-0 right-0 p-3 opacity-10 pointer-events-none"><span class="material-symbols-outlined text-6xl text-amber-700">workspace_premium</span></div>';
      html += '<div class="w-16 h-16 rounded-full bg-gradient-to-br from-amber-400 to-yellow-500 text-white mx-auto flex items-center justify-center shadow-lg shadow-amber-400/30"><span class="material-symbols-outlined text-3xl" style="font-variation-settings:\'FILL\' 1">military_tech</span></div>';
      html += '<h3 class="font-extrabold text-base text-amber-900">Life Saver Certificate</h3>';
      html += '<p class="text-[10px] font-bold text-amber-700 uppercase tracking-widest">' + esc(c.certificateNumber) + '</p>';
      html += '</div>';
      html += '<div class="p-5 space-y-3">';
      html += '<div class="grid grid-cols-2 gap-3 text-center">';
      html += '<div class="bg-surface-container-low rounded-xl p-3"><p class="text-xl font-black text-primary">' + (c.donationCount || 0) + '</p><p class="text-[10px] font-bold text-on-surface-variant uppercase">Donations</p></div>';
      html += '<div class="bg-surface-container-low rounded-xl p-3"><p class="text-xl font-black text-success">' + (c.unitsDonated || 0) + '</p><p class="text-[10px] font-bold text-on-surface-variant uppercase">Units Given</p></div>';
      html += '</div>';
      html += '<div class="space-y-1.5 text-xs text-on-surface-variant font-medium">';
      html += '<div class="flex items-center gap-2"><span class="material-symbols-outlined text-sm text-primary">local_hospital</span><span class="font-bold text-on-surface">' + esc(c.hospitalName) + '</span></div>';
      html += '<div class="flex items-center gap-2"><span class="material-symbols-outlined text-sm text-primary">bloodtype</span><span>Blood Type: <strong>' + esc(c.bloodType) + '</strong></span></div>';
      html += '<div class="flex items-center gap-2"><span class="material-symbols-outlined text-sm text-primary">calendar_today</span><span>Issued: ' + (c.issuedDate ? new Date(c.issuedDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '---') + '</span></div>';
      html += '</div></div></div>';
    });
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    console.error('Failed to load certificates:', e);
    container.innerHTML = '<div class="text-center py-12 text-error"><p class="text-sm font-bold">Failed to load certificates.</p></div>';
  }
}

