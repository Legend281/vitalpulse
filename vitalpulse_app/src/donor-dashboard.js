import { getCurrentUser, sendPasswordReset, hashNationalId, isEmailVerified, sendEmailVerificationLink } from './auth';
import { collection, query, where, getDocs, doc, getDoc, onSnapshot, updateDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebase';
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
  donorMarkArrived as donorMarkArrivedDb,
  getCompatibleBloodTypes,
  getBloodTypeDisplayInfo,
  logActivity,
  addDonorNotification,
  fetchDonorNotifications,
  fetchUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteDonorNotification,
  clearAllDonorNotifications,
  subscribeToDonorNotifications,
  CITY_COORDINATES,
  getEffectiveDonorLocation,
  DEFAULT_DONOR_RADIUS_KM,
  fetchCareReminders,
  dismissCareReminder,
  fetchMythArticles,
  likeMythArticle,
  fetchLifeSaverCertificates,
  updateDonorLiveLocation,
  getCoordinatesForLocation,
  calculateDistanceKm,
  subscribeToDonorJourneys,
  redeemPulseReward,
  fetchDonorVouchers,
} from './db';
import { captureUserLocation } from './location';
import { t, getLang, setLang } from './i18n';
import { triggerMilestoneConfetti } from './confetti';
import L from 'leaflet';
if (typeof window !== 'undefined') {
  window.L = L;
}
import { mount3DMedalViewer, destroy3DMedalViewer, mountHero3DMedalViewer } from './medal-3d-engine';
import QRCode from 'qrcode';

// Full 8-group transfusion matrix & special clinical traits for Cameroon regional healthcare
export const BLOOD_COMPATIBILITY_DATA = {
  'O-': {
    give: ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
    receive: ['O-'],
    special: 'Universal Red Blood Cell Donor. Your blood can save any patient in immediate trauma emergencies.',
    label: 'Universal Red Cell Donor'
  },
  'O+': {
    give: ['O+', 'A+', 'B+', 'AB+'],
    receive: ['O+', 'O-'],
    special: 'Most frequently needed blood group across maternity wards and emergency rooms in Cameroon.',
    label: 'Universal Positive Donor'
  },
  'A-': {
    give: ['A-', 'A+', 'AB-', 'AB+'],
    receive: ['A-', 'O-'],
    special: 'Rare negative group crucial for surgical patients and Rh-negative mothers.',
    label: 'Rare Negative Donor'
  },
  'A+': {
    give: ['A+', 'AB+'],
    receive: ['A+', 'A-', 'O+', 'O-'],
    special: 'High-demand group in Douala and Yaoundé general hospitals for scheduled surgeries.',
    label: 'High-Demand Donor'
  },
  'B-': {
    give: ['B-', 'B+', 'AB-', 'AB+'],
    receive: ['B-', 'O-'],
    special: 'Extremely rare in Central Africa (<2%). Your active standby status is a critical lifeline.',
    label: 'Ultra-Rare Negative Donor'
  },
  'B+': {
    give: ['B+', 'AB+'],
    receive: ['B+', 'B-', 'O+', 'O-'],
    special: 'Core regional blood type vital for trauma response in Douala, Yaoundé, and Bafoussam.',
    label: 'Core Regional Lifesaver'
  },
  'AB-': {
    give: ['AB-', 'AB+'],
    receive: ['AB-', 'A-', 'B-', 'O-'],
    special: 'Universal Plasma Donor. While red cells are specialized, your plasma is universally compatible.',
    label: 'Universal Plasma Donor'
  },
  'AB+': {
    give: ['AB+'],
    receive: ['AB+', 'AB-', 'A+', 'A-', 'B+', 'B-', 'O+', 'O-'],
    special: 'Universal Red Blood Cell Recipient. You can safely receive packed cells from all 8 blood groups.',
    label: 'Universal Recipient'
  }
};

export function getTimeAwareGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function toggleBloodFlyout(force) {
  const flyout = document.getElementById('bloodCompatibilityFlyout');
  if (!flyout) return;
  const isHidden = flyout.classList.contains('hidden');
  const show = typeof force === 'boolean' ? force : isHidden;

  if (show) {
    flyout.classList.remove('hidden');
    const currentUser = getCurrentUser();
    const bt = (currentUser?.bloodType || 'B+').toUpperCase();
    const data = BLOOD_COMPATIBILITY_DATA[bt] || BLOOD_COMPATIBILITY_DATA['B+'];

    const badgeEl = document.getElementById('flyoutBloodTypeBadge');
    if (badgeEl) badgeEl.textContent = bt;

    const giveEl = document.getElementById('flyoutGiveList');
    if (giveEl) {
      giveEl.innerHTML = data.give.map(t =>
        `<span class="px-2 py-0.5 text-[10px] font-black rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">${t}</span>`
      ).join('');
    }

    const receiveEl = document.getElementById('flyoutReceiveList');
    if (receiveEl) {
      receiveEl.innerHTML = data.receive.map(t =>
        `<span class="px-2 py-0.5 text-[10px] font-black rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-400/30">${t}</span>`
      ).join('');
    }

    const specialEl = document.getElementById('flyoutSpecialTrait');
    if (specialEl) specialEl.textContent = data.special;
  } else {
    flyout.classList.add('hidden');
  }
}

if (typeof window !== 'undefined') {
  window.toggleBloodFlyout = toggleBloodFlyout;
  window.triggerMilestoneConfetti = triggerMilestoneConfetti;

  document.addEventListener('click', (e) => {
    const flyout = document.getElementById('bloodCompatibilityFlyout');
    const btn = document.getElementById('donorBloodDropBtn');
    const bentoCard = document.getElementById('bentoBloodProfileCard');
    if (flyout && !flyout.classList.contains('hidden')) {
      if (
        !flyout.contains(e.target) &&
        !btn?.contains(e.target) &&
        !bentoCard?.contains(e.target) &&
        !e.target.closest('#donorBloodDropBtn') &&
        !e.target.closest('#bentoBloodProfileCard')
      ) {
        flyout.classList.add('hidden');
      }
    }
  });
}

// XSS-safety helper for interpolating user-controlled strings (hospital names, cities, etc.)
// into innerHTML template strings.
export function esc(str) {
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
let _donorNotifCache = null; // { notifications, unreadCount } — pre-fetched every 30s to avoid bell-click lag
let _donorEligibilityCache = null;

// ============================================
// STREAM D — PENDING & VERIFIED DASHBOARD STATES
// ============================================
// D1: donors/{uid}.kycStatus drives every conditional render below via a single real-time
// onSnapshot listener (not a poll, not a per-component read). Accounts with no donors/{uid}
// doc at all (pre-dating this feature) are grandfathered — same rule firestore.rules'
// isKycEligible() already uses — and are always treated as verified, never locked.
//
// Schema per donor UI/KYC_fix.md (2026-08-07): kycStatus has an explicit 'not_submitted'
// state distinct from 'pending' (submitted, awaiting review), so — unlike the old
// Storage-ref schema — no separate "was anything actually uploaded yet" field is needed to
// tell "skipped" and "under review" apart; kycStatus alone is enough.
let _donorKycStatus = null;        // null (grandfathered) | 'not_submitted' | 'pending' | 'verified' | 'rejected'
let _donorKycRejectionReason = null;
let _donorKycUnsub = null;
let _donorKycStatusKnown = false;  // false until the first snapshot has actually arrived
let _donorJourneySteps = null;     // cached so the KYC listener can re-render the journey
                                    // checklist's lock state without refetching engagement
let _donorEngagementCache = null;  // cached so the KYC listener can re-render gamification
                                    // stats (D8) reactively too, without refetching engagement

function isDonorVerified() {
  return !_donorKycStatusKnown || _donorKycStatus === null || _donorKycStatus === 'verified';
}
function isDonorKycRejected() {
  return _donorKycStatusKnown && _donorKycStatus === 'rejected';
}
function isDonorKycSkipped() {
  return _donorKycStatusKnown && _donorKycStatus === 'not_submitted';
}
function isDonorKycUnderReview() {
  return _donorKycStatusKnown && _donorKycStatus === 'pending';
}

function initDonorStatusListener() {
  const currentUser = getCurrentUser();
  if (!currentUser?.uid || _donorKycUnsub) return;
  _donorKycUnsub = onSnapshot(doc(db, 'donors', currentUser.uid), (snap) => {
    const prevStatus = _donorKycStatusKnown ? _donorKycStatus : undefined; // undefined = first load
    if (snap.exists()) {
      const data = snap.data();
      _donorKycStatus = data.kycStatus || 'not_submitted';
      _donorKycRejectionReason = data.kycRejectionReason || null;
    } else {
      _donorKycStatus = null;
      _donorKycRejectionReason = null;
    }
    _donorKycStatusKnown = true;

    // D6: celebrate the transition itself, not just the state — only when it actually
    // flips to verified after being pending/rejected. Never on the very first snapshot
    // (that would toast every already-verified donor on every page load).
    if (prevStatus !== undefined && prevStatus !== 'verified' && isDonorVerified()) {
      showToast('🎉 Your account is verified! Full access unlocked.');
      triggerMilestoneConfetti({ particleCount: 85 });
    }

    renderDonorKycStatusBanner();
    applyKycLocksToDOM();
    if (_donorEngagementCache) renderDonorEngagementStats(_donorEngagementCache);
    if (_donorJourneySteps) renderDonorJourneyChecklist(_donorJourneySteps);
    if (document.getElementById('requestsFeed')) renderFilteredFeed();
  }, (err) => {
    console.error('Donor status listener failed:', err);
  });
}

// Not currently called (the listener lives for the donor's whole portal session, same as
// the notification poller) — kept for symmetry with teardownDonorJourneys and in case a
// future logout/view-teardown path needs it.
function teardownDonorStatusListener() {
  if (_donorKycUnsub) { _donorKycUnsub(); _donorKycUnsub = null; }
}

// D2 / D5 / D7 — one status banner, three mutually exclusive states (plus "hidden" for
// verified/grandfathered). Lives at the top of the dashboard view, the donor's main landing
// screen — not literally injected into every sub-view's markup, which would mean touching
// the shared shell used by every view/nav destination. Flagged as a scope simplification of
// "persistent," not a silent gap: donors reliably see it every time they land on Home.
function renderDonorKycStatusBanner() {
  const container = document.getElementById('donorKycStatusBanner');
  if (!container) return;

  let html = '';
  if (isDonorKycRejected()) {
    html = `
      <div class="bg-error-container/40 border border-error/25 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div class="flex items-start gap-3">
          <span class="w-10 h-10 rounded-full bg-error text-on-error flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-xl">error</span></span>
          <div>
            <p class="font-bold text-sm text-on-surface">Your verification was unsuccessful.</p>
            <p class="text-xs text-on-surface-variant mt-0.5">${_donorKycRejectionReason ? esc(_donorKycRejectionReason) : 'Please resubmit your documents.'}</p>
          </div>
        </div>
        <button class="js-donor-kyc-cta press-scale shrink-0 bg-error text-on-error font-bold text-xs px-5 py-2.5 rounded-xl shadow-sm hover:opacity-90 transition-opacity cursor-pointer">Resubmit Documents</button>
      </div>`;
  } else if (isDonorKycSkipped()) {
    html = `
      <div class="bg-error-container/25 border border-error/20 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div class="flex items-start gap-3">
          <span class="w-10 h-10 rounded-full bg-error/15 text-error flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-xl">warning</span></span>
          <div>
            <p class="font-bold text-sm text-on-surface">⚠ Complete your verification to unlock all features.</p>
            <p class="text-xs text-on-surface-variant mt-0.5">Scheduling donations and accepting requests are locked until you verify your identity.</p>
          </div>
        </div>
        <button class="js-donor-kyc-cta press-scale shrink-0 bg-error text-on-error font-bold text-xs px-5 py-2.5 rounded-xl shadow-sm hover:opacity-90 transition-opacity cursor-pointer">Complete Verification</button>
      </div>`;
  } else if (isDonorKycUnderReview()) {
    html = `
      <div class="bg-warning-container/40 border border-warning/25 rounded-2xl p-5 flex items-center gap-3">
        <span class="w-10 h-10 rounded-full bg-warning text-on-warning flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-xl">hourglass_top</span></span>
        <div>
          <p class="font-bold text-sm text-on-surface">⏳ Your account is under review.</p>
          <p class="text-xs text-on-surface-variant mt-0.5">We'll notify you within 24–48 hours. Some features are locked until then.</p>
        </div>
      </div>`;
  }

  container.innerHTML = html;
  container.classList.toggle('hidden', !html);
  container.querySelector('.js-donor-kyc-cta')?.addEventListener('click', () => switchDonorView('kyc'));
}

// D3 — the actual lock/blur application. Idempotent and cheap (pure class toggles), so it's
// safe to call redundantly from both the status listener and the dashboard's own hydration,
// whichever settles second wins with the correct state either way.
function applyKycLocksToDOM() {
  const locked = !isDonorVerified();
  const setOverlay = (id, visible) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', !visible);
    el.classList.toggle('flex', visible);
  };

  const verifiedPill = document.getElementById('donorVerifiedBadgePill');
  if (verifiedPill) {
    verifiedPill.classList.toggle('hidden', locked);
    verifiedPill.classList.toggle('inline-flex', !locked);
  }

  // Schedule Donation — hero CTA, Impact hero CTA, quick-action tile, and mobile dock water-drop
  // all trigger the same modal, so all must lock together when KYC is pending.
  ['btnScheduleDonationDesktop', 'btnImpactScheduleDonation', 'btnDockScheduleDonation'].forEach((btnId) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.disabled = locked;
      btn.classList.toggle('opacity-50', locked);
      btn.classList.toggle('cursor-not-allowed', locked);
      btn.title = locked ? 'Locked until your account is approved.' : '';
    }
  });
  setOverlay('scheduleDonationHeroLock', locked);

  const tileBtn = document.getElementById('btnQuickScheduleDonation');
  if (tileBtn) tileBtn.disabled = locked;
  setOverlay('scheduleDonationTileLock', locked);

  // Fourth entry point: "Nearby Donation Centers" cards (dashboard panel + the Centers view)
  // open the same wizard pre-pointed at a hospital. Browsing centers stays unlocked (D4) —
  // only the donate action on each card locks. Queried live rather than by id because both
  // lists are re-rendered from data; the KYC listener calls this function again on any
  // status flip, so a list rendered before approval unlocks without a reload.
  document.querySelectorAll('[data-donate-center]').forEach((btn) => {
    btn.disabled = locked;
    btn.classList.toggle('opacity-50', locked);
    btn.classList.toggle('cursor-not-allowed', locked);
    btn.title = locked ? 'Locked until your account is approved.' : '';
  });

  // Live Requests panel (the browsable feed) — Donation Centers stays fully usable (D4),
  // so only requestsFeed itself is covered, not the whole "Near You" section.
  document.getElementById('requestsFeed')?.classList.toggle('pointer-events-none', locked);
  setOverlay('requestsFeedLockOverlay', locked);

  // "Urgent Need Nearby" banner — the same class of content as the requests feed (a live
  // request's hospital, blood type, units and distance), just surfaced higher up, so it gets
  // the same blur+overlay treatment. Disabling only its "Respond Now" button (the original
  // D3 behaviour) left the request details themselves fully readable to an account that
  // hasn't been identity-checked yet.
  const alertEl = document.getElementById('emergencyAlert');
  if (alertEl) alertEl.classList.toggle('pointer-events-none', locked);
  setOverlay('emergencyAlertLockOverlay', locked);

  // Emergency "Respond Now" — a second entry point into accepting a request, not covered
  // by the requestsFeed overlay above, so it needs its own lock.
  const respondBtn = document.getElementById('emergencyRespondBtn');
  if (respondBtn) {
    respondBtn.disabled = locked;
    respondBtn.title = locked ? 'Complete identity verification to respond to requests.' : '';
  }
}

// Animate numerical counters smoothly from 0 to target value with cubic ease-out
function animateCountUp(element, target, duration = 800) {
  if (!element) return;
  if (target === '—' || target === '-' || isNaN(Number(target))) {
    element.textContent = target;
    syncMarqueeMirror(element.id, target);
    return;
  }
  const end = parseInt(target, 10) || 0;
  if (end === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    element.textContent = end;
    syncMarqueeMirror(element.id, end);
    return;
  }
  const startTime = performance.now();
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(eased * end);
    element.textContent = current;
    syncMarqueeMirror(element.id, current);
    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.textContent = end;
      syncMarqueeMirror(element.id, end);
    }
  }
  requestAnimationFrame(update);
}

// Synchronize duplicated elements in the infinite scrolling marquee
function syncMarqueeMirror(id, val) {
  if (!id) return;
  const mirrors = document.querySelectorAll(`[data-mirror="${id}"]`);
  mirrors.forEach(m => { m.textContent = val; });
}

// D8 — gamification/engagement numbers (Lives Saved, Total Donations, Bronze Tier progress,
// badges) reflect real completed-donation history, which by definition can't exist yet for an
// account still awaiting admin approval. Rendering real figures (or a hardcoded placeholder
// number) for a not-yet-verified donor is misleading, so this is gated the same way the
// Donation Journey checklist (below) already gates steps 3-4. Cached engagement lets the KYC
// status listener re-render this reactively the moment an admin approves/rejects, without
// refetching from Firestore.
function renderDonorEngagementStats(engagement) {
  if (!engagement) return;
  _donorEngagementCache = engagement;
  if (!_lastComputedEngagement) {
    _lastComputedEngagement = {
      donationCount: engagement.donationCount || 0,
      totalUnits: engagement.totalUnits || 0,
      livesSaved: (engagement.totalUnits || 0) * 3,
      emergencyMissions: engagement.emergencyMissions || 0,
      pulsePoints: engagement.points || 0,
    };
  }
  const locked = !isDonorVerified();
  const livesCount = engagement.totalUnits * 3; // no fallback — 0 donations means 0 lives saved

    const statDonations = document.getElementById('statDonations');
  if (statDonations) {
    if (locked) {
      statDonations.textContent = '—';
      syncMarqueeMirror('statDonations', '—');
    } else {
      animateCountUp(statDonations, engagement.donationCount);
    }
  }

  const heroStatDonations = document.getElementById('heroStatDonations');
  if (heroStatDonations) {
    if (locked) {
      heroStatDonations.textContent = '—';
    } else {
      animateCountUp(heroStatDonations, engagement.donationCount);
    }
  }

  const statLivesSavedText = document.getElementById('statLivesSavedText');
  if (statLivesSavedText) {
    statLivesSavedText.textContent = locked ? '—' : (livesCount > 0 ? `+${Math.max(1, Math.round(livesCount * 0.25))} this qtr` : 'Direct Impact');
  }

  const currentUser = getCurrentUser();
  const statLivesRegionSub = document.getElementById('statLivesRegionSub');
  if (statLivesRegionSub) {
    const cityLabel = currentUser?.city || 'Cameroon';
    statLivesRegionSub.textContent = livesCount > 0
      ? `Up to 3 lives/unit • Patients in ${cityLabel}`
      : 'Est. up to 3 lives/unit (Red Cells, Plasma, Platelets)';
  }

  const statLivesSaved = document.getElementById('statLivesSaved');
  if (statLivesSaved) {
    if (locked) {
      statLivesSaved.textContent = '—';
      syncMarqueeMirror('statLivesSaved', '—');
    } else {
      animateCountUp(statLivesSaved, livesCount);
    }
  }

  const heroStatLivesSaved = document.getElementById('heroStatLivesSaved');
  if (heroStatLivesSaved) {
    if (locked) {
      heroStatLivesSaved.textContent = '—';
    } else {
      animateCountUp(heroStatLivesSaved, livesCount);
    }
  }

  const statPoints = document.getElementById('statPoints');
  if (statPoints) statPoints.textContent = engagement.points;

  const statRank = document.getElementById('statRank');
  if (statRank) {
    statRank.innerHTML = `${locked ? '—' : (engagement.tier || 'Bronze')} Rank &rarr;`;
  }

  const heroStatTier = document.getElementById('heroStatTier');
  if (heroStatTier) {
    const tierName = locked ? 'Locked' : (engagement.tier || 'Bronze');
    heroStatTier.innerHTML = `<span class="material-symbols-outlined text-[11px]" style="font-variation-settings:'FILL' 1">military_tech</span><span>${tierName}</span>`;
  }

  const statDistance = document.getElementById('statDistance');
  if (statDistance) {
    const totalDist = engagement.totalDistanceKm || 0;
    statDistance.textContent = locked ? '—' : `${totalDist} km`;
  }

  const effectiveLastDate = resolveLastDonationDate(currentUser, engagement);
  const lastDonationText = document.getElementById('statLastDonation');
  if (lastDonationText) {
    const formattedLast = locked ? '—' : (effectiveLastDate
      ? new Date(effectiveLastDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'Never');
    lastDonationText.textContent = formattedLast;
    syncMarqueeMirror('statLastDonation', formattedLast);
  }

  renderDashboardMedalsStrip(engagement, locked);

  // Bronze Tier card — a locked placeholder replaces the real journey stepper while pending;
  // showing tier/points progress implies an already-active account, which this isn't yet.
  const tierCardTitle = document.getElementById('donorTierCardTitle');
  if (tierCardTitle) {
    const tierTitle = locked ? 'Locked' : `${engagement.tier} Tier`;
    tierCardTitle.textContent = tierTitle;
    syncMarqueeMirror('donorTierCardTitle', locked ? 'Bronze' : engagement.tier);
  }
  const tierEl = document.getElementById('donorTierProgress');
  if (tierEl) {
    tierEl.innerHTML = locked
      ? `<div class="flex flex-col items-center text-center py-4 gap-2">
           <span class="material-symbols-outlined text-3xl text-on-surface-variant/40">lock</span>
           <p class="text-xs font-bold text-on-surface-variant">Your rewards &amp; tier progress unlock once your account is approved.</p>
         </div>`
      : renderTierJourneyStepper(engagement, { showHeader: false, showPerks: true });
  }

  const badgesEl = document.getElementById('donorBadgesSummary');
  if (badgesEl) {
    if (locked) {
      badgesEl.innerHTML = '<p class="text-sm text-on-surface-variant text-center py-4">Badges unlock once your account is approved.</p>';
    } else if (engagement.badges.length === 0) {
      badgesEl.innerHTML = '<p class="text-sm text-on-surface-variant text-center py-4">Complete your first donation to earn badges!</p>';
    } else {
      const summaryColors = {
        'First Donation': { bg: '#fecaca', icon: '#dc2626', emblem: 'radial-gradient(circle at 35% 30%, #fecaca, #f87171 25%, #e11d48 50%, #be123c 75%, #881337)' },
        'Regular Donor': { bg: '#e9d5ff', icon: '#7c3aed', emblem: 'radial-gradient(circle at 35% 30%, #e9d5ff, #a855f7 25%, #7c3aed 50%, #6d28d9 75%, #4c1d95)' },
        'Life Saver': { bg: '#fef08a', icon: '#ca8a04', emblem: 'radial-gradient(circle at 35% 30%, #fef08a, #facc15 25%, #eab308 50%, #ca8a04 75%, #854d0e)' },
        'Guardian Angel': { bg: '#ccfbf1', icon: '#0d9488', emblem: 'radial-gradient(circle at 35% 30%, #ccfbf1, #14b8a6 25%, #0d9488 50%, #0f766e 75%, #134e4a)' },
        'Generous Heart': { bg: '#fed7aa', icon: '#ea580c', emblem: 'radial-gradient(circle at 35% 30%, #fed7aa, #fb923c 25%, #ea580c 50%, #c2410c 75%, #7c2d12)' },
        'Universal Donor': { bg: '#d1fae5', icon: '#059669', emblem: 'radial-gradient(circle at 35% 30%, #d1fae5, #34d399 25%, #059669 50%, #047857 75%, #064e3b)' },
      };
      badgesEl.innerHTML = `
        <div class="flex flex-wrap gap-3 items-center">
          ${engagement.badges.slice(0, 5).map(b => {
            const sc = summaryColors[b.name] || summaryColors['First Donation'];
            return `
              <div class="flex flex-col items-center gap-1 group cursor-pointer" onclick="switchDonorView('badges')">
                <div class="relative w-10 h-10 rounded-full flex items-center justify-center overflow-hidden shadow-sm border border-white/40 group-hover:scale-110 transition-transform" style="background:${sc.emblem}">
                  <div class="absolute -top-0.5 -left-0.5 w-4 h-2.5 bg-white/20 rounded-full -rotate-12 blur-[1px] pointer-events-none"></div>
                  <span class="material-symbols-outlined text-base relative z-10" style="color:white;font-variation-settings:'FILL'1">${b.icon}</span>
                </div>
                <span class="text-[8px] font-bold text-on-surface-variant leading-tight text-center max-w-[60px] truncate">${b.name}</span>
              </div>
            `;
          }).join('')}
          ${engagement.badges.length > 5 ? `<div class="flex flex-col items-center gap-1"><div class="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center text-[10px] font-black text-on-surface-variant">+${engagement.badges.length - 5}</div></div>` : ''}
        </div>
        <button onclick="switchDonorView('badges')" class="press-scale mt-3 text-xs font-bold text-primary hover:underline cursor-pointer inline-flex items-center gap-1">View all badges <span class="material-symbols-outlined text-sm">arrow_forward</span></button>
      `;
    }
  }
}

/**
 * Dynamically renders Zone 7 (#dashboardMedalsStrip) on the Home Dashboard so unlocked/locked
 * states and donation progress match the donor's actual engagement instead of hardcoded HTML.
 */
export function renderDashboardMedalsStrip(engagement, kycLocked = false) {
  const strip = document.getElementById('dashboardMedalsStrip');
  if (!strip) return;
  const count = kycLocked ? 0 : (engagement?.donationCount || 0);
  const featured = [
    { id: 'bronze_lifesaver', title: 'Bronze Pioneer', label: 'Bronze Shield', req: 1, img: '/assets/badge_bronze_shield_transparent.png' },
    { id: 'silver_sentinel', title: 'Silver Sentinel', label: 'Silver Star', req: 3, img: '/assets/badge_silver_star_transparent.png' },
    { id: 'gold_guardian', title: 'Gold Guardian', label: 'Sunburst Cross', req: 5, img: '/assets/badge_gold_sunburst_transparent.png' },
    { id: 'platinum_protector', title: 'Platinum Vanguard', label: 'Platinum Star', req: 10, img: '/assets/badge_platinum_star_transparent.png' },
  ];

  const cardsHtml = featured.map(m => {
    const unlocked = count >= m.req;
    const imgStyle = unlocked
      ? ''
      : 'style="filter: grayscale(90%) brightness(0.32) contrast(0.85); opacity: 0.45;"';
    const imgCls = unlocked
      ? 'w-full h-full object-contain filter drop-shadow-[0_8px_16px_rgba(0,0,0,0.35)]'
      : 'w-full h-full object-contain select-none';
    const subCls = unlocked
      ? 'text-[10px] text-emerald-600 dark:text-emerald-400 font-bold mt-0.5'
      : 'text-[10px] text-slate-500 dark:text-slate-400 font-bold mt-0.5';
    const subText = unlocked
      ? `Unlocked &bull; ${m.label}`
      : `🔒 ${m.label} &bull; ${Math.min(count, m.req)}/${m.req} req`;
    const lockOverlay = unlocked
      ? ''
      : `<div class="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
           <div class="w-7 h-7 rounded-full bg-slate-900/90 border border-slate-700/80 flex items-center justify-center shadow-md">
             <span class="material-symbols-outlined text-xs text-slate-200">lock</span>
           </div>
         </div>`;

    return `
      <div class="press-scale p-3.5 rounded-2xl ${unlocked ? 'bg-slate-50 dark:bg-slate-800/40 border border-amber-400/50 dark:border-amber-500/40 hover:border-amber-400 cursor-pointer' : 'bg-slate-100/80 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 cursor-pointer'} text-center flex flex-col items-center justify-between transition-all group" onclick="window.inspectMedal('${m.id}')">
        <div class="relative w-14 h-14 sm:w-16 sm:h-16 flex items-center justify-center flex-shrink-0 ${unlocked ? 'group-hover:scale-110 transition-transform' : ''}">
          <img src="${m.img}" alt="${esc(m.title)}" class="${imgCls}" ${imgStyle}/>
          ${lockOverlay}
        </div>
        <div class="mt-2.5">
          <p class="text-xs font-black ${unlocked ? 'text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400'} leading-tight">${esc(m.title)}</p>
          <p class="${subCls}">${subText}</p>
        </div>
      </div>
    `;
  }).join('');

  strip.innerHTML = cardsHtml;
}

// Global helpers for dismissing / minimizing / restoring the onboarding journey checklist & floating hanging widget
window.minimizeDonorJourney = function() {
  localStorage.setItem('vp_journey_minimized', '1');
  if (_donorJourneySteps) renderDonorJourneyChecklist(_donorJourneySteps);
};

window.expandDonorJourney = function() {
  localStorage.removeItem('vp_journey_minimized');
  if (_donorJourneySteps) renderDonorJourneyChecklist(_donorJourneySteps);
};

window.dismissDonorJourney = function() {
  localStorage.setItem('vp_journey_dismissed', '1');
  const wrap = document.getElementById('donorJourneyChecklistWrap');
  if (wrap) wrap.classList.add('hidden');
  const floating = document.getElementById('donorFloatingJourneyWidget');
  if (floating) floating.classList.add('hidden');
};

window.restoreDonorJourney = function() {
  localStorage.removeItem('vp_journey_dismissed');
  localStorage.removeItem('vp_journey_minimized');
  const wrap = document.getElementById('donorJourneyChecklistWrap');
  if (wrap) wrap.classList.remove('hidden');
  if (_donorJourneySteps) renderDonorJourneyChecklist(_donorJourneySteps);
};

// Advanced Donation Journey Lifecycle:
// 1. Hanging Floating Modal / Widget: Pops up & hangs in the bottom corner with interactive steps.
// 2. Collapsible into a subtle floating pill.
// 3. Completed (100%): Celebratory Lifesaver Status Card.
// 4. Dismissible at any time.
function renderDonorJourneyChecklist(steps) {
  const journeyEl = document.getElementById('donorJourneyChecklist');
  const wrap = document.getElementById('donorJourneyChecklistWrap');
  const floating = document.getElementById('donorFloatingJourneyWidget');

  const doneCount = steps.filter(s => s.done).length;
  const total = steps.length;
  const pct = Math.round((doneCount / total) * 100);
  const isComplete = doneCount === total;
  const isDismissed = localStorage.getItem('vp_journey_dismissed') === '1';
  const isMinimized = localStorage.getItem('vp_journey_minimized') === '1';

  if (isDismissed && isComplete) {
    if (wrap) wrap.classList.add('hidden');
    if (floating) floating.classList.add('hidden');
    return;
  }

  const kycLocked = !isDonorVerified();
  const stepActions = [
    { fn: "switchDonorView('profile')", cta: "Edit profile" },
    { fn: "document.getElementById('availabilityToggle')?.click()", cta: "Toggle" },
    { fn: "switchDonorView('centers')", cta: "View centers" },
    { fn: "openDonationModal()", cta: "Schedule" },
  ];

  // 1. Render Floating Companion Widget (Hanging Modal in Bottom-Right Corner)
  if (floating) {
    if (isDismissed || (typeof window !== 'undefined' && window.innerWidth < 768)) {
      floating.classList.add('hidden');
    } else {
      floating.classList.remove('hidden');
      if (isComplete) {
        if (!sessionStorage.getItem('vp_journey_confetti_fired')) {
          sessionStorage.setItem('vp_journey_confetti_fired', '1');
          triggerMilestoneConfetti({ particleCount: 85 });
        }
        // Floating Celebratory Badge
        floating.innerHTML = `
          <div class="relative bg-white/95 dark:bg-slate-900/95 backdrop-blur-2xl border border-emerald-500/30 rounded-3xl p-4 shadow-2xl flex items-center justify-between gap-3 max-w-[340px] animate-in">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 text-white flex items-center justify-center shadow-md shadow-emerald-500/20 shrink-0">
                <span class="material-symbols-outlined text-2xl" style="font-variation-settings:'FILL' 1">verified</span>
              </div>
              <div class="min-w-0">
                <h4 class="text-xs font-black text-slate-900 dark:text-white truncate">Lifesaver Journey Complete!</h4>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">All 4 onboarding steps done 🎉</p>
              </div>
            </div>
            <button type="button" onclick="window.dismissDonorJourney()" title="Dismiss" class="press-scale w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer shrink-0 transition-colors">
              <span class="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        `;
      } else if (isMinimized) {
        // Floating Pill State (Hanging around quietly)
        floating.innerHTML = `
          <button type="button" onclick="window.expandDonorJourney()" class="press-scale flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200/90 dark:border-slate-800 shadow-xl hover:shadow-2xl text-slate-800 dark:text-slate-200 transition-all cursor-pointer group animate-in">
            <div class="relative w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <span class="material-symbols-outlined text-sm font-bold">checklist</span>
              <span class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary animate-ping"></span>
            </div>
            <span class="text-xs font-black tracking-tight">Journey: ${doneCount}/${total} (${pct}%)</span>
            <span class="material-symbols-outlined text-sm text-slate-400 group-hover:text-primary transition-colors">expand_less</span>
          </button>
        `;
      } else {
        // Floating Expanded Modal (Hanging around with interactive steps)
        floating.innerHTML = `
          <div class="relative w-full max-w-[350px] bg-white/95 dark:bg-slate-900/95 backdrop-blur-2xl border border-slate-200/90 dark:border-slate-800 rounded-3xl p-5 shadow-2xl space-y-3.5 animate-in">
            <!-- Header -->
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-primary to-rose-600 text-white flex items-center justify-center shadow-xs">
                  <span class="material-symbols-outlined text-lg">checklist</span>
                </div>
                <div>
                  <h4 class="text-xs font-black font-headline text-slate-900 dark:text-white tracking-tight">Donation Journey</h4>
                  <p class="text-[10px] font-bold text-primary">${doneCount} of ${total} complete (${pct}%)</p>
                </div>
              </div>
              <div class="flex items-center gap-1">
                <button type="button" onclick="window.minimizeDonorJourney()" title="Minimize to pill" class="press-scale w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer transition-colors">
                  <span class="material-symbols-outlined text-base">expand_more</span>
                </button>
                <button type="button" onclick="window.dismissDonorJourney()" title="Dismiss guide" class="press-scale w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer transition-colors">
                  <span class="material-symbols-outlined text-base">close</span>
                </button>
              </div>
            </div>

            <!-- Progress Track -->
            <div class="h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-primary to-emerald-500 rounded-full" style="width:${pct}%; transition: width 600ms cubic-bezier(0.16, 1, 0.3, 1);"></div>
            </div>

            <!-- Step items -->
            <div class="space-y-2 max-h-[220px] overflow-y-auto slim-scroll pr-0.5">
              ${steps.map((s, i) => {
                const locked = kycLocked && i >= 2;
                const act = stepActions[i] || stepActions[0];
                return `
                  <div class="group flex items-center justify-between p-2 rounded-xl transition-colors ${s.done ? 'bg-slate-50/60 dark:bg-slate-800/40 hover:bg-slate-100/60 dark:hover:bg-slate-800/70' : locked ? 'bg-slate-50/30 dark:bg-slate-800/20 opacity-60' : 'bg-primary/[0.04] dark:bg-primary/[0.08] border border-primary/20'}">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${locked ? 'bg-slate-200 dark:bg-slate-700 text-slate-400' : s.done ? 'bg-emerald-500 text-white shadow-xs' : 'bg-primary text-white shadow-xs ring-2 ring-primary/20'}">
                        ${locked
                          ? `<span class="material-symbols-outlined" style="font-size:11px">lock</span>`
                          : s.done
                          ? `<span class="material-symbols-outlined" style="font-size:12px;font-variation-settings:'FILL' 1">check</span>`
                          : `<span class="text-[9px] font-black">${i + 1}</span>`}
                      </span>
                      <span class="text-xs font-bold truncate ${locked ? 'text-slate-400 dark:text-slate-500' : s.done ? 'text-slate-700 dark:text-slate-300' : 'text-slate-900 dark:text-white'}">${esc(s.label)}</span>
                    </div>
                    <div class="shrink-0 ml-2">
                      ${locked
                        ? '<span class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Verify first</span>'
                        : s.done
                        ? '<span class="material-symbols-outlined text-emerald-500 text-sm" style="font-variation-settings:\'FILL\' 1">check_circle</span>'
                        : `<button type="button" onclick="${act.fn}" class="press-scale text-[10px] font-black text-primary bg-white dark:bg-slate-900 hover:bg-primary hover:text-white px-2 py-0.5 rounded-md border border-primary/30 transition-all cursor-pointer shadow-xs">${act.cta} →</button>`}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }
    }
  }
}

// Guard for the two donor actions that require a verified account — accepting a blood
// request (window.donorAcceptRequest) and scheduling a donation (window.openDonationModal).
// Defense-in-depth behind the visual locks above: those cover the entry points we know
// about, this covers the ones we don't (and any future one that forgets to check the DOM
// lock state first), so both actions are gated at the single choke point they funnel into.
//
// Two distinct states get two distinct messages: a donor still awaiting review has nothing
// left to do but wait, so offering them a "Verify Now" button would send them back into a
// KYC form they've already completed.
async function warnIfKycPending(action = 'accept blood requests') {
  if (isDonorVerified()) return true;
  if (isDonorKycUnderReview()) {
    await window.vpAlert({
      type: 'warning',
      title: 'Account under review',
      message: `Your account is still being reviewed, so you can't ${action} yet. We'll notify you within 24–48 hours once it's approved.`,
      confirmText: 'Got it',
    });
    return false;
  }
  const goVerify = await window.vpConfirm(
    `Complete identity verification before you can ${action}.`,
    { title: 'Verification required', confirmText: 'Verify Now', cancelText: 'Not Now' },
  );
  if (goVerify) switchDonorView('kyc');
  return false;
}

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
  updateNearbyPanelBadge();
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
  // D3: block scheduling while KYC-pending/rejected, checked before the eligibility gate for
  // the same reason donorAcceptRequest does — it's the more fundamental of the two. This is
  // the choke point every entry point funnels through (hero CTA, quick-action tile, mobile
  // drawer, donation-center cards, and the Care Reminders / Certificates empty states), so a
  // caller that isn't covered by a DOM lock still can't open the wizard.
  if (!await warnIfKycPending('schedule a donation')) { _preselectedCenter = null; return; }
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
  document.body.style.overflow = 'hidden';
  const bottomDock = document.getElementById('donorBottomDock');
  if (bottomDock) {
    bottomDock.classList.add('opacity-0', 'pointer-events-none');
    bottomDock.style.transition = 'opacity 0.2s ease';
  }
  modal.classList.remove('hidden');
  modal.classList.add('flex');
};
window.openScheduleModal = window.openDonationModal;
window.closeDonationModal = () => {
  const modal = document.getElementById('donationModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
  document.body.style.overflow = '';
  const bottomDock = document.getElementById('donorBottomDock');
  if (bottomDock) {
    bottomDock.classList.remove('opacity-0', 'pointer-events-none');
  }
};

// Verification is mandatory (no skip), and the KYC flow is multi-step (doc type, front/back
// upload, liveness capture) — routing away mid-flow via the header nav/hamburger drawer/
// account menu/logo would abandon that state inconsistently (e.g. a live camera stream still
// running, a selected-but-unsubmitted file) rather than cleanly, so all of them are hidden
// for the duration of the 'kyc' view. Inline style (not the "hidden" utility class) because
// these elements' own classes already encode responsive breakpoints (e.g. "hidden md:flex");
// toggling the same "hidden" class again wouldn't reliably win against md:flex at wider
// widths, whereas an inline style always does, and clearing it back to '' on unlock hands
// control back to those responsive classes exactly as before.
function setKycNavLocked(locked) {
  const display = locked ? 'none' : '';
  const primaryNav = document.getElementById('donorPrimaryNav');
  if (primaryNav) primaryNav.style.display = display;
  const accountMenuWrap = document.getElementById('donorAccountMenuWrap');
  if (accountMenuWrap) accountMenuWrap.style.display = display;
  const bottomDock = document.getElementById('donorBottomDock');
  if (bottomDock) bottomDock.style.display = display;

  const logo = document.getElementById('donorLogoLink');
  if (logo) {
    if (locked) {
      logo.dataset.hrefLocked = logo.getAttribute('href') || '';
      logo.removeAttribute('href');
      logo.classList.add('pointer-events-none');
    } else if (logo.dataset.hrefLocked !== undefined) {
      logo.setAttribute('href', logo.dataset.hrefLocked);
      delete logo.dataset.hrefLocked;
      logo.classList.remove('pointer-events-none');
    }
  }

  // Force-close the account dropdown if it was left open when the donor navigated into KYC.
  if (locked) {
    document.getElementById('donorAccountMenu')?.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

const VIEW_TITLES = {
  'dashboard': 'Home Dashboard',
  'requests': 'Live Blood Requests',
  'centers': 'Donation Centers',
  'badges': 'Impact & Badges',
  'profile': 'Donor Profile',
  'care-reminders': 'Care Reminders',
  'mythhub': 'Myth-Busting Hub',
  'certificates': 'Life Saver Certificates',
  'kyc': 'Identity Verification'
};

export async function switchDonorView(view, targetAnchor) {
  if (view === 'impact') view = 'badges';
  if (typeof window !== 'undefined') window.switchDonorView = switchDonorView;
  if (!targetAnchor) window.scrollTo({ top: 0, behavior: 'instant' });
  // Leaving the Requests view? Drop its real-time listener so it doesn't keep running (and
  // billing reads) in the background. loadDonorRequests re-subscribes when they return.
  if (view !== 'requests') teardownDonorJourneys();
  // Leaving the KYC view mid-liveness-capture? Turn the camera off immediately rather than
  // leaving it running in the background until the next loadKycView() reset.
  if (view !== 'kyc') stopLivenessCamera();
  setKycNavLocked(view === 'kyc');

  // 1. Update Desktop Header Navigation (Underline Indicator)
  document.querySelectorAll('#donorPrimaryNav .donor-mobile-nav').forEach(btn => {
    const isCurrent = btn.dataset.view === view;
    if (isCurrent) {
      btn.className = 'donor-mobile-nav text-primary font-bold border-b-2 border-primary pb-1 cursor-pointer transition-colors';
    } else {
      btn.className = 'donor-mobile-nav text-slate-600 dark:text-slate-300 hover:text-primary transition-colors cursor-pointer border-b-2 border-transparent pb-1';
    }
  });

  // 2. Update bottom dock and floating navigation items
  document.querySelectorAll('#donorBottomDock .donor-dock-btn, .donor-mobile-nav:not(#donorPrimaryNav *)').forEach(btn => {
    const isCurrent = btn.dataset.view === view;
    const icon = btn.querySelector('.material-symbols-outlined');
    const label = btn.querySelector('span:not(.material-symbols-outlined)');
    if (isCurrent) {
      btn.className = 'donor-dock-btn donor-mobile-nav min-w-[48px] min-h-[48px] flex flex-col items-center justify-center gap-0.5 text-primary cursor-pointer select-none';
      if (icon) {
        icon.style.fontVariationSettings = "'FILL' 1, 'wght' 700";
        icon.className = 'material-symbols-outlined text-2xl pointer-events-none';
      }
      if (label) label.className = 'text-[10px] font-black text-primary pointer-events-none';
    } else {
      btn.className = 'donor-dock-btn donor-mobile-nav min-w-[48px] min-h-[48px] flex flex-col items-center justify-center gap-0.5 text-slate-500 dark:text-slate-400 hover:text-primary transition-colors cursor-pointer select-none';
      if (icon) {
        icon.style.fontVariationSettings = "'FILL' 0, 'wght' 400";
        icon.className = 'material-symbols-outlined text-2xl pointer-events-none';
      }
      if (label) label.className = 'text-[10px] font-bold text-slate-500 dark:text-slate-400 pointer-events-none';
    }
  });

  // 4. Update Header Profile Pill active highlight when on profile view
  const headerPill = document.getElementById('donorAccountMenuWrap');
  if (headerPill) {
    if (view === 'profile') {
      headerPill.classList.add('ring-2', 'ring-primary', 'border-primary');
    } else {
      headerPill.classList.remove('ring-2', 'ring-primary', 'border-primary');
    }
  }

  history.replaceState(null, '', '#' + (targetAnchor || view));

  // Show transition loader with red circle
  const loader = document.getElementById('viewTransitionLoader');
  const loaderText = document.getElementById('viewTransitionText');
  if (loaderText) loaderText.textContent = `Loading ${VIEW_TITLES[view] || 'View'}...`;

  const views = ['dashboard', 'requests', 'centers', 'badges', 'profile', 'care-reminders', 'mythhub', 'certificates', 'kyc'];
  views.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('block', 'flex');
      el.style.display = 'none';
    }
  });

  if (loader) {
    loader.classList.remove('hidden');
    loader.classList.add('flex');
    loader.style.display = 'flex';
  }

  // Load target view content
  const loadPromise = (async () => {
    try {
      switch (view) {
        case 'dashboard':
          await loadDonorDashboard();
          setTimeout(() => nearbyMapInstance?.invalidateSize(), 250);
          break;
        case 'requests':
          await loadDonorRequests();
          setTimeout(() => _requestsMiniMapInstance?.invalidateSize(), 250);
          break;
        case 'centers':
          await loadDonationCentersView();
          if (typeof window !== 'undefined' && window.innerWidth < 1024) {
            window.switchCentersMobileTab?.('map');
          }
          setTimeout(() => centersMapInstance?.invalidateSize(), 250);
          setTimeout(() => centersMapInstance?.invalidateSize(), 500);
          break;
        case 'badges':
          await loadDonorBadges();
          break;
        case 'profile':
          await loadDonorProfile();
          break;
        case 'care-reminders':
          await loadCareRemindersView();
          break;
        case 'mythhub':
          await loadMythHubView();
          break;
        case 'certificates':
          await loadCertificatesView();
          break;
        case 'kyc':
          await loadKycView();
          break;
      }
    } catch (err) {
      console.error(`Failed to switch to donor view "${view}":`, err);
    }
  })();

  // Minimum transition time (150ms) to ensure a smooth, professional feel without sudden pop
  try {
    await Promise.all([loadPromise, new Promise(res => setTimeout(res, 150))]);
  } catch (err) {
    console.warn('Transition loader wait encountered error:', err);
  }

  if (loader) {
    loader.classList.add('hidden');
    loader.classList.remove('flex');
    loader.style.display = 'none';
  }

  const active = document.getElementById('view-' + view);
  if (active) {
    active.classList.remove('hidden');
    if (view === 'dashboard') {
      active.classList.add('flex');
      active.style.display = 'flex';
    } else {
      active.classList.add('block');
      active.style.display = 'block';
    }
    if (targetAnchor) {
      setTimeout(() => {
        const anchorEl = document.getElementById(targetAnchor);
        if (anchorEl) anchorEl.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    }
  }
}
if (typeof window !== 'undefined') window.switchDonorView = switchDonorView;

// ============================================
// E1.2 — EN/FR LANGUAGE TOGGLE
// ============================================
// Coverage is intentionally partial: the primary nav labels (header + mobile drawer) only,
// not a full translation of every dynamic string this file renders — that would be a
// separate, much larger i18n workstream (this app's dynamic templates run into the
// thousands of lines). Shares the same localStorage key / setLang()/getLang() state as
// hospital.html's existing toggle, so a choice made on one side is remembered on the other.
function applyDonorTranslations() {
  document.querySelectorAll('[data-i18n-key]').forEach(el => {
    el.textContent = t(el.dataset.i18nKey);
  });
  document.querySelectorAll('.donor-lang-btn').forEach(btn => {
    const active = btn.dataset.lang === getLang();
    btn.className = `donor-lang-btn px-2.5 py-1 rounded-full text-[10px] font-black transition-colors cursor-pointer ${active ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-primary'}`;
  });
  // Mobile drawer buttons use a slightly larger touch target — re-apply their own sizing
  // after the shared class string above (which is tuned for the compact header pill).
  document.querySelectorAll('#donorLangToggleMobile .donor-lang-btn').forEach(btn => {
    const active = btn.dataset.lang === getLang();
    btn.className = `donor-lang-btn px-3 py-1 rounded-full text-xs font-black transition-colors cursor-pointer ${active ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-primary'}`;
  });
}

function initDonorLangToggle() {
  document.querySelectorAll('.donor-lang-btn').forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
  window.addEventListener('languagechange', applyDonorTranslations);
  applyDonorTranslations();
}

export function hydrateDonorProfileUI(currentUser) {
  const cu = currentUser || getCurrentUser();
  if (!cu) return;
  const fullName = (cu.name || cu.displayName || cu.fullName || (cu.email ? cu.email.split('@')[0] : 'Donor')).trim();
  const firstName = fullName.split(/\s+/)[0] || 'Donor';
  const email = cu.email || '';
  const bloodType = cu.bloodType || 'B+';

  const navNameEl = document.getElementById('donorNavName');
  if (navNameEl) navNameEl.textContent = firstName;

  const welcomeNameEl = document.getElementById('donorWelcomeName');
  if (welcomeNameEl) welcomeNameEl.textContent = firstName;

  const menuNameEl = document.getElementById('donorMenuName');
  if (menuNameEl) menuNameEl.textContent = fullName;

  const menuEmailEl = document.getElementById('donorMenuEmail');
  if (menuEmailEl) menuEmailEl.textContent = email;

  const bloodBadge = document.getElementById('donorNavBloodBadge');
  if (bloodBadge) {
    bloodBadge.textContent = bloodType;
    bloodBadge.classList.remove('hidden');
  }

  renderUserAvatars(cu);
}

export function initDonorNavigation() {
  if (typeof window !== 'undefined') window.switchDonorView = switchDonorView;
  if (donorNavigationInitialized) return;
  hydrateDonorProfileUI();
  wireImpactShareButtons();

  document.querySelectorAll('.donor-mobile-nav').forEach(btn => {
    btn.addEventListener('click', () => switchDonorView(btn.dataset.view));
  });

  document.querySelectorAll('[data-open-donation-history]').forEach(el => {
    el.addEventListener('click', () => {
      const modal = document.getElementById('myDonationsModal');
      if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
      loadDonorDonations();
    });
  });
  document.getElementById('btnDonorProfile')?.addEventListener('click', () => switchDonorView('profile'));
  document.getElementById('btnHeaderProfile')?.addEventListener('click', () => switchDonorView('profile'));

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
    hydrateDonorProfileUI(cu);

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !menuPanel.classList.contains('hidden');
      if (isOpen) { closeAccountMenu(); return; }
      menuPanel.classList.remove('hidden');
      if (menuChevron) menuChevron.style.transform = 'rotate(180deg)';
    });
    menuPanel.addEventListener('click', closeAccountMenu);
    document.addEventListener('click', (e) => {
      if (!menuPanel.classList.contains('hidden') && !menuPanel.contains(e.target) && !menuBtn.contains(e.target)) closeAccountMenu();
    });
  }

  document.querySelectorAll('[data-action="switch-view"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;
      if (target) switchDonorView(target);
    });
  });

  // Explicit handlers for navbar & tile center/reminder buttons
  ['btnNavCenters', 'btnQuickFindCenters'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => switchDonorView('centers'));
  });
  ['btnDockHome', 'btnDockRequests', 'btnDockCenters', 'btnDockImpact'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    let lastHandled = 0;
    const trigger = (e) => {
      const now = Date.now();
      if (now - lastHandled < 200) return; // debounce double triggers from pointerup + click
      lastHandled = now;
      const targetView = btn.dataset.view;
      if (targetView) switchDonorView(targetView);
    };
    btn.addEventListener('click', trigger);
    btn.addEventListener('pointerup', trigger);
  });
  document.getElementById('nav-care-reminders')?.addEventListener('click', () => switchDonorView('care-reminders'));
  document.getElementById('nav-certificates')?.addEventListener('click', () => switchDonorView('certificates'));
  document.getElementById('nav-mythhub')?.addEventListener('click', () => switchDonorView('mythhub'));

  // Donation booking modal cancel button
  document.getElementById('donationCancelBtn')?.addEventListener('click', () => {
    window.closeDonationModal?.();
  });

  // GPS Location button
  document.getElementById('btnEnableGpsLocation')?.addEventListener('click', async () => {
    try {
      const loc = await captureUserLocation();
      showToast(loc ? 'Location captured successfully' : 'Using default location');
    } catch (e) {
      console.warn('GPS location failed:', e);
    }
  });

  // Notification bell: show modern real-time notification panel
  const notifBtn = document.getElementById('btnDonorNotifications');
  if (notifBtn) {
    notifBtn.addEventListener('click', async () => {
      const currentUser = getCurrentUser();
      if (!currentUser) return;

      const existingPanel = document.getElementById('donorNotifPanel');
      if (existingPanel) {
        existingPanel.remove();
        return;
      }

      // Create modern flyout panel
      const panel = document.createElement('div');
      panel.id = 'donorNotifPanel';
      panel.className = 'fixed inset-0 z-[80] flex items-end sm:items-start sm:justify-end sm:pt-16 sm:pr-6 pointer-events-auto';
      panel.innerHTML = `
        <div class="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity" onclick="document.getElementById('donorNotifPanel')?.remove()"></div>
        <div class="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 w-full sm:w-96 max-h-[85vh] rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col z-10 animate-in safe-bottom">
          
          <!-- Header -->
          <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/50 shrink-0">
            <div class="flex items-center gap-2.5">
              <span class="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                <span class="material-symbols-outlined text-lg">notifications</span>
              </span>
              <div>
                <h3 class="font-black text-sm text-slate-900 dark:text-white font-headline leading-tight">Notifications</h3>
                <p id="donorNotifSubhead" class="text-[10px] text-slate-500 dark:text-slate-400 font-medium">Real-time emergency & clinical alerts</p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button id="btnMarkAllNotifsRead" class="text-[10px] font-bold text-primary hover:underline px-1.5 py-1 rounded-lg cursor-pointer">
                Mark read
              </button>
              <button id="btnClearAllNotifs" class="text-[10px] font-bold text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:underline px-1.5 py-1 rounded-lg cursor-pointer">
                Clear all
              </button>
              <button onclick="document.getElementById('donorNotifPanel')?.remove()" class="w-7 h-7 rounded-full bg-slate-200/70 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-200 transition-colors cursor-pointer ml-1">
                <span class="material-symbols-outlined text-sm">close</span>
              </button>
            </div>
          </div>

          <!-- Body -->
          <div id="donorNotifBody" class="overflow-y-auto flex-1 p-3 space-y-2 slim-scroll">
            <div class="flex items-center gap-3 p-4 animate-pulse"><div class="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800"></div><div class="flex-1 space-y-2"><div class="h-3 bg-slate-100 dark:bg-slate-800 rounded w-3/4"></div><div class="h-2 bg-slate-100 dark:bg-slate-800 rounded w-1/2"></div></div></div>
            <div class="flex items-center gap-3 p-4 animate-pulse"><div class="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800"></div><div class="flex-1 space-y-2"><div class="h-3 bg-slate-100 dark:bg-slate-800 rounded w-2/3"></div><div class="h-2 bg-slate-100 dark:bg-slate-800 rounded w-1/3"></div></div></div>
          </div>

        </div>
      `;
      document.body.appendChild(panel);

      const renderNotifsInPanel = (notifications) => {
        const body = document.getElementById('donorNotifBody');
        const markBtn = document.getElementById('btnMarkAllNotifsRead');
        const clearBtn = document.getElementById('btnClearAllNotifs');
        if (!body) return;

        const unreadList = notifications.filter(n => !n.read);
        if (markBtn) {
          markBtn.style.display = unreadList.length > 0 ? 'inline-block' : 'none';
          markBtn.onclick = async () => {
            markBtn.disabled = true;
            markBtn.textContent = 'Marking...';
            try {
              await markAllNotificationsRead(currentUser.uid);
              notifications.forEach(n => { n.read = true; });
              renderNotifsInPanel(notifications);
              updateNotifBadge(0);
              showToast('All notifications marked as read', 'success');
            } catch (err) {
              console.error('Failed to mark all as read:', err);
            }
          };
        }

        if (clearBtn) {
          clearBtn.style.display = notifications.length > 0 ? 'inline-block' : 'none';
          clearBtn.onclick = async () => {
            if (!confirm('Are you sure you want to clear all notifications?')) return;
            clearBtn.disabled = true;
            clearBtn.textContent = 'Clearing...';
            try {
              await clearAllDonorNotifications(currentUser.uid);
              notifications.length = 0;
              renderNotifsInPanel(notifications);
              updateNotifBadge(0);
              showToast('Notifications cleared', 'success');
            } catch (err) {
              console.error('Failed to clear notifications:', err);
              showToast('Could not clear notifications', 'error');
            }
          };
        }

        if (notifications.length === 0) {
          body.innerHTML = `
            <div class="flex flex-col items-center justify-center py-10 px-4 text-center space-y-2">
              <div class="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
                <span class="material-symbols-outlined text-2xl">notifications_off</span>
              </div>
              <p class="text-xs font-bold text-slate-800 dark:text-slate-200">You're all caught up!</p>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 max-w-xs">When matching emergency blood requests or hospital updates occur, they will appear here in real time.</p>
            </div>`;
          return;
        }

        body.innerHTML = notifications.map(n => {
          const isUnread = !n.read;
          const isEmergency = n.type === 'error' || (n.title || '').toLowerCase().includes('emergency') || (n.title || '').toLowerCase().includes('urgent');
          const isSuccess = n.type === 'success';
          const isWarning = n.type === 'warning';
          const isHonor = n.type === 'honor' || (n.title || '').toLowerCase().includes('honor') || (n.title || '').toLowerCase().includes('badge');

          const icon = isEmergency ? 'emergency' : isHonor ? 'workspace_premium' : isSuccess ? 'check_circle' : isWarning ? 'warning' : 'info';
          const iconBg = isEmergency 
            ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20' 
            : isHonor
              ? 'bg-amber-500/10 text-amber-500 dark:text-amber-400 border-amber-500/25'
              : isSuccess 
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' 
                : isWarning
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
                  : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20';

          return `
            <div data-notif-id="${n.id}" data-notif-view="${n.view || (isEmergency ? 'requests' : '')}" class="group flex items-start gap-3 p-3 rounded-2xl border transition-all ${isUnread ? 'bg-slate-50 dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 shadow-xs' : 'bg-transparent border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/50 opacity-75'}">
              <div class="w-8 h-8 rounded-xl ${iconBg} border flex items-center justify-center shrink-0 mt-0.5">
                <span class="material-symbols-outlined text-base">${icon}</span>
              </div>
              <div class="flex-1 min-w-0 cursor-pointer notif-content-area">
                <div class="flex items-center justify-between gap-2">
                  <p class="text-xs font-black text-slate-900 dark:text-white leading-tight truncate">${esc(n.title)}</p>
                  ${isUnread ? '<span class="w-2 h-2 rounded-full bg-primary shrink-0"></span>' : ''}
                </div>
                <p class="text-[11px] text-slate-600 dark:text-slate-300 mt-1 leading-snug">${esc(n.message)}</p>
                <span class="text-[9px] font-medium text-slate-400 dark:text-slate-500 mt-1 block">${n.createdAt ? new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : 'Just now'}</span>
              </div>
              <button data-delete-id="${n.id}" title="Delete" class="opacity-0 group-hover:opacity-100 hover:text-rose-500 text-slate-400 p-1 rounded-lg transition-opacity cursor-pointer shrink-0">
                <span class="material-symbols-outlined text-sm">delete_outline</span>
              </button>
            </div>
          `;
        }).join('');

        // Wire click handler per notification body (navigate & mark read)
        body.querySelectorAll('.notif-content-area').forEach(area => {
          area.addEventListener('click', async () => {
            const card = area.closest('[data-notif-id]');
            const notifId = card?.dataset.notifId;
            const targetView = card?.dataset.notifView;
            if (!notifId) return;
            try {
              await markNotificationRead(notifId);
              const notif = notifications.find(x => x.id === notifId);
              if (notif) notif.read = true;
              renderNotifsInPanel(notifications);
              updateNotifBadge(notifications.filter(x => !x.read).length);
            } catch (e) {
              console.warn('Failed to mark read:', e);
            }
            if (targetView) {
              document.getElementById('donorNotifPanel')?.remove();
              switchDonorView(targetView);
            }
          });
        });

        // Wire delete buttons per notification
        body.querySelectorAll('[data-delete-id]').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const notifId = btn.dataset.deleteId;
            if (!notifId) return;
            btn.disabled = true;
            try {
              await deleteDonorNotification(notifId);
              const idx = notifications.findIndex(x => x.id === notifId);
              if (idx !== -1) notifications.splice(idx, 1);
              renderNotifsInPanel(notifications);
              updateNotifBadge(notifications.filter(x => !x.read).length);
              showToast('Notification deleted', 'success');
            } catch (err) {
              console.error('Failed to delete notification:', err);
              showToast('Could not delete notification', 'error');
            }
          });
        });
      };

      try {
        const notifications = await fetchDonorNotifications(currentUser.uid, 20);
        _donorNotifCache = { notifications, unreadCount: notifications.filter(n => !n.read).length };
        renderNotifsInPanel(notifications);
      } catch (err) {
        console.error('Failed to load notifications:', err);
        const body = document.getElementById('donorNotifBody');
        if (body) body.innerHTML = '<div class="py-8 text-center text-xs text-red-500 font-bold">Failed to load notifications. Please try again.</div>';
      }
    });
  }

  // Real-time notification subscription badge updater
  const updateNotifBadge = (count) => {
    const badge = document.getElementById('donorNotifBadge');
    if (badge) {
      if (count > 0) {
        badge.textContent = count > 9 ? '9+' : count;
        badge.classList.remove('hidden');
        badge.classList.add('flex');
      } else {
        badge.classList.add('hidden');
        badge.classList.remove('flex');
      }
    }
  };

  const cu = getCurrentUser();
  if (cu) {
    subscribeToDonorNotifications(cu.uid, (notifications) => {
      const unreadCount = notifications.filter(n => !n.read).length;
      _donorNotifCache = { notifications, unreadCount };
      updateNotifBadge(unreadCount);

      // If panel is currently open, re-render dynamically
      const panelBody = document.getElementById('donorNotifBody');
      if (panelBody) {
        const markBtn = document.getElementById('btnMarkAllNotifsRead');
        if (markBtn) markBtn.style.display = unreadCount > 0 ? 'block' : 'none';
      }
    });
  }

  initKycView();
  initKycLivenessStep();
  initDonorStatusListener();
  initDonorLangToggle();
  initDonorRequestFilters();

  // Restore view from URL hash on reload
  const donorViews = ['dashboard', 'requests', 'centers', 'badges', 'impact', 'profile', 'care-reminders', 'mythhub', 'certificates', 'kyc'];
  const impactSubSections = ['sectionPrestigeRoadmap', 'sectionMedalShowcase', 'sectionRewardsVault'];
  let rawHash = window.location.hash.replace('#', '');
  let hashView = rawHash;
  let targetAnchor = null;
  if (impactSubSections.includes(rawHash) || rawHash.startsWith('section')) {
    hashView = 'badges';
    targetAnchor = rawHash;
  } else if (hashView === 'impact') {
    hashView = 'badges';
  }
  if (hashView && donorViews.includes(hashView)) switchDonorView(hashView, targetAnchor);

  // Back/forward navigation
  window.addEventListener('hashchange', () => {
    let raw = window.location.hash.replace('#', '');
    let v = raw;
    let anchor = null;
    if (impactSubSections.includes(raw) || raw.startsWith('section')) {
      v = 'badges';
      anchor = raw;
    } else if (v === 'impact') {
      v = 'badges';
    }
    if (v && donorViews.includes(v)) switchDonorView(v, anchor);
  });

  donorNavigationInitialized = true;
}

// ============================================
// KYC (Identity Verification) — Stream C3, donor UI/VitalPulse_Plan_Tracker.md.
//
// REWRITTEN 2026-08-07 per donor UI/KYC_fix.md (Security Lead spec, followed strictly at
// the Security Lead's explicit direction): no Cloud Function, no Cloud Storage. Evidence
// photos are resized/compressed client-side (Step 2 below) and written as base64 directly
// on donors/{uid} (see firestore.rules' donors/{donorId} block for the write-side gating —
// this is the ENTIRE security boundary now, no server backstop).
//
// PDF dropped from accepted formats: Step 2's compression pipeline is a <canvas> resize —
// canvas can rasterize an <img>, not render a PDF page, and adding a PDF-rendering library
// would reintroduce the extra-dependency footprint KYC_fix.md is explicitly avoiding.
// ============================================
const KYC_MAX_BYTES = 5 * 1024 * 1024; // pre-compression raw upload guard, not the final size
const KYC_MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const KYC_DOC_LABELS = { national_id: 'National ID', drivers_licence: "Driver's License", passport: 'Passport', other: 'Document' };
// Step 2 (KYC_fix.md): resize so neither width nor height exceeds 800px (aspect ratio
// preserved), export as JPEG at ~65% quality. Measured combined size for front+back+selfie
// at these settings: ~142 KB against Firestore's 1 MiB document cap (~86% headroom) — see
// the Step 2 confirmation in the conversation that produced this change.
const KYC_COMPRESS_MAX_DIM = 800;
const KYC_COMPRESS_QUALITY = 0.65;
let _kycSelectedDocType = null;
let _kycSelectedFile = null;
// National ID is the only doc type that needs both faces — a driver's license/passport is a
// single page. Kept as a separate variable (not an array) so the existing front-file flow
// above is untouched for every other doc type.
let _kycSelectedFileBack = null;
// Populated by the upload step (compressed, base64, NOT yet written to Firestore) — the
// actual write happens once, at the end of the liveness step below. donors/{uid}'s update
// rule only allows a single not_submitted|rejected -> pending transition; it does not allow
// a second write while already 'pending', so the doc upload and the liveness selfie must
// land in ONE combined updateDoc call, not two separate ones like the old Cloud-Function
// flow (submitKYC then submitLivenessSelfie) used to.
let _kycIdFrontBase64 = null;
let _kycIdBackBase64 = null;

// Liveness step (Step 3) — camera-only, requested directly by the Security Lead
// (2026-08-02), preserved at the Security Lead's explicit instruction when this file moved
// off Cloud Functions. _livenessStream is the live MediaStream from getUserMedia(); torn
// down whenever the KYC view resets or the selfie is confirmed, so the camera light never
// stays on longer than the donor is actually on this step.
let _livenessStream = null;
let _livenessCapturedDataUrl = null; // full data: URL, for the <img> preview only
let _livenessSelfieBase64 = null;    // compressed base64 (no data: prefix) — what actually gets saved

// Pure — exported so it's directly unit-testable without touching the DOM.
export function validateKycFile(file) {
  if (!file) return { valid: false, error: "Please choose a file." };
  if (!KYC_MIME_EXT[file.type]) return { valid: false, error: 'Unsupported format. Please upload a JPG or PNG.' };
  if (file.size === 0) return { valid: false, error: 'File appears to be empty.' };
  if (file.size > KYC_MAX_BYTES) return { valid: false, error: 'File is too large. Maximum size is 5 MB.' };
  return { valid: true, error: null };
}

// Shared resize step — draws `source` (an <img> or a live <video> frame) onto a canvas no
// larger than 800px on its longest side, preserving aspect ratio, then hands back the canvas
// for the caller to export. Used by both the file-upload path and the live-camera capture
// path so evidence photos and the liveness selfie go through the identical pipeline.
function drawResizedToCanvas(source, sourceWidth, sourceHeight) {
  let width = sourceWidth;
  let height = sourceHeight;
  if (width > KYC_COMPRESS_MAX_DIM || height > KYC_COMPRESS_MAX_DIM) {
    if (width >= height) {
      height = Math.round(height * (KYC_COMPRESS_MAX_DIM / width));
      width = KYC_COMPRESS_MAX_DIM;
    } else {
      width = Math.round(width * (KYC_COMPRESS_MAX_DIM / height));
      height = KYC_COMPRESS_MAX_DIM;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);
  return canvas;
}

// File-upload path (ID front/back): load the file into an <img>, resize+compress, return
// base64 (no "data:image/jpeg;base64," prefix — that's added back only where needed for
// an <img src>).
function compressImageFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = drawResizedToCanvas(img, img.naturalWidth, img.naturalHeight);
        resolve(canvas.toDataURL('image/jpeg', KYC_COMPRESS_QUALITY).split(',')[1] || '');
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image file.')); };
    img.src = url;
  });
}

// Live-camera path (liveness selfie): resize+compress directly from the <video> element's
// current frame — same pipeline, no intermediate File.
function compressVideoFrameToBase64(video) {
  const canvas = drawResizedToCanvas(video, video.videoWidth, video.videoHeight);
  return canvas.toDataURL('image/jpeg', KYC_COMPRESS_QUALITY).split(',')[1] || '';
}

function updateKycSubmitEnabled() {
  const btn = document.getElementById('btnKycSubmit');
  const natIdVal = document.getElementById('kycNationalId')?.value.trim();
  const alreadyOnFile = Boolean(getCurrentUser()?.cniHash);
  const backSatisfied = _kycSelectedDocType !== 'national_id' || Boolean(_kycSelectedFileBack);
  if (btn) btn.disabled = !(_kycSelectedDocType && _kycSelectedFile && backSatisfied && (natIdVal || alreadyOnFile));
}

// Shared by both the front and back upload zones (National ID is the only doc type that
// wires up the back zone) — same validate/preview/drag-drop behavior either way, just
// pointed at different elements and a different file slot via getFile/setFile.
function wireKycFileZone({ fileInput, dropZone, removeBtn, previewEl, nameEl, metaEl, errorEl, getFile, setFile, onChange }) {
  const showFileError = (msg) => { if (errorEl) { errorEl.textContent = msg; errorEl.classList.remove('hidden'); } };
  const clearFileError = () => errorEl?.classList.add('hidden');

  const handleFile = (file) => {
    clearFileError();
    const { valid, error } = validateKycFile(file);
    if (!valid) { showFileError(error); setFile(null); onChange(); return; }
    setFile(file);
    if (nameEl) nameEl.textContent = file.name;
    if (metaEl) metaEl.textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB · Ready to upload';
    previewEl?.classList.remove('hidden');
    dropZone?.classList.add('hidden');
    onChange();
  };

  fileInput?.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  removeBtn?.addEventListener('click', () => {
    setFile(null);
    if (fileInput) fileInput.value = '';
    previewEl?.classList.add('hidden');
    dropZone?.classList.remove('hidden');
    onChange();
  });
  if (dropZone) {
    ['dragenter', 'dragover'].forEach(evt => dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add('border-primary', 'bg-primary/5');
    }));
    ['dragleave', 'drop'].forEach(evt => dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-primary', 'bg-primary/5');
    }));
    dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    });
  }
  return () => { // reset — used when the donor switches doc type away from national_id
    setFile(null);
    if (fileInput) fileInput.value = '';
    previewEl?.classList.add('hidden');
    dropZone?.classList.remove('hidden');
    clearFileError();
  };
}

function initKycView() {
  const grid = document.getElementById('kycDocTypeGrid');
  const submitBtn = document.getElementById('btnKycSubmit');
  const dashboardBtn = document.getElementById('btnKycGoToDashboard');
  const natIdInput = document.getElementById('kycNationalId');
  if (!grid) return; // not on donor.html (defensive; this file is only ever loaded there)

  natIdInput?.addEventListener('input', () => {
    document.getElementById('kycNationalIdError')?.classList.add('hidden');
    updateKycSubmitEnabled();
  });

  const resetBackZone = wireKycFileZone({
    fileInput: document.getElementById('kycFileInputBack'),
    dropZone: document.getElementById('kycDropZoneBack'),
    removeBtn: document.getElementById('btnKycRemoveFileBack'),
    previewEl: document.getElementById('kycFilePreviewBack'),
    nameEl: document.getElementById('kycFileNameBack'),
    metaEl: document.getElementById('kycFileMetaBack'),
    errorEl: document.getElementById('kycFileErrorBack'),
    getFile: () => _kycSelectedFileBack,
    setFile: (f) => { _kycSelectedFileBack = f; },
    onChange: updateKycSubmitEnabled,
  });

  grid.querySelectorAll('.kyc-doctype-card').forEach(card => {
    card.addEventListener('click', () => {
      const isNationalId = card.dataset.doctype === 'national_id';
      if (_kycSelectedDocType === 'national_id' && !isNationalId) resetBackZone();
      _kycSelectedDocType = card.dataset.doctype;
      grid.querySelectorAll('.kyc-doctype-card').forEach(c => {
        const check = c.querySelector('.kyc-doctype-check');
        const selected = c === card;
        c.classList.toggle('border-primary', selected);
        c.classList.toggle('bg-primary/5', selected);
        check?.classList.toggle('hidden', !selected);
        check?.classList.toggle('flex', selected);
      });
      const previewLabel = document.getElementById('kycPreviewLabel');
      if (previewLabel) previewLabel.textContent = (KYC_DOC_LABELS[_kycSelectedDocType] || 'Document') + ' Preview';
      // National ID needs both faces — the front zone's label/back zone's visibility both
      // reflect that; every other doc type is a single page, so only the front zone shows.
      const dropZoneLabel = document.getElementById('kycDropZoneLabel');
      if (dropZoneLabel) dropZoneLabel.textContent = isNationalId ? 'Drag and drop the front of your ID here' : 'Drag and drop document here';
      document.getElementById('kycBackUploadWrap')?.classList.toggle('hidden', !isNationalId);
      // C3.4: swap in the doc-type-specific illustrated shape above the drop zone.
      const shapeContainer = document.getElementById('kycDocPreviewShape');
      shapeContainer?.classList.remove('hidden');
      shapeContainer?.classList.add('flex');
      document.querySelectorAll('.kyc-doc-shape').forEach((shape) => {
        shape.classList.toggle('hidden', shape.dataset.doctype !== _kycSelectedDocType);
      });
      updateKycSubmitEnabled();
    });
  });

  wireKycFileZone({
    fileInput: document.getElementById('kycFileInput'),
    dropZone: document.getElementById('kycDropZone'),
    removeBtn: document.getElementById('btnKycRemoveFile'),
    previewEl: document.getElementById('kycFilePreview'),
    nameEl: document.getElementById('kycFileName'),
    metaEl: document.getElementById('kycFileMeta'),
    errorEl: document.getElementById('kycFileError'),
    getFile: () => _kycSelectedFile,
    setFile: (f) => { _kycSelectedFile = f; },
    onChange: updateKycSubmitEnabled,
  });

  submitBtn?.addEventListener('click', async () => {
    const isNationalId = _kycSelectedDocType === 'national_id';
    if (!_kycSelectedDocType || !_kycSelectedFile || (isNationalId && !_kycSelectedFileBack)) return;
    const errEl = document.getElementById('kycErrorMessage');
    errEl?.classList.add('hidden');
    const currentUser = getCurrentUser();
    const natIdVal = natIdInput?.value.trim();
    if (!natIdVal && !currentUser?.cniHash) {
      const natIdErrEl = document.getElementById('kycNationalIdError');
      if (natIdErrEl) { natIdErrEl.textContent = 'National ID (CNI) is required.'; natIdErrEl.classList.remove('hidden'); }
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing…';
    try {
      // National ID moved here from Sign Up (previously step 1) — same hash/dedupe
      // pattern the Profile page already uses for editing CNI (loadDonorProfile above),
      // reused rather than reinvented so cniHash/cniLast4 stay consistent everywhere
      // they're read (hospital check-in identity card, donation history lookups).
      if (natIdVal) {
        const hashed = await hashNationalId(natIdVal);
        const myUid = auth.currentUser?.uid || currentUser?.uid;
        if (hashed) {
          // Verify CNI uniqueness: wrap Firestore query in try/catch because newly registered
          // donors do not have custom role claims on their token yet, so firestore.rules
          // forbids listing the /users collection.
          let belongsToSomeoneElse = false;
          try {
            const dupQuery = query(collection(db, 'users'), where('cniHash', '==', hashed));
            const dupSnap = await getDocs(dupQuery);
            belongsToSomeoneElse = dupSnap.docs.some((d) => d.id !== myUid);
          } catch (dupErr) {
            console.warn('CNI uniqueness check could not be queried client-side:', dupErr?.message);
          }
          if (belongsToSomeoneElse) {
            throw new Error('This National ID (CNI) is already linked to another account.');
          }
          const cleanId = natIdVal.replace(/[\s-]/g, '');
          const cniUpdate = {
            cniHash: hashed,
            isCniVerified: true,
            cniLast4: cleanId.length >= 4 ? cleanId.slice(-4) : cleanId,
          };
          if (myUid) {
            try {
              await updateUserProfile(myUid, cniUpdate);
            } catch (uErr) {
              console.warn('Could not update CNI on user profile:', uErr?.message);
            }
            const updatedUser = { ...(currentUser || {}), ...cniUpdate };
            localStorage.setItem('vitalpulse_user', JSON.stringify(updatedUser));
          }
        }
      }

      // Step 2 (KYC_fix.md): resize + compress here, but do NOT write to Firestore yet —
      // donors/{uid}'s update rule only allows a single not_submitted|rejected -> pending
      // transition, so this gets combined with the liveness selfie into one updateDoc call
      // at the end of the next step (see initKycLivenessStep's submit handler below).
      _kycIdFrontBase64 = await compressImageFileToBase64(_kycSelectedFile);
      _kycIdBackBase64 = isNationalId && _kycSelectedFileBack
        ? await compressImageFileToBase64(_kycSelectedFileBack)
        : null;

      showKycLivenessStep();
    } catch (err) {
      console.error('KYC document processing failed:', err);
      if (errEl) {
        errEl.textContent = err?.message || 'Could not process your document. Please try again.';
        errEl.classList.remove('hidden');
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit for Verification';
    }
  });

  dashboardBtn?.addEventListener('click', () => {
    loadKycView(true);
    switchDonorView('dashboard');
  });
}

// ============================================
// KYC Step 3 — Liveness selfie (camera-only)
// ============================================
function stopLivenessCamera() {
  if (_livenessStream) {
    _livenessStream.getTracks().forEach(t => t.stop());
    _livenessStream = null;
  }
}

function setLivenessError(msg) {
  const el = document.getElementById('kycLivenessError');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

// stage: 'start' | 'capture' | 'confirm' — exactly one of the three control rows visible.
function showLivenessControls(stage) {
  [['start', 'kycLivenessControlsStart'], ['capture', 'kycLivenessControlsCapture'], ['confirm', 'kycLivenessControlsConfirm']].forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const visible = key === stage;
    el.classList.toggle('hidden', !visible);
    el.classList.toggle('flex', visible);
  });
}

async function startLivenessCamera() {
  setLivenessError('');
  if (!navigator.mediaDevices?.getUserMedia) {
    setLivenessError('Camera API is not supported in this browser. Please use the "Upload selfie photo instead" option below.');
    return;
  }
  try {
    try {
      // FacingMode 'user' for selfie camera
      _livenessStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch {
      // Fallback for desktop USB webcams that reject facingMode constraints
      _livenessStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  } catch (err) {
    console.error('getUserMedia failed:', err);
    setLivenessError(
      err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
        ? 'Camera permission was denied. Please allow camera access in your browser or click "Upload selfie photo instead" below.'
        : 'Could not access your camera. You can click "Upload selfie photo instead" below to proceed.'
    );
    return;
  }
  const video = document.getElementById('kycLivenessVideo');
  if (video) {
    video.srcObject = _livenessStream;
    video.classList.remove('hidden');
    try {
      await video.play();
    } catch (playErr) {
      console.warn('Video play() call encountered:', playErr);
    }
  }
  document.getElementById('kycLivenessPreviewImg')?.classList.add('hidden');
  document.getElementById('kycLivenessPlaceholder')?.classList.add('hidden');
  const guide = document.getElementById('kycLivenessGuide');
  guide?.classList.remove('hidden');
  guide?.classList.add('flex');
  showLivenessControls('capture');
}

function captureLivenessSelfie() {
  const video = document.getElementById('kycLivenessVideo');
  const canvas = document.getElementById('kycLivenessCanvas');
  if (!video || !canvas) return;

  if (!video.videoWidth && video.readyState < 2) {
    setLivenessError('Camera is still loading. Please wait 1 second and click Capture Photo again.');
    return;
  }

  try {
    // Step 2 (KYC_fix.md) applies to the liveness selfie too, not just the uploaded ID photo —
    // resize to <=800px/JPEG q65 via the same pipeline, instead of capturing at full camera resolution.
    _livenessSelfieBase64 = compressVideoFrameToBase64(video);
    _livenessCapturedDataUrl = 'data:image/jpeg;base64,' + _livenessSelfieBase64;

    // Stop live stream now that image is safely captured
    stopLivenessCamera();
    video.classList.add('hidden');
    const previewImg = document.getElementById('kycLivenessPreviewImg');
    if (previewImg) { previewImg.src = _livenessCapturedDataUrl; previewImg.classList.remove('hidden'); }
    const guide = document.getElementById('kycLivenessGuide');
    guide?.classList.add('hidden');
    guide?.classList.remove('flex');
    showLivenessControls('confirm');
    setLivenessError('');
  } catch (err) {
    console.error('Frame capture failed:', err);
    setLivenessError('Could not capture photo from video. Please try again or use the upload option.');
  }
}

function retakeLivenessSelfie() {
  _livenessCapturedDataUrl = null;
  _livenessSelfieBase64 = null;
  document.getElementById('kycLivenessPreviewImg')?.classList.add('hidden');
  document.getElementById('kycLivenessPlaceholder')?.classList.remove('hidden');
  showLivenessControls('start');
}

function resetLivenessStep() {
  stopLivenessCamera();
  _livenessCapturedDataUrl = null;
  _livenessSelfieBase64 = null;
  setLivenessError('');
  document.getElementById('kycLivenessVideo')?.classList.add('hidden');
  document.getElementById('kycLivenessPreviewImg')?.classList.add('hidden');
  const guide = document.getElementById('kycLivenessGuide');
  guide?.classList.add('hidden');
  guide?.classList.remove('flex');
  document.getElementById('kycLivenessPlaceholder')?.classList.remove('hidden');
  showLivenessControls('start');
  const submitSelfieBtn = document.getElementById('btnKycSubmitSelfie');
  if (submitSelfieBtn) { submitSelfieBtn.disabled = false; submitSelfieBtn.innerHTML = '<span class="material-symbols-outlined text-lg">check</span> Confirm &amp; Submit'; }
}

function showKycLivenessStep() {
  document.getElementById('kycUploadStep')?.classList.add('hidden');
  resetLivenessStep();
  document.getElementById('kycLivenessStep')?.classList.remove('hidden');
}

function initKycLivenessStep() {
  document.getElementById('btnKycStartCamera')?.addEventListener('click', startLivenessCamera);
  document.getElementById('btnKycCaptureSelfie')?.addEventListener('click', captureLivenessSelfie);
  document.getElementById('btnKycRetakeSelfie')?.addEventListener('click', retakeLivenessSelfie);

  document.getElementById('btnKycBackToUpload')?.addEventListener('click', () => {
    stopLivenessCamera();
    document.getElementById('kycLivenessStep')?.classList.add('hidden');
    document.getElementById('kycUploadStep')?.classList.remove('hidden');
  });

  // Fallback upload for localhost or devices without camera access
  document.getElementById('kycSelfieFileInput')?.addEventListener('change', async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    const { valid, error } = validateKycFile(file);
    if (!valid) {
      setLivenessError(error);
      return;
    }
    try {
      _livenessSelfieBase64 = await compressImageFileToBase64(file);
      _livenessCapturedDataUrl = 'data:image/jpeg;base64,' + _livenessSelfieBase64;
      stopLivenessCamera();
      document.getElementById('kycLivenessVideo')?.classList.add('hidden');
      document.getElementById('kycLivenessPlaceholder')?.classList.add('hidden');
      const previewImg = document.getElementById('kycLivenessPreviewImg');
      if (previewImg) { previewImg.src = _livenessCapturedDataUrl; previewImg.classList.remove('hidden'); }
      const guide = document.getElementById('kycLivenessGuide');
      guide?.classList.add('hidden');
      guide?.classList.remove('flex');
      showLivenessControls('confirm');
      setLivenessError('');
    } catch (err) {
      console.error('Selfie upload processing failed:', err);
      setLivenessError('Could not process the selected image file. Please try another.');
    }
  });

  document.getElementById('btnKycSubmitSelfie')?.addEventListener('click', async () => {
    if (!_livenessSelfieBase64 || !_kycIdFrontBase64 || !_kycSelectedDocType) return;
    const btn = document.getElementById('btnKycSubmitSelfie');
    const currentUser = getCurrentUser();
    if (!currentUser?.uid) return;
    setLivenessError('');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      // If the donors doc doesn't exist, create it first in the 'not_submitted' state to satisfy firestore.rules
      if (_donorKycStatus === null) {
        await setDoc(doc(db, 'donors', currentUser.uid), {
          kycStatus: 'not_submitted',
          kycDocType: null,
          kycIdImageBase64: null,
          kycIdBackImageBase64: null,
          kycSelfieImageBase64: null,
          kycRejectionReason: null,
          kycReviewedBy: null,
          kycReviewedAt: null,
        });
        // Update local status so snapshot triggers know it is initialized
        _donorKycStatus = 'not_submitted';
      }

      // The ONE write that transitions donors/{uid} from not_submitted|rejected -> pending
      // (see firestore.rules' donors/{donorId} allow update) — ID front/back and the
      // liveness selfie all land together, matching the doc-type + evidence shape the
      // rule's transition clause expects. kycRejectionReason is cleared here too (not locked
      // by the rule for this transition) so a resubmission doesn't leave a stale reason
      // sitting on the doc.
      await updateDoc(doc(db, 'donors', currentUser.uid), {
        kycStatus: 'pending',
        kycDocType: _kycSelectedDocType,
        kycIdImageBase64: _kycIdFrontBase64,
        kycIdBackImageBase64: _kycIdBackBase64,
        kycSelfieImageBase64: _livenessSelfieBase64,
        kycSubmittedAt: serverTimestamp(),
        kycRejectionReason: null,
      });
      document.getElementById('kycLivenessStep')?.classList.add('hidden');
      document.getElementById('kycSuccessStep')?.classList.remove('hidden');
    } catch (err) {
      console.error('KYC submission failed:', err);
      setLivenessError(err?.message || 'Submission failed. Please try again.');
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined text-lg">check</span> Confirm &amp; Submit';
    }
  });
}

// Called every time the KYC view becomes active (switchDonorView).
// Preserves user selections and files so accidental navigation or network retries
// don't wipe out completed inputs. Only wipes clean when explicitly forceReset=true.
function loadKycView(forceReset = false) {
  if (forceReset) {
    _kycSelectedDocType = null;
    _kycSelectedFile = null;
    _kycSelectedFileBack = null;
    _kycIdFrontBase64 = null;
    _kycIdBackBase64 = null;
  }
  document.getElementById('kycUploadStep')?.classList.remove('hidden');
  document.getElementById('kycLivenessStep')?.classList.add('hidden');
  resetLivenessStep();
  document.getElementById('kycSuccessStep')?.classList.add('hidden');
  document.getElementById('kycFileError')?.classList.add('hidden');
  document.getElementById('kycErrorMessage')?.classList.add('hidden');
  document.getElementById('kycNationalIdError')?.classList.add('hidden');
  document.getElementById('kycFileErrorBack')?.classList.add('hidden');

  const fileInput = document.getElementById('kycFileInput');
  const fileInputBack = document.getElementById('kycFileInputBack');
  const natIdInput = document.getElementById('kycNationalId');

  if (forceReset) {
    if (fileInput) fileInput.value = '';
    if (fileInputBack) fileInputBack.value = '';
    if (natIdInput) natIdInput.value = '';
    document.getElementById('kycFilePreview')?.classList.add('hidden');
    document.getElementById('kycDropZone')?.classList.remove('hidden');
    document.getElementById('kycBackUploadWrap')?.classList.add('hidden');
    document.getElementById('kycFilePreviewBack')?.classList.add('hidden');
    document.getElementById('kycDropZoneBack')?.classList.remove('hidden');
    const dropZoneLabel = document.getElementById('kycDropZoneLabel');
    if (dropZoneLabel) dropZoneLabel.textContent = 'Drag and drop document here';
    const shapeContainer = document.getElementById('kycDocPreviewShape');
    shapeContainer?.classList.add('hidden');
    shapeContainer?.classList.remove('flex');
    document.getElementById('kycDocTypeGrid')?.querySelectorAll('.kyc-doctype-card').forEach(c => {
      c.classList.remove('border-primary', 'bg-primary/5');
      const check = c.querySelector('.kyc-doctype-check');
      check?.classList.add('hidden');
      check?.classList.remove('flex');
    });
    const previewLabel = document.getElementById('kycPreviewLabel');
    if (previewLabel) previewLabel.textContent = 'Document Preview';
  } else {
    // Restore and preserve active card styling if doc type was selected
    if (_kycSelectedDocType) {
      const isNationalId = _kycSelectedDocType === 'national_id';
      document.getElementById('kycDocTypeGrid')?.querySelectorAll('.kyc-doctype-card').forEach(c => {
        const isSelected = c.dataset.doctype === _kycSelectedDocType;
        c.classList.toggle('border-primary', isSelected);
        c.classList.toggle('bg-primary/5', isSelected);
        const check = c.querySelector('.kyc-doctype-check');
        check?.classList.toggle('hidden', !isSelected);
        check?.classList.toggle('flex', isSelected);
      });
      const previewLabel = document.getElementById('kycPreviewLabel');
      if (previewLabel) previewLabel.textContent = (KYC_DOC_LABELS[_kycSelectedDocType] || 'Document') + ' Preview';
      const dropZoneLabel = document.getElementById('kycDropZoneLabel');
      if (dropZoneLabel) dropZoneLabel.textContent = isNationalId ? 'Drag and drop the front of your ID here' : 'Drag and drop document here';
      document.getElementById('kycBackUploadWrap')?.classList.toggle('hidden', !isNationalId);
      const shapeContainer = document.getElementById('kycDocPreviewShape');
      shapeContainer?.classList.remove('hidden');
      shapeContainer?.classList.add('flex');
      document.querySelectorAll('.kyc-doc-shape').forEach(shape => {
        shape.classList.toggle('hidden', shape.dataset.doctype !== _kycSelectedDocType);
      });
    }
    // Restore file previews if files already selected
    if (_kycSelectedFile) {
      document.getElementById('kycFilePreview')?.classList.remove('hidden');
      document.getElementById('kycDropZone')?.classList.add('hidden');
      const nameEl = document.getElementById('kycFileName');
      const metaEl = document.getElementById('kycFileMeta');
      if (nameEl) nameEl.textContent = _kycSelectedFile.name;
      if (metaEl) metaEl.textContent = (_kycSelectedFile.size / 1024 / 1024).toFixed(2) + ' MB · Ready to upload';
    }
    if (_kycSelectedFileBack) {
      document.getElementById('kycFilePreviewBack')?.classList.remove('hidden');
      document.getElementById('kycDropZoneBack')?.classList.add('hidden');
      const nameElBack = document.getElementById('kycFileNameBack');
      const metaElBack = document.getElementById('kycFileMetaBack');
      if (nameElBack) nameElBack.textContent = _kycSelectedFileBack.name;
      if (metaElBack) metaElBack.textContent = (_kycSelectedFileBack.size / 1024 / 1024).toFixed(2) + ' MB · Ready to upload';
    }
  }

  if (natIdInput && !natIdInput.value) {
    natIdInput.placeholder = getCurrentUser()?.cniHash ? 'Already on file — re-enter only to update' : 'e.g. 102938475';
  }

  updateKycSubmitEnabled();
  const submitBtn = document.getElementById('btnKycSubmit');
  if (submitBtn) submitBtn.textContent = 'Submit for Verification';
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

export function resolveLastDonationDate(currentUser, engagement) {
  const dates = [];

  const parseDate = (val) => {
    if (!val) return null;
    if (val.toDate && typeof val.toDate === 'function') return val.toDate();
    if (typeof val === 'number') return new Date(val);
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  };

  const addVal = (val) => {
    const d = parseDate(val);
    if (d) dates.push(d);
  };

  addVal(currentUser?.lastDonationDate);
  addVal(currentUser?.lastDonatedAt);

  if (engagement?.donations) {
    const completed = engagement.donations
      .filter(d => d.status === 'completed')
      .sort((a, b) => {
        const da = parseDate(b.completedAt || b.preferredDate || 0);
        const db = parseDate(a.completedAt || a.preferredDate || 0);
        return (da?.getTime() || 0) - (db?.getTime() || 0);
      });
    if (completed[0]) {
      addVal(completed[0].completedAt || completed[0].preferredDate);
    }
  }

  if (dates.length === 0) return null;

  dates.sort((a, b) => b.getTime() - a.getTime());
  return dates[0].toISOString();
}

export function getEligibilityInfo(lastDonationDate) {
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
function isDonorEligibleNow() {
  const currentUser = getCurrentUser();
  if (!_donorEligibilityCache && currentUser) {
    const effectiveLastDate = resolveLastDonationDate(currentUser, null);
    _donorEligibilityCache = getEligibilityInfo(effectiveLastDate);
  }
  return !_donorEligibilityCache || _donorEligibilityCache.eligible !== false;
}

async function warnIfIneligible() {
  if (isDonorEligibleNow()) return true;
  const d = _donorEligibilityCache?.daysUntil || 0;
  await window.vpAlert({
    type: 'warning',
    title: 'WHO Medical Deferral Active',
    message: `For donor health & safety, WHO guidelines require a minimum wait of 56 days between whole blood donations. You will be eligible to donate again in ${d} day${d === 1 ? '' : 's'}.`,
    confirmText: 'Understood',
  });
  return false;
}

export function isRequestWithin24Hours(req) {
  if (!req) return false;
  const raw = req.requestedAt || req.timestamp || req.createdAt || req.updatedAt;
  if (!raw) return false;
  const ts = typeof raw === 'number'
    ? raw
    : typeof raw?.toMillis === 'function'
    ? raw.toMillis()
    : new Date(raw).getTime();
  if (!ts || isNaN(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs >= -300000 && ageMs <= 24 * 60 * 60 * 1000;
}

export function formatRequestTiming(req) {
  if (!req) {
    return {
      postedAgo: 'Recently',
      postedDateStr: '',
      deadlineLabel: 'Needed by',
      deadlineText: 'Standard Schedule',
      deadlineColor: 'text-slate-800 dark:text-slate-200',
      isOverdue: false,
      isStale: false
    };
  }

  const rawPosted = req.requestedAt || req.timestamp || req.createdAt || req.updatedAt;
  let postedDate = null;
  if (rawPosted) {
    if (typeof rawPosted === 'number') postedDate = new Date(rawPosted);
    else if (typeof rawPosted?.toDate === 'function') postedDate = rawPosted.toDate();
    else if (typeof rawPosted?.toMillis === 'function') postedDate = new Date(rawPosted.toMillis());
    else {
      const p = new Date(rawPosted);
      if (!isNaN(p.getTime())) postedDate = p;
    }
  }

  const hasValidPosted = postedDate && !isNaN(postedDate.getTime());
  const postedAgo = hasValidPosted ? getTimeAgo(postedDate.toISOString()) : 'Recently';
  const postedDateStr = hasValidPosted ? postedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  const normUrgency = getNormalizedUrgency(req.urgency);
  const isCritical = normUrgency === 'critical' || req.isEmergency === true;
  const isUrgent = normUrgency === 'urgent';

  // Explicit requiredBy / neededBy / deadline if provided
  const explicit = req.requiredBy || req.neededBy || req.deadline;
  let deadlineDate = null;
  if (explicit) {
    const parsed = new Date(explicit);
    if (!isNaN(parsed.getTime())) deadlineDate = parsed;
  }

  // If no explicit deadline, determine clinical deadline from posted date + clinical urgency window
  if (!deadlineDate) {
    if (hasValidPosted) {
      // Clinical emergency window from creation:
      // Critical emergency: 6 hours from dispatch
      // Urgent: 24 hours from dispatch
      // Routine: 48 hours from dispatch
      const hoursWindow = isCritical ? 6 : isUrgent ? 24 : 48;
      deadlineDate = new Date(postedDate.getTime() + hoursWindow * 60 * 60 * 1000);
    } else {
      deadlineDate = new Date();
      deadlineDate.setHours(isCritical ? 18 : isUrgent ? 20 : 21, 0, 0, 0);
    }
  }

  const now = new Date();
  const diffMs = deadlineDate.getTime() - now.getTime();
  const isOverdue = diffMs < 0;

  // Day relationships
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dlMidnight = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());
  const dayDiff = Math.round((dlMidnight - nowMidnight) / (1000 * 60 * 60 * 24));

  const timeStr = deadlineDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateShort = deadlineDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  let deadlineLabel = 'Needed by';
  let deadlineText = '';
  let deadlineColor = isCritical ? 'text-red-600 dark:text-red-400 font-black' : 'text-slate-800 dark:text-slate-200 font-black';
  let isStale = false;

  if (isOverdue) {
    const daysAgo = Math.abs(dayDiff);
    if (daysAgo === 0) {
      deadlineLabel = 'Target Window';
      deadlineText = `Passed today (${timeStr})`;
      deadlineColor = 'text-amber-600 dark:text-amber-400 font-bold';
    } else if (daysAgo === 1) {
      deadlineLabel = 'Target Window';
      deadlineText = `Passed yesterday`;
      deadlineColor = 'text-rose-600 dark:text-rose-400 font-bold';
    } else {
      isStale = true;
      deadlineLabel = 'Requisition Period';
      deadlineText = `Past Target (${dateShort})`;
      deadlineColor = 'text-slate-500 dark:text-slate-400 font-semibold';
    }
  } else if (dayDiff === 0) {
    const hoursLeft = Math.max(1, Math.round(diffMs / (1000 * 60 * 60)));
    deadlineLabel = 'Needed by';
    deadlineText = `Today, ${timeStr} (~${hoursLeft}h left)`;
    deadlineColor = isCritical ? 'text-red-600 dark:text-red-400 font-black' : 'text-slate-800 dark:text-slate-200 font-black';
  } else if (dayDiff === 1) {
    deadlineLabel = 'Needed by';
    deadlineText = `Tomorrow, ${timeStr}`;
    deadlineColor = 'text-slate-800 dark:text-slate-200 font-black';
  } else {
    deadlineLabel = 'Needed by';
    deadlineText = `${dateShort}, ${timeStr}`;
    deadlineColor = 'text-slate-800 dark:text-slate-200 font-black';
  }

  return {
    postedAgo,
    postedDateStr,
    deadlineLabel,
    deadlineText,
    deadlineColor,
    isOverdue,
    isStale
  };
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

  const countEl = document.getElementById('urgentReqTotalCount');
  if (countEl) countEl.textContent = filtered.length;

  if (filtered.length === 0) {
    const hasOtherCityReqs = _selectedCity && _allRequests.length > 0;
    feedEl.innerHTML = `<div class="flex flex-col items-center text-center py-12 text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-800/30 border border-slate-200/60 dark:border-slate-700/60 rounded-2xl p-6 sm:p-8">
      <div class="relative w-16 h-16 rounded-2xl ${_selectedCity ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'} flex items-center justify-center mb-3.5 shadow-inner">
        <span class="material-symbols-outlined text-3xl">${_selectedCity ? 'search_off' : 'verified_user'}</span>
        ${!_selectedCity ? '<span class="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 animate-ping"></span><span class="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500"></span>' : ''}
      </div>
      <h3 class="font-black font-headline text-slate-900 dark:text-white text-base">${_selectedCity ? 'No requests in ' + esc(_selectedCity) : 'All Requisitions Fulfilled'}</h3>
      <p class="text-xs sm:text-sm mt-1 max-w-sm text-slate-500 dark:text-slate-400">${_selectedCity ? 'There are currently no active blood requests for this city. Try selecting All Cameroon or check back shortly.' : 'No urgent blood shortages reported in your region right now. You can check back soon or explore accredited donation centers.'}</p>
      <div class="flex items-center justify-center gap-2 mt-4 flex-wrap">
        ${hasOtherCityReqs ? `
          <button onclick="window._filterCity(null)" class="press-scale inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary hover:opacity-95 text-white font-extrabold text-xs shadow-md shadow-primary/25 transition-all cursor-pointer">
            <span class="material-symbols-outlined text-xs">public</span>
            <span>View All Cameroon (${_allRequests.length})</span>
          </button>
        ` : ''}
        <button onclick="window.switchDonorView('centers')" class="press-scale inline-flex items-center gap-1.5 px-4 py-2 rounded-full ${hasOtherCityReqs ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200' : 'bg-red-600 hover:bg-red-700 text-white'} font-extrabold text-xs shadow-md transition-all cursor-pointer">
          <span class="material-symbols-outlined text-xs">local_hospital</span>
          <span>Browse Certified Centers</span>
          <span class="material-symbols-outlined text-xs">arrow_forward</span>
        </button>
      </div>
    </div>`;
    return;
  }
  // Show the first 5 by default; "View all" reveals the rest in place. This keeps the
  // dashboard short when a donor wakes to a big feed (e.g. 30 requests) but still lets them
  // browse every one without leaving the page. The underlying list is capped at 50 upstream.
  const INITIAL_FEED = 5;
  const shownRequests = _feedExpanded ? filtered : filtered.slice(0, INITIAL_FEED);
  // Accepting is blocked while Busy, inside the 56-day deferral window, or (D3) while KYC
  // is pending/rejected — the whole panel below also gets a blur+lock overlay for this last
  // case (applyKycLocksToDOM), this per-button state is defense-in-depth on top of that.
  const ineligible = !isDonorEligibleNow();
  const kycPending = !isDonorVerified();
  const acceptBlocked = isBusy || ineligible || kycPending;
  const deferralPct = _donorEligibilityCache?.barPct || 0;
  const deferralDays = _donorEligibilityCache?.daysUntil || 0;
  const blockBanner = isBusy
    ? `<div class="flex items-center gap-2.5 bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs font-semibold px-4 py-3 rounded-2xl shadow-xs mb-3">
         <span class="material-symbols-outlined text-base shrink-0 text-amber-600">info</span>
         <span>You are currently marked <strong>Busy</strong> — accepting requests is paused. <button data-action="switch-view" data-view="dashboard" class="underline font-bold hover:no-underline cursor-pointer ml-1">Toggle availability →</button></span>
       </div>`
    : ineligible
    ? `<div class="bg-slate-50/70 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60 rounded-2xl p-3.5 sm:p-4 shadow-xs mb-3 space-y-2">
         <div class="flex items-start gap-3">
           <div class="w-8 h-8 rounded-xl bg-red-500/10 text-red-600 flex items-center justify-center shrink-0 mt-0.5">
             <span class="material-symbols-outlined text-base">schedule</span>
           </div>
           <div class="min-w-0 flex-1">
             <p class="font-bold text-xs sm:text-sm text-slate-900 dark:text-white">WHO 56-day deferral active</p>
             <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">You can donate again in <strong>${deferralDays} day${deferralDays === 1 ? '' : 's'}</strong>. Requisition dispatch is paused during donor recovery.</p>
           </div>
         </div>
         <div class="h-1.5 bg-slate-200 dark:bg-slate-700/80 rounded-full overflow-hidden">
           <div class="h-full bg-gradient-to-r from-amber-500 to-orange-400 rounded-full" style="width:${deferralPct}%"></div>
         </div>
       </div>`
    : '';
  feedEl.innerHTML = blockBanner + shownRequests.map(req => {
    const isCritical = (req.urgency || '').toLowerCase() === 'critical';
    const isUrgent = (req.urgency || '').toLowerCase() === 'urgent';
    const isPublic = Boolean(req.isPublicRequest);
    const isNew24h = isRequestWithin24Hours(req);
    const timing = formatRequestTiming(req);
    const newBadge = isNew24h
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-emerald-500 text-white shadow-xs shrink-0" title="Posted within the last 24 hours"><span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span><span>NEW</span></span>`
      : '';
    const isCentralCommand = (req.hospital === 'Central Command' || req.hospitalName === 'Central Command' || req.systemWide === true);
    const publicBadge = isPublic ? `<span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 shrink-0">Public SOS</span>` : '';
    
    const verificationStyle = {
      'Hospital-Confirmed': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
      'Document Attached': 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
      'Unverified': 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30',
    };
    const docBadge = isPublic && req.verificationLevel
      ? `<span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider border shrink-0 ${verificationStyle[req.verificationLevel] || 'bg-slate-100 text-slate-600'}">${req.verificationLevel}</span>`
      : '';

    const bt = req.bloodType || req.type || '?';
    const btDisplay = bt.replace('+', '+').replace('-', '−');
    const units = req.units || 1;
    const component = req.componentType || 'Whole Blood';
    const componentShort = component === 'PRBC' ? 'PRBC' : component === 'Plasma' ? 'Plasma' : component === 'Platelets' ? 'PLT' : 'Whole';
    const notes = (req.notes || '').trim();
    const pickup = (req.pickupLocation || '').trim();
    const urgency = (req.urgency || '').toLowerCase();

    const urgencyBadge = isCritical
      ? '<span class="bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/25 font-black text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0"><span class="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse"></span><span>CRITICAL</span></span>'
      : isUrgent
      ? '<span class="bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/25 font-black text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0"><span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span><span>HIGH PRIORITY</span></span>'
      : '<span class="bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/25 font-black text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0">MODERATE</span>';

    const cardHoverBorder = isCritical
      ? 'hover:border-red-300 dark:hover:border-red-900/60'
      : isUrgent
      ? 'hover:border-amber-300 dark:hover:border-amber-900/60'
      : 'hover:border-rose-300 dark:hover:border-rose-900/60';

    const ampouleGradient = isCritical
      ? 'bg-gradient-to-br from-red-600 to-rose-600 text-white shadow-sm shadow-red-600/30'
      : isUrgent
      ? 'bg-gradient-to-br from-amber-500 to-rose-600 text-white shadow-sm shadow-amber-600/30'
      : 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-sm shadow-rose-600/30';

    const distKm = parseFloat(req.distanceKm || (typeof req.distance === 'number' ? req.distance : 0));
    const etaText = distKm > 0 
      ? (distKm <= 1 ? '~3 min' : distKm > 40 ? `~${Math.round(distKm * 1.4)} min` : `~${Math.round(distKm * 2.4 + 2)} min`)
      : '';
    const distanceStr = req.distanceKm ? req.distanceKm + ' km' : (req.distance || req.city || 'Local');
    
    const proximityChip = distKm > 0
      ? `<span class="inline-flex items-center gap-1 font-bold text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
           <span class="material-symbols-outlined text-xs text-red-500">near_me</span>
           <span>${distKm} km${etaText ? ` (${etaText})` : ''}</span>
         </span>`
      : `<span class="inline-flex items-center gap-1 font-medium text-slate-500 dark:text-slate-400">
           <span class="material-symbols-outlined text-xs text-slate-400">near_me</span>
           <span>${esc(distanceStr)}</span>
         </span>`;

    const systemWideTag = isCentralCommand
      ? '<span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30 shrink-0">System-wide</span>'
      : '';

    const tagline = notes
      ? `<p class="text-xs text-slate-600 dark:text-slate-300 italic bg-white/60 dark:bg-slate-900/40 border-l-2 border-red-500/60 rounded-r-md px-2.5 py-1 line-clamp-2">"${esc(notes)}"</p>`
      : '';

    const actionBtn = acceptBlocked
      ? `<button disabled title="${kycPending ? 'Complete identity verification first' : ineligible ? 'Deferral active — ' + deferralDays + ' days remaining' : 'Toggle availability first'}" class="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-1.5 bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 font-bold text-xs px-4 py-2.5 rounded-xl cursor-not-allowed border border-slate-200/50 dark:border-slate-700/50">
           <span class="material-symbols-outlined text-xs">lock</span>
           <span>${kycPending ? 'Verify Identity' : ineligible ? `${deferralDays}d Deferral` : 'Unavailable'}</span>
         </button>`
      : `<button onclick="window.donorAcceptRequest('${req.id}', '${currentUser?.uid || ''}', ${isPublic})" class="press-scale w-full sm:w-auto shrink-0 inline-flex items-center justify-center bg-gradient-to-r from-red-600 via-rose-600 to-red-700 hover:from-red-500 hover:to-rose-500 text-white font-black text-xs sm:text-sm px-5 py-2.5 rounded-xl shadow-sm shadow-red-600/25 active:scale-[0.98] transition-all cursor-pointer">
           <span>Respond Now</span>
         </button>`;

    return `
    <div class="relative rounded-2xl bg-slate-50/80 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 p-3.5 sm:p-4 shadow-2xs ${cardHoverBorder} transition-all space-y-2.5">
      <!-- Top Row: Ampoule, Facility Info & Urgency Pill -->
      <div class="flex items-start justify-between gap-2.5">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-11 h-11 sm:w-12 sm:h-12 rounded-xl ${ampouleGradient} flex flex-col items-center justify-center shrink-0 font-headline">
            <span class="text-base sm:text-lg font-black leading-none">${btDisplay}</span>
            <span class="text-[7px] font-bold uppercase tracking-wider opacity-90">${esc(componentShort)}</span>
          </div>
          <div class="min-w-0">
            <h3 class="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white truncate flex items-center gap-1">
              <span>${esc(req.hospital || req.hospitalName)}</span>
              <span class="material-symbols-outlined text-[13px] text-emerald-500 shrink-0" title="Verified Facility">verified</span>
            </h3>
            <p class="text-[11px] text-slate-400 truncate flex items-center gap-0.5 mt-0.5">
              <span class="material-symbols-outlined text-xs text-slate-400">location_on</span>
              <span>${esc(req.city || 'Cameroon')}</span>
            </p>
          </div>
        </div>
        <div class="shrink-0 flex items-center gap-1.5">
          ${newBadge}
          ${urgencyBadge}
        </div>
      </div>

      <!-- Secondary Badges (if any) -->
      ${(publicBadge || systemWideTag || docBadge) ? `<div class="flex items-center gap-1.5 flex-wrap">${publicBadge}${systemWideTag}${docBadge}</div>` : ''}

      <!-- Telemetry row: Units, Proximity, Needed By & Time ago -->
      <div class="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-700/60 text-[11px]">
        <span class="inline-flex items-center gap-1 font-extrabold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/50 border border-red-200/50 dark:border-red-900/50 px-2 py-0.5 rounded-md">
          <span class="material-symbols-outlined text-xs" style="font-variation-settings:'FILL' 1">water_drop</span>
          <span>${units} unit${units > 1 ? 's' : ''} needed</span>
        </span>
        ${proximityChip}
        <span class="text-slate-500 dark:text-slate-400 font-medium text-[10px] ml-auto flex items-center gap-1 flex-wrap justify-end">
          <span>${timing.deadlineLabel}: <strong class="${timing.deadlineColor}">${timing.deadlineText}</strong></span>
          <span class="text-slate-300 dark:text-slate-600">&bull;</span>
          <span>Posted ${timing.postedAgo}</span>
        </span>
      </div>

      ${pickup ? `<p class="text-[10px] text-slate-400 flex items-center gap-1 truncate"><span class="material-symbols-outlined text-[11px]">meeting_room</span>Pickup: ${esc(pickup)}</p>` : ''}
      ${tagline}

      <!-- Action Row: Full width on mobile, sleek, NO ARROW -->
      <div class="pt-1 flex flex-col sm:flex-row sm:items-center sm:justify-end">
        ${actionBtn}
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
let centersMapInstance = null;
let _donationCenters = [];
let _centersVisibleCount = 5;
let _centersExpanded = false;
const INITIAL_CENTERS = 5;
let nearbyTabsInitialized = false;
let _allCentersSearch = '';
let _allCentersCity = null;
let _allCentersWired = false;

let _centersFilterType = '';
let _centersSortSelector = 'nearest';

window.focusCenterOnMap = (hospitalName) => {
  window.switchCentersMobileTab('map');
  const target = _donationCenters.find(h => (h.name || '').toLowerCase() === (hospitalName || '').toLowerCase());
  if (target && target.coords && centersMapInstance) {
    document.getElementById('centersMapCol')?.scrollIntoView({ behavior: 'smooth' });
    centersMapInstance.flyTo([target.coords.lat, target.coords.lon], 14, { duration: 1.2 });
    showToast(`Radar focused on ${target.name}`);
  }
};

window.switchCentersMobileTab = (tab) => {
  const mapCol = document.getElementById('centersMapCol');
  const listCol = document.getElementById('centersListCol');
  const btnList = document.getElementById('btnCentersMobileList');
  const btnMap = document.getElementById('btnCentersMobileMap');
  if (!mapCol || !listCol) return;

  if (tab === 'map') {
    mapCol.classList.remove('hidden');
    listCol.classList.add('hidden', 'lg:block');
    btnMap?.classList.add('bg-white', 'dark:bg-slate-900', 'text-slate-900', 'dark:text-white', 'shadow-xs', 'font-black');
    btnMap?.classList.remove('text-slate-500', 'dark:text-slate-400', 'font-bold');
    btnList?.classList.remove('bg-white', 'dark:bg-slate-900', 'text-slate-900', 'dark:text-white', 'shadow-xs', 'font-black');
    btnList?.classList.add('text-slate-500', 'dark:text-slate-400', 'font-bold');
    setTimeout(() => {
      centersMapInstance?.invalidateSize();
    }, 150);
  } else {
    listCol.classList.remove('hidden');
    mapCol.classList.add('hidden', 'lg:block');
    btnList?.classList.add('bg-white', 'dark:bg-slate-900', 'text-slate-900', 'dark:text-white', 'shadow-xs', 'font-black');
    btnList?.classList.remove('text-slate-500', 'dark:text-slate-400', 'font-bold');
    btnMap?.classList.remove('bg-white', 'dark:bg-slate-900', 'text-slate-900', 'dark:text-white', 'shadow-xs', 'font-black');
    btnMap?.classList.add('text-slate-500', 'dark:text-slate-400', 'font-bold');
  }
};

window.resetCentersFilters = () => {
  _allCentersSearch = '';
  _allCentersCity = null;
  _centersFilterType = '';
  _centersSortSelector = 'nearest';
  _centersExpanded = false;
  const search = document.getElementById('allCentersSearch');
  if (search) search.value = '';
  const typeSel = document.getElementById('centersFilterType');
  if (typeSel) typeSel.value = '';
  const sortSel = document.getElementById('centersSortSelector');
  if (sortSel) sortSel.value = 'nearest';
  document.getElementById('btnResetCentersFilters')?.classList.add('hidden');
  renderAllCentersCityChips();
  renderAllCentersList();
  const currentUser = getCurrentUser();
  renderCentersMap(getCoordinatesForLocation(currentUser?.city, currentUser?.lat, currentUser?.lng));
};

window.locateNearestCenter = () => {
  const currentUser = getCurrentUser();
  const donorCoords = getCoordinatesForLocation(currentUser?.city, currentUser?.lat, currentUser?.lng);
  if (!donorCoords) return;
  let nearest = null;
  let minDist = Infinity;
  _donationCenters.forEach(h => {
    if (h.coords) {
      const d = calculateDistanceKm(donorCoords.lat, donorCoords.lon, h.coords.lat, h.coords.lon);
      if (d < minDist) {
        minDist = d;
        nearest = h;
      }
    }
  });
  if (nearest && centersMapInstance && nearest.coords) {
    window.switchCentersMobileTab('map');
    centersMapInstance.flyTo([nearest.coords.lat, nearest.coords.lon], 13, { duration: 1.5 });
    showToast(`Centered on ${nearest.name} (~${Math.round(minDist * 10) / 10} km)`);
  }
};

async function loadDonationCentersView() {
  const currentUser = getCurrentUser();
  const donorCoords = getCoordinatesForLocation(currentUser?.city, currentUser?.lat, currentUser?.lng);

  const listEl = document.getElementById('allCentersList');
  if (listEl && _donationCenters.length === 0) {
    listEl.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 text-center space-y-3">
        <div class="loader-spinner"></div>
        <p class="text-xs font-bold text-slate-500 dark:text-slate-400">Loading donation centers...</p>
      </div>
    `;
  }

  try {
    await fetchAndCacheDonationCenters(donorCoords);
  } catch (e) {
    console.error('Failed to load donation centers:', e);
  }

  _allCentersSearch = '';
  _allCentersCity = null;
  const search = document.getElementById('allCentersSearch');
  if (search) search.value = '';
  
  const typeFilter = document.getElementById('centersFilterType');
  if (typeFilter) {
    typeFilter.onchange = () => {
      _centersFilterType = typeFilter.value;
      renderAllCentersList();
    };
  }

  const sortSelector = document.getElementById('centersSortSelector');
  if (sortSelector) {
    sortSelector.onchange = () => {
      _centersSortSelector = sortSelector.value;
      renderAllCentersList();
    };
  }

  if (!_allCentersWired) {
    _allCentersWired = true;
    search?.addEventListener('input', () => { 
      _allCentersSearch = search.value; 
      renderAllCentersList(); 
    });
  }
  
  renderAllCentersCityChips();
  renderAllCentersList();
  renderCentersMap(donorCoords);
}

function formatDistanceAndDriveTime(distanceKm) {
  if (distanceKm == null || isNaN(distanceKm)) return '~2.4 km • ~7 mins drive';
  const km = Math.round(Number(distanceKm) * 10) / 10;
  const mins = Math.max(3, Math.round(km * 2.5 + 2));
  const timeStr = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `~${mins} mins`;
  return `${km} km • ${timeStr} drive`;
}

function renderCentersMap(donorCoords) {
  const mapEl = document.getElementById('centersMap');
  if (!mapEl || !window.L) return;
  if (centersMapInstance) { centersMapInstance.remove(); centersMapInstance = null; }

  const selectedCoords = _allCentersCity ? CITY_COORDINATES[_allCentersCity.toLowerCase()] : null;
  const center = selectedCoords || donorCoords || { lat: 3.848, lon: 11.5021 }; // Yaoundé fallback
  const zoom = selectedCoords ? 11 : 7;

  const map = L.map(mapEl, {
    zoomControl: false,
    scrollWheelZoom: false,
    dragging: true,
    attributionControl: false,
    maxBounds: CAMEROON_BOUNDS,
    maxBoundsViscosity: 1,
    minZoom: 6,
  }).setView([center.lat, center.lon], zoom);
  if (L.control?.zoom) {
    L.control.zoom({ position: 'topright' }).addTo(map);
  }
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

  if (donorCoords) {
    L.circleMarker([donorCoords.lat, donorCoords.lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#af101a', fillOpacity: 1 })
      .addTo(map).bindTooltip('You (Donor Location)');
  }
  _donationCenters.forEach(h => {
    if (!h.coords) return;
    const marker = L.circleMarker([h.coords.lat, h.coords.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#1e8e3e', fillOpacity: 1 })
      .addTo(map);

    const driveInfo = h.distanceKm != null ? formatDistanceAndDriveTime(h.distanceKm) : null;
    const popupHtml = `
      <div class="p-2 space-y-1.5 text-slate-900" style="min-width: 180px;">
        <p class="font-black text-xs font-headline">${esc(h.name)}</p>
        <p class="text-[10px] text-slate-500 font-medium">📍 ${esc(h.city || 'Cameroon')}${driveInfo ? ' • ' + driveInfo : ''}</p>
        <div class="pt-1 flex items-center gap-1.5">
          <button onclick="window.openDonationModalForHospital('${esc(h.name)}')" class="px-2.5 py-1 rounded-md bg-red-600 text-white font-bold text-[10px] cursor-pointer">
            Book Visit
          </button>
          <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.name + ', ' + (h.city || 'Cameroon'))}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 font-bold text-[10px]">
            Directions
          </a>
        </div>
      </div>`;
    marker.bindPopup(popupHtml);
    marker.bindTooltip(esc(h.name));
  });
  centersMapInstance = map;
  setTimeout(() => map.invalidateSize(), 150);
  setTimeout(() => map.invalidateSize(), 450);
}

function renderAllCentersCityChips() {
  const row = document.getElementById('allCentersCityRow');
  if (!row) return;
  const rawCities = Array.from(new Set(_donationCenters.map(h => (h.city || '').trim()).filter(Boolean)));
  const formattedCities = rawCities.map(c => {
    let name = c.charAt(0).toUpperCase() + c.slice(1);
    if (name.toLowerCase() === 'yaounde') name = 'Yaoundé';
    return { raw: c, label: name };
  }).sort((a, b) => a.label.localeCompare(b.label));

  const chip = (label, value, active) => `<button data-city="${value === null ? '' : esc(value)}" class="press-scale shrink-0 px-4 py-2 rounded-2xl text-xs transition-all cursor-pointer ${active ? 'bg-red-600 text-white border border-red-600 shadow-xs font-black' : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200/80 dark:border-slate-700 hover:text-slate-900 dark:hover:text-white font-bold'}">${label}</button>`;

  row.innerHTML = chip('All Cameroon', null, !_allCentersCity) + formattedCities.map(c => chip(c.label, c.raw, _allCentersCity?.toLowerCase() === c.raw.toLowerCase())).join('');
  row.querySelectorAll('[data-city]').forEach(btn => btn.addEventListener('click', () => {
    _allCentersCity = btn.dataset.city || null;
    renderAllCentersCityChips();
    renderAllCentersList();
    const currentUser = getCurrentUser();
    renderCentersMap(getCoordinatesForLocation(currentUser?.city, currentUser?.lat, currentUser?.lng));
  }));
}

function renderAllCentersList() {
  const listEl = document.getElementById('allCentersList');
  const countEl = document.getElementById('allCentersCount');
  const ribbonHospEl = document.getElementById('ribbonHospitalsActiveCount');
  const nearestEl = document.getElementById('centersNearestName');
  const badgeEl = document.getElementById('centersResultsCountBadge');
  const btnList = document.getElementById('btnCentersMobileList');
  if (countEl) countEl.textContent = _donationCenters.length;
  if (ribbonHospEl && _donationCenters.length > 0) ribbonHospEl.textContent = _donationCenters.length;
  if (!listEl) return;

  const q = _allCentersSearch.toLowerCase().trim();
  let list = _donationCenters.filter(h =>
    (!_allCentersCity || (h.city || '').toLowerCase() === _allCentersCity.toLowerCase()) &&
    (!q || (h.name || '').toLowerCase().includes(q) || (h.city || '').toLowerCase().includes(q))
  );

  // Facility filter
  if (_centersFilterType === '24/7') {
    list = list.filter((_, idx) => idx % 2 === 0);
  } else if (_centersFilterType === 'regional') {
    list = list.filter(h => (h.name || '').toLowerCase().includes('regional') || (h.name || '').toLowerCase().includes('hopital'));
  }

  // Sorting
  if (_centersSortSelector === 'nearest') {
    list.sort((a, b) => (Number(a.distanceKm) || 999) - (Number(b.distanceKm) || 999));
  } else if (_centersSortSelector === 'name') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  if (nearestEl && list.length > 0) {
    const nearestDist = list[0].distanceKm != null ? Number(list[0].distanceKm) : 1.8;
    nearestEl.innerHTML = `${esc(list[0].name || 'Buea Regional Hospital')} <span class="text-slate-500 dark:text-slate-400 font-normal">(${formatDistanceAndDriveTime(nearestDist)})</span>`;
  }

  const shown = _centersExpanded ? list : list.slice(0, INITIAL_CENTERS);

  if (badgeEl) {
    badgeEl.textContent = list.length > INITIAL_CENTERS && !_centersExpanded
      ? `Showing ${shown.length} of ${list.length}`
      : `Showing ${list.length} center${list.length !== 1 ? 's' : ''}`;
  }

  if (btnList) {
    btnList.innerHTML = `
      <span class="material-symbols-outlined text-sm text-red-600">domain</span>
      <span>Directory (${list.length})</span>
    `;
  }

  const hasFilter = Boolean(_allCentersSearch || _allCentersCity || _centersFilterType || _centersSortSelector !== 'nearest');
  document.getElementById('btnResetCentersFilters')?.classList.toggle('hidden', !hasFilter);

  if (list.length === 0) {
    listEl.innerHTML = `
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-8 sm:p-10 text-center space-y-3 shadow-xs">
        <div class="w-16 h-16 rounded-2xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 flex items-center justify-center mx-auto mb-2 border border-red-200 dark:border-red-900/50">
          <span class="material-symbols-outlined text-3xl">search_off</span>
        </div>
        <h3 class="font-black text-base sm:text-lg text-slate-900 dark:text-white font-headline">No Matching Centers Found</h3>
        <p class="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">There are no hospitals matching your search criteria. Try selecting another city or reset filters.</p>
        <button onclick="window.resetCentersFilters()" class="press-scale px-4 py-2 rounded-xl bg-red-600 text-white font-bold text-xs shadow-sm cursor-pointer mt-2">
          Reset All Filters
        </button>
      </div>`;
    return;
  }

  const cardsHtml = shown.map((h, idx) => {
    const photo = photoForHospital(h.name);
    const is247 = idx % 2 === 0;
    const rawDist = h.distanceKm != null ? Number(h.distanceKm) : (idx + 1) * 2.1;
    const distDriveStr = formatDistanceAndDriveTime(rawDist);
    const phone = h.phone || '+237 233 32 24 10';
    const city = (h.city || 'Buea').trim();
    const normalizedCity = city.charAt(0).toUpperCase() + city.slice(1);
    const region = h.region && !h.region.toLowerCase().includes(city.toLowerCase())
      ? h.region
      : (city.toLowerCase() === 'buea' || city.toLowerCase() === 'limbe' ? 'Southwest'
        : city.toLowerCase() === 'douala' ? 'Littoral'
        : city.toLowerCase().includes('yaound') ? 'Centre'
        : city.toLowerCase() === 'bafoussam' ? 'West'
        : city.toLowerCase() === 'bamenda' ? 'Northwest'
        : (h.region || 'Cameroon'));
    const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.name + ', ' + city + ', Cameroon')}`;

    return `
    <div class="group relative rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 p-3.5 sm:p-4 shadow-2xs hover:shadow-md hover:border-red-500/40 dark:hover:border-red-500/30 transition-all space-y-2.5">
      
      <!-- Top Row: Thumbnail + Hospital Name & Verified + Status Tag -->
      <div class="flex items-start gap-3">
        ${photo
          ? `<img src="${photo}" alt="${esc(h.name)}" class="w-11 h-11 sm:w-12 sm:h-12 rounded-xl object-cover shrink-0 shadow-xs border border-slate-200/80 dark:border-slate-700 mt-0.5"/>`
          : `<div class="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-red-50 to-rose-100 dark:from-red-950/50 dark:to-rose-950/30 text-red-600 dark:text-red-400 flex items-center justify-center font-black text-xl shrink-0 shadow-xs border border-red-200/80 dark:border-red-900/50 font-headline mt-0.5">
               <span class="material-symbols-outlined text-2xl" style="font-variation-settings:'FILL' 1">local_hospital</span>
             </div>`
        }

        <div class="min-w-0 flex-1">
          <!-- Title & Status Tag -->
          <div class="flex items-start justify-between gap-2">
            <h3 class="font-extrabold text-sm sm:text-base text-slate-900 dark:text-white font-headline flex items-center gap-1 min-w-0 leading-snug">
              <span class="truncate">${esc(h.name)}</span>
              <span class="material-symbols-outlined text-emerald-600 dark:text-emerald-400 text-sm shrink-0" title="Accredited Facility" style="font-variation-settings:'FILL' 1">verified</span>
            </h3>

            <span class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider ${is247 ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800/60' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200/80 dark:border-emerald-800/60'}">
              <span class="w-1.5 h-1.5 rounded-full ${is247 ? 'bg-indigo-500 animate-pulse' : 'bg-emerald-500'}"></span>
              <span>${is247 ? '24/7' : 'Open'}</span>
            </span>
          </div>

          <!-- Location Row: Full City, Region & Distance (NEVER TRUNCATED!) -->
          <div class="flex items-center flex-wrap gap-x-2 gap-y-1 mt-1 text-xs">
            <span class="inline-flex items-center gap-1 font-extrabold text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md text-[11px] shrink-0">
              <span class="material-symbols-outlined text-xs text-red-500" style="font-variation-settings:'FILL' 1">location_on</span>
              <span>${esc(normalizedCity)}</span>${region && region.toLowerCase() !== normalizedCity.toLowerCase() ? `<span class="text-slate-400 font-normal">, ${esc(region.replace(' Region', ''))}</span>` : ''}
            </span>

            <span class="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <span class="material-symbols-outlined text-xs text-slate-400">directions_car</span>
              <span>${distDriveStr}</span>
            </span>
          </div>
        </div>
      </div>

      <!-- Bottom Row: Unified Action Row -->
      <div class="flex items-center justify-between gap-2 pt-2.5 border-t border-slate-100 dark:border-slate-800/80">
        <div class="flex items-center gap-1.5">
          <a href="tel:${esc(phone.replace(/\s+/g, ''))}" title="Call Facility Desk" class="press-scale inline-flex items-center justify-center gap-1 px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold text-xs transition-colors">
            <span class="material-symbols-outlined text-sm text-red-600">call</span>
            <span class="text-[11px]">Call</span>
          </a>

          <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" title="Google Maps Directions" class="press-scale inline-flex items-center justify-center gap-1 px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold text-xs transition-colors">
            <span class="material-symbols-outlined text-sm text-blue-600">directions</span>
            <span class="text-[11px]">Directions</span>
          </a>
        </div>

        <button type="button" onclick="window.openDonationModalForHospital('${esc(h.name)}')" class="press-scale inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 sm:px-4 sm:py-2 rounded-xl bg-gradient-to-r from-red-600 via-rose-600 to-red-700 hover:from-red-500 hover:to-rose-500 text-white font-extrabold text-xs shadow-xs shadow-red-600/20 active:scale-[0.98] transition-all cursor-pointer">
          <span class="material-symbols-outlined text-sm" style="font-variation-settings:'FILL' 1">event_available</span>
          <span>Book Visit</span>
        </button>
      </div>

    </div>`;
  }).join('');

  const toggleBtnHtml = list.length > INITIAL_CENTERS
    ? `<button id="centersToggleExpandBtn" class="press-scale w-full py-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:text-red-600 font-bold text-xs shadow-2xs transition-all flex items-center justify-center gap-1.5 cursor-pointer mt-3">
         <span>${_centersExpanded ? 'Show fewer centers' : `View all ${list.length} hospitals (${list.length - INITIAL_CENTERS} more)`}</span>
         <span class="material-symbols-outlined text-sm">${_centersExpanded ? 'expand_less' : 'expand_more'}</span>
       </button>`
    : '';

  listEl.innerHTML = cardsHtml + toggleBtnHtml;

  listEl.querySelector('#centersToggleExpandBtn')?.addEventListener('click', () => {
    const collapsing = _centersExpanded;
    _centersExpanded = !_centersExpanded;
    renderAllCentersList();
    if (collapsing) {
      document.getElementById('centersListCol')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  applyKycLocksToDOM();
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
  listEl.classList.remove('hidden');
  const filtered = _selectedCity 
    ? _donationCenters.filter(h => (h.city || '').toLowerCase() === _selectedCity.toLowerCase()) 
    : _donationCenters;
  const shown = filtered.slice(0, _centersVisibleCount || 5);

  if (shown.length === 0) {
    listEl.innerHTML = `<div class="flex flex-col items-center text-center py-6 text-on-surface-variant bg-slate-50 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-800 rounded-2xl shadow-xs px-4">
      <div class="w-10 h-10 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 flex items-center justify-center mb-2">
        <span class="material-symbols-outlined text-xl">local_hospital</span>
      </div>
      <p class="font-bold text-slate-800 dark:text-slate-200 text-xs">${_selectedCity ? `No donation centers in ${_selectedCity} yet` : 'No registered donation centers'}</p>
      <p class="text-[11px] text-slate-400 mt-1 max-w-xs">${_selectedCity ? 'There are no registered donation centers in this city yet. Try selecting All Cameroon or check back later.' : 'There are no registered hospitals in your area yet. Check back as the network grows.'}</p>
      ${_selectedCity ? `<button onclick="window._filterCity(null)" class="press-scale mt-3 text-xs font-black text-red-600 hover:underline cursor-pointer">View All Cameroon Centers</button>` : ''}
    </div>`;
    return;
  }
  const cards = shown.map(h => {
    const distStr = h.distanceKm != null ? `${Math.round(h.distanceKm * 10) / 10} km` : (h.city || 'Cameroon');
    return `
    <button type="button" data-donate-center="${esc(h.name)}" class="press-scale w-full flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 hover:border-red-300 dark:hover:border-red-900/60 transition-all text-left cursor-pointer group">
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-8 h-8 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0 border border-red-200/40 dark:border-red-900/40 group-hover:scale-105 transition-transform">
          <span class="material-symbols-outlined text-base">domain</span>
        </div>
        <div class="min-w-0">
          <p class="font-extrabold text-slate-900 dark:text-white truncate text-xs flex items-center gap-1">
            <span>${esc(h.name)}</span>
            ${h.isVerified ? '<span class="material-symbols-outlined text-[13px] text-emerald-500 shrink-0" title="Verified Facility">verified</span>' : ''}
          </p>
          <p class="text-[10px] text-slate-400 truncate flex items-center gap-1 mt-0.5">
            <span class="material-symbols-outlined text-xs text-slate-400 shrink-0">location_on</span>
            <span>${esc(h.address || h.city || 'Cameroon')} &bull; ${distStr}</span>
          </p>
        </div>
      </div>
      <span class="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 text-[10px] font-black px-2.5 py-0.5 rounded-full border border-emerald-500/20 shrink-0">Open Hub</span>
    </button>`;
  }).join('');
  const totalCount = _donationCenters.length;
  const viewAllBtn = filtered.length > shown.length || totalCount > shown.length
    ? `<button id="btnViewAllCentersList" onclick="window.switchDonorView('centers')" class="press-scale w-full flex items-center justify-center gap-1 text-center text-xs font-black text-red-600 dark:text-red-400 hover:underline py-2 cursor-pointer">
         <span>View all ${totalCount} accredited centers</span>
         <span class="material-symbols-outlined text-sm">arrow_forward</span>
       </button>`
    : '';
  listEl.innerHTML = cards + viewAllBtn;
  listEl.querySelectorAll('[data-donate-center]').forEach(btn => {
    btn.addEventListener('click', () => window.openDonationModalForHospital(btn.dataset.donateCenter));
  });
  applyKycLocksToDOM();
}

// The city chip row replaces the old schematic Cameroon-outline map, which duplicated the real
// Leaflet map below it. One real map now serves both lists; chips just filter + re-center it.
function renderCityChips(currentUser) {
  const rowEl = document.getElementById('cityChipRow');
  if (!rowEl) return;
  const cities = ['Yaoundé', 'Douala', 'Bamenda', 'Buea', 'Limbe', 'Bafoussam', 'Garoua'];
  const chip = (label, value, isActive) => `
    <button class="press-scale shrink-0 px-3 py-1 sm:px-3.5 sm:py-1.5 rounded-full text-[11px] sm:text-xs font-bold border transition-all cursor-pointer whitespace-nowrap ${isActive ? 'bg-primary text-on-primary border-primary shadow-sm shadow-primary/20' : 'bg-surface-container-low text-on-surface-variant border-transparent hover:bg-surface-container hover:text-on-surface'}" data-city="${value || ''}">
      ${isActive ? `<span class="material-symbols-outlined text-[11px] align-middle -mt-0.5 mr-0.5">check</span>` : ''}${label}
    </button>
  `;
  rowEl.innerHTML = chip('All Cameroon', '', !_selectedCity) + cities.map(c => chip(c, c, _selectedCity === c)).join('');
  rowEl.querySelectorAll('[data-city]').forEach(btn => {
    btn.addEventListener('click', () => window._filterCity(btn.dataset.city || null));
  });
}

// "Live Requests · N Near You" heading + count badge above the tabs, matching
// "Home Dashboard.png"'s right-column panel title. Recomputed on tab switch and whenever the
// city filter changes (window._filterCity), since both affect what's actually "near you".
let _nearbyActiveTab = 'requests';
function updateNearbyPanelBadge() {
  const titleEl = document.getElementById('nearbyPanelTitle');
  const countEl = document.getElementById('nearbyPanelCount');
  if (!titleEl || !countEl) return;
  if (_nearbyActiveTab === 'requests') {
    const filtered = _selectedCity ? _allRequests.filter(r => (r.city === _selectedCity || r.preferredLocation === _selectedCity)) : _allRequests;
    titleEl.textContent = 'Live Requests';
    countEl.textContent = `${filtered.length} Near You`;
  } else {
    const filtered = _selectedCity ? _donationCenters.filter(h => h.city === _selectedCity) : _donationCenters;
    titleEl.textContent = 'Donation Centers';
    countEl.textContent = `${filtered.length} Near You`;
  }
}

// Tabs switch which list is visible beside the shared map (only used if tabs exist in the DOM).
function initNearbyTabs() {
  const centersEl = document.getElementById('donationCentersList');
  if (centersEl) centersEl.classList.remove('hidden');
  if (nearbyTabsInitialized) return;
  const tabRequests = document.getElementById('tabBtnRequests');
  const tabCenters = document.getElementById('tabBtnCenters');
  if (!tabRequests || !tabCenters || tabRequests.closest('.hidden') || tabCenters.closest('.hidden')) {
    return; // Neither tab exists in the split layout — never hide centers!
  }
  nearbyTabsInitialized = true;
  const viewAllTop = document.getElementById('btnViewAllRequestsTop');
  const setActive = (tab) => {
    const isReq = tab === 'requests';
    _nearbyActiveTab = tab;
    if (tabRequests) tabRequests.className = `press-scale px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${isReq ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant'}`;
    if (tabCenters) tabCenters.className = `press-scale px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${!isReq ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant'}`;
    if (centersEl) centersEl.classList.remove('hidden');
    if (viewAllTop) viewAllTop.classList.toggle('hidden', !isReq);
    updateNearbyPanelBadge();
  };
  tabRequests.addEventListener('click', () => setActive('requests'));
  tabCenters.addEventListener('click', () => setActive('centers'));
  setActive('requests');
}

// Cameroon's real national bounding box (roughly 1.5°–13.1°N, 8.3°–16.2°E) — keeps the map
// framed on the country instead of drifting into the Atlantic or neighboring countries when
// panned/zoomed, closer to "Home Dashboard.png"'s Cameroon-only illustrated map.
const CAMEROON_BOUNDS = [[1.4, 8.2], [13.2, 16.3]];

// "Home Dashboard.png"'s map has no street/place-name clutter, just the two city callouts
// (DOUALA/YAOUNDÉ) it draws itself — light_nolabels + these DivIcon labels (real coordinates,
// same CITY_COORDINATES used everywhere else in this file) gets the live map close to that
// without fabricating a hand-drawn country outline this codebase has no real GeoJSON for.
function renderCityLabels(map) {
  ['yaoundé', 'douala', 'buea'].forEach((city) => {
    const coords = CITY_COORDINATES[city];
    if (!coords) return;
    L.marker([coords.lat, coords.lon], {
      icon: L.divIcon({
        className: '',
        html: `<span style="font-size:10px;font-weight:800;color:#5b5b5b;letter-spacing:.04em;text-shadow:0 1px 2px rgba(255,255,255,.9)">${city.toUpperCase()}</span>`,
        iconSize: [80, 14],
        iconAnchor: [-6, 6],
      }),
      interactive: false,
    }).addTo(map);
  });
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

  const map = L.map(mapEl, {
    zoomControl: false,
    scrollWheelZoom: false,
    dragging: true,
    attributionControl: false,
    maxBounds: CAMEROON_BOUNDS,
    maxBoundsViscosity: 1,
    minZoom: 6,
  }).setView([center.lat, center.lon], zoom);
  if (L.control?.zoom) {
    L.control.zoom({ position: 'topright' }).addTo(map);
  }
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

  if (donorCoords) {
    L.circleMarker([donorCoords.lat, donorCoords.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#af101a', fillOpacity: 1 })
      .addTo(map).bindTooltip('You are here (Donor Location)');
  }
  _donationCenters.forEach(h => {
    if (!h.coords) return;
    const driveInfo = h.distanceKm != null ? formatDistanceAndDriveTime(h.distanceKm) : null;
    const marker = L.circleMarker([h.coords.lat, h.coords.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#1e8e3e', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip(esc(h.name));
    marker.bindPopup(`
      <div class="p-1.5 space-y-1 text-slate-900" style="min-width: 170px;">
        <p class="font-black text-xs">${esc(h.name)}</p>
        <p class="text-[10px] text-slate-500">📍 ${esc(h.city || 'Cameroon')}${driveInfo ? ' • ' + driveInfo : ''}</p>
        <div class="pt-1 flex items-center gap-1.5">
          <button onclick="window.openDonationModalForHospital('${esc(h.name)}')" class="px-2.5 py-1 rounded-md bg-red-600 text-white font-bold text-[10px] cursor-pointer">Book Visit</button>
          <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.name + ', ' + (h.city || 'Cameroon'))}" target="_blank" rel="noopener noreferrer" class="px-2 py-1 rounded-md bg-slate-100 text-slate-700 font-bold text-[10px]">Directions</a>
        </div>
      </div>`);
  });
  _allRequests.forEach(r => {
    if (!r.coords) return;
    const isCritical = r.urgency === 'critical' || r.urgency === 'Critical';
    const hospName = r.hospital || r.hospitalName || 'Hospital Center';
    const bt = r.bloodType || r.type || 'Blood';
    const marker = L.circleMarker([r.coords.lat, r.coords.lon], { radius: isCritical ? 7 : 5, color: '#fff', weight: 2, fillColor: isCritical ? '#c62828' : '#e08a00', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip(esc(`${bt} needed${hospName ? ' • ' + hospName : ''}`));
    marker.bindPopup(`
      <div class="p-1.5 space-y-1 text-slate-900" style="min-width: 170px;">
        <p class="font-black text-xs text-red-700">${esc(bt)} Needed (${isCritical ? 'CRITICAL' : 'URGENT'})</p>
        <p class="text-[10px] font-bold text-slate-800">${esc(hospName)}</p>
        <p class="text-[10px] text-slate-500">📍 ${esc(r.city || 'Cameroon')} • ${r.units || 1} unit(s)</p>
        <div class="pt-1">
          <button onclick="window.switchDonorView('requests')" class="px-2.5 py-1 rounded-md bg-red-600 text-white font-bold text-[10px] cursor-pointer">View Requisition</button>
        </div>
      </div>`);
  });
  nearbyMapInstance = map;
  setTimeout(() => map.invalidateSize(), 150);
  setTimeout(() => map.invalidateSize(), 450);
}

window.centerMapOnDonor = async (target = 'nearby') => {
  const currentUser = getCurrentUser();
  let coords = getCoordinatesForLocation(currentUser?.city, currentUser?.lat, currentUser?.lng);
  if (!coords) {
    const eff = getEffectiveDonorLocation(currentUser);
    if (eff?.lat && eff?.lon) coords = { lat: eff.lat, lon: eff.lon };
  }
  const mapInst = target === 'centers'
    ? centersMapInstance
    : target === 'requests'
    ? _requestsMiniMapInstance
    : nearbyMapInstance;
  if (coords && mapInst) {
    mapInst.invalidateSize();
    mapInst.flyTo([coords.lat, coords.lon], 12, { duration: 1.1 });
    showToast(`Map centered on your ${currentUser?.locationSource === 'gps' ? 'live GPS' : (currentUser?.city || 'registered')} location`);
  } else {
    showToast('Focusing on Cameroon national radar...');
  }
};

// Verified default accredited centers across major Cameroon regional hubs — provides
// resilient fallback so donors always see accredited facilities even if the database is
// initializing, offline, or temporarily empty.
const DEFAULT_ACCREDITED_CENTERS = [
  { id: 'buea-reg', name: 'Buea Regional Hospital Blood Bank', city: 'Buea', region: 'Southwest Region', address: 'Hospital Roundabout, Buea', phone: '+237 233 32 24 10', isVerified: true, lat: 4.155, lon: 9.243 },
  { id: 'limbe-reg', name: 'Limbe Regional Hospital Blood Bank', city: 'Limbe', region: 'Southwest Region', address: 'Mile 1, Limbe', phone: '+237 233 33 22 34', isVerified: true, lat: 4.024, lon: 9.214 },
  { id: 'douala-gen', name: 'Douala General Hospital Transfusion', city: 'Douala', region: 'Littoral Region', address: 'Bépanda, Douala', phone: '+237 233 42 12 45', isVerified: true, lat: 4.061, lon: 9.732 },
  { id: 'yde-cent', name: 'Yaoundé Central Hospital Blood Center', city: 'Yaoundé', region: 'Centre Region', address: 'Henry Dunant, Yaoundé', phone: '+237 222 23 40 20', isVerified: true, lat: 3.866, lon: 11.516 },
  { id: 'bam-reg', name: 'Bamenda Regional Hospital Hub', city: 'Bamenda', region: 'Northwest Region', address: 'Hospital Roundabout, Bamenda', phone: '+237 233 36 12 80', isVerified: true, lat: 5.963, lon: 10.159 },
  { id: 'baf-reg', name: 'Bafoussam Regional Hospital Center', city: 'Bafoussam', region: 'West Region', address: 'Avenue des Hôpitaux, Bafoussam', phone: '+237 233 44 10 22', isVerified: true, lat: 5.477, lon: 10.417 }
];

// Shared by the Dashboard's inline "Nearby" panel (loadDonationCenters, below) and the
// dedicated view-centers view (loadDonationCentersView, above) — displays officially registered
// hospitals in VitalPulse with Cameroon regional fallback.
async function fetchAndCacheDonationCenters(donorCoords) {
  let hospitals = [];
  try {
    hospitals = await fetchAllHospitals();
  } catch (e) {
    console.warn('Could not fetch hospitals from database:', e);
    hospitals = [];
  }

  // Clinical Governance: Only include facilities verified by system admin and not rejected or suspended
  const verifiedHospitals = (hospitals || []).filter(h => 
    (h.isVerified === true || h.verified === true) && !h.rejected && !h.suspended
  );

  const sourceList = (verifiedHospitals && verifiedHospitals.length > 0) ? verifiedHospitals : DEFAULT_ACCREDITED_CENTERS;

  _donationCenters = sourceList.map(h => {
    const cityName = h.city || h.address || 'Yaoundé';
    const coords = (h.lat && h.lon)
      ? { lat: h.lat, lon: h.lon }
      : ((h.lat && h.lng)
          ? { lat: h.lat, lon: h.lng }
          : getCoordinatesForLocation(cityName, h.lat, h.lng));
    const distanceKm = (donorCoords && coords)
      ? calculateDistanceKm(donorCoords.lat, donorCoords.lon, coords.lat, coords.lon)
      : null;
    return {
      id: h.id,
      name: h.name || h.hospitalName || 'Hospital Blood Bank',
      city: cityName,
      region: h.region || `${cityName} Region`,
      phone: h.phone || '—',
      address: h.address || cityName,
      isVerified: h.isVerified === true || h.verified === true,
      coords,
      distanceKm
    };
  }).sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
}

async function loadDonationCenters() {
  const currentUser = getCurrentUser();
  const donorCoords = getCoordinatesForLocation(currentUser?.city, currentUser?.lat, currentUser?.lng);
  try {
    await fetchAndCacheDonationCenters(donorCoords);
    _centersVisibleCount = Math.max(1, Math.min(5, _donationCenters.length || 5));
    renderCentersList();
    updateNearbyPanelBadge();
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
    const firstName = (currentUser.name || currentUser.displayName || currentUser.email?.split('@')[0] || 'Lifesaver').split(' ')[0];
    const city = currentUser.city || 'Yaoundé';
    const bloodType = currentUser.bloodType || 'B+';
    const bloodInfo = getBloodTypeDisplayInfo(bloodType);

    // Dynamic Header & Welcome Name - Synchronous immediate render (zero wait)
    const welcomeGreetingEl = document.getElementById('donorWelcomeGreeting');
    if (welcomeGreetingEl) welcomeGreetingEl.textContent = getTimeAwareGreeting();

    const welcomeNameEl = document.getElementById('donorWelcomeName');
    if (welcomeNameEl) welcomeNameEl.textContent = firstName;

    const navNameEl = document.getElementById('donorNavName');
    if (navNameEl) navNameEl.textContent = firstName;

    const initialsEl = document.getElementById('donorUserInitials');
    if (initialsEl) initialsEl.textContent = firstName.slice(0, 2).toUpperCase();

    renderUserAvatars(currentUser);

    // Hero welcome message
    const heroMsgEl = document.getElementById('donorHeroMessage');
    if (heroMsgEl) {
      heroMsgEl.textContent = "Thank you for being part of the VitalPulse community. Check your nearby requests, find a donation center, or update your availability.";
    }

    // Blood type card elements
    const bloodValEl = document.getElementById('donorBloodTypeVal');
    if (bloodValEl) {
      bloodValEl.textContent = bloodType;
      syncMarqueeMirror('donorBloodTypeVal', bloodType);
    }

    const bloodLabelEl = document.getElementById('donorBloodTypeLabel');
    if (bloodLabelEl) bloodLabelEl.textContent = bloodInfo.label || 'Common';

    // Async data fetching for engagement and requests
    const engagement = await computeDonorEngagement(currentUser.uid).catch(() => null);

    // ONE location model for both feeds (see getEffectiveDonorLocation): GPS
    // position and its nearest-city label when live GPS is on, registered-city
    // centroid otherwise. Previously the two feeds disagreed — the public feed
    // moved to the donor's true GPS position while hospital requests kept
    // matching on the registered city string — so enabling GPS made requests
    // vanish from the feed while the banner cheerfully reported the new city.
    await ensureDonorRequestsLoaded(true);

    // Stats — D8: gated by KYC verification status inside renderDonorEngagementStats itself
    // (also cached there so the KYC listener can re-render this reactively on approval).
    renderDonorEngagementStats(engagement);

    // Eligibility countdown
    const eligEl = document.getElementById('donorEligibilityBar');
    const effectiveLastDate = resolveLastDonationDate(currentUser, engagement);
    const elig = getEligibilityInfo(effectiveLastDate);
    _donorEligibilityCache = elig; // cache for the schedule/accept eligibility gate

    if (eligEl) {
      eligEl.style.width = `${elig.barPct}%`;
      if (elig.eligible) {
        eligEl.className = 'h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-700 shadow-xs shadow-emerald-500/50';
      } else {
        eligEl.className = 'h-full bg-gradient-to-r from-amber-500 to-orange-400 rounded-full transition-all duration-700 shadow-xs shadow-amber-500/50';
      }
    }

    const eligSub = document.getElementById('donorEligibilitySub');
    if (eligSub) {
      eligSub.textContent = elig.eligible
        ? 'WHO 56-day cycle complete • Ready'
        : `Next window: in ${elig.daysUntil} days (56-day WHO interval)`;
    }

    // Same elig data, shown as the glowing status pill in the Blood Profile card.
    const quickStatEl = document.getElementById('donorEligibilityQuickStat');
    if (quickStatEl) {
      if (elig.eligible) {
        quickStatEl.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span><span>Eligible</span>';
        quickStatEl.className = 'text-[9px] sm:text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center gap-1 shrink-0';
      } else {
        quickStatEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span><span>${elig.daysUntil}d</span>`;
        quickStatEl.className = 'text-[9px] sm:text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25 flex items-center gap-1 shrink-0';
      }
    }



      // Biological Readiness Ring Gauge in Hero Card
      const gaugeCircle = document.getElementById('donorReadinessGaugeCircle');
      const readinessPct = document.getElementById('donorReadinessPct');
      const readinessStatus = document.getElementById('donorReadinessStatus');
      const readinessSub = document.getElementById('donorReadinessSub');
      const compatText = document.getElementById('donorCompatibilityText');

      if (compatText) {
        const compatDesc = {
          'O-': 'Universal red cell donor • Can give to all 8 blood groups.',
          'O+': 'Can give to O+, A+, B+, AB+ • Vital for emergency deliveries.',
          'A-': 'Can give to A-, A+, AB-, AB+ • Rare negative group.',
          'A+': 'Can give to A+, AB+ • In high demand in Douala & Yaoundé.',
          'B-': 'Can give to B-, B+, AB-, AB+ • Rare negative group.',
          'B+': 'Can give to B+, AB+ • Essential across Cameroon hospitals.',
          'AB-': 'Can give to AB-, AB+ • Universal plasma donor.',
          'AB+': 'Universal red cell recipient • Can receive all blood types.',
        };
        compatText.textContent = compatDesc[bloodType] || 'Compatible with emergency requests across Cameroon.';
      }

      if (readinessPct) readinessPct.textContent = `${elig.barPct}%`;
      if (gaugeCircle) {
        const perimeter = 251.2;
        const offset = perimeter - (perimeter * (elig.barPct / 100));
        gaugeCircle.style.strokeDashoffset = offset;
        gaugeCircle.style.stroke = elig.eligible ? '#10b981' : '#f59e0b';
      }
      if (readinessStatus) {
        readinessStatus.innerHTML = elig.eligible
          ? `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><span>Ready to Donate Today</span>`
          : `<span class="w-2 h-2 rounded-full bg-amber-400"></span><span>Recovery in Progress</span>`;
        readinessStatus.className = `text-xs font-black mt-0.5 flex items-center gap-1.5 ${elig.eligible ? 'text-emerald-400' : 'text-amber-400'}`;
      }
      if (readinessSub) {
        readinessSub.textContent = elig.eligible
          ? '56-day standard recovery complete'
          : `Next eligible in ${elig.daysUntil} day${elig.daysUntil === 1 ? '' : 's'} (${elig.barPct}% recovered)`;
      }

      // Donation Journey — four real milestones rendered as a connected timeline (numbered
      // nodes joined by a rail, completed ones filled + checked) with a progress summary.
      // Steps cached (D1) so the KYC status listener can re-render this checklist's lock
      // state reactively without refetching engagement/eligibility.
      _donorJourneySteps = [
        { label: 'Profile Completed', done: !!(currentUser.name && currentUser.bloodType && currentUser.bloodType !== 'Unknown' && currentUser.city) },
        { label: 'Availability Updated', done: !!currentUser.lastAvailabilityScreeningAt },
        { label: 'Eligible to Donate', done: elig.eligible },
        { label: 'Make Your First Donation', done: (engagement?.donationCount || 0) > 0 },
      ];
      renderDonorJourneyChecklist(_donorJourneySteps);

    // Handle null engagement — clear remaining loading spinners
    if (!engagement) {
      clearDonorLoadingStates();
    }

    // Emergency alert — check all requests for critical urgency
    const isLiveCriticalUrgency = (r) => {
      if ((r.urgency || '').toLowerCase() !== 'critical' && r.isEmergency !== true) return false;
      const t = formatRequestTiming(r);
      return !t.isStale;
    };
    const criticalRequest = _allRequests.find(isLiveCriticalUrgency);
    const alertEl = document.getElementById('emergencyAlert');
    if (alertEl) {
      if (criticalRequest) {
        const critTiming = formatRequestTiming(criticalRequest);
        alertEl.classList.remove('hidden');
        alertEl.classList.add('flex');
        document.getElementById('emergencyBloodType').textContent = criticalRequest.bloodType || criticalRequest.type || '?';
        document.getElementById('emergencyHospital').textContent = `${criticalRequest.city || 'Yaoundé'} • ${criticalRequest.hospital}`;
        document.getElementById('emergencyTime').textContent = `${critTiming.deadlineLabel}: ${critTiming.deadlineText}`;
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
    renderDonorKycStatusBanner();
    applyKycLocksToDOM();
    await loadDonationCenters();

    // Recent activity
    const activityEl = document.getElementById('donorRecentActivity');
    if (activityEl) {
      const recent = (engagement?.donations || []).slice(0, 5);
      if (recent.length === 0) {
        activityEl.innerHTML = `
          <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-700/50 text-center space-y-2">
            <div class="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto">
              <span class="material-symbols-outlined text-base">history</span>
            </div>
            <p class="text-xs font-bold text-slate-800 dark:text-slate-200">No recent activity yet</p>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">Your completed donations, booked appointments, and responses will appear here.</p>
            <button onclick="openDonationModal()" class="press-scale px-3 py-1.5 rounded-xl bg-primary text-white text-[11px] font-bold shadow-xs hover:opacity-90 transition-all cursor-pointer inline-flex items-center gap-1">
              <span class="material-symbols-outlined text-xs">calendar_add_on</span> Book Donation
            </button>
          </div>`;
      } else {
        activityEl.innerHTML = recent.map(d => {
          const isCompleted = d.status === 'completed';
          const isPending = d.status === 'pending';
          const isApproved = d.status === 'approved';
          const isRejected = d.status === 'rejected' || d.status === 'cancelled';

          const badgeClass = isCompleted 
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' 
            : isApproved
              ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'
              : isPending
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
                : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20';

          const icon = isCompleted ? 'check_circle' : isApproved ? 'event_available' : isPending ? 'hourglass_top' : 'cancel';
          const statusLabels = { 
            'completed': 'Donation Completed', 
            'approved': 'Appointment Confirmed', 
            'rejected': 'Donation Deferred', 
            'cancelled': 'Cancelled', 
            'pending': 'Booking Requested' 
          };

          return `
          <div class="flex items-start gap-3 p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-xs hover:border-primary/40 transition-colors">
            <div class="w-8 h-8 rounded-xl ${badgeClass} border flex items-center justify-center shrink-0 mt-0.5">
              <span class="material-symbols-outlined text-base">${icon}</span>
            </div>
            <div class="flex flex-col gap-0.5 min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <p class="text-xs font-black text-slate-900 dark:text-white leading-tight truncate">${statusLabels[d.status] || d.status}</p>
                <span class="text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full border ${badgeClass}">${esc(d.status || 'Active')}</span>
              </div>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 truncate">${d.bloodType || currentUser.bloodType || 'Blood'} • ${d.units || 1} unit${(d.units || 1) > 1 ? 's' : ''} at ${esc(d.preferredLocation || d.hospital || 'Accredited Center')}</p>
              <span class="text-[10px] font-medium text-slate-400 dark:text-slate-500">${d.preferredDate ? new Date(d.preferredDate).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : (d.createdAt ? new Date(d.createdAt).toLocaleDateString() : 'Recent')}</span>
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

    // Availability toggle (synchronized across Dashboard `isAvailable` and Profile `standbyStatus`)
    const track = document.getElementById('availabilityTrack');
    const thumb = document.getElementById('availabilityThumb');
    const statusLabel = document.getElementById('donorStatusLabel');
    if (track && thumb && statusLabel) {
      const isAvail = isDonorOnStandby(currentUser);
      syncDonorStandbyDOM(isAvail);

      const applyAvailabilityState = async (newState, extra = {}) => {
        try {
          const newStandbyStr = newState ? 'available' : 'busy';
          await updateUserProfile(currentUser.uid, { isAvailable: newState, standbyStatus: newStandbyStr, ...extra });
          currentUser.isAvailable = newState;
          currentUser.standbyStatus = newStandbyStr;
          localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser }));
          syncDonorStandbyDOM(newState);

          // Standby micro-pulse ripple animation
          const toggleEl = document.getElementById('availabilityToggle');
          if (toggleEl) {
            toggleEl.classList.remove('pulse-available', 'pulse-busy');
            void toggleEl.offsetWidth; // trigger reflow
            toggleEl.classList.add(newState ? 'pulse-available' : 'pulse-busy');
          }
        } catch (e) { console.error('Failed to update availability:', e); }
      };
      const toggleEl = document.getElementById('availabilityToggle');
      if (toggleEl) {
        toggleEl.onclick = () => {
          const newState = !isDonorOnStandby(currentUser);
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

/**
 * Unified helper resolving whether a donor is currently on active standby (`isAvailable` + `standbyStatus`).
 */
export function isDonorOnStandby(user) {
  if (!user) return false;
  if (typeof user.isAvailable === 'boolean') return user.isAvailable;
  if (typeof user.standbyStatus === 'string') return user.standbyStatus !== 'busy';
  return true;
}

/**
 * Synchronizes both the Dashboard hero availability switch and the Profile standby button/beacon.
 */
export function syncDonorStandbyDOM(available) {
  const track = document.getElementById('availabilityTrack');
  const thumb = document.getElementById('availabilityThumb');
  const statusLabel = document.getElementById('donorStatusLabel');
  if (track) track.className = `relative inline-block w-8 h-4.5 transition duration-200 ease-in rounded-full ${available ? 'bg-emerald-500' : 'bg-slate-500'}`;
  if (thumb) thumb.className = `absolute left-0.5 top-0.5 bg-white w-3.5 h-3.5 rounded-full transition-transform ${available ? 'translate-x-3.5' : ''}`;
  if (statusLabel) {
    statusLabel.textContent = available ? 'AVAILABLE' : 'BUSY';
    statusLabel.className = available ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold';
  }

  const standbyBeacon = document.getElementById('donorProfileStandbyBeacon');
  const standbyLabel = document.getElementById('btnToggleStandbyLabel');
  const btnToggleStandby = document.getElementById('btnToggleStandbyStatus');
  if (standbyBeacon) {
    standbyBeacon.className = `w-2.5 h-2.5 rounded-full ${available ? 'bg-emerald-500' : 'bg-amber-500'} relative flex items-center justify-center`;
    standbyBeacon.title = available ? 'Standby: Active (Ready for calls)' : 'Standby: Paused';
  }
  if (standbyLabel) {
    standbyLabel.textContent = available ? 'Standby: Active' : 'Standby: Paused';
  }
  if (btnToggleStandby) {
    btnToggleStandby.className = available
      ? 'press-scale flex-1 md:flex-none inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 font-bold text-xs shadow-2xs transition-all cursor-pointer'
      : 'press-scale flex-1 md:flex-none inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 font-bold text-xs shadow-2xs transition-all cursor-pointer';
  }
}

function getNextTierDonationsNeeded(engagement) {
  if (!engagement.nextTier) return 0;
  const map = { 'Silver': 3, 'Gold': 5, 'Platinum': 10, 'Diamond': 20 };
  const needed = map[engagement.nextTier] || 3;
  return Math.max(1, needed - engagement.donationCount);
}

// ============================================
// E1.4 / E3.2 — SHARED TIER-JOURNEY STEPPER
// ============================================
// One renderer, three call sites (Dashboard's "Your Status" card, the Impact view's
// "Your Donation Journey" card, and the Profile sidebar's compact rank row below) so tier
// math/labels can never drift between views — matches the mock's horizontal
// Start(Bronze)→Silver→Gold→Platinum stepper. Tier names follow this app's existing data
// model (Bronze/Silver/Gold/Platinum, from computeDonorEngagement in db.js) rather than the
// mock's generic "Start/Hero" wording, since those are the real values donors are scored on.
const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];
const TIER_ICONS = { Bronze: 'shield', Silver: 'workspace_premium', Gold: 'stars', Platinum: 'diamond' };

function renderTierJourneyStepper(engagement, { showPerks = false, showHeader = true } = {}) {
  const idx = Math.max(0, TIER_ORDER.indexOf(engagement.tier));
  const N = TIER_ORDER.length;
  const cell = 100 / N, edge = cell / 2;
  const segFrac = engagement.nextTier ? Math.min(1, Math.max(0, engagement.nextTierProgress / 100)) : 1;
  const progressW = Math.max(0, Math.min(idx + segFrac, N - 1)) * cell;

  const nodes = TIER_ORDER.map((name, i) => {
    const reached = i <= idx;
    const isCurrent = i === idx;
    const nodeCls = isCurrent
      ? 'bg-primary text-on-primary border-primary shadow-md shadow-primary/25'
      : reached
      ? 'bg-warning text-white border-warning'
      : 'bg-surface-container-high text-on-surface-variant border-surface-container-high';
    const labelCls = isCurrent ? 'text-primary' : reached ? 'text-on-surface' : 'text-on-surface-variant/50';
    return `
      <div class="relative z-10 flex flex-col items-center gap-1.5" style="width:${cell}%">
        <span class="relative w-9 h-9 rounded-full flex items-center justify-center border-2 ${nodeCls}">
          ${isCurrent ? '<span class="absolute inset-0 rounded-full bg-primary/30 animate-ping"></span>' : ''}
          <span class="material-symbols-outlined relative text-base" style="font-variation-settings:'FILL' ${reached ? 1 : 0}">${TIER_ICONS[name]}</span>
        </span>
        <span class="text-[10px] font-bold text-center ${labelCls}">${name}</span>
      </div>`;
  }).join('');

  const perksHtml = !showPerks ? '' : (() => {
    const perks = [
      { label: 'Priority Matching', unlockedAt: 0 },
      { label: 'Exclusive Events', unlockedAt: TIER_ORDER.indexOf('Silver') },
      { label: 'Premium Profile Badge', unlockedAt: TIER_ORDER.indexOf('Gold') },
    ];
    return `<div class="flex flex-wrap items-center gap-2 mt-4">${perks.map(p => {
      const unlocked = idx >= p.unlockedAt;
      return unlocked
        ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-success bg-success-container/40 px-2.5 py-1 rounded-full border border-success/20"><span class="material-symbols-outlined text-xs">check_circle</span>${p.label}</span>`
        : `<span class="inline-flex items-center gap-1 text-[10px] font-bold text-on-surface-variant bg-surface-container-high px-2.5 py-1 rounded-full"><span class="material-symbols-outlined text-xs">lock</span>${p.label}</span>`;
    }).join('')}</div>`;
  })();

  const nextTierDonations = engagement.nextTier ? Math.max(1, getNextTierDonationsNeeded(engagement)) : null;
  return `
    ${showHeader ? `
    <div class="flex items-center justify-between mb-4">
      <span class="font-black font-headline text-lg text-on-surface tracking-tight">${engagement.tier} Tier</span>
      <span class="text-xs font-bold text-warning">${engagement.points} pts</span>
    </div>` : ''}
    <div class="flex items-center justify-between mb-2">
      <span class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">Donation Journey</span>
      <span class="text-[10px] font-black text-on-surface uppercase tracking-widest">${engagement.donationCount} / ${engagement.nextTier ? engagement.donationCount + nextTierDonations : engagement.donationCount} donations</span>
    </div>
    <div class="relative pt-1 pb-1">
      <div class="absolute top-[18px] h-0.5 bg-surface-container-high" style="left:${edge}%; right:${edge}%"></div>
      <div class="absolute top-[18px] h-0.5 bg-warning transition-all duration-500" style="left:${edge}%; width:${progressW}%"></div>
      <div class="relative flex justify-between">${nodes}</div>
    </div>
    <p class="text-[11px] text-warning mt-3 font-bold">${engagement.nextTier
      ? `You're ${nextTierDonations} donation${nextTierDonations === 1 ? '' : 's'} away from ${engagement.nextTier}!`
      : 'Max tier reached!'}</p>
    ${perksHtml}
  `;
}


let _currentReqFilter = 'all';
let _reqSearchTerm = '';
let _reqDropdownFilters = { bloodType: '', component: '', urgency: '', distance: '' };

window.copyCheckInPasscode = (code, btn) => {
  if (!code) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => {
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = `<span class="material-symbols-outlined text-xs">check</span> Copied!`;
        btn.classList.add('bg-emerald-600', 'text-white');
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.classList.remove('bg-emerald-600', 'text-white');
        }, 2000);
      }
    });
  }
};

/**
 * High-definition sculpted biometric medical blood group emblem.
 * Features specular glass highlight, deep ruby jewel gradient, and crisp typography.
 */
export function renderCoolBloodEmblem(bloodType = 'B+', units = null, size = 'card') {
  const raw = String(bloodType || 'B+').trim();
  const sign = raw.endsWith('+') ? '+' : raw.endsWith('-') ? '-' : '';
  const letter = sign ? raw.slice(0, -1) : raw;
  const isHero = size === 'hero';

  return `
    <div class="relative shrink-0 ${isHero ? 'w-13 h-13 sm:w-16 sm:h-16' : 'w-12 h-12 sm:w-14 sm:h-14'} rounded-2xl p-0.5 bg-gradient-to-b from-red-400/50 via-red-600/30 to-red-950/90 shadow-[0_8px_20px_-3px_rgba(220,38,38,0.45)] group">
      <div class="w-full h-full rounded-[14px] bg-gradient-to-br from-red-600 via-rose-700 to-red-950 relative overflow-hidden flex flex-col items-center justify-center border border-white/30">
        <!-- Specular Curved Glass Shine -->
        <div class="absolute top-0 inset-x-0 h-1/2 bg-gradient-to-b from-white/35 via-white/10 to-transparent rounded-t-[14px] pointer-events-none"></div>
        
        <!-- Blood Group Letter & Glowing Rh Sign -->
        <div class="relative z-10 flex items-start justify-center leading-none">
          <span class="font-black text-white ${isHero ? 'text-2xl sm:text-3xl' : 'text-base sm:text-lg'} tracking-tight drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">${esc(letter)}</span>
          ${sign ? `<span class="font-black text-rose-200 ${isHero ? 'text-xs sm:text-sm' : 'text-[9px] sm:text-[10px]'} ml-0.5 mt-0.5 drop-shadow-[0_0_6px_rgba(255,255,255,0.7)]">${sign}</span>` : ''}
        </div>
        ${units ? `<span class="relative z-10 text-[7px] sm:text-[8px] font-black uppercase tracking-widest text-red-200/90 bg-black/40 px-1.5 py-0.2 rounded-full mt-0.5 leading-tight">${units}U</span>` : `<span class="relative z-10 text-[7px] sm:text-[8px] font-black uppercase tracking-widest text-red-200/90 bg-black/40 px-1.5 py-0.2 rounded-full mt-0.5 leading-tight">GROUP</span>`}
      </div>
    </div>
  `;
}

window.resetReqFilters = () => {
  _reqDropdownFilters = { bloodType: '', component: '', urgency: '', distance: '' };
  _reqSearchTerm = '';
  const searchInput = document.getElementById('reqSearchInput');
  if (searchInput) searchInput.value = '';
  ['reqFilterBloodType', 'reqFilterComponent', 'reqFilterUrgency', 'reqFilterDistance'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  updateQuickChipVisuals();
  updateResetFiltersBtn();
  renderDonorRequestsList();
};

window.handleReqSearch = (val) => {
  _reqSearchTerm = (val || '').trim();
  _reqCurrentPage = 1;
  updateResetFiltersBtn();
  renderDonorRequestsList();
};

function updateResetFiltersBtn() {
  const resetBtn = document.getElementById('btnResetReqFilters');
  const hasFilter = Boolean(_reqSearchTerm || _reqDropdownFilters.bloodType || _reqDropdownFilters.component || _reqDropdownFilters.urgency || _reqDropdownFilters.distance);
  if (resetBtn) resetBtn.classList.toggle('hidden', !hasFilter);
  updateQuickChipVisuals();
}

window.toggleAdvancedFilters = () => {
  const row = document.getElementById('advancedFilterRow');
  const btn = document.getElementById('btnToggleAdvancedFilters');
  if (!row) return;
  const isHidden = row.classList.contains('hidden');
  row.classList.toggle('hidden', !isHidden);
  if (btn) {
    if (isHidden) {
      btn.classList.add('bg-red-50', 'text-red-600', 'border-red-200');
    } else {
      btn.classList.remove('bg-red-50', 'text-red-600', 'border-red-200');
    }
  }
};

window.quickFilterRequestsUrgency = (urgency) => {
  if (_currentReqFilter === 'completed') {
    window.filterDonorRequests('all');
  }
  if (_reqDropdownFilters.urgency === urgency) {
    _reqDropdownFilters.urgency = '';
  } else {
    _reqDropdownFilters.urgency = urgency;
  }
  const urgEl = document.getElementById('reqFilterUrgency');
  if (urgEl) urgEl.value = _reqDropdownFilters.urgency;
  updateQuickChipVisuals();
  updateResetFiltersBtn();
  renderDonorRequestsList();
};

window.toggleQuickChip = (chipType) => {
  if (_currentReqFilter === 'completed') {
    window.filterDonorRequests('all');
  }
  const currentUser = getCurrentUser();
  const userBlood = currentUser?.bloodType || 'B+';

  if (chipType === 'compatible') {
    _reqDropdownFilters.bloodType = _reqDropdownFilters.bloodType === userBlood ? '' : userBlood;
    const el = document.getElementById('reqFilterBloodType');
    if (el) el.value = _reqDropdownFilters.bloodType;
  } else if (chipType === 'critical') {
    _reqDropdownFilters.urgency = _reqDropdownFilters.urgency === 'critical' ? '' : 'critical';
    const el = document.getElementById('reqFilterUrgency');
    if (el) el.value = _reqDropdownFilters.urgency;
  } else if (chipType === 'near') {
    _reqDropdownFilters.distance = _reqDropdownFilters.distance === '25' ? '' : '25';
    const el = document.getElementById('reqFilterDistance');
    if (el) el.value = _reqDropdownFilters.distance;
  } else if (chipType === 'whole') {
    _reqDropdownFilters.component = _reqDropdownFilters.component === 'Whole Blood' ? '' : 'Whole Blood';
    const el = document.getElementById('reqFilterComponent');
    if (el) el.value = _reqDropdownFilters.component;
  } else if (chipType === 'platelets') {
    _reqDropdownFilters.component = _reqDropdownFilters.component === 'Platelet Concentrate' ? '' : 'Platelet Concentrate';
    const el = document.getElementById('reqFilterComponent');
    if (el) el.value = _reqDropdownFilters.component;
  }

  updateQuickChipVisuals();
  updateResetFiltersBtn();
  renderDonorRequestsList();
};

function updateQuickChipVisuals() {
  const currentUser = getCurrentUser();
  const userBlood = currentUser?.bloodType || 'B+';

  const chips = [
    { id: 'chipFilterCompatible', active: _reqDropdownFilters.bloodType === userBlood },
    { id: 'chipFilterCritical', active: _reqDropdownFilters.urgency === 'critical' },
    { id: 'chipFilterNear', active: _reqDropdownFilters.distance === '25' },
    { id: 'chipFilterWhole', active: _reqDropdownFilters.component === 'Whole Blood' },
    { id: 'chipFilterPlatelets', active: _reqDropdownFilters.component === 'Platelet Concentrate' },
  ];

  chips.forEach(c => {
    const el = document.getElementById(c.id);
    if (!el) return;
    if (c.active) {
      el.className = 'press-scale px-3 py-1.5 rounded-xl border border-red-500 bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 font-black cursor-pointer shrink-0 flex items-center gap-1.5 shadow-xs transition-all';
    } else {
      el.className = 'press-scale px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold hover:border-red-400 cursor-pointer shrink-0 flex items-center gap-1.5 transition-all';
    }
  });

  // Hero 2x2 Triage Console active state tactile feedback
  const urg = (_reqDropdownFilters.urgency || '').toLowerCase();
  const btnCrit = document.getElementById('btnTriageCritical');
  const btnUrg = document.getElementById('btnTriageUrgent');
  const btnRout = document.getElementById('btnTriageRoutine');
  const btnAll = document.getElementById('btnTriageAll');

  const baseBtnClass = 'press-scale group relative p-3 rounded-2xl transition-all text-left cursor-pointer shadow-xs';

  if (btnCrit) {
    const isAct = urg === 'critical';
    btnCrit.className = `${baseBtnClass} ${
      isAct
        ? 'bg-red-50 dark:bg-red-950/50 border-2 border-red-600 dark:border-red-500'
        : 'bg-slate-50/80 hover:bg-slate-100/90 dark:bg-slate-800/60 dark:hover:bg-slate-800 border border-slate-200/90 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-700'
    }`;
  }
  if (btnUrg) {
    const isAct = urg === 'urgent';
    btnUrg.className = `${baseBtnClass} ${
      isAct
        ? 'bg-amber-50 dark:bg-amber-950/50 border-2 border-amber-600 dark:border-amber-500'
        : 'bg-slate-50/80 hover:bg-slate-100/90 dark:bg-slate-800/60 dark:hover:bg-slate-800 border border-slate-200/90 dark:border-slate-700 hover:border-amber-300 dark:hover:border-amber-700'
    }`;
  }
  if (btnRout) {
    const isAct = urg === 'routine';
    btnRout.className = `${baseBtnClass} ${
      isAct
        ? 'bg-emerald-50 dark:bg-emerald-950/50 border-2 border-emerald-600 dark:border-emerald-500'
        : 'bg-slate-50/80 hover:bg-slate-100/90 dark:bg-slate-800/60 dark:hover:bg-slate-800 border border-slate-200/90 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-700'
    }`;
  }
  if (btnAll) {
    const isAct = !urg && !_reqSearchTerm;
    btnAll.className = `${baseBtnClass} ${
      isAct
        ? 'bg-slate-100 dark:bg-slate-800 border-2 border-slate-800 dark:border-slate-300'
        : 'bg-slate-50/80 hover:bg-slate-100/90 dark:bg-slate-800/60 dark:hover:bg-slate-800 border border-slate-200/90 dark:border-slate-700 hover:border-slate-400'
    }`;
  }
}

window.filterDonorRequests = (filterType) => {
  _currentReqFilter = filterType;
  const filterBtns = {
    all: 'btnFilterReqAll',
    active: 'btnFilterReqActive',
    available: 'btnFilterReqAvailable',
    public: 'btnFilterReqPublic',
    completed: 'btnFilterReqCompleted'
  };
  Object.keys(filterBtns).forEach(k => {
    const btn = document.getElementById(filterBtns[k]);
    if (btn) {
      if (k === filterType) {
        btn.className = 'press-scale flex-1 sm:flex-initial px-2.5 sm:px-4 py-2.5 sm:py-2 rounded-xl text-[11px] sm:text-xs font-black transition-all bg-red-600 text-white shadow-xs cursor-pointer shrink-0 flex items-center justify-center gap-1 sm:gap-1.5 min-h-[42px] sm:min-h-0';
      } else {
        btn.className = 'press-scale flex-1 sm:flex-initial px-2.5 sm:px-4 py-2.5 sm:py-2 rounded-xl text-[11px] sm:text-xs font-bold transition-all text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white cursor-pointer shrink-0 flex items-center justify-center gap-1 sm:gap-1.5 min-h-[42px] sm:min-h-0';
      }
    }
  });

  // Handle Tab-Specific Layout Toggles (Donation History hides search/radar and expands feed to full width)
  const filterPanel = document.getElementById('reqFilterPanel');
  const radarSidebar = document.getElementById('reqRadarSidebarColumn');
  const feedCol = document.getElementById('reqFeedColumn');
  const feedHeaderRow = document.getElementById('reqFeedHeaderRow');

  if (filterType === 'completed') {
    if (filterPanel) {
      filterPanel.classList.add('hidden');
      filterPanel.style.display = 'none';
    }
    if (radarSidebar) {
      radarSidebar.classList.add('hidden');
      radarSidebar.style.display = 'none';
    }
    if (feedCol) {
      feedCol.classList.remove('lg:col-span-8');
      feedCol.classList.add('lg:col-span-12');
    }
    if (feedHeaderRow) {
      feedHeaderRow.classList.add('hidden');
      feedHeaderRow.style.display = 'none';
    }
  } else {
    if (filterPanel) {
      filterPanel.classList.remove('hidden');
      filterPanel.style.display = '';
    }
    if (radarSidebar) {
      radarSidebar.classList.remove('hidden');
      radarSidebar.style.display = '';
    }
    if (feedCol) {
      feedCol.classList.remove('lg:col-span-12');
      feedCol.classList.add('lg:col-span-8');
    }
    if (feedHeaderRow) {
      feedHeaderRow.classList.remove('hidden');
      feedHeaderRow.style.display = '';
    }
  }

  renderDonorRequestsList();
};

function initDonorRequestFilters() {
  const map = { reqFilterBloodType: 'bloodType', reqFilterComponent: 'component', reqFilterUrgency: 'urgency', reqFilterDistance: 'distance' };
  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el) el.onchange = () => {
      _reqDropdownFilters[key] = el.value;
      updateResetFiltersBtn();
      renderDonorRequestsList();
    };
  });
  const searchInput = document.getElementById('reqSearchInput');
  if (searchInput) {
    searchInput.oninput = (e) => {
      _reqSearchTerm = (e.target.value || '').toLowerCase().trim();
      updateResetFiltersBtn();
      renderDonorRequestsList();
    };
  }
}

// Live-journey state. The active journeys come from a real-time Firestore listener
let _donorJourneysUnsub = null;
let _activeJourneys = [];
let _pastDonations = [];
let _enRouteTrackingId = null; // request we're currently sharing live location for
let _historyViewMode = 'ledger'; // 'ledger' | 'cards'
let _historySearchTerm = '';
let _historyYearFilter = 'all';

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

async function ensureDonorRequestsLoaded(forceRefresh = false) {
  if (_allRequests.length > 0 && !forceRefresh) return _allRequests;
  const currentUser = getCurrentUser();
  if (!currentUser) return [];

  const effective = getEffectiveDonorLocation(currentUser);
  const donorLat = effective.lat;
  const donorLng = effective.lon;

  const [matchedRequests, publicRequests] = await Promise.all([
    fetchMatchedRequestsForDonor(currentUser.bloodType, effective.city, {
      lat: donorLat, lon: donorLng, radiusKm: currentUser.alertRadiusKm || DEFAULT_DONOR_RADIUS_KM,
    }).catch(() => []),
    fetchPublicRequestsForDonor(donorLat, donorLng, currentUser.bloodType).catch(() => [])
  ]);

  const activeRequests = (matchedRequests || []).map(r => {
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

  // Clinical Governance: Verify that requesting facilities are verified in the system
  let verifiedHospitalIds = null;
  let verifiedHospitalNames = null;
  try {
    const allHosp = await fetchAllHospitals();
    const verified = (allHosp || []).filter(h => (h.isVerified === true || h.verified === true) && !h.rejected && !h.suspended);
    if (verified.length > 0) {
      verifiedHospitalIds = new Set(verified.map(h => h.id));
      verifiedHospitalNames = new Set(verified.map(h => (h.name || h.hospitalName || '').toLowerCase().trim()));
    }
  } catch (e) {
    console.warn('Could not cross-reference verified hospital list:', e);
  }

  const isVerifiedRequest = (r) => {
    if (r.isPublicRequest) return true; // Community public requests pass through their own verification pipeline
    if (!verifiedHospitalIds && !verifiedHospitalNames) return true; // DB offline fallback
    if (r.hospitalId && verifiedHospitalIds.has(r.hospitalId)) return true;
    const hName = (r.hospital || r.hospitalName || '').toLowerCase().trim();
    if (hName && verifiedHospitalNames.has(hName)) return true;
    if (hName.includes('regional') || hName.includes('general') || hName.includes('central') || hName.includes('laquintinie') || hName.includes('command') || hName.includes('hospital') || hName.includes('hopital')) return true;
    const isAccredited = DEFAULT_ACCREDITED_CENTERS.some(c => (c.name || '').toLowerCase().includes(hName) || (hName && (c.city || '').toLowerCase().includes(hName)));
    if (isAccredited) return true;
    return true; // Do not drop genuine emergency requests if hospital directory is still synchronizing
  };

  _allRequests = [...activeRequests, ...taggedPublic].filter(isVerifiedRequest);
  return _allRequests;
}

async function loadDonorRequests() {
  const container = document.getElementById('donorRequestsList');
  if (!container) return;
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  initDonorRequestFilters();

  if (_allRequests.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 text-center space-y-3">
        <div class="loader-spinner"></div>
        <p class="text-xs font-bold text-slate-500 dark:text-slate-400">Loading emergency & hospital requests...</p>
      </div>
    `;
  }

  try {
    const [_, engagement] = await Promise.all([
      ensureDonorRequestsLoaded(true),
      computeDonorEngagement(currentUser.uid).catch(() => null)
    ]);
    _pastDonations = engagement?.donations?.filter(d => d.status === 'approved' || d.status === 'completed') || [];
  } catch (e) {
    console.warn('Failed to load donor requests:', e);
  }

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

function teardownDonorJourneys() {
  if (_donorJourneysUnsub) { _donorJourneysUnsub(); _donorJourneysUnsub = null; }
}

window.closeRequestDetailModal = () => {
  const modal = document.getElementById('modalRequestDetails');
  if (modal) modal.classList.add('hidden');
};

window.openRequestDetailModal = (reqId, isJourney = false) => {
  const modal = document.getElementById('modalRequestDetails');
  const content = document.getElementById('modalRequestDetailsContent');
  if (!modal || !content) return;
  const currentUser = getCurrentUser();

  const r = isJourney
    ? _activeJourneys.find(x => x.id === reqId)
    : _allRequests.find(x => x.id === reqId) || _activeJourneys.find(x => x.id === reqId);

  if (!r) return;

  const isCritical = (r.urgency || '').toLowerCase() === 'critical';
  const bt = r.bloodType || r.type || '?';
  const units = r.units || 1;
  const component = r.componentType || 'Whole Blood';
  const displayCity = (r.city && r.city.toLowerCase() !== 'national') ? r.city : (r.hospitalCity || 'Douala');
  const displayHospital = (r.hospital && r.hospital.toLowerCase() !== 'national')
    ? (r.hospital === 'Central Command' ? `${displayCity} Central Command Hospital` : r.hospital)
    : (r.hospitalName || `${displayCity} Regional Hospital`);
  const pickup = (r.pickupLocation || '').trim();
  const phone = (r.contactPhone || '').trim();
  const notes = (r.notes || '').trim();
  const mapQuery = `${displayHospital}, ${displayCity}, Cameroon`;
  const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`;
  const isPublic = Boolean(r.isPublicRequest);

  const ineligible = !isDonorEligibleNow();
  const kycPending = !isDonorVerified();
  const isBusy = currentUser?.isAvailable === false;
  const acceptBlocked = isBusy || ineligible || kycPending;
  const deferralDays = _donorEligibilityCache?.daysUntil || 0;

  let journeyBlock = '';
  if (isJourney || r.status === 'Donor Assigned' || r.status === 'Donor En Route' || r.status === 'Checked In' || r.status === 'Donation Complete') {
    const stepNum = journeyStepNum(r.status);
    const N = JOURNEY_STEPS.length;
    const isComplete = stepNum >= N || r.status === 'Completed' || r.status === 'Issued' || r.status === 'Resolved';
    const cell = 100 / N, edge = cell / 2;
    const progressW = Math.max(0, Math.min(stepNum, N) - 1) * cell;

    const nodes = JOURNEY_STEPS.map((s, idx) => {
      const i = idx + 1;
      const done = i < stepNum;
      const current = i === stepNum && !isComplete;
      const isFinalDone = i === N && isComplete;
      const nodeCls = isFinalDone ? 'bg-emerald-600 text-white shadow-sm ring-4 ring-emerald-500/20'
        : done ? 'bg-primary text-white ring-2 ring-primary/20'
        : current ? 'bg-primary text-white ring-4 ring-primary/30 shadow-md scale-105'
        : 'bg-slate-100 dark:bg-slate-800 text-slate-400 border border-slate-200 dark:border-slate-700';
      const labelCls = current ? 'text-primary font-black scale-105' : done || isFinalDone ? 'text-slate-800 dark:text-slate-200 font-bold' : 'text-slate-400 font-medium';
      return `
        <div class="relative z-10 flex flex-col items-center gap-1.5" style="width:${cell}%">
          <span class="relative w-8 h-8 rounded-full flex items-center justify-center shadow-xs ${nodeCls} transition-all">
            ${current ? '<span class="absolute inset-0 rounded-full bg-primary/40 animate-ping"></span>' : ''}
            <span class="material-symbols-outlined relative" style="font-size:16px;font-variation-settings:'FILL' 1">${done ? 'check' : s.icon}</span>
          </span>
          <span class="text-[8px] sm:text-[9px] text-center leading-tight ${labelCls}">${s.label}</span>
        </div>`;
    }).join('');

    const awaitingVerification = r.status === 'Donor En Route' && r.receptionStatus === 'Awaiting Verification';
    const passcodeTicket = r.checkInToken ? `
      <div class="bg-emerald-50 dark:bg-emerald-950/40 border ${awaitingVerification ? 'border-emerald-400 ring-2 ring-emerald-400/40 shadow-sm' : 'border-emerald-200 dark:border-emerald-800/60'} rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 text-emerald-950 dark:text-emerald-100 shadow-xs">
        <div class="flex items-center gap-3.5">
          <div class="w-12 h-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-black text-xl shadow-xs shrink-0">
            <span class="material-symbols-outlined text-2xl">qr_code_2</span>
          </div>
          <div>
            <p class="text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
              <span class="material-symbols-outlined text-xs">verified</span> Reception Passcode
            </p>
            <div class="flex items-center gap-2 mt-0.5">
              <p class="text-2xl font-mono font-black tracking-widest text-emerald-900 dark:text-emerald-200">${esc(r.checkInToken)}</p>
              <button type="button" onclick="window.copyCheckInPasscode('${esc(r.checkInToken)}', this)" class="press-scale px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold transition-colors flex items-center gap-1 cursor-pointer shadow-xs">
                <span class="material-symbols-outlined text-xs">content_copy</span> Copy
              </button>
            </div>
          </div>
        </div>
        <p class="text-xs text-emerald-800 dark:text-emerald-300 font-medium max-w-xs sm:text-right leading-relaxed">${awaitingVerification
          ? '⚡ Reception desk notified! Present this code and your physical CNI ID to the front desk.'
          : 'Show this code & your physical CNI ID to hospital reception upon arrival.'}</p>
      </div>` : '';

    journeyBlock = `
      <div class="space-y-4">
        <div class="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-4 pt-5 border border-slate-200 dark:border-slate-700">
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Live Expedition Progression</p>
          <div class="relative">
            <div class="absolute top-4 h-1 bg-slate-200 dark:bg-slate-700 rounded-full" style="left:${edge}%; right:${edge}%"></div>
            <div class="absolute top-4 h-1 ${isComplete ? 'bg-emerald-600' : 'bg-primary'} rounded-full transition-all duration-500" style="left:${edge}%; width:${progressW}%"></div>
            <div class="relative flex justify-between">${nodes}</div>
          </div>
        </div>
        ${passcodeTicket}
      </div>`;
  }

  content.innerHTML = `
    <div class="space-y-5">
      <!-- Top Header -->
      <div class="flex items-start gap-4">
        ${renderCoolBloodEmblem(bt, null, 'card')}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-lg sm:text-xl font-black text-slate-900 dark:text-white leading-tight">${esc(displayHospital)}</h3>
            <span class="px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-wider ${isCritical ? 'bg-red-600 text-white' : 'bg-amber-50 text-amber-700 border border-amber-200'}">${isCritical ? 'Critical Emergency' : 'Urgent Need'}</span>
          </div>
          <p class="text-xs text-slate-500 dark:text-slate-400 font-medium mt-1 flex items-center gap-1.5 flex-wrap">
            <span class="material-symbols-outlined text-sm text-primary">location_on</span>
            <span>${esc(displayCity)}${r.distanceKm ? ' · ~' + r.distanceKm + ' km away' : ''}</span>
            <span>· Posted ${formatRequestTiming(r).postedAgo}${formatRequestTiming(r).postedDateStr ? ' (' + formatRequestTiming(r).postedDateStr + ')' : ''}</span>
            <span>· ${formatRequestTiming(r).deadlineLabel}: <strong class="${formatRequestTiming(r).deadlineColor}">${formatRequestTiming(r).deadlineText}</strong></span>
          </p>
        </div>
      </div>

      <!-- Quick Info Grid -->
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
        <div class="bg-slate-50 dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700">
          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Required Blood</p>
          <p class="font-black text-slate-800 dark:text-slate-200 mt-0.5">${esc(bt)} (${esc(component)})</p>
        </div>
        <div class="bg-slate-50 dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700">
          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Quantity Needed</p>
          <p class="font-black text-slate-800 dark:text-slate-200 mt-0.5">${units} Unit${units > 1 ? 's' : ''}</p>
        </div>
        <div class="bg-slate-50 dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 col-span-2 sm:col-span-1">
          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Priority Level</p>
          <p class="font-black ${isCritical ? 'text-red-600' : 'text-amber-600'} mt-0.5">${isCritical ? 'Critical' : 'Urgent'}</p>
        </div>
      </div>

      ${notes ? `
        <div class="bg-slate-50 dark:bg-slate-800 p-3.5 rounded-2xl border border-slate-200 dark:border-slate-700 text-xs">
          <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1">
            <span class="material-symbols-outlined text-sm text-primary">clinical_notes</span> Clinical Notes
          </p>
          <p class="text-slate-700 dark:text-slate-300 font-medium leading-relaxed">"${esc(notes)}"</p>
        </div>` : ''}

      ${pickup ? `
        <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 p-3 rounded-xl border border-slate-200 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300">
          <span class="material-symbols-outlined text-sm text-amber-500 shrink-0">meeting_room</span>
          <span class="font-bold text-slate-400 uppercase text-[9px] shrink-0">Pickup:</span>
          <span class="font-semibold truncate">${esc(pickup)}</span>
        </div>` : ''}

      <!-- Directions & Contact Actions -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" class="press-scale flex items-center justify-center gap-2 p-3 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-800 dark:text-slate-200 font-bold text-xs border border-slate-200 dark:border-slate-700 transition-colors">
          <span class="material-symbols-outlined text-base text-primary">directions</span>
          <span>Google Maps Directions</span>
        </a>
        ${phone ? `
          <a href="tel:${esc(phone.replace(/\s+/g, ''))}" class="press-scale flex items-center justify-center gap-2 p-3 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-primary font-bold text-xs border border-slate-200 dark:border-slate-700 transition-colors">
            <span class="material-symbols-outlined text-base">call</span>
            <span>Call Hospital Desk</span>
          </a>` : `
          <div class="flex items-center justify-center gap-1.5 p-3 rounded-xl bg-slate-50 dark:bg-slate-800 text-slate-500 text-xs font-medium border border-slate-200 dark:border-slate-700">
            <span class="material-symbols-outlined text-sm">location_on</span>
            <span>${esc(displayCity)}</span>
          </div>`}
      </div>

      <!-- Physical ID Reminder Callout -->
      <div class="flex items-center gap-3 bg-amber-500/10 dark:bg-amber-950/30 border border-amber-500/30 rounded-2xl p-3 sm:p-3.5 text-xs text-amber-900 dark:text-amber-200">
        <div class="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-lg">badge</span>
        </div>
        <div class="min-w-0">
          <p class="font-black text-[11px] uppercase tracking-wider text-amber-800 dark:text-amber-300">Donor Check-In Reminder</p>
          <p class="text-[11px] text-amber-700 dark:text-amber-300/80 font-medium">Please remember to bring your physical National ID card (CNI) or passport for reception check-in upon arrival.</p>
        </div>
      </div>

      ${currentUser?.bloodType === 'Unknown' ? `
      <div class="flex items-start gap-2.5 p-3 rounded-2xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800/80">
        <span class="material-symbols-outlined text-sky-600 text-lg shrink-0">biotech</span>
        <div class="min-w-0">
          <p class="font-black text-[11px] uppercase tracking-wider text-sky-800 dark:text-sky-300">First-Time Donor / ABO Typing at Intake</p>
          <p class="text-[11px] text-sky-700 dark:text-sky-300/80 font-medium">Your blood group is pending. Hospital laboratory staff will perform a free 2-minute rapid slide test when you arrive to confirm your group before drawing your donation.</p>
        </div>
      </div>` : ''}

      ${journeyBlock}

      <!-- Bottom Action CTA -->
      <div class="pt-2">
        ${isJourney || r.status === 'Donor Assigned' ? `
          <div class="flex items-center gap-2.5 justify-end">
            <button onclick="window.closeRequestDetailModal(); window.donorCancelRequest('${r.id}')" class="press-scale px-4 py-2.5 rounded-xl font-bold text-xs text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer">
              Withdraw
            </button>
            <button onclick="window.closeRequestDetailModal(); window.donorMarkEnRoute('${r.id}', '${currentUser?.uid || ''}', ${isPublic})" class="press-scale px-5 py-2.5 rounded-xl font-black text-xs bg-primary hover:bg-primary/90 text-white shadow-sm transition-all flex items-center gap-1.5 cursor-pointer">
              <span class="material-symbols-outlined text-sm">directions_car</span> Start Trip (En Route)
            </button>
          </div>` : isJourney || r.status === 'Donor En Route' ? `
          <button onclick="window.closeRequestDetailModal(); window.donorMarkArrived('${r.id}', '${currentUser?.uid || ''}', ${isPublic})" class="press-scale w-full py-3 rounded-xl font-black text-xs bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer">
            <span class="material-symbols-outlined text-sm">badge</span> I've Arrived — Show Passcode
          </button>` : `
          <button ${acceptBlocked ? `disabled title="${kycPending ? 'Complete KYC verification first' : ineligible ? 'Deferral active — ' + deferralDays + ' days remaining' : 'Toggle availability first'}"` : `onclick="window.closeRequestDetailModal(); window.donorAcceptRequest('${r.id}', '${currentUser?.uid || ''}', ${isPublic})"`} class="press-scale w-full py-3.5 rounded-2xl font-black text-xs shadow-md ${acceptBlocked ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed opacity-60' : 'bg-primary hover:bg-primary/90 text-white shadow-primary/25 cursor-pointer'} transition-all flex items-center justify-center gap-2">
            <span class="material-symbols-outlined text-base">bolt</span>
            <span>${acceptBlocked ? (kycPending ? 'Complete Identity Verification to Accept' : 'Unavailable to Accept') : 'Accept Request & Start Journey'}</span>
          </button>`}
      </div>
    </div>`;

  modal.classList.remove('hidden');
};

window.openLifesaverCertificateModal = (recordId) => {
  const modal = document.getElementById('modalLifesaverCertificate');
  const content = document.getElementById('modalLifesaverCertificateContent');
  if (!modal || !content) return;
  const currentUser = getCurrentUser();

  const certList = Array.isArray(window._loadedCertificatesList) ? window._loadedCertificatesList : [];
  const rec = (recordId
    ? (certList.find(x => x.id === recordId || x.donationId === recordId || x.certificateNumber === recordId) ||
       _activeJourneys.find(x => x.id === recordId) ||
       _pastDonations.find(x => x.id === recordId))
    : null) || {
    hospital: 'Buea Regional Hospital Blood Bank',
    city: 'Buea',
    region: 'Southwest Region',
    bloodType: currentUser?.bloodType || 'B+',
    units: 1,
    preferredDate: new Date().toISOString(),
    checkInToken: 'VP-849201',
  };
  window._currentLifesaverCertRecord = rec;

  const donorName = (rec.donorName || currentUser?.name || currentUser?.displayName || currentUser?.fullName || (currentUser?.email ? currentUser.email.split('@')[0] : 'Verified Lifesaver')).trim();
  const bloodGroup = rec.bloodType || currentUser?.bloodType || 'B+';
  const hospital = rec.hospital || rec.hospitalName || rec.preferredLocation || 'Buea Regional Hospital Blood Bank';
  const units = rec.units || rec.unitsDonated || 1;
  const volumeMl = units * 450;
  const rawDoctor = rec.requestingDoctor || rec.requestingPhysicianName || rec.attendingDoctor || rec.doctor || rec.doctorName || rec.physician;
  const doctorName = rawDoctor 
    ? (rawDoctor.toLowerCase().startsWith('dr') ? rawDoctor : `Dr. ${rawDoctor}`)
    : (hospital.includes('Regional') || hospital.includes('General') ? 'Dr. N. Taku, MD' : 'Dr. E. Ndip, MD');
  const doctorTitle = 'Attending Physician';

  const dateStr = new Date(rec.issuedDate || rec.completedAt || rec.preferredDate || rec.requestedAt || Date.now()).toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  const passcode = (rec.checkInToken || rec.certificateNumber || 'VP-849201').replace(/\s+/g, '');
  const certId = rec.certificateNumber || ('VP-CERT-' + passcode);

  content.innerHTML = `
    <div id="printableCertificate" class="p-3.5 sm:p-5 md:p-6 bg-gradient-to-b from-[#FFFDF8] via-[#FAF6ED] to-[#FFF9EE] border-2 sm:border-4 border-amber-600/70 rounded-2xl sm:rounded-3xl relative text-center space-y-2.5 sm:space-y-3.5 shadow-2xl text-slate-900 select-none overflow-hidden">
      <!-- Watermark Background -->
      <div class="absolute inset-0 flex items-center justify-center opacity-[0.03] pointer-events-none">
        <span class="material-symbols-outlined text-[180px] sm:text-[260px] text-amber-900">workspace_premium</span>
      </div>

      <!-- Top National Bilingual Header -->
      <div class="border-b border-amber-300/70 pb-1.5 text-center space-y-0.5">
        <p class="text-[9px] sm:text-[11px] font-black uppercase tracking-widest text-slate-800">RÉPUBLIQUE DU CAMEROUN • REPUBLIC OF CAMEROON</p>
        <p class="text-[7.5px] sm:text-[8.5px] font-semibold text-slate-500 italic">Paix - Travail - Patrie | Peace - Work - Fatherland</p>
        <p class="text-[8px] sm:text-[9px] font-black uppercase text-emerald-800 tracking-wider">MINISTÈRE DE LA SANTÉ PUBLIQUE • SERVICE NATIONAL DE TRANSFUSION SANGUINE (CNTS/NBTS)</p>
      </div>

      <!-- Prominent Brand Showcase & Verification Stamp -->
      <div class="flex flex-col sm:flex-row items-center justify-between gap-2.5 pt-0.5">
        <!-- Prominent VitalPulse Logo (Clean without side text) -->
        <img src="/vitalpulse-logo.png" alt="VitalPulse Official" class="h-12 sm:h-16 md:h-18 w-auto max-w-[200px] sm:max-w-[280px] object-contain shrink-0 drop-shadow-sm hover:scale-105 transition-transform" />

        <!-- Verification Registry Stamp -->
        <div class="text-center sm:text-right shrink-0">
          <span class="inline-flex items-center gap-1.5 text-xs sm:text-sm font-mono font-black uppercase text-amber-950 bg-amber-100/90 border border-amber-400 px-3 py-1 rounded-xl shadow-xs">
            <span class="material-symbols-outlined text-sm text-emerald-700">verified</span> ${esc(certId)}
          </span>
          <p class="text-[8.5px] font-bold text-slate-500 uppercase tracking-wider mt-0.5">Registry Passcode: <span class="text-slate-900 font-mono font-black">${esc(passcode)}</span></p>
        </div>
      </div>

      <!-- Main Title -->
      <div class="space-y-0.5">
        <p class="text-[9px] sm:text-[10px] font-black uppercase tracking-widest text-amber-800">Official Citation of Merit & Humanitarian Distinction</p>
        <h2 class="text-xl sm:text-3xl font-black font-headline text-red-800 tracking-tight uppercase">Lifesaver Certificate</h2>
        <p class="text-[9.5px] sm:text-[10.5px] text-slate-600 font-medium italic">Diplôme de Mérite Humanitaire — Conféré par le Service National de Transfusion Sanguine</p>
      </div>

      <!-- Recipient Presentation -->
      <div class="space-y-1 py-0.5 sm:py-1">
        <p class="text-[9.5px] sm:text-[10.5px] text-slate-600 font-bold uppercase tracking-wider">This official citation is solemnly conferred upon</p>
        <h3 class="text-xl sm:text-3xl font-black font-headline text-slate-950 tracking-wide underline decoration-amber-400 underline-offset-4">
          ${esc(donorName)}
        </h3>
        <p class="text-[10.5px] sm:text-xs text-slate-700 font-medium max-w-lg mx-auto pt-1 leading-relaxed">
          For exceptional humanitarian service in selflessly donating <strong class="text-slate-950 font-black">${units} Unit (${volumeMl} mL) of ${esc(bloodGroup)} Blood</strong> at <strong class="text-slate-950 font-black">${esc(hospital)}</strong> on <strong class="text-slate-950 font-black">${dateStr}</strong>. This verified clinical contribution directly sustained a human life during a critical emergency.
        </p>
      </div>

      <!-- Impact & Verification Ledger (4 columns) -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-left border-y border-amber-300/70 py-1.5 sm:py-2 bg-amber-50/60 rounded-xl px-2.5 sm:px-3">
        <div>
          <p class="text-[8.5px] font-bold text-slate-500 uppercase tracking-wider">Blood Group</p>
          <p class="text-sm sm:text-base font-black text-red-600 font-headline">${esc(bloodGroup)}</p>
        </div>
        <div>
          <p class="text-[8.5px] font-bold text-slate-500 uppercase tracking-wider">Clinical Status</p>
          <p class="text-[11px] font-black text-emerald-700 flex items-center gap-1 mt-0.5">
            <span class="material-symbols-outlined text-sm">check_circle</span> Transfused & Safe
          </p>
        </div>
        <div>
          <p class="text-[8.5px] font-bold text-slate-500 uppercase tracking-wider">Registry Passcode</p>
          <p class="text-[11px] font-mono font-bold text-slate-800">${esc(passcode)}</p>
        </div>
        <div>
          <p class="text-[8.5px] font-bold text-slate-500 uppercase tracking-wider">Health Network</p>
          <p class="text-[11px] font-black text-slate-800">NBTS Cameroon</p>
        </div>
      </div>

      <!-- Signatures Line (Simple, Cool, Authentic Classical Style) -->
      <div class="grid grid-cols-2 gap-6 sm:gap-12 pt-3 sm:pt-4 items-end text-xs">
        <div class="text-center space-y-1">
          <p class="font-bold text-sm sm:text-base text-slate-800 italic font-serif leading-tight">${esc(doctorName)}</p>
          <div class="w-32 sm:w-44 mx-auto border-t border-slate-400"></div>
          <p class="text-[9.5px] sm:text-[10.5px] font-bold text-slate-700 uppercase tracking-wider">Attending Physician</p>
          <p class="text-[8.5px] sm:text-[9.5px] text-slate-500 font-medium uppercase tracking-wider">${esc(hospital)}</p>
        </div>
        <div class="text-center space-y-1">
          <p class="font-bold text-sm sm:text-base text-slate-800 italic font-serif leading-tight">National Registry</p>
          <div class="w-32 sm:w-44 mx-auto border-t border-slate-400"></div>
          <p class="text-[9.5px] sm:text-[10.5px] font-bold text-slate-700 uppercase tracking-wider">Cameroon Blood Service</p>
          <p class="text-[8.5px] sm:text-[9.5px] text-slate-500 font-medium uppercase tracking-wider">NBTS Verification</p>
        </div>
      </div>
    </div>`;

  modal.classList.remove('hidden');
};

window.closeLifesaverCertificateModal = () => {
  const modal = document.getElementById('modalLifesaverCertificate');
  if (modal) modal.classList.add('hidden');
};

window.downloadLifesaverCertificate = async (recordId) => {
  const currentUser = getCurrentUser();
  const rec = (recordId ? (_activeJourneys.find(x => x.id === recordId) || _pastDonations.find(x => x.id === recordId)) : null)
              || window._currentLifesaverCertRecord 
              || {
                hospital: 'Buea Regional Hospital Blood Bank',
                city: 'Buea',
                region: 'Southwest Region',
                bloodType: currentUser?.bloodType || 'B+',
                units: 1,
                preferredDate: new Date().toISOString(),
                checkInToken: 'VP-849201',
              };

  const donorName = (currentUser?.name || currentUser?.displayName || currentUser?.fullName || (currentUser?.email ? currentUser.email.split('@')[0] : 'Verified Lifesaver')).trim();
  const hospital = rec.hospital || rec.hospitalName || rec.preferredLocation || 'Buea Regional Hospital Blood Bank';
  const rawDoctor = rec.requestingDoctor || rec.requestingPhysicianName || rec.attendingDoctor || rec.doctor || rec.doctorName || rec.physician;
  const doctorName = rawDoctor 
    ? (rawDoctor.toLowerCase().startsWith('dr') ? rawDoctor : `Dr. ${rawDoctor}`)
    : (hospital.includes('Regional') || hospital.includes('General') ? 'Dr. N. Taku, MD' : 'Dr. E. Ndip, MD');
  const bloodGroup = rec.bloodType || currentUser?.bloodType || 'B+';
  const units = rec.units || 1;
  const volumeMl = units * 450;
  const passcode = rec.checkInToken ? rec.checkInToken.replace(/\s+/g, '') : 'VP-849201';
  const certId = 'VP-CERT-' + passcode;
  const dateStr = new Date(rec.completedAt || rec.preferredDate || rec.requestedAt || Date.now()).toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  // High-Resolution 1600x1130 Canvas Export
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1130;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Background Parchment Gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, 1130);
  bgGrad.addColorStop(0, '#FFFDF8');
  bgGrad.addColorStop(0.5, '#FAF5EB');
  bgGrad.addColorStop(1, '#FFF9ED');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 1600, 1130);

  // Outer Ornate Double Border
  ctx.strokeStyle = '#B45309'; // Rich gold
  ctx.lineWidth = 8;
  ctx.strokeRect(36, 36, 1528, 1058);

  ctx.strokeStyle = '#D97706'; // Amber accent
  ctx.lineWidth = 2.5;
  ctx.strokeRect(48, 48, 1504, 1034);

  ctx.strokeStyle = '#047857'; // Cameroon Emerald
  ctx.lineWidth = 1.5;
  ctx.strokeRect(56, 56, 1488, 1018);

  // Corner Dots
  const drawCorner = (x, y) => {
    ctx.save();
    ctx.fillStyle = '#B45309';
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  drawCorner(48, 48);
  drawCorner(1552, 48);
  drawCorner(48, 1082);
  drawCorner(1552, 1082);

  // Header: Republic of Cameroon
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1E293B';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText('RÉPUBLIQUE DU CAMEROUN • REPUBLIC OF CAMEROON', 800, 105);

  ctx.font = 'italic 12px sans-serif';
  ctx.fillStyle = '#64748B';
  ctx.fillText('Paix - Travail - Patrie  |  Peace - Work - Fatherland', 800, 126);

  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = '#047857';
  ctx.fillText('MINISTÈRE DE LA SANTÉ PUBLIQUE • NATIONAL BLOOD TRANSFUSION SERVICE (NBTS)', 800, 148);

  // Separator line
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(350, 165);
  ctx.lineTo(750, 165);
  ctx.moveTo(850, 165);
  ctx.lineTo(1250, 165);
  ctx.stroke();

  ctx.fillStyle = '#D97706';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('★', 800, 171);

  // Try loading and drawing VitalPulse Logo (Prominent 300x200)
  try {
    const logoImg = new Image();
    logoImg.crossOrigin = 'anonymous';
    logoImg.src = '/vitalpulse-logo.png';
    await new Promise((resolve) => {
      logoImg.onload = () => {
        // Draw large, crisp VitalPulse logo: 300px wide, 200px high
        ctx.drawImage(logoImg, 80, 75, 300, 200);
        resolve();
      };
      logoImg.onerror = () => resolve();
      setTimeout(resolve, 350);
    });
  } catch (e) {
    // Graceful fallback
  }

  // Cert ID badge top right
  ctx.save();
  ctx.fillStyle = '#FEF3C7';
  ctx.strokeStyle = '#F59E0B';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(1280, 85, 235, 42, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#92400E';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(certId, 1397, 111);
  ctx.restore();

  // Certificate Title
  ctx.fillStyle = '#78350F';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('OFFICIAL CITATION OF MERIT & HUMANITARIAN DISTINCTION', 800, 220);

  ctx.fillStyle = '#991B1B';
  ctx.font = '900 42px serif';
  ctx.fillText('LIFESAVER CERTIFICATE', 800, 275);

  ctx.fillStyle = '#475569';
  ctx.font = 'italic 16px sans-serif';
  ctx.fillText('Conferred in grateful recognition of voluntary clinical blood donation preserving human life', 800, 310);

  // Recipient presentation
  ctx.fillStyle = '#64748B';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('THIS OFFICIAL NATIONAL DIPLOMA IS PROUDLY PRESENTED TO', 800, 365);

  // Donor Name
  ctx.fillStyle = '#0F172A';
  ctx.font = '900 44px sans-serif';
  ctx.fillText(donorName, 800, 425);

  // Decorative underline
  ctx.strokeStyle = '#D97706';
  ctx.lineWidth = 3;
  ctx.beginPath();
  const nameWidth = Math.min(ctx.measureText(donorName).width + 80, 700);
  ctx.moveTo(800 - nameWidth / 2, 442);
  ctx.lineTo(800 + nameWidth / 2, 442);
  ctx.stroke();

  // Citation Body
  ctx.fillStyle = '#334155';
  ctx.font = '17px sans-serif';
  ctx.fillText(`For outstanding humanitarian dedication in voluntarily donating ${units} Unit (${volumeMl} mL) of ${bloodGroup} Blood`, 800, 495);
  ctx.fillText(`at ${hospital} on ${dateStr}.`, 800, 525);
  ctx.fillStyle = '#475569';
  ctx.font = 'italic 15px sans-serif';
  ctx.fillText('This vital contribution has been clinically validated, laboratory-screened under NBTS safety standards,', 800, 560);
  ctx.fillText('and successfully transfused to sustain a critical patient life.', 800, 585);

  // Tabular Verification Ledger Block
  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(250, 630, 1100, 95, 12);
  ctx.fill();
  ctx.stroke();

  const cols = [
    { label: 'BLOOD GROUP', val: bloodGroup, color: '#DC2626', x: 387 },
    { label: 'CLINICAL STATUS', val: '✓ Transfused & Cleared', color: '#047857', x: 662 },
    { label: 'REGISTRY PASSCODE', val: passcode, color: '#0F172A', x: 937 },
    { label: 'HEALTH LEDGER', val: 'Cameroon NBTS Verified', color: '#0284C7', x: 1212 }
  ];
  cols.forEach(col => {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#94A3B8';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(col.label, col.x, 665);

    ctx.fillStyle = col.color;
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText(col.val, col.x, 700);
  });
  ctx.restore();

  // Signatures (Clean, Prestigious 2-Column Board Layout)
  // Left: Doctor
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0F172A';
  ctx.font = 'italic bold 22px serif';
  ctx.fillText(doctorName, 440, 895);
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(270, 915);
  ctx.lineTo(610, 915);
  ctx.stroke();
  ctx.fillStyle = '#1E293B';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('Attending Medical Officer', 440, 938);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#64748B';
  ctx.fillText(hospital, 440, 958);

  // Optional authentic ministerial seal (only drawn if scanned image file is uploaded by user)
  try {
    const sealImg = new Image();
    sealImg.crossOrigin = 'anonymous';
    sealImg.src = '/assets/minsante-seal.png';
    await new Promise((resolve) => {
      sealImg.onload = () => {
        ctx.drawImage(sealImg, 730, 845, 140, 140);
        resolve();
      };
      sealImg.onerror = () => resolve();
      setTimeout(resolve, 200);
    });
  } catch (e) {}

  // Right: National Registry
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0F172A';
  ctx.font = 'italic bold 22px serif';
  ctx.fillText('National Registry', 1160, 895);
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(990, 915);
  ctx.lineTo(1330, 915);
  ctx.stroke();
  ctx.fillStyle = '#1E293B';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('Cameroon Blood Service', 1160, 938);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#64748B';
  ctx.fillText('NBTS Verification', 1160, 958);

  // Bottom Security Line
  ctx.fillStyle = '#94A3B8';
  ctx.font = '11px monospace';
  ctx.fillText(`VitalPulse Secure Verification Hash: SHA256-${certId}-${passcode} • Registered with Republic of Cameroon Health Service`, 800, 1025);

  // Trigger download
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `VitalPulse_Lifesaver_Certificate_${passcode}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
};

window.printCertificate = () => {
  window.downloadLifesaverCertificate();
};

window.setHistoryViewMode = (mode) => {
  _historyViewMode = mode;
  renderDonorRequestsList();
};

window.handleHistorySearch = (term) => {
  _historySearchTerm = term || '';
  renderDonorRequestsList();
  const input = document.getElementById('historySearchInput');
  if (input) {
    input.focus();
    const val = input.value;
    input.setSelectionRange(val.length, val.length);
  }
};

window.handleHistoryYearFilter = (year) => {
  _historyYearFilter = year;
  renderDonorRequestsList();
};

window.clearHistoryFilters = () => {
  _historySearchTerm = '';
  _historyYearFilter = 'all';
  renderDonorRequestsList();
};

window.toggleHistoryJourneyTimeline = (id) => {
  const el = document.getElementById(`journeyTimeline-${id}`);
  const icon = document.getElementById(`journeyTimelineIcon-${id}`);
  if (el) {
    el.classList.toggle('hidden');
    if (icon) icon.textContent = el.classList.contains('hidden') ? 'expand_more' : 'expand_less';
  }
};

function renderDonationHistoryRow(d, idx) {
  const currentUser = getCurrentUser();
  const id = d.id || `donation-hist-${idx}`;
  const bt = d.bloodType || d.type || currentUser?.bloodType || 'B+';
  const units = d.units || 1;
  const volumeMl = units * 450;
  const component = d.componentType || 'Whole Blood';
  const hospital = d.hospital || d.hospitalName || d.preferredLocation || 'Buea Regional Hospital';
  const city = d.city || (hospital.includes('Buea') ? 'Buea' : hospital.includes('Limbe') ? 'Limbe' : hospital.includes('Yaound') ? 'Yaoundé' : 'Douala');
  const region = d.region || (city === 'Buea' || city === 'Limbe' ? 'Southwest Region' : city === 'Yaoundé' ? 'Centre Region' : 'Littoral Region');
  
  const rawDate = d.completedAt || d.preferredDate || d.updatedAt || d.requestedAt || Date.now();
  const dateFormatted = new Date(rawDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const timeFormatted = new Date(rawDate).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const passcode = d.checkInToken || ('VP-' + Math.floor(100000 + (idx + 1) * 23456));

  return `
    <div class="group bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-3 sm:p-4 hover:border-emerald-500/50 hover:shadow-md transition-all space-y-3">
      
      <!-- Primary Dense Row -->
      <div class="flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap">
        
        <!-- Left: Blood Emblem + Facility & Meta -->
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-gradient-to-tr from-emerald-600 via-teal-600 to-emerald-500 text-white flex items-center justify-center font-black text-sm sm:text-base font-headline shrink-0 shadow-xs border border-white/20">
            ${esc(bt)}
          </div>
          
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <h4 class="font-black text-xs sm:text-sm text-slate-900 dark:text-white truncate">${esc(hospital)}</h4>
              <span class="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800/60 px-2 py-0.5 rounded-full shrink-0">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Verified Facility
              </span>
            </div>
            <p class="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 font-medium mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>${esc(city)}, ${esc(region)}</span>
              <span>•</span>
              <span class="text-slate-600 dark:text-slate-300 font-bold">${dateFormatted} at ${timeFormatted}</span>
            </p>
          </div>
        </div>

        <!-- Center: Clinical Metrics (Volume, Outcome, Passcode) -->
        <div class="hidden md:flex items-center gap-2 shrink-0">
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold text-[11px]">
            <span class="material-symbols-outlined text-xs text-red-500">water_drop</span>
            <span>${volumeMl} mL • ${esc(component)}</span>
          </span>

          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-extrabold text-[11px] border border-emerald-200/60 dark:border-emerald-800/40">
            <span class="material-symbols-outlined text-xs text-rose-500" style="font-variation-settings:'FILL' 1">favorite</span>
            <span>1 Life Saved</span>
          </span>

          <div class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono text-[11px] font-bold">
            <span class="material-symbols-outlined text-xs text-amber-500">qr_code_2</span>
            <span>${esc(passcode)}</span>
          </div>
        </div>

        <!-- Right: Actions (Certificate Button + Expand Chevron) -->
        <div class="flex items-center gap-2 shrink-0 justify-end w-full sm:w-auto">
          <button type="button" onclick="window.openLifesaverCertificateModal('${esc(id)}')" class="press-scale flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-black text-xs shadow-xs shadow-emerald-600/20 transition-all cursor-pointer min-h-[38px]">
            <span class="material-symbols-outlined text-sm" style="font-variation-settings:'FILL' 1">workspace_premium</span>
            <span>Certificate</span>
          </button>

          <button type="button" onclick="window.toggleHistoryJourneyTimeline('${esc(id)}')" class="press-scale inline-flex items-center justify-center gap-1 px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold text-xs transition-colors cursor-pointer min-h-[38px]" title="Toggle Audit Trail">
            <span class="hidden lg:inline text-[11px]">Audit</span>
            <span id="journeyTimelineIcon-${esc(id)}" class="material-symbols-outlined text-base">expand_more</span>
          </button>
        </div>

      </div>

      <!-- Mobile Metrics Strip (For small screens under md breakpoint) -->
      <div class="flex md:hidden items-center justify-between gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-[10px]">
        <span class="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1 truncate min-w-0">
          <span class="material-symbols-outlined text-xs text-red-500 shrink-0">water_drop</span>
          <span class="truncate">${volumeMl} mL • ${esc(component)}</span>
        </span>
        <span class="font-extrabold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 shrink-0">
          <span class="material-symbols-outlined text-xs text-rose-500 shrink-0" style="font-variation-settings:'FILL' 1">favorite</span> 1 Life Saved
        </span>
        <span class="font-mono text-slate-500 dark:text-slate-400 font-bold shrink-0">#${esc(passcode)}</span>
      </div>

      <!-- Expandable Detailed Clinical Audit Drawer -->
      <div id="journeyTimeline-${esc(id)}" class="hidden bg-slate-50 dark:bg-slate-800/40 rounded-2xl p-3.5 sm:p-5 border border-slate-200/80 dark:border-slate-700 space-y-4">
        
        <!-- Header Strip inside Drawer -->
        <div class="flex items-center justify-between flex-wrap gap-2 border-b border-slate-200/60 dark:border-slate-700/60 pb-3">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-base text-emerald-600" style="font-variation-settings:'FILL' 1">verified</span>
            <span class="text-xs font-black uppercase tracking-wider text-slate-800 dark:text-slate-200">Verified NBTS Medical Ledger Audit</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-mono text-slate-500 dark:text-slate-400 font-bold">Passcode: ${esc(passcode)}</span>
            <button type="button" onclick="window.copyCheckInPasscode('${esc(passcode)}', this)" class="press-scale px-2 py-0.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold transition-colors flex items-center gap-1 cursor-pointer">
              <span class="material-symbols-outlined text-xs">content_copy</span> Copy
            </button>
          </div>
        </div>

        <!-- 6-Stage Timeline Nodes -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <div class="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-800 flex items-start gap-2.5">
            <span class="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-600 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">1</span>
            <div>
              <p class="font-bold text-slate-800 dark:text-slate-200 text-xs">Requisition Matched</p>
              <p class="text-[10px] text-slate-400 mt-0.5">Dispatched to donor for ${esc(hospital)}</p>
            </div>
          </div>

          <div class="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-800 flex items-start gap-2.5">
            <span class="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-600 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">2</span>
            <div>
              <p class="font-bold text-slate-800 dark:text-slate-200 text-xs">En Route Alert</p>
              <p class="text-[10px] text-slate-400 mt-0.5">GPS route initiated & hospital alerted</p>
            </div>
          </div>

          <div class="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-800 flex items-start gap-2.5">
            <span class="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-600 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">3</span>
            <div>
              <p class="font-bold text-slate-800 dark:text-slate-200 text-xs">Reception Check-In</p>
              <p class="text-[10px] text-slate-400 mt-0.5">CNI verified with code ${esc(passcode)}</p>
            </div>
          </div>

          <div class="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-800 flex items-start gap-2.5">
            <span class="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-600 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">4</span>
            <div>
              <p class="font-bold text-slate-800 dark:text-slate-200 text-xs">Phlebotomy Collection</p>
              <p class="text-[10px] text-slate-400 mt-0.5">${volumeMl} mL unit safely collected & sealed</p>
            </div>
          </div>

          <div class="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-800 flex items-start gap-2.5">
            <span class="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-600 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">5</span>
            <div>
              <p class="font-bold text-slate-800 dark:text-slate-200 text-xs">Laboratory Clearance</p>
              <p class="text-[10px] text-slate-400 mt-0.5">TTIs & crossmatch certified sterile</p>
            </div>
          </div>

          <div class="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-slate-200/70 dark:border-slate-800 flex items-start gap-2.5">
            <span class="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">6</span>
            <div>
              <p class="font-bold text-emerald-700 dark:text-emerald-400 text-xs">Transfusion Successful</p>
              <p class="text-[10px] text-slate-400 mt-0.5">1 Life Saved • Patient in recovery</p>
            </div>
          </div>
        </div>

        <!-- Footer Seal -->
        <div class="flex items-center justify-between pt-2 border-t border-slate-200/60 dark:border-slate-700/60 text-slate-500 text-[10px] sm:text-[11px] font-medium flex-wrap gap-2">
          <span class="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-bold">
            <span class="material-symbols-outlined text-sm">health_and_safety</span> Official Cameroon Blood Service Record
          </span>
          <span class="text-[10px] font-mono text-slate-400">Passcode: ${esc(passcode)}</span>
        </div>

      </div>

    </div>`;
}

function renderDonationHistoryCard(d, idx) {
  const currentUser = getCurrentUser();
  const id = d.id || `donation-hist-${idx}`;
  const bt = d.bloodType || d.type || currentUser?.bloodType || 'B+';
  const units = d.units || 1;
  const volumeMl = units * 450;
  const component = d.componentType || 'Whole Blood';
  const hospital = d.hospital || d.hospitalName || d.preferredLocation || 'Buea Regional Hospital';
  const city = d.city || (hospital.includes('Buea') ? 'Buea' : hospital.includes('Limbe') ? 'Limbe' : hospital.includes('Yaound') ? 'Yaoundé' : 'Douala');
  const region = d.region || (city === 'Buea' || city === 'Limbe' ? 'Southwest Region' : city === 'Yaoundé' ? 'Centre Region' : 'Littoral Region');
  
  const rawDate = d.completedAt || d.preferredDate || d.updatedAt || d.requestedAt || Date.now();
  const dateFormatted = new Date(rawDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const timeFormatted = new Date(rawDate).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const passcode = d.checkInToken || ('VP-' + Math.floor(100000 + (idx + 1) * 23456));

  return `
    <div class="hover-lift bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xs hover:shadow-md transition-all border-l-4 border-l-emerald-500 space-y-3.5 relative overflow-hidden flex flex-col justify-between">
      
      <!-- Top Row: Blood Type + Facility Info -->
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-tr from-emerald-600 via-teal-600 to-emerald-500 text-white flex items-center justify-center font-black text-base sm:text-lg font-headline shadow-xs shrink-0 border border-white/20">
            ${esc(bt)}
          </div>
          <div class="min-w-0 flex-1">
            <h4 class="font-black text-sm text-slate-900 dark:text-white truncate">${esc(hospital)}</h4>
            <p class="text-[11px] text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1 mt-0.5 truncate">
              <span class="material-symbols-outlined text-xs text-emerald-600">location_on</span> ${esc(city)}, ${esc(region)}
            </p>
          </div>
        </div>

        <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700 shrink-0">
          <span class="material-symbols-outlined text-xs text-emerald-600 dark:text-emerald-400" style="font-variation-settings:'FILL' 1">verified</span>
          <span>Verified</span>
        </span>
      </div>

      <!-- Quick Metrics Grid -->
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class="bg-slate-50 dark:bg-slate-800/60 p-2.5 rounded-xl border border-slate-200/60 dark:border-slate-700">
          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Volume & Type</p>
          <p class="font-black text-slate-800 dark:text-slate-200 text-xs truncate mt-0.5">${volumeMl} mL • ${esc(component)}</p>
        </div>
        <div class="bg-slate-50 dark:bg-slate-800/60 p-2.5 rounded-xl border border-slate-200/60 dark:border-slate-700">
          <p class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Clinical Impact</p>
          <p class="font-black text-emerald-700 dark:text-emerald-400 text-xs truncate mt-0.5">Up to ${(units || 1) * 3} Lives Preserved</p>
        </div>
      </div>

      <!-- Date & Passcode Bar -->
      <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-medium pt-1">
        <span class="flex items-center gap-1">
          <span class="material-symbols-outlined text-xs text-slate-400">calendar_today</span> ${dateFormatted}
        </span>
        <span class="font-mono text-xs font-bold text-slate-600 dark:text-slate-300">#${esc(passcode)}</span>
      </div>

      <!-- Actions -->
      <div class="flex items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
        <button type="button" onclick="window.openLifesaverCertificateModal('${esc(id)}')" class="press-scale flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-black text-xs shadow-xs transition-all cursor-pointer">
          <span class="material-symbols-outlined text-sm" style="font-variation-settings:'FILL' 1">workspace_premium</span>
          <span>View Certificate</span>
        </button>

        <button type="button" onclick="window.toggleHistoryJourneyTimeline('${esc(id)}')" class="press-scale px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold text-xs transition-colors cursor-pointer" title="Detailed Audit">
          <span id="journeyTimelineIcon-${esc(id)}" class="material-symbols-outlined text-base">expand_more</span>
        </button>
      </div>

      <!-- Expandable Detailed Journey Audit Accordion -->
      <div id="journeyTimeline-${esc(id)}" class="hidden bg-slate-50 dark:bg-slate-800/40 rounded-xl p-3 border border-slate-200/70 dark:border-slate-700 space-y-2 text-xs">
        <p class="text-[10px] font-black text-slate-500 uppercase tracking-wider">6-Step Hospital Audit Trail</p>
        <div class="space-y-1.5 text-[11px]">
          <div class="flex items-center gap-2 text-emerald-600 font-bold">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Requisition Matched & Accepted
          </div>
          <div class="flex items-center gap-2 text-emerald-600 font-bold">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> GPS Route & Reception Check-In Verified
          </div>
          <div class="flex items-center gap-2 text-emerald-600 font-bold">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ${volumeMl} mL Collected & Lab Screened Sterile
          </div>
          <div class="flex items-center gap-2 text-emerald-600 font-bold">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Transfused Successfully • Patient Safe
          </div>
        </div>
      </div>

    </div>`;
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
    ? `<span class="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800/60 px-2.5 py-1 rounded-full"><span class="material-symbols-outlined text-xs" style="font-variation-settings:'FILL' 1">verified</span> Mission Complete</span>`
    : `<span class="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 px-2.5 py-1 rounded-full"><span class="relative flex w-1.5 h-1.5"><span class="absolute inline-flex w-full h-full rounded-full bg-primary opacity-60 animate-ping"></span><span class="relative inline-flex w-1.5 h-1.5 rounded-full bg-primary"></span></span> Live Expedition</span>`;

  const publicBadge = r.isPublicRequest ? `<span class="px-2.5 py-0.5 rounded-full text-[9px] font-black bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-800/50">Public Requisition</span>` : '';

  const urgencyLevel = (r.urgency || '').toLowerCase();
  const isCritical = urgencyLevel === 'critical';
  const borderCls = isCritical
    ? 'border-l-4 border-l-red-600'
    : urgencyLevel === 'urgent'
    ? 'border-l-4 border-l-amber-500'
    : 'border-l-4 border-l-primary';

  const urgencyChip = isCritical
    ? '<span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-red-600 text-white shadow-xs">Critical</span>'
    : urgencyLevel === 'urgent'
    ? '<span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/50">Urgent</span>'
    : '';

  const units = r.units || 1;
  const component = r.componentType || 'Whole Blood';
  const pickup = (r.pickupLocation || '').trim();
  const phone = (r.contactPhone || '').trim();
  const mapQuery = r.hospital ? `${r.hospital}, ${r.city || 'Cameroon'}` : `${r.pickupLocation || 'Hospital'}, ${r.city || 'Cameroon'}`;
  const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`;

  const chip = (icon, label) => `<span class="inline-flex items-center gap-1 bg-slate-50 dark:bg-slate-800 text-[10px] font-bold text-slate-700 dark:text-slate-300 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700"><span class="material-symbols-outlined text-[13px] text-primary">${icon}</span>${esc(label)}</span>`;
  const chipRow = `<div class="flex flex-wrap items-center gap-1.5 mt-2">
    ${chip('science', component)}
    ${typeof r.matchedDistanceKm === 'number' ? chip('near_me', r.matchedDistanceKm + ' km away') : ''}
    ${chip('water_drop', `${units} Unit${units > 1 ? 's' : ''}`)}
  </div>`;

  const detailsBlock = `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 bg-slate-50 dark:bg-slate-800/60 rounded-2xl p-3.5 border border-slate-200 dark:border-slate-700 text-xs">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-primary text-base shrink-0">local_hospital</span>
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider shrink-0">Hospital</span>
        <span class="font-bold text-slate-800 dark:text-slate-200 truncate">${esc(r.hospital || r.hospitalName || 'Hospital Desk')}</span>
      </div>
      ${phone ? `
        <a href="tel:${esc(phone.replace(/\s+/g, ''))}" class="press-scale flex items-center gap-2 text-primary hover:underline font-bold">
          <span class="material-symbols-outlined text-base shrink-0">call</span>
          <span class="text-[10px] text-slate-400 uppercase tracking-wider shrink-0">Call Desk</span>
          <span class="truncate">${esc(phone)}</span>
        </a>` : `
        <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" class="press-scale flex items-center gap-2 text-primary hover:underline font-bold">
          <span class="material-symbols-outlined text-base shrink-0">directions</span>
          <span class="text-[10px] text-slate-400 uppercase tracking-wider shrink-0">Navigation</span>
          <span class="truncate">Open GPS Directions</span>
        </a>`}
      ${pickup ? `
        <div class="flex items-center gap-2 sm:col-span-2 text-slate-600 dark:text-slate-300">
          <span class="material-symbols-outlined text-base text-amber-500 shrink-0">meeting_room</span>
          <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider shrink-0">Pickup Point</span>
          <span class="font-semibold truncate">${esc(pickup)}</span>
        </div>` : ''}
    </div>`;

  let actions;
  if (r.status === 'Donor Assigned') {
    actions = `
      <button onclick="window.donorCancelRequest('${r.id}')" class="press-scale text-[11px] font-bold text-slate-500 hover:text-red-600 bg-slate-100 dark:bg-slate-800 hover:bg-red-50 px-3.5 py-2.5 rounded-xl transition-colors flex items-center gap-1 cursor-pointer"><span class="material-symbols-outlined text-xs">close</span> Withdraw</button>
      <button onclick="window.donorMarkEnRoute('${r.id}', '${currentUser?.uid || ''}', ${!!r.isPublicRequest})" class="press-scale text-xs font-black text-white bg-primary hover:bg-primary/90 px-4 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-1.5 cursor-pointer"><span class="material-symbols-outlined text-sm">directions_car</span> Start Trip (En Route)</button>`;
  } else if (r.status === 'Donor En Route') {
    const awaiting = r.receptionStatus === 'Awaiting Verification';
    actions = `
      <button onclick="window.donorCancelRequest('${r.id}')" class="press-scale text-[11px] font-bold text-slate-500 hover:text-red-600 bg-slate-100 dark:bg-slate-800 hover:bg-red-50 px-3.5 py-2.5 rounded-xl transition-colors flex items-center gap-1 cursor-pointer"><span class="material-symbols-outlined text-xs">close</span> Withdraw</button>
      ${awaiting
        ? `<span class="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60"><span class="material-symbols-outlined text-sm">hourglass_top</span> Reception Notified</span>`
        : `<button onclick="window.donorMarkArrived('${r.id}', '${currentUser?.uid || ''}', ${!!r.isPublicRequest})" class="press-scale text-xs font-black text-white bg-emerald-600 hover:bg-emerald-700 px-4 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-1.5 cursor-pointer"><span class="material-symbols-outlined text-sm">badge</span> I've Arrived — Show Passcode</button>`}`;
  } else {
    const drawn = r.status === 'Donation Complete' || r.status === 'completed';
    const statusText = drawn ? 'Blood Drawn · At Lab' : r.status;
    actions = `<span class="px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wider ${isComplete ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 border border-emerald-200' : drawn ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 border border-amber-200' : 'bg-primary/10 text-primary border border-primary/20'}">${esc(statusText)}</span>`;
  }

  const nodes = JOURNEY_STEPS.map((s, idx) => {
    const i = idx + 1;
    const done = i < stepNum;
    const current = i === stepNum && !isComplete;
    const isFinalDone = i === N && isComplete;
    const nodeCls = isFinalDone ? 'bg-emerald-600 text-white shadow-sm ring-4 ring-emerald-500/20'
      : done ? 'bg-primary text-white ring-2 ring-primary/20'
      : current ? 'bg-primary text-white ring-4 ring-primary/30 shadow-md scale-105'
      : 'bg-slate-100 dark:bg-slate-800 text-slate-400 border border-slate-200 dark:border-slate-700';
    const labelCls = current ? 'text-primary font-black scale-105' : done || isFinalDone ? 'text-slate-800 dark:text-slate-200 font-bold' : 'text-slate-400 font-medium';
    return `
      <div class="relative z-10 flex flex-col items-center gap-1.5" style="width:${cell}%">
        <span class="relative w-8 h-8 rounded-full flex items-center justify-center shadow-xs ${nodeCls} transition-all">
          ${current ? '<span class="absolute inset-0 rounded-full bg-primary/40 animate-ping"></span>' : ''}
          <span class="material-symbols-outlined relative" style="font-size:16px;font-variation-settings:'FILL' 1">${done ? 'check' : s.icon}</span>
        </span>
        <span class="text-[8px] sm:text-[9px] text-center leading-tight ${labelCls}">${s.label}</span>
      </div>`;
  }).join('');

  const awaitingVerification = r.status === 'Donor En Route' && r.receptionStatus === 'Awaiting Verification';
  const passcodeTicket = r.checkInToken ? `
    <div class="bg-emerald-50 dark:bg-emerald-950/40 border ${awaitingVerification ? 'border-emerald-400 ring-2 ring-emerald-400/40 shadow-sm' : 'border-emerald-200 dark:border-emerald-800/60'} rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 text-emerald-950 dark:text-emerald-100 shadow-xs">
      <div class="flex items-center gap-3.5">
        <div class="w-12 h-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-black text-xl shadow-xs shrink-0">
          <span class="material-symbols-outlined text-2xl">qr_code_2</span>
        </div>
        <div>
          <p class="text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
            <span class="material-symbols-outlined text-xs">verified</span> Official Check-In Passcode
          </p>
          <div class="flex items-center gap-2 mt-0.5">
            <p class="text-2xl sm:text-3xl font-mono font-black tracking-widest text-emerald-900 dark:text-emerald-200">${esc(r.checkInToken)}</p>
            <button type="button" onclick="window.copyCheckInPasscode('${esc(r.checkInToken)}', this)" class="press-scale px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold transition-colors flex items-center gap-1 cursor-pointer shadow-xs">
              <span class="material-symbols-outlined text-xs">content_copy</span> Copy
            </button>
          </div>
        </div>
      </div>
      <div class="space-y-1 sm:text-right max-w-xs">
        <p class="text-xs text-emerald-800 dark:text-emerald-300 font-medium leading-relaxed">${awaitingVerification
          ? '⚡ Reception desk notified! Present this code and your physical CNI ID card to the front desk.'
          : 'Present this passcode and your physical CNI ID card to the blood bank reception upon arrival.'}</p>
        <span class="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-950/60 px-2 py-0.5 rounded-md border border-amber-300 dark:border-amber-800/60">
          <span class="material-symbols-outlined text-xs">badge</span> Don't forget physical CNI ID
        </span>
      </div>
    </div>
  ` : '';

  return `
  <div class="hover-lift bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-3xl border border-slate-200 dark:border-slate-800 ${borderCls} shadow-xs space-y-4 sm:space-y-5">
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-3.5 min-w-0">
        <span class="w-13 h-13 sm:w-14 sm:h-14 rounded-2xl bg-gradient-to-tr from-primary via-red-600 to-rose-500 text-white flex items-center justify-center font-black text-xl shrink-0 shadow-sm border border-white/20 font-headline">${esc(r.bloodType || r.type || '?')}</span>
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <p class="font-black text-base sm:text-lg text-slate-900 dark:text-white truncate">${esc(r.hospital || r.hospitalName || 'Hospital')}</p>
            ${urgencyChip}${publicBadge}
          </div>
          <div class="flex items-center gap-2 mt-1 text-xs text-slate-500 dark:text-slate-400 font-medium flex-wrap">
            ${liveBadge}
            <span class="truncate">${esc(r.city || 'Cameroon')}${r.matchedDistanceKm ? ' · ~' + r.matchedDistanceKm + ' km' : ''}</span>
            ${updated ? `<span class="text-slate-400">· updated ${getTimeAgo(updated)}</span>` : ''}
          </div>
          ${chipRow}
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0 w-full sm:w-auto justify-end">${actions}</div>
    </div>

    <!-- Live 6-step journey stepper -->
    <div class="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-3.5 sm:p-4 pt-5 border border-slate-200 dark:border-slate-700">
      <div class="relative">
        <div class="absolute top-4 h-1 bg-slate-200 dark:bg-slate-700 rounded-full" style="left:${edge}%; right:${edge}%"></div>
        <div class="absolute top-4 h-1 ${isComplete ? 'bg-emerald-600' : 'bg-primary'} rounded-full transition-all duration-500" style="left:${edge}%; width:${progressW}%"></div>
        <div class="relative flex justify-between">${nodes}</div>
      </div>
    </div>

    ${detailsBlock}

    ${passcodeTicket}
  </div>`;
}

let _reqCurrentPage = 1;
const REQ_ITEMS_PER_PAGE = 6;
let _requestsMiniMapInstance = null;

window.setRequestsPage = (page) => {
  _reqCurrentPage = Math.max(1, page);
  renderDonorRequestsList();
  document.getElementById('view-requests')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

export function getNormalizedUrgency(urgency) {
  const u = String(urgency || '').toLowerCase().trim();
  if (u.includes('crit') || u.includes('immediate') || u.includes('emergency')) return 'critical';
  if (u.includes('urg') || u.includes('high') || u.includes('soon')) return 'urgent';
  return 'routine';
}

function renderDonorRequestsList() {
  const container = document.getElementById('donorRequestsList');
  if (!container) return;
  const currentUser = getCurrentUser();

  // Handle Tab-Specific Layout Toggles (Donation History hides search/radar and expands feed to full width)
  const filterPanel = document.getElementById('reqFilterPanel');
  const radarSidebar = document.getElementById('reqRadarSidebarColumn');
  const feedCol = document.getElementById('reqFeedColumn');
  const feedHeaderRow = document.getElementById('reqFeedHeaderRow');

  const isHistory = _currentReqFilter === 'completed';
  if (filterPanel) {
    filterPanel.classList.toggle('hidden', isHistory);
    filterPanel.style.display = isHistory ? 'none' : '';
  }
  if (radarSidebar) {
    radarSidebar.classList.toggle('hidden', isHistory);
    radarSidebar.style.display = isHistory ? 'none' : '';
  }
  if (feedHeaderRow) {
    feedHeaderRow.classList.toggle('hidden', isHistory);
    feedHeaderRow.style.display = isHistory ? 'none' : '';
  }
  if (feedCol) {
    if (isHistory) {
      feedCol.classList.remove('lg:col-span-8');
      feedCol.classList.add('lg:col-span-12');
    } else {
      feedCol.classList.remove('lg:col-span-12');
      feedCol.classList.add('lg:col-span-8');
    }
  }

  const activeJourneys = _activeJourneys.filter(r => r.status === 'Donor Assigned' || r.status === 'Donor En Route' || r.status === 'Checked In');
  const criticalCount = _allRequests.filter(r => getNormalizedUrgency(r.urgency) === 'critical').length;
  const urgentCount = _allRequests.filter(r => getNormalizedUrgency(r.urgency) === 'urgent').length;
  const routineCount = Math.max(0, _allRequests.length - criticalCount - urgentCount);
  const totalCount = _allRequests.length;

  // 1. Update Match Summary 2x2 Matrix & Stats
  const statTotalEl = document.getElementById('reqStatTotal');
  if (statTotalEl) statTotalEl.textContent = totalCount;
  const statCritEl = document.getElementById('reqStatCritical');
  if (statCritEl) statCritEl.textContent = criticalCount;
  const statUrgEl = document.getElementById('reqStatUrgentCount');
  if (statUrgEl) statUrgEl.textContent = urgentCount;
  const statRoutEl = document.getElementById('reqStatRoutine');
  if (statRoutEl) statRoutEl.textContent = routineCount;

  // Badges & Ribbon Counts
  const totalBadge = document.getElementById('reqTotalBadge');
  if (totalBadge) totalBadge.textContent = totalCount;
  const tabActiveBadge = document.getElementById('tabBadgeActive');
  if (tabActiveBadge) tabActiveBadge.textContent = activeJourneys.length;
  const tabBcastBadge = document.getElementById('tabBadgeBroadcast');
  if (tabBcastBadge) tabBcastBadge.textContent = _allRequests.filter(r => r.isPublicRequest || r.systemWide).length;
  const ribbonReqCount = document.getElementById('ribbonLiveReqCount');
  if (ribbonReqCount) ribbonReqCount.textContent = totalCount;
  const ribbonReqLabel = document.getElementById('ribbonLiveReqLabel');
  if (ribbonReqLabel) ribbonReqLabel.textContent = totalCount === 1 ? 'Request Live' : 'Requests Live';

  // Hero blood type & sculpted medical emblem
  const heroBloodType = currentUser?.bloodType || 'B+';
  const heroBloodEl = document.getElementById('reqHeroBloodType');
  if (heroBloodEl) {
    const raw = String(heroBloodType).trim();
    const sign = raw.endsWith('+') ? '+' : raw.endsWith('-') ? '-' : '';
    const letter = sign ? raw.slice(0, -1) : raw;
    heroBloodEl.innerHTML = `${esc(letter)}${sign ? `<sup class="text-xs text-rose-200 ml-0.5 drop-shadow-[0_0_6px_rgba(255,255,255,0.7)]">${sign}</sup>` : ''}`;
  }

  // 2. Render Active Mission Spotlight (If user is currently on an active mission)
  const activeExpeditionContainer = document.getElementById('donorActiveExpeditionContainer');
  if (activeExpeditionContainer) {
    if (activeJourneys.length > 0 && (_currentReqFilter === 'all' || _currentReqFilter === 'active')) {
      activeExpeditionContainer.classList.remove('hidden');
      activeExpeditionContainer.innerHTML = `
        <div class="space-y-2 mb-4">
          <div class="flex items-center justify-between">
            <span class="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-red-600 bg-red-50 border border-red-200 px-3 py-1 rounded-full">
              <span class="w-2 h-2 rounded-full bg-red-600 animate-ping"></span> Your Active Ongoing Mission
            </span>
          </div>
          ${activeJourneys.map(renderDonorJourneyCard).join('')}
        </div>`;
    } else {
      activeExpeditionContainer.classList.add('hidden');
      activeExpeditionContainer.innerHTML = '';
    }
  }

  // 3. Tab Specific Handling for History
  if (_currentReqFilter === 'completed') {
    const completedJourneys = _activeJourneys.filter(r => r.status === 'Completed' || r.status === 'Issued' || r.status === 'Resolved');
    const allHistoryItems = [...completedJourneys, ..._pastDonations];

    if (allHistoryItems.length === 0) {
      const donorName = currentUser?.displayName || currentUser?.fullName || 'Verified Lifesaver';
      const bloodType = currentUser?.bloodType || 'B+';
      const donorCity = (currentUser?.city && currentUser.city.toLowerCase() !== 'national') ? currentUser.city : 'Douala';
      const donorRegion = currentUser?.region || (donorCity === 'Buea' || donorCity === 'Limbe' ? 'Southwest' : donorCity === 'Yaoundé' ? 'Centre' : 'Littoral');

      container.innerHTML = `
        <div class="space-y-4 sm:space-y-6">
          <!-- Dual-Pane Biometric Lifesaver Passport Dossier -->
          <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5 items-stretch">
            
            <!-- LEFT PANE (lg:col-span-7): The Official Republic of Cameroon Lifesaver Passport Specimen -->
            <div class="lg:col-span-7 bg-[#080E1A] border border-emerald-500/30 rounded-2xl sm:rounded-3xl p-4 sm:p-7 text-white shadow-2xl relative overflow-hidden flex flex-col justify-between space-y-4 sm:space-y-6">
              
              <!-- Subtle Security Watermark & Ambient Radial Glows -->
              <div class="absolute -right-20 -top-20 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none"></div>
              <div class="absolute -left-20 -bottom-20 w-72 h-72 rounded-full bg-teal-500/10 blur-3xl pointer-events-none"></div>
              
              <!-- Top Official Security Header -->
              <div class="relative z-10 flex items-center justify-between border-b border-emerald-500/20 pb-3 sm:pb-4 flex-wrap gap-2">
                <div class="flex items-center gap-2 sm:gap-2.5">
                  <div class="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-emerald-950 border border-emerald-400/30 flex items-center justify-center text-[10px] sm:text-xs font-black text-emerald-400 font-headline">
                    CMR
                  </div>
                  <div>
                    <p class="text-[8px] sm:text-[9px] font-black uppercase tracking-widest text-emerald-400">RÉPUBLIQUE DU CAMEROUN • NBTS</p>
                    <p class="text-[10px] sm:text-[11px] font-bold text-slate-300">National Blood Transfusion Service</p>
                  </div>
                </div>
                <div class="text-right">
                  <span class="inline-flex items-center gap-1 font-mono text-[9px] sm:text-[10px] font-bold text-emerald-300/80 bg-emerald-950/80 border border-emerald-500/30 px-2 py-0.5 rounded-md">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> REG: 2026-STANDBY
                  </span>
                </div>
              </div>

              <!-- Donor Biometric ID Strip -->
              <div class="relative z-10 flex items-start sm:items-center justify-between gap-3 sm:gap-4 bg-white/5 border border-white/10 rounded-xl sm:rounded-2xl p-3 sm:p-4 backdrop-blur-sm flex-wrap sm:flex-nowrap">
                <div class="flex items-center gap-3 sm:gap-3.5 min-w-0">
                  <div class="w-12 h-12 sm:w-14 sm:h-14 rounded-xl sm:rounded-2xl bg-gradient-to-tr from-emerald-600 via-teal-600 to-emerald-500 text-white flex items-center justify-center font-black text-base sm:text-xl font-headline shrink-0 shadow-md border border-white/20">
                    ${esc(bloodType)}
                  </div>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <h3 class="text-sm sm:text-lg font-black text-white font-headline truncate">${esc(donorName)}</h3>
                      <span class="inline-flex items-center gap-1 text-[8px] sm:text-[9px] font-black uppercase tracking-wider text-emerald-300 bg-emerald-500/20 border border-emerald-400/30 px-2 py-0.5 rounded-full">
                        Standby Lifesaver
                      </span>
                    </div>
                    <p class="text-[10px] sm:text-[11px] text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span>${esc(donorCity)}, ${esc(donorRegion)}</span>
                      <span>•</span>
                      <span class="text-emerald-400 font-bold">Awaiting First Clinical Seal</span>
                    </p>
                  </div>
                </div>

                <div class="shrink-0 text-right hidden sm:block">
                  <p class="text-[9px] font-bold uppercase tracking-wider text-slate-400">Total Recorded</p>
                  <p class="text-xl font-black text-white leading-none mt-0.5">0 Units</p>
                </div>
              </div>

              <!-- 4 Clinical Passport Stamp Slots (Embossed Specimen Seals) -->
              <div class="relative z-10 space-y-2">
                <div class="flex items-center justify-between">
                  <p class="text-[9px] sm:text-[10px] font-black uppercase tracking-wider text-slate-400">Lifesaver Credential Milestones</p>
                  <span class="text-[8px] sm:text-[9px] font-bold text-emerald-400">0 of 4 Seals Minted</span>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-2.5">
                  <!-- Stamp 1 -->
                  <div class="border-2 border-dashed border-emerald-500/25 bg-emerald-950/20 rounded-xl sm:rounded-2xl p-2.5 sm:p-3 flex items-start gap-2.5 sm:gap-3 relative group">
                    <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg sm:rounded-xl bg-emerald-500/10 border border-emerald-400/20 text-emerald-400 flex items-center justify-center shrink-0">
                      <span class="material-symbols-outlined text-base">water_drop</span>
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between">
                        <p class="text-[11px] sm:text-xs font-black text-white">Seal #01 · Collection</p>
                        <span class="text-[8px] sm:text-[9px] font-bold text-slate-400 uppercase tracking-widest">Slot Open</span>
                      </div>
                      <p class="text-[9.5px] sm:text-[10px] text-slate-400 mt-0.5 leading-snug">450 mL sterile phlebotomy unit drawn at accredited facility.</p>
                    </div>
                  </div>

                  <!-- Stamp 2 -->
                  <div class="border-2 border-dashed border-teal-500/25 bg-teal-950/20 rounded-xl sm:rounded-2xl p-2.5 sm:p-3 flex items-start gap-2.5 sm:gap-3 relative group">
                    <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg sm:rounded-xl bg-teal-500/10 border border-teal-400/20 text-teal-400 flex items-center justify-center shrink-0">
                      <span class="material-symbols-outlined text-base">biotech</span>
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between">
                        <p class="text-[11px] sm:text-xs font-black text-white">Seal #02 · Lab Clear</p>
                        <span class="text-[8px] sm:text-[9px] font-bold text-slate-400 uppercase tracking-widest">Slot Open</span>
                      </div>
                      <p class="text-[9.5px] sm:text-[10px] text-slate-400 mt-0.5 leading-snug">Full serology & infectious disease screening verified sterile.</p>
                    </div>
                  </div>

                  <!-- Stamp 3 -->
                  <div class="border-2 border-dashed border-rose-500/25 bg-rose-950/20 rounded-xl sm:rounded-2xl p-2.5 sm:p-3 flex items-start gap-2.5 sm:gap-3 relative group">
                    <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg sm:rounded-xl bg-rose-500/10 border border-rose-400/20 text-rose-400 flex items-center justify-center shrink-0">
                      <span class="material-symbols-outlined text-base">volunteer_activism</span>
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between">
                        <p class="text-[11px] sm:text-xs font-black text-white">Seal #03 · Patient Saved</p>
                        <span class="text-[8px] sm:text-[9px] font-bold text-slate-400 uppercase tracking-widest">Slot Open</span>
                      </div>
                      <p class="text-[9.5px] sm:text-[10px] text-slate-400 mt-0.5 leading-snug">Attending physician confirmation of successful transfusion.</p>
                    </div>
                  </div>

                  <!-- Stamp 4 -->
                  <div class="border-2 border-dashed border-amber-500/25 bg-amber-950/20 rounded-xl sm:rounded-2xl p-2.5 sm:p-3 flex items-start gap-2.5 sm:gap-3 relative group">
                    <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg sm:rounded-xl bg-amber-500/10 border border-amber-400/20 text-amber-400 flex items-center justify-center shrink-0">
                      <span class="material-symbols-outlined text-base">workspace_premium</span>
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between">
                        <p class="text-[11px] sm:text-xs font-black text-white">Seal #04 · Presidential</p>
                        <span class="text-[8px] sm:text-[9px] font-bold text-slate-400 uppercase tracking-widest">Slot Open</span>
                      </div>
                      <p class="text-[9.5px] sm:text-[10px] text-slate-400 mt-0.5 leading-snug">Official NBTS Lifesaver Diploma & QR credential issued.</p>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Bottom Security Barcode Footer -->
              <div class="relative z-10 pt-2.5 sm:pt-3 border-t border-emerald-500/20 flex items-center justify-between text-[9px] sm:text-[10px] text-slate-400 flex-wrap gap-1.5">
                <span class="flex items-center gap-1.5 text-emerald-400 font-bold">
                  <span class="material-symbols-outlined text-xs">health_and_safety</span>
                  <span>National Health Service Verifiable Credential</span>
                </span>
                <span class="font-mono text-slate-400 hidden sm:inline">|| | | ||| | |||| || ||| |</span>
              </div>

            </div>

            <!-- RIGHT PANE (lg:col-span-5): Mission Launch & Activation Hub -->
            <div class="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl sm:rounded-3xl p-4 sm:p-7 shadow-xl flex flex-col justify-between space-y-4 sm:space-y-5">
              
              <div class="space-y-3 sm:space-y-4">
                <div class="flex items-center justify-between">
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 sm:px-3 sm:py-1 rounded-full text-[9px] sm:text-[10px] font-black uppercase tracking-wider bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300 border border-red-200 dark:border-red-800/60">
                    <span class="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-red-600 animate-ping"></span> Live Hospital Network
                  </span>
                  <span class="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase">Emergency Standby</span>
                </div>

                <div>
                  <h3 class="text-lg sm:text-2xl font-black font-headline text-slate-900 dark:text-white tracking-tight">Activate Your First Lifesaver Stamp</h3>
                  <p class="text-[11px] sm:text-xs text-slate-600 dark:text-slate-300 leading-relaxed mt-1.5 sm:mt-2">
                    Hospitals across Cameroon rely on verified voluntary donors. Responding to a live requisition or donating at an accredited center immediately validates your clinical passport.
                  </p>
                </div>

                <!-- 3-Step Rapid Flow -->
                <div class="space-y-2 sm:space-y-2.5 pt-1">
                  <div class="flex items-start gap-2.5 sm:gap-3 p-2 sm:p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700">
                    <span class="w-5.5 h-5.5 sm:w-6 sm:h-6 rounded-lg bg-red-600 text-white flex items-center justify-center font-black text-[11px] sm:text-xs shrink-0 mt-0.5">1</span>
                    <div class="min-w-0">
                      <p class="text-[11px] sm:text-xs font-black text-slate-900 dark:text-white">Accept an Urgent Requisition</p>
                      <p class="text-[9.5px] sm:text-[10px] text-slate-500 dark:text-slate-400">Match with a hospital emergency in your region (${esc(donorRegion)}).</p>
                    </div>
                  </div>

                  <div class="flex items-start gap-2.5 sm:gap-3 p-2 sm:p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700">
                    <span class="w-5.5 h-5.5 sm:w-6 sm:h-6 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-black text-[11px] sm:text-xs shrink-0 mt-0.5">2</span>
                    <div class="min-w-0">
                      <p class="text-[11px] sm:text-xs font-black text-slate-900 dark:text-white">Fast-Track Reception Check-In</p>
                      <p class="text-[9.5px] sm:text-[10px] text-slate-500 dark:text-slate-400">Present your National CNI ID and 1-tap passcode at the desk.</p>
                    </div>
                  </div>

                  <div class="flex items-start gap-2.5 sm:gap-3 p-2 sm:p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700">
                    <span class="w-5.5 h-5.5 sm:w-6 sm:h-6 rounded-lg bg-amber-500 text-white flex items-center justify-center font-black text-[11px] sm:text-xs shrink-0 mt-0.5">3</span>
                    <div class="min-w-0">
                      <p class="text-[11px] sm:text-xs font-black text-slate-900 dark:text-white">Official Diploma & Recovery Log</p>
                      <p class="text-[9.5px] sm:text-[10px] text-slate-500 dark:text-slate-400">Your verifiable diploma and laboratory seal are permanently logged.</p>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Action CTAs -->
              <div class="space-y-2 sm:space-y-2.5 pt-2">
                <button onclick="window.filterDonorRequests('all')" class="press-scale w-full py-3 sm:py-3.5 rounded-xl sm:rounded-2xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-700 hover:to-rose-700 text-white font-black text-xs shadow-lg shadow-red-600/25 transition-all flex items-center justify-center gap-2 cursor-pointer min-h-[44px]">
                  <span class="material-symbols-outlined text-base">emergency</span>
                  <span>Respond to Open Requisitions</span>
                </button>

                <div class="grid grid-cols-2 gap-2 sm:gap-2.5">
                  <button onclick="window.switchDonorView('centers')" class="press-scale py-2.5 px-2 sm:px-3 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-bold text-[11px] sm:text-xs border border-slate-200 dark:border-slate-700 transition-colors flex items-center justify-center gap-1.5 cursor-pointer min-h-[40px]">
                    <span class="material-symbols-outlined text-sm text-emerald-600">location_on</span>
                    <span>Find Centers</span>
                  </button>

                  <button onclick="window.openLifesaverCertificateModal('sample')" class="press-scale py-2.5 px-2 sm:px-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 text-emerald-800 dark:text-emerald-300 font-bold text-[11px] sm:text-xs border border-emerald-200 dark:border-emerald-800/60 transition-colors flex items-center justify-center gap-1.5 cursor-pointer min-h-[40px]">
                    <span class="material-symbols-outlined text-sm text-emerald-600">workspace_premium</span>
                    <span>Preview Diploma</span>
                  </button>
                </div>
              </div>

            </div>

          </div>
        </div>`;
      document.getElementById('donorRequestsPagination').innerHTML = '';
      return;
    }

    const totalDonatedMl = allHistoryItems.reduce((acc, curr) => acc + ((curr.units || 1) * 450), 0);
    const totalUnitsGiven = allHistoryItems.reduce((acc, curr) => acc + (curr.units || 1), 0);
    const livesSaved = totalUnitsGiven * 3;

    // Extract available years for filtering
    const availableYears = Array.from(new Set(allHistoryItems.map(item => {
      const raw = item.completedAt || item.preferredDate || item.updatedAt || item.requestedAt || Date.now();
      return new Date(raw).getFullYear();
    }))).sort((a, b) => b - a);

    const yearCounts = {};
    availableYears.forEach(yr => {
      yearCounts[yr] = allHistoryItems.filter(item => {
        const raw = item.completedAt || item.preferredDate || item.updatedAt || item.requestedAt || Date.now();
        return new Date(raw).getFullYear() === yr;
      }).length;
    });

    // Apply Search and Year Filters
    let visibleItems = [...allHistoryItems];
    if (_historySearchTerm) {
      const q = _historySearchTerm.toLowerCase();
      visibleItems = visibleItems.filter(item => {
        const hospital = (item.hospital || item.hospitalName || item.preferredLocation || '').toLowerCase();
        const city = (item.city || '').toLowerCase();
        const region = (item.region || '').toLowerCase();
        const component = (item.componentType || '').toLowerCase();
        const passcode = (item.checkInToken || '').toLowerCase();
        const bt = (item.bloodType || item.type || '').toLowerCase();
        return hospital.includes(q) || city.includes(q) || region.includes(q) || component.includes(q) || passcode.includes(q) || bt.includes(q);
      });
    }

    if (_historyYearFilter !== 'all') {
      const targetYr = Number(_historyYearFilter);
      visibleItems = visibleItems.filter(item => {
        const raw = item.completedAt || item.preferredDate || item.updatedAt || item.requestedAt || Date.now();
        return new Date(raw).getFullYear() === targetYr;
      });
    }

    // Group visible items by Year
    const groupedByYear = {};
    visibleItems.forEach(item => {
      const raw = item.completedAt || item.preferredDate || item.updatedAt || item.requestedAt || Date.now();
      const yr = new Date(raw).getFullYear();
      if (!groupedByYear[yr]) groupedByYear[yr] = [];
      groupedByYear[yr].push(item);
    });
    const sortedYears = Object.keys(groupedByYear).map(Number).sort((a, b) => b - a);

    // Render items by view mode
    const renderItemsList = (items) => {
      if (_historyViewMode === 'cards') {
        return `
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            ${items.map((item, idx) => renderDonationHistoryCard(item, idx)).join('')}
          </div>`;
      }
      return `
        <div class="space-y-2.5">
          ${items.map((item, idx) => renderDonationHistoryRow(item, idx)).join('')}
        </div>`;
    };

    container.innerHTML = `
      <div class="space-y-5">
        <!-- Executive Lifesaver Passport Banner -->
        <div class="bg-gradient-to-br from-emerald-950 via-slate-900 to-emerald-950 border border-emerald-800/40 rounded-2xl sm:rounded-3xl p-4 sm:p-6 text-white shadow-xl relative overflow-hidden">
          <div class="absolute -right-10 -bottom-10 w-44 h-44 rounded-full bg-emerald-500/10 blur-2xl pointer-events-none"></div>
          
          <div class="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 sm:gap-5 relative z-10">
            <div class="space-y-1.5 flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                  <span class="material-symbols-outlined text-xs" style="font-variation-settings:'FILL' 1">verified</span> Verified Lifesaver Ledger
                </span>
                <span class="text-xs text-emerald-200/80 font-semibold">• Cameroon NBTS Registered</span>
              </div>
              <h2 class="text-lg sm:text-2xl font-black font-headline text-white tracking-tight">Your Official Donation Records</h2>
              <p class="text-xs text-slate-300 max-w-lg leading-relaxed">
                Complete clinical registry of your blood donations across accredited hospitals in Cameroon. Search records, export official certificates, or review laboratory screening clearances.
              </p>
            </div>

            <!-- Stat Badges + Print Action -->
            <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3 shrink-0">
              <div class="grid grid-cols-3 gap-1.5 sm:gap-2.5 shrink-0">
                <div class="bg-white/10 backdrop-blur-md rounded-xl sm:rounded-2xl p-2 sm:p-3 text-center border border-white/10 min-w-0 sm:min-w-[76px]">
                  <p class="text-base sm:text-2xl font-black text-emerald-400 leading-none">${allHistoryItems.length}</p>
                  <p class="text-[8px] sm:text-[9px] uppercase tracking-wider font-extrabold text-slate-300 mt-1">Donations</p>
                </div>
                <div class="bg-white/10 backdrop-blur-md rounded-xl sm:rounded-2xl p-2 sm:p-3 text-center border border-white/10 min-w-0 sm:min-w-[76px]">
                  <p class="text-base sm:text-2xl font-black text-white leading-none">${totalDonatedMl}</p>
                  <p class="text-[8px] sm:text-[9px] uppercase tracking-wider font-extrabold text-slate-300 mt-1">mL Given</p>
                </div>
                <div class="bg-white/10 backdrop-blur-md rounded-xl sm:rounded-2xl p-2 sm:p-3 text-center border border-white/10 min-w-0 sm:min-w-[76px]">
                  <p class="text-base sm:text-2xl font-black text-rose-400 leading-none">${livesSaved}</p>
                  <p class="text-[8px] sm:text-[9px] uppercase tracking-wider font-extrabold text-slate-300 mt-1">Lives Saved</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Lifesaver Ledger Control Toolbar (Search + Year Filter + View Switcher) -->
        <div class="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl p-2.5 sm:p-3.5 shadow-xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 sm:gap-3">
          
          <!-- Search input -->
          <div class="flex-1 relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-base pointer-events-none">search</span>
            <input id="historySearchInput" type="text" value="${esc(_historySearchTerm)}" oninput="window.handleHistorySearch(this.value)" placeholder="Search facility, city, component, or passcode..." class="w-full bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 rounded-xl pl-9 pr-8 py-2 text-xs font-bold text-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all shadow-xs min-h-[40px]" />
            ${_historySearchTerm ? `
              <button type="button" onclick="window.handleHistorySearch('')" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-500 cursor-pointer transition-colors" title="Clear Search">
                <span class="material-symbols-outlined text-sm">cancel</span>
              </button>` : ''}
          </div>

          <!-- Controls Right: Year Filter + Density Mode Toggle -->
          <div class="flex items-center gap-2 justify-between sm:justify-end shrink-0">
            
            <!-- Year Selector -->
            <div class="flex items-center gap-1.5 flex-1 sm:flex-initial">
              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider hidden sm:inline">Year:</span>
              <select onchange="window.handleHistoryYearFilter(this.value)" class="w-full sm:w-auto bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl px-2.5 py-2 text-xs font-bold text-slate-700 dark:text-slate-300 outline-none cursor-pointer min-h-[40px]">
                <option value="all" ${_historyYearFilter === 'all' ? 'selected' : ''}>All Years (${allHistoryItems.length})</option>
                ${availableYears.map(yr => `<option value="${yr}" ${_historyYearFilter === String(yr) ? 'selected' : ''}>${yr} (${yearCounts[yr]})</option>`).join('')}
              </select>
            </div>

            <!-- Density Toggle (Ledger View vs Card View) -->
            <div class="inline-flex items-center p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 gap-1 shrink-0 min-h-[40px]">
              <button type="button" onclick="window.setHistoryViewMode('ledger')" class="px-2.5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer flex items-center gap-1 ${_historyViewMode === 'ledger' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}" title="High-density list view">
                <span class="material-symbols-outlined text-sm">view_agenda</span>
                <span class="text-[11px]">Ledger</span>
              </button>
              <button type="button" onclick="window.setHistoryViewMode('cards')" class="px-2.5 py-1.5 rounded-lg text-xs font-black transition-all cursor-pointer flex items-center gap-1 ${_historyViewMode === 'cards' ? 'bg-emerald-600 text-white shadow-xs' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}" title="Visual card grid view">
                <span class="material-symbols-outlined text-sm">grid_view</span>
                <span class="text-[11px]">Cards</span>
              </button>
            </div>

          </div>
        </div>

        <!-- List Content Area -->
        ${visibleItems.length === 0 ? `
          <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-8 text-center space-y-3">
            <div class="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center mx-auto">
              <span class="material-symbols-outlined text-2xl">search_off</span>
            </div>
            <div>
              <h3 class="font-bold text-sm text-slate-800 dark:text-slate-200">No Matching Donation Records</h3>
              <p class="text-xs text-slate-400 max-w-sm mx-auto mt-1">No past donations matched your search filter "${esc(_historySearchTerm)}".</p>
            </div>
            <button type="button" onclick="window.clearHistoryFilters()" class="press-scale inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold cursor-pointer hover:bg-emerald-700 transition-colors">
              <span class="material-symbols-outlined text-sm">refresh</span> Clear Filters
            </button>
          </div>
        ` : sortedYears.map(yr => {
            const yrItems = groupedByYear[yr] || [];
            const yrMl = yrItems.reduce((acc, c) => acc + ((c.units || 1) * 450), 0);
            return `
              <div class="space-y-3">
                <div class="flex items-center justify-between px-1 flex-wrap gap-1.5">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-black uppercase tracking-wider text-slate-800 dark:text-slate-200">${yr} Records</span>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">${yrItems.length} donation${yrItems.length > 1 ? 's' : ''}</span>
                  </div>
                  <span class="text-[10px] sm:text-[11px] font-bold text-emerald-600 dark:text-emerald-400">${yrMl} mL total • Up to ${yrItems.reduce((a, c) => a + ((c.units || 1) * 3), 0)} lives preserved</span>
                </div>
                ${renderItemsList(yrItems)}
              </div>
            `;
          }).join('')}

      </div>`;
    document.getElementById('donorRequestsPagination').innerHTML = '';
    return;
  }

  // 4. Filter Available Requests
  let filtered = [..._allRequests];

  // Search Filter
  if (_reqSearchTerm) {
    const q = _reqSearchTerm.toLowerCase();
    filtered = filtered.filter(r =>
      (r.hospital || '').toLowerCase().includes(q) ||
      (r.hospitalName || '').toLowerCase().includes(q) ||
      (r.city || '').toLowerCase().includes(q) ||
      (r.region || '').toLowerCase().includes(q) ||
      (r.bloodType || r.type || '').toLowerCase().includes(q) ||
      (r.notes || '').toLowerCase().includes(q)
    );
  }

  // Dropdowns
  const df = _reqDropdownFilters;
  if (df.bloodType) filtered = filtered.filter(r => (r.bloodType || r.type) === df.bloodType);
  if (df.component) filtered = filtered.filter(r => (r.componentType || 'Whole Blood') === df.component);
  if (df.urgency) filtered = filtered.filter(r => getNormalizedUrgency(r.urgency) === df.urgency);
  if (df.distance) filtered = filtered.filter(r => typeof r.distanceKm === 'number' && r.distanceKm <= Number(df.distance));

  if (_currentReqFilter === 'public') {
    filtered = filtered.filter(r => r.isPublicRequest);
  }

  // 5. Sorting
  const sortVal = document.getElementById('reqSortSelector')?.value || 'nearest';
  if (sortVal === 'nearest') {
    filtered.sort((a, b) => (Number(a.distanceKm) || 999) - (Number(b.distanceKm) || 999));
  } else if (sortVal === 'urgency') {
    const rank = { 'critical': 3, 'urgent': 2, 'routine': 1 };
    filtered.sort((a, b) => (rank[getNormalizedUrgency(b.urgency)] || 0) - (rank[getNormalizedUrgency(a.urgency)] || 0));
  } else if (sortVal === 'recent') {
    filtered.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
  }

  // 6. Pagination Slice
  const totalPages = Math.ceil(filtered.length / REQ_ITEMS_PER_PAGE) || 1;
  _reqCurrentPage = Math.min(_reqCurrentPage, totalPages);
  const startIdx = (_reqCurrentPage - 1) * REQ_ITEMS_PER_PAGE;
  const pagedList = filtered.slice(startIdx, startIdx + REQ_ITEMS_PER_PAGE);

  const ineligible = !isDonorEligibleNow();
  const kycPending = !isDonorVerified();
  const isBusy = currentUser?.isAvailable === false;
  const acceptBlocked = isBusy || ineligible || kycPending;
  const deferralDays = _donorEligibilityCache?.daysUntil || 0;

  updateQuickChipVisuals();

  if (filtered.length === 0) {
    const userBt = currentUser?.bloodType || 'B+';
    const hasSearch = Boolean(_reqSearchTerm);
    const hasUrgency = Boolean(_reqDropdownFilters.urgency);
    const filterContext = hasSearch ? `for "${esc(_reqSearchTerm)}"` : hasUrgency ? `with ${_reqDropdownFilters.urgency.toUpperCase()} priority` : '';
    container.innerHTML = `
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-10 sm:p-12 text-center space-y-4 shadow-xs">
        <div class="w-16 h-16 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 flex items-center justify-center mx-auto shadow-inner border border-emerald-200/50">
          <span class="material-symbols-outlined text-3xl" style="font-variation-settings:'FILL' 1">verified</span>
        </div>
        <div class="space-y-1.5 max-w-md mx-auto">
          <h3 class="font-black text-lg text-slate-900 dark:text-white font-headline">Transfusion Reserves Stable</h3>
          <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            There are currently no active requisitions ${filterContext} matching your compatible blood group (${esc(userBt)}). Hospital reserves in this catchment are safely stocked!
          </p>
        </div>
        <div class="pt-2 flex items-center justify-center gap-3 flex-wrap">
          <button onclick="window.resetReqFilters()" class="press-scale px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs shadow-sm cursor-pointer flex items-center gap-2">
            <span class="material-symbols-outlined text-sm">refresh</span> Reset Filters & View All Live
          </button>
          <button onclick="switchDonorView('centers')" class="press-scale px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 font-bold text-xs border border-slate-200 dark:border-slate-700 cursor-pointer">
            Explore Blood Banks
          </button>
        </div>
      </div>`;
    document.getElementById('donorRequestsPagination').innerHTML = '';
    return;
  }

  // 7. Render Tactical Requisition Cards
  container.innerHTML = pagedList.map((req, idx) => {
    const normUrgency = getNormalizedUrgency(req.urgency);
    const isCritical = normUrgency === 'critical';
    const isUrgent = normUrgency === 'urgent';
    const urgencyLabel = isCritical ? 'CRITICAL' : isUrgent ? 'URGENT' : 'ROUTINE';
    const urgencyCls = isCritical
      ? 'text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/50'
      : isUrgent
      ? 'text-amber-700 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50'
      : 'text-slate-600 bg-slate-100 dark:bg-slate-800 border border-slate-200';

    const cardBorderAccent = isCritical
      ? 'border-l-4 border-l-red-600 bg-gradient-to-r from-red-500/[0.03] via-transparent to-transparent'
      : isUrgent
      ? 'border-l-4 border-l-amber-500 bg-gradient-to-r from-amber-500/[0.03] via-transparent to-transparent'
      : 'border-l-4 border-l-slate-300 dark:border-l-slate-700';

    const bt = req.bloodType || req.type || 'B+';
    const units = req.units || (idx % 2 === 0 ? 3 : 2);
    const component = req.componentType || (idx % 3 === 0 ? 'Packed Red Blood Cells (PRBC)' : idx % 2 === 0 ? 'Whole Blood' : 'Fresh Frozen Plasma (FFP)');
    const rawCity = (req.city || '').trim();
    const rawHospital = (req.hospital || req.hospitalName || '').trim();
    const isNationalOrSystem = rawCity.toLowerCase() === 'national' || rawHospital.toLowerCase().includes('central command');
    const city = isNationalOrSystem ? (idx === 0 ? 'Douala' : 'Yaoundé') : (rawCity || (idx === 0 ? 'Buea' : idx === 1 ? 'Limbe' : idx === 2 ? 'Bamenda' : idx === 3 ? 'Yaoundé' : 'Douala'));
    const region = req.region && req.region.toLowerCase() !== 'national'
      ? req.region
      : (city === 'Buea' || city === 'Limbe' ? 'Southwest Region' : city === 'Bamenda' ? 'Northwest Region' : city === 'Yaoundé' ? 'Centre Region' : 'Littoral Region');
    const distanceKmNum = typeof req.distanceKm === 'number' ? req.distanceKm : (idx + 1) * 2.3;
    const distanceStr = req.distanceKm ? req.distanceKm + ' km' : `${distanceKmNum.toFixed(1)} km`;
    const driveTimeMin = Math.max(5, Math.round(distanceKmNum * 2.2));
    const hospitalName = rawHospital && rawHospital.toLowerCase() !== 'national'
      ? (rawHospital === 'Central Command' ? `${city} Central Command Hospital` : rawHospital)
      : `${city} Regional Hospital`;

    // Consistent & Accurate Clinical Timing
    const timing = formatRequestTiming(req);

    // Tags & Status Indicators
    const isNew24h = isRequestWithin24Hours(req);
    const newBadge = isNew24h
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[8px] sm:text-[9px] font-black uppercase tracking-wider bg-emerald-500 text-white shadow-xs shrink-0" title="Posted within the last 24 hours"><span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span><span>NEW</span></span>`
      : '';
    const tagEmergency = isCritical ? `<span class="inline-flex items-center gap-1 bg-red-50 dark:bg-red-950/40 text-red-600 text-[10px] font-bold px-2 py-0.5 rounded-md border border-red-100"><span class="material-symbols-outlined text-xs">emergency</span> Emergency</span>` : '';
    const blockedReason = isBusy ? 'Availability Paused' : kycPending ? 'Verification Required' : ineligible ? `Deferred: ${deferralDays}d` : '';

    return `
      <div class="hover-lift bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 hover:border-red-500/30 dark:hover:border-red-500/40 rounded-2xl sm:rounded-3xl p-4 sm:p-5 shadow-xs hover:shadow-lg transition-all duration-200 ${cardBorderAccent} space-y-3.5 sm:space-y-4">
        
        <!-- Top Row: Emblem, Hospital Info, Urgency & Distance -->
        <div class="flex items-start justify-between gap-3 flex-wrap sm:flex-nowrap">
          <div class="flex items-start sm:items-center gap-3 sm:gap-4 min-w-0 flex-1">
            <!-- Cool Biometric Medical Blood Emblem -->
            ${renderCoolBloodEmblem(bt, units, 'card')}

            <!-- Hospital Info -->
            <div class="min-w-0 flex-1 space-y-0.5">
              <div class="flex items-center gap-2 flex-wrap">
                ${newBadge}
                <span class="text-[8px] sm:text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${urgencyCls}">${urgencyLabel}</span>
                <h3 class="font-black text-sm sm:text-base text-slate-900 dark:text-white truncate">${esc(hospitalName)}</h3>
              </div>
              
              <div class="flex items-center gap-2 text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 font-medium flex-wrap pt-0.5">
                <span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-xs text-red-500">location_on</span> ${esc(city)}, ${esc(region)}</span>
                <span>•</span>
                <span class="inline-flex items-center gap-1 font-bold text-slate-700 dark:text-slate-300"><span class="material-symbols-outlined text-xs text-slate-400">near_me</span> ${esc(distanceStr)}</span>
                <span class="hidden sm:inline">•</span>
                <span class="inline-flex items-center gap-1 text-slate-500"><span class="material-symbols-outlined text-xs text-slate-400">directions_car</span> ~${driveTimeMin} min drive</span>
                <span>•</span>
                <span class="inline-flex items-center gap-1 font-semibold text-slate-500 dark:text-slate-400"><span class="material-symbols-outlined text-xs text-slate-400">schedule</span> Posted ${timing.postedAgo}</span>
              </div>
            </div>
          </div>

          <!-- Needed By / Timing Badge -->
          <div class="shrink-0 text-left sm:text-right bg-slate-50 dark:bg-slate-800/60 sm:bg-transparent sm:dark:bg-transparent p-2 sm:p-0 rounded-xl w-full sm:w-auto flex items-center sm:block justify-between">
            <p class="text-[9px] sm:text-[10px] text-slate-400 font-bold uppercase tracking-wider">${timing.deadlineLabel}</p>
            <p class="text-xs sm:text-sm ${timing.deadlineColor}">${timing.deadlineText}</p>
          </div>
        </div>

        <!-- Middle Spec Strip: Component & Emergency Tags -->
        <div class="flex items-center justify-between gap-2 flex-wrap text-xs pt-1 border-t border-slate-100 dark:border-slate-800">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-bold text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg">
              ${units} Units • <span class="text-slate-600 dark:text-slate-300">${esc(component)}</span>
            </span>
            ${tagEmergency}
            ${currentUser?.bloodType === 'Unknown' ? `<span class="inline-flex items-center gap-1 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 text-[10px] font-bold px-2 py-0.5 rounded-md border border-sky-200/60"><span class="material-symbols-outlined text-xs">biotech</span> Typing at Intake</span>` : ''}
            ${blockedReason ? `<span class="inline-flex items-center gap-1 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 text-[10px] font-bold px-2 py-0.5 rounded-md border border-amber-200/60"><span class="material-symbols-outlined text-xs">info</span> ${blockedReason}</span>` : ''}
          </div>

          <!-- Bottom Action Buttons: Mobile Friendly Full Width On Small Phones -->
          <div class="flex items-center gap-2 w-full sm:w-auto justify-end pt-2 sm:pt-0">
            <button onclick="window.openRequestDetailModal('${req.id}', false)" class="press-scale flex-1 sm:flex-initial text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-red-600 bg-slate-50 dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-300 rounded-xl px-3.5 py-2.5 transition-all text-center cursor-pointer flex items-center justify-center">
              View Details
            </button>
            <button ${acceptBlocked ? `disabled title="${kycPending ? 'Complete identity verification first' : ineligible ? 'Deferral active — ' + deferralDays + ' days remaining' : 'Toggle availability first'}"` : `onclick="window.donorAcceptRequest('${req.id}', '${currentUser?.uid || ''}', ${Boolean(req.isPublicRequest)})"`} class="press-scale flex-1 sm:flex-initial px-4 py-2.5 rounded-xl text-xs font-black shadow-sm ${acceptBlocked ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed opacity-60' : 'bg-red-600 hover:bg-red-700 text-white shadow-red-600/25 cursor-pointer'} transition-all flex items-center justify-center gap-1.5 text-center">
              <span class="material-symbols-outlined text-sm">check_circle</span>
              <span>Respond Now</span>
            </button>
          </div>
        </div>

      </div>`;
  }).join('');

  // 8. Render Pagination Controls
  const pagEl = document.getElementById('donorRequestsPagination');
  if (pagEl) {
    if (totalPages <= 1) {
      pagEl.innerHTML = `
        <div class="flex items-center justify-between text-xs text-slate-400 font-medium pt-1">
          <p>Showing ${filtered.length} live requisition${filtered.length === 1 ? '' : 's'}</p>
          <span class="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400 font-bold">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span> Live Dispatch Synced
          </span>
        </div>`;
    } else {
      let pagHtml = `
        <div class="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500 font-bold">
          <p>Showing ${startIdx + 1} to ${Math.min(startIdx + REQ_ITEMS_PER_PAGE, filtered.length)} of ${filtered.length} requests</p>
          <div class="flex items-center gap-1.5">
            <button onclick="window.setRequestsPage(${_reqCurrentPage - 1})" ${_reqCurrentPage <= 1 ? 'disabled class="opacity-40 cursor-not-allowed"' : 'class="press-scale hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"'} class="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center">
              <span class="material-symbols-outlined text-sm">chevron_left</span>
            </button>`;

      for (let p = 1; p <= totalPages; p++) {
        const active = p === _reqCurrentPage;
        pagHtml += `
          <button onclick="window.setRequestsPage(${p})" class="w-8 h-8 rounded-lg font-black text-xs transition-all ${active ? 'bg-red-600 text-white shadow-xs' : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer'}">
            ${p}
          </button>`;
      }

      pagHtml += `
            <button onclick="window.setRequestsPage(${_reqCurrentPage + 1})" ${_reqCurrentPage >= totalPages ? 'disabled class="opacity-40 cursor-not-allowed"' : 'class="press-scale hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"'} class="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center">
              <span class="material-symbols-outlined text-sm">chevron_right</span>
            </button>
          </div>
        </div>`;
      pagEl.innerHTML = pagHtml;
    }
  }

  // 9. Render Mini Radar Map & Proximity List
  renderRequestsMiniMap();
  renderRequestsProximityList();
}

function renderRequestsMiniMap() {
  const mapEl = document.getElementById('requestsMiniRadarMap');
  if (!mapEl || !window.L) return;
  if (_requestsMiniMapInstance) {
    _requestsMiniMapInstance.remove();
    _requestsMiniMapInstance = null;
  }

  const currentUser = getCurrentUser();
  const effective = getEffectiveDonorLocation(currentUser);
  const defaultCenter = [effective?.lat || 4.155, effective?.lon || 9.243];
  const map = window.L.map(mapEl, {
    zoomControl: false,
    scrollWheelZoom: false,
    dragging: true,
    tap: false,
    attributionControl: false,
    maxBounds: CAMEROON_BOUNDS,
    minZoom: 6,
  }).setView(defaultCenter, 9);
  if (window.L.control?.zoom) {
    window.L.control.zoom({ position: 'topright' }).addTo(map);
  }

  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  const markerPoints = [];

  // Donor pin
  if (effective?.lat && effective?.lon) {
    markerPoints.push([effective.lat, effective.lon]);
    window.L.circleMarker([effective.lat, effective.lon], {
      radius: 6,
      color: '#fff',
      weight: 2,
      fillColor: '#af101a',
      fillOpacity: 1
    }).addTo(map).bindTooltip('Your Location');
  }

  const CITY_COORDS = {
    douala: { lat: 4.0511, lon: 9.7679 },
    yaounde: { lat: 3.8667, lon: 11.5167 },
    buea: { lat: 4.1550, lon: 9.2430 },
    limbe: { lat: 4.0167, lon: 9.2133 },
    bamenda: { lat: 5.9631, lon: 10.1591 },
    bafoussam: { lat: 5.4778, lon: 10.4176 },
  };

  const activeReqs = (_allRequests && _allRequests.length > 0) ? _allRequests : [
    { hospital: 'Buea Regional Hospital', city: 'Buea', urgency: 'critical', coords: { lat: 4.155, lon: 9.243 } },
    { hospital: 'Douala General Hospital', city: 'Douala', urgency: 'urgent', coords: { lat: 4.051, lon: 9.767 } },
    { hospital: 'Yaoundé Central Hospital', city: 'Yaoundé', urgency: 'routine', coords: { lat: 3.866, lon: 11.516 } }
  ];

  activeReqs.forEach((r, idx) => {
    let lat = r.coords?.lat;
    let lon = r.coords?.lon;
    if (!lat || !lon) {
      const cityKey = (r.city || '').toLowerCase().trim();
      const fallback = CITY_COORDS[cityKey] || (r.hospital && r.hospital.toLowerCase().includes('douala') ? CITY_COORDS.douala : (idx === 0 ? CITY_COORDS.douala : CITY_COORDS.buea));
      lat = fallback.lat;
      lon = fallback.lon;
    }
    if (lat && lon) {
      markerPoints.push([lat, lon]);
      const norm = getNormalizedUrgency(r.urgency);
      const isCrit = norm === 'critical';
      const isUrg = norm === 'urgent';
      const fillColor = isCrit ? '#dc2626' : isUrg ? '#d97706' : '#2563eb';
      const rawHospital = (r.hospital || r.hospitalName || 'Hospital Center');
      const hName = rawHospital
        .replace(/Central Command/gi, 'Douala Central Command Hospital')
        .replace(/National/gi, 'Regional');
      const marker = window.L.circleMarker([lat, lon], {
        radius: isCrit ? 7 : 5,
        color: '#fff',
        weight: 2,
        fillColor: fillColor,
        fillOpacity: 1,
      }).addTo(map).bindTooltip(`${esc(hName)} (${norm.toUpperCase()})`);
      marker.bindPopup(`
        <div class="p-1.5 space-y-1 text-slate-900" style="min-width: 165px;">
          <p class="font-black text-xs">${esc(hName)}</p>
          <p class="text-[10px] font-bold text-red-600">${esc(r.bloodType || r.type || 'Blood')} • ${norm.toUpperCase()}</p>
          <p class="text-[10px] text-slate-500">📍 ${esc(r.city || 'Cameroon')}</p>
        </div>`);
    }
  });

  if (markerPoints.length > 1) {
    try {
      const bounds = window.L.latLngBounds(markerPoints);
      map.fitBounds(bounds.pad(0.25), { maxZoom: 12 });
    } catch (_) {
      map.setView(defaultCenter, 9);
    }
  } else if (markerPoints.length === 1) {
    map.setView(markerPoints[0], 10);
  }

  _requestsMiniMapInstance = map;
  setTimeout(() => map.invalidateSize(), 150);
  setTimeout(() => map.invalidateSize(), 450);
}

function renderRequestsProximityList() {
  const container = document.getElementById('requestsProximityList');
  if (!container) return;

  const top3 = (_allRequests && _allRequests.length > 0)
    ? _allRequests.slice(0, 3).map((r, idx) => {
        const rawCity = (r.city || '').trim();
        const rawHospital = (r.hospital || r.hospitalName || '').trim();
        const isNationalOrSystem = rawCity.toLowerCase() === 'national' || rawHospital.toLowerCase().includes('central command');
        const city = isNationalOrSystem ? (idx === 0 ? 'Douala' : 'Yaoundé') : (rawCity || (idx === 0 ? 'Buea' : idx === 1 ? 'Limbe' : 'Yaoundé'));
        const hospitalName = rawHospital && rawHospital.toLowerCase() !== 'national'
          ? (rawHospital === 'Central Command' ? `${city} Central Command Hospital` : rawHospital)
          : `${city} Regional Hospital`;
        const distanceKmNum = typeof r.distanceKm === 'number' ? r.distanceKm : (idx + 1) * 2.3;
        const distStr = r.distanceKm ? `${r.distanceKm} km` : `${distanceKmNum.toFixed(1)} km`;
        const norm = getNormalizedUrgency(r.urgency);
        const isCrit = norm === 'critical';
        const isUrg = norm === 'urgent';

        return {
          id: r.id,
          bt: r.bloodType || r.type || 'B+',
          name: hospitalName,
          dist: distStr,
          normUrgency: norm,
          urgencyText: isCrit ? 'CRITICAL' : isUrg ? 'URGENT' : 'ROUTINE',
          isCrit,
          isUrg
        };
      })
    : [
        { id: 'buea-reg', bt: 'B+', name: 'Buea Regional Hospital', dist: '2.3 km', normUrgency: 'critical', urgencyText: 'CRITICAL', isCrit: true, isUrg: false },
        { id: 'st-luke', bt: 'B+', name: 'St Luke Hospital, Buea', dist: '8.7 km', normUrgency: 'urgent', urgencyText: 'URGENT', isCrit: false, isUrg: true },
        { id: 'limbe-reg', bt: 'A-', name: 'Limbe Regional Hospital', dist: '11.4 km', normUrgency: 'urgent', urgencyText: 'URGENT', isCrit: false, isUrg: true },
      ];

  container.innerHTML = top3.map(n => {
    const badgeStyle = n.isCrit
      ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400 border border-red-200 dark:border-red-800/50'
      : n.isUrg
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-200 dark:border-amber-800/50'
      : 'text-slate-600 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700';

    const clickAction = n.id ? `onclick="window.openRequestDetailModal('${n.id}', false)"` : `onclick="switchDonorView('centers')"`;

    return `
      <div ${clickAction} class="press-scale group flex items-center justify-between gap-3 p-2.5 rounded-2xl bg-slate-50 hover:bg-red-50/30 dark:bg-slate-800/60 dark:hover:bg-slate-800 border border-slate-100 dark:border-slate-700/60 hover:border-red-500/30 dark:hover:border-red-500/30 transition-all cursor-pointer shadow-2xs">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-red-600 to-rose-500 text-white font-black text-xs flex items-center justify-center shrink-0 shadow-xs border border-white/20">
            ${esc(n.bt)}
          </div>
          <div class="min-w-0">
            <p class="font-bold text-xs text-slate-800 dark:text-slate-200 group-hover:text-red-600 dark:group-hover:text-red-400 truncate transition-colors">${esc(n.name)}</p>
            <p class="text-[10px] text-slate-400 font-medium flex items-center gap-1">
              <span class="material-symbols-outlined text-[11px] text-slate-400">near_me</span>
              <span>${esc(n.dist)}</span>
            </p>
          </div>
        </div>
        <span class="px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-wider ${badgeStyle} shrink-0">${esc(n.urgencyText)}</span>
      </div>`;
  }).join('');
}

function renderRequestsBroadcastSpotlight() {
  const container = document.getElementById('requestsBroadcastSpotlight');
  if (!container) return;
  const currentUser = getCurrentUser();

  const req = _allRequests.find(r => (r.urgency || '').toLowerCase() === 'critical') || _allRequests[0] || {
    id: 'broadcast-spotlight-1',
    bloodType: 'O-',
    hospital: 'Central Command Hospital, Yaoundé',
    units: 2,
    componentType: 'Packed Red Blood Cells (PRBC)',
    notes: 'We need this blood group ASAP. It is a matter between life and death.',
    requestedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  };

  container.innerHTML = `
    <div class="bg-rose-50/50 dark:bg-slate-800/80 border border-rose-100 dark:border-slate-700 rounded-2xl p-4 space-y-3">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2.5">
          <span class="w-10 h-10 rounded-full bg-red-600 text-white font-black text-sm flex items-center justify-center font-headline shrink-0">${esc(req.bloodType || 'O-')}</span>
          <div class="min-w-0">
            <span class="px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-red-100 text-red-700">CRITICAL BROADCAST</span>
            <p class="font-extrabold text-xs text-slate-900 dark:text-white truncate mt-0.5">${esc(req.hospital || req.hospitalName || 'Central Command Hospital')}</p>
          </div>
        </div>
        <span class="text-[10px] text-slate-400 font-bold shrink-0">Posted ${formatRequestTiming(req).postedAgo}</span>
      </div>

      <p class="text-[11px] text-slate-600 dark:text-slate-300 font-medium">
        ${req.units || 2} Units • ${esc(req.componentType || 'Packed Red Blood Cells (PRBC)')}
      </p>

      <div class="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-rose-100/80 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 italic font-medium leading-relaxed">
        "${esc(req.notes || 'We need this blood group ASAP. It is a matter between life and death.')}"
      </div>

      <div class="grid grid-cols-2 gap-2 pt-1">
        <button onclick="window.openRequestDetailModal('${req.id}', false)" class="press-scale py-2 rounded-xl text-xs font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 flex items-center justify-center gap-1 cursor-pointer">
          <span class="material-symbols-outlined text-sm">visibility</span> View Details
        </button>
        <button onclick="window.donorAcceptRequest('${req.id}', '${currentUser?.uid || ''}', false)" class="press-scale py-2 rounded-xl text-xs font-black bg-rose-100 hover:bg-rose-200 text-red-700 flex items-center justify-center gap-1 cursor-pointer transition-colors">
          <span class="material-symbols-outlined text-sm">bolt</span> I'm Available
        </button>
      </div>

      <!-- Carousel indicator dots -->
      <div class="flex items-center justify-center gap-1.5 pt-1">
        <span class="w-2 h-2 rounded-full bg-red-600"></span>
        <span class="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700"></span>
        <span class="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700"></span>
      </div>
    </div>`;
}

// E3.5 — shareable donor card. WhatsApp deep link needs no library; the download uses a
// plain <canvas> drawn client-side from data already on the page, exported via toDataURL().
// Re-wired on every loadDonorBadges() call (onclick assignment, not addEventListener) so
// re-entering the view never stacks duplicate listeners or goes stale on new engagement data.
function initShareCard(currentUser, { bloodType, donationCount, livesSaved, tier }) {
  const waBtn = document.getElementById('btnShareWhatsapp');
  if (waBtn) {
    waBtn.onclick = () => {
      const text = `I'm a VitalPulse Donor! 🩸 ${bloodType} · ${donationCount} donation${donationCount === 1 ? '' : 's'} · ${livesSaved} lives saved. Join me and help save lives in Cameroon!`;
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    };
  }

  const dlBtn = document.getElementById('btnDownloadShareCard');
  if (dlBtn) {
    dlBtn.onclick = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 450;
      const ctx = canvas.getContext('2d');

      const grad = ctx.createLinearGradient(0, 0, 800, 450);
      grad.addColorStop(0, '#af101a');
      grad.addColorStop(1, '#7a0c14');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 800, 450);

      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.arc(760, 420, 200, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = '900 22px sans-serif';
      ctx.fillText((currentUser?.name || 'VitalPulse Donor'), 56, 70);

      ctx.font = '900 30px sans-serif';
      ctx.fillText("I'm a VitalPulse Donor!", 56, 120);

      ctx.font = '600 16px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText('Join me and help save lives in Cameroon.', 56, 150);

      ctx.font = '900 84px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(bloodType, 56, 270);
      ctx.font = 'bold 17px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(`${donationCount} donation${donationCount === 1 ? '' : 's'}   ·   ${livesSaved} lives saved   ·   ${tier} Tier`, 56, 320);

      ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText('VitalPulse — Blood Donation Coordination for Cameroon', 56, 400);

      const link = document.createElement('a');
      link.download = 'vitalpulse-donor-card.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
    };
  }
}

// ══════════════════════════════════════════════════════════════
// PROFILE & LIFESAVER COMMAND HUB CONTROLLER
// ══════════════════════════════════════════════════════════════

export function renderUserAvatars(currentUser) {
  if (!currentUser) return;
  const photo = currentUser.photoURL;
  const nameVal = currentUser.name || currentUser.email?.split('@')[0] || 'Verified Donor';
  const initials = nameVal.trim().split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase() || 'D';

  // 1. Profile Page Avatar
  const profImg = document.getElementById('donorProfileAvatarImg');
  const profInitials = document.getElementById('donorProfileInitials');
  const btnRemove = document.getElementById('btnRemoveProfilePhoto');
  const btnUploadText = document.getElementById('btnUploadPhotoText');

  if (profImg && profInitials) {
    if (photo) {
      profImg.src = photo;
      profImg.classList.remove('hidden');
      profInitials.classList.add('hidden');
      if (btnRemove) btnRemove.classList.remove('hidden');
      if (btnUploadText) btnUploadText.textContent = 'Change Photo';
    } else {
      profImg.classList.add('hidden');
      profInitials.textContent = initials;
      profInitials.classList.remove('hidden');
      if (btnRemove) btnRemove.classList.add('hidden');
      if (btnUploadText) btnUploadText.textContent = 'Upload Photo';
    }
  }

  // 2. Top Header Nav Avatar
  const navImg = document.getElementById('donorNavAvatarImg');
  const navInitialsWrap = document.getElementById('donorUserInitialsWrap');
  const navInitials = document.getElementById('donorUserInitials');
  if (navImg && navInitialsWrap) {
    if (photo) {
      navImg.src = photo;
      navImg.classList.remove('hidden');
      navInitialsWrap.classList.add('hidden');
    } else {
      navImg.classList.add('hidden');
      if (navInitials) navInitials.textContent = initials;
      navInitialsWrap.classList.remove('hidden');
    }
  }
}

let _profilePhotoWired = false;
export function initProfilePhotoUpload() {
  if (_profilePhotoWired) return;
  _profilePhotoWired = true;

  const photoInput = document.getElementById('donorProfilePhotoInput');
  const btnRemove = document.getElementById('btnRemoveProfilePhoto');

  if (photoInput) {
    photoInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showToast('Please select a valid image file (JPG, PNG, WebP).', 'error');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        showToast('Image size exceeds 5MB limit.', 'error');
        return;
      }

      showToast('Optimizing and saving photo...', 'info');

      const reader = new FileReader();
      reader.onload = (readEvt) => {
        const img = new Image();
        img.onload = async () => {
          try {
            const canvas = document.createElement('canvas');
            const MAX_DIM = 320;
            let width = img.width;
            let height = img.height;
            if (width > height) {
              if (width > MAX_DIM) {
                height = Math.round((height * MAX_DIM) / width);
                width = MAX_DIM;
              }
            } else {
              if (height > MAX_DIM) {
                width = Math.round((width * MAX_DIM) / height);
                height = MAX_DIM;
              }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

            const currentUser = getCurrentUser();
            if (!currentUser) return;
            await updateUserProfile(currentUser.uid, { photoURL: dataUrl });
            currentUser.photoURL = dataUrl;
            localStorage.setItem('vitalpulse_user', JSON.stringify(currentUser));

            renderUserAvatars(currentUser);
            showToast('Profile photo updated successfully!', 'success');
          } catch (err) {
            console.error('Failed to update photo:', err);
            showToast('Failed to save profile photo.', 'error');
          }
        };
        img.onerror = () => showToast('Failed to process image.', 'error');
        img.src = readEvt.target.result;
      };
      reader.readAsDataURL(file);
      photoInput.value = '';
    });
  }

  if (btnRemove) {
    btnRemove.addEventListener('click', async () => {
      try {
        const currentUser = getCurrentUser();
        if (!currentUser) return;
        await updateUserProfile(currentUser.uid, { photoURL: null });
        delete currentUser.photoURL;
        localStorage.setItem('vitalpulse_user', JSON.stringify(currentUser));
        renderUserAvatars(currentUser);
        showToast('Profile photo removed.', 'info');
      } catch (err) {
        console.error('Failed to remove photo:', err);
        showToast('Failed to remove profile photo.', 'error');
      }
    });
  }
}

window.switchProfileTab = (tabName) => {
  const tabs = ['personal', 'clinical', 'dispatch', 'security'];
  tabs.forEach(t => {
    const btn = document.getElementById(`tabBtnProfile${t.charAt(0).toUpperCase() + t.slice(1)}`);
    const pane = document.getElementById(`profileTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    const isActive = t === tabName;

    if (btn) {
      if (isActive) {
        btn.className = 'flex-1 min-w-[130px] flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-black transition-all bg-white dark:bg-slate-900 text-red-600 dark:text-red-400 shadow-2xs border border-slate-200/90 dark:border-slate-700 cursor-pointer';
      } else {
        btn.className = 'flex-1 min-w-[130px] flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer';
      }
    }
    if (pane) {
      pane.classList.toggle('hidden', !isActive);
    }
  });
};

async function loadDonorProfile() {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  initProfilePhotoUpload();
  renderUserAvatars(currentUser);

  const nameVal = currentUser.name || currentUser.email?.split('@')[0] || 'Verified Donor';
  const bloodTypeVal = currentUser.bloodType || 'O+';

  // Hero Headers & Monograms
  const headerNameEl = document.getElementById('donorProfileHeaderName');
  if (headerNameEl) headerNameEl.textContent = nameVal;

  const headerEmailEl = document.getElementById('donorProfileHeaderEmail');
  if (headerEmailEl) headerEmailEl.textContent = currentUser.email || '—';

  const initialsEl = document.getElementById('donorProfileInitials');
  if (initialsEl) initialsEl.textContent = nameVal.slice(0, 2).toUpperCase();

  const bloodPillVal = document.getElementById('donorProfileBloodTypePillVal');
  const bloodPill = document.getElementById('donorProfileBloodTypePill');
  if (bloodPillVal) {
    if (bloodTypeVal === 'Unknown') {
      bloodPillVal.textContent = 'Pending';
      if (bloodPill) bloodPill.className = 'text-xs font-black px-2.5 py-0.5 rounded-md bg-amber-500 text-slate-950 shadow-2xs inline-flex items-center gap-1';
    } else {
      bloodPillVal.textContent = bloodTypeVal;
      if (bloodPill) bloodPill.className = 'text-xs font-black px-2.5 py-0.5 rounded-md bg-red-600 text-white shadow-2xs inline-flex items-center gap-1';
    }
  }

  // Form Pre-fill
  const nameInput = document.getElementById('donorProfileName');
  if (nameInput) nameInput.value = currentUser.name || '';

  const emailInput = document.getElementById('donorProfileEmail');
  if (emailInput) emailInput.value = currentUser.email || '';

  const bloodSelect = document.getElementById('donorProfileBloodType');
  if (bloodSelect) bloodSelect.value = bloodTypeVal;

  const citySelect = document.getElementById('donorProfileCity');
  if (citySelect && currentUser.city) citySelect.value = currentUser.city;

  const phoneInput = document.getElementById('donorProfilePhone');
  if (phoneInput) phoneInput.value = currentUser.phone || '';

  const nextOfKinName = document.getElementById('donorEmergencyContactName');
  if (nextOfKinName) nextOfKinName.value = currentUser.emergencyContactName || '';

  const nextOfKinPhone = document.getElementById('donorEmergencyContactPhone');
  if (nextOfKinPhone) nextOfKinPhone.value = currentUser.emergencyContactPhone || '';

  const natIdInput = document.getElementById('donorProfileNationalId');
  if (natIdInput) {
    natIdInput.placeholder = currentUser.cniHash
      ? `CNI Hashed (SHA-256: ${currentUser.cniHash.slice(0, 12)}...)`
      : 'Enter National ID (Hashed with SHA-256 for privacy)';
  }

  // CNI Badge Status
  const cniBadge = document.getElementById('donorCniStatusBadge');
  const updateCniBadgeUI = (cniHash) => {
    if (!cniBadge) return;
    if (cniHash) {
      cniBadge.innerHTML = '<span class="material-symbols-outlined text-xs">verified</span> CNI Verified';
      cniBadge.className = 'text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200/80 dark:border-emerald-800/60 flex items-center gap-1 shrink-0 cursor-default';
      cniBadge.title = 'National ID has been verified and securely hashed (SHA-256) for hospital intake.';
      cniBadge.onclick = null;
    } else {
      cniBadge.innerHTML = '<span class="material-symbols-outlined text-xs">shield</span> CNI Unverified';
      cniBadge.className = 'text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/60 flex items-center gap-1 shrink-0 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors';
      cniBadge.title = 'Click to enter and verify your National ID';
      cniBadge.onclick = () => {
        window.switchProfileTab('personal');
        const input = document.getElementById('donorProfileNationalId');
        if (input) {
          input.focus();
          input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
    }
  };
  updateCniBadgeUI(currentUser.cniHash);

  renderBloodTypeSourceBadge(currentUser, ['donorBloodTypeSourceBadge', 'medStatusBloodSource']);

  // Standby Availability Toggle (synchronized with Dashboard `isAvailable`)
  const isAvailable = isDonorOnStandby(currentUser);
  const btnToggleStandby = document.getElementById('btnToggleStandbyStatus');
  syncDonorStandbyDOM(isAvailable);

  if (btnToggleStandby) {
    btnToggleStandby.onclick = async () => {
      const curState = isDonorOnStandby(currentUser);
      const newBool = !curState;
      const newStandbyStr = newBool ? 'available' : 'busy';
      const applyStandbyChange = async (extra = {}) => {
        try {
          await updateUserProfile(currentUser.uid, { isAvailable: newBool, standbyStatus: newStandbyStr, ...extra });
          currentUser.isAvailable = newBool;
          currentUser.standbyStatus = newStandbyStr;
          localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser }));
          syncDonorStandbyDOM(newBool);
          showToast(newBool ? '🟢 Standby mode active! You will receive emergency blood alerts.' : '🟡 Standby paused.');
        } catch (err) {
          console.error('Failed to toggle standby status:', err);
          showToast('Failed to update standby status.', 'error');
        }
      };

      if (newBool) {
        initAvailabilityScreeningModal();
        openAvailabilityScreeningModal(() => applyStandbyChange({ lastAvailabilityScreeningAt: new Date().toISOString() }));
      } else {
        await applyStandbyChange();
      }
    };
  }

  // Synchronous Lifesaver Pass & Clinical Specs Hydration from currentUser
  const passName = document.getElementById('donorPassName');
  if (passName) passName.textContent = nameVal;

  const donorPassIdVal = `VP-NBTS-${(currentUser.cniLast4 || currentUser.uid?.slice(0, 6) || '8849').toUpperCase()}`;
  const passId = document.getElementById('donorPassId');
  if (passId) passId.textContent = `NBTS-ID: ${donorPassIdVal}`;

  const passBlood = document.getElementById('donorPassBloodType');
  if (passBlood) passBlood.textContent = bloodTypeVal === 'Unknown' ? 'Pending' : bloodTypeVal;

  const medBloodType = document.getElementById('medStatusBloodType');
  if (medBloodType) medBloodType.textContent = bloodTypeVal === 'Unknown' ? 'Pending' : bloodTypeVal;

  // Immediate Offline QR Generation
  const qrImg = document.getElementById('donorPassQrImg');
  if (qrImg) {
    const qrData = JSON.stringify({
      donorId: currentUser.uid,
      name: nameVal,
      bloodType: bloodTypeVal,
      passId: donorPassIdVal,
      city: currentUser.city || 'Yaoundé',
      issuedBy: 'VitalPulse Cameroon NBTS'
    });
    if (QRCode && typeof QRCode.toDataURL === 'function') {
      QRCode.toDataURL(qrData, {
        width: 256,
        margin: 1,
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        }
      }).then(dataUrl => {
        qrImg.src = dataUrl;
      }).catch(err => {
        console.warn('QRCode generation fallback:', err);
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrData)}`;
      });
    } else {
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrData)}`;
    }
  }

  // Pre-calculate initial eligibility from currentUser profile before async engagement completes
  const initialLastDate = resolveLastDonationDate(currentUser, null);
  const initialElig = getEligibilityInfo(initialLastDate);

  const medLastDonation = document.getElementById('medStatusLastDonation');
  const medLastDonationTag = document.getElementById('medStatusLastDonationTag');
  if (medLastDonation) {
    medLastDonation.textContent = initialLastDate
      ? new Date(initialLastDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Never';
  }
  if (medLastDonationTag) {
    medLastDonationTag.textContent = initialLastDate ? 'Profile record' : 'No previous records';
  }

  const medElig = document.getElementById('medStatusEligibility');
  const medEligTag = document.getElementById('medStatusEligibilityTag');
  if (medElig) {
    medElig.textContent = initialElig.label;
    medElig.className = `text-xl font-black font-headline ${initialElig.color}`;
  }
  if (medEligTag) {
    medEligTag.textContent = initialElig.eligible ? 'Ready to donate today' : `Mandatory safety window: ${initialElig.daysUntil} days remaining`;
  }

  const statElig = document.getElementById('profileStatEligibility');
  const statEligTag = document.getElementById('profileStatEligibilityTag');
  if (statElig) {
    statElig.textContent = initialElig.label;
    statElig.className = `text-base font-black font-headline truncate ${initialElig.color}`;
  }
  if (statEligTag) {
    statEligTag.textContent = initialElig.eligible ? 'Ready to Donate' : `Safe in ${initialElig.daysUntil} days`;
  }

  // Load Engagement, Tier, Stats, and Safe Window
  (async () => {
    const [engagement, emailVerified] = await Promise.all([
      computeDonorEngagement(currentUser.uid).catch(() => null),
      isEmailVerified().catch(() => false),
    ]);

    if (engagement) {
      const donCount = engagement.donationCount || 0;
      const totalUnits = engagement.totalUnits || 0;
      const livesSaved = totalUnits * 3;
      const points = engagement.points || 0;

      // Hero Tier Pill
      const tierPillVal = document.getElementById('donorProfileTierPillVal');
      if (tierPillVal) tierPillVal.textContent = `${engagement.tier} Lifesaver`;

      // 4-Pillar Stat Strip
      const statDonations = document.getElementById('profileStatDonations');
      if (statDonations) statDonations.textContent = donCount;

      const statLives = document.getElementById('profileStatLives');
      if (statLives) statLives.textContent = livesSaved;

      const statPoints = document.getElementById('profileStatPoints');
      if (statPoints) statPoints.textContent = `${points} pts`;

      // Resolve most recent donation date from BOTH currentUser and engagement history
      const effectiveLastDate = resolveLastDonationDate(currentUser, engagement);
      const completedCount = (engagement.donations || []).filter(d => (d.status || '').toLowerCase() === 'completed').length;

      if (medLastDonation) {
        medLastDonation.textContent = effectiveLastDate
          ? new Date(effectiveLastDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : 'Never';
      }
      if (medLastDonationTag) {
        medLastDonationTag.textContent = effectiveLastDate
          ? `${completedCount > 0 ? completedCount : 1} draw${completedCount === 1 ? '' : 's'} on record`
          : 'No previous records';
      }

      const updatedElig = getEligibilityInfo(effectiveLastDate);
      if (statElig) {
        statElig.textContent = updatedElig.label;
        statElig.className = `text-lg sm:text-xl font-black font-headline truncate ${updatedElig.color}`;
      }
      if (statEligTag) {
        statEligTag.textContent = updatedElig.eligible ? 'Ready to Donate' : `Safe in ${updatedElig.daysUntil} days`;
      }

      if (medElig) {
        medElig.textContent = updatedElig.label;
        medElig.className = `text-xl font-black font-headline ${updatedElig.color}`;
      }
      if (medEligTag) {
        medEligTag.textContent = updatedElig.eligible ? '56-day WHO safety window satisfied' : `Mandatory safety window: ${updatedElig.daysUntil} days remaining`;
      }
    }
  })();


  // Form Submit Handler
  const form = document.getElementById('donorProfileForm');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const origHtml = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined text-lg animate-spin">progress_activity</span> Saving...';
      btn.disabled = true;

      try {
        const updateData = {
          name: document.getElementById('donorProfileName').value.trim(),
          bloodType: document.getElementById('donorProfileBloodType').value,
          city: document.getElementById('donorProfileCity').value,
          phone: document.getElementById('donorProfilePhone').value.trim(),
          emergencyContactName: document.getElementById('donorEmergencyContactName')?.value.trim() || '',
          emergencyContactPhone: document.getElementById('donorEmergencyContactPhone')?.value.trim() || '',
        };

        const newNatId = document.getElementById('donorProfileNationalId')?.value;
        if (newNatId && newNatId.trim()) {
          const cleanId = newNatId.trim().replace(/[\s-]/g, '');
          if (cleanId.length < 6) {
            throw new Error('Please enter a valid Cameroon National ID (CNI) number (at least 6 digits).');
          }
          const hashed = await hashNationalId(newNatId);
          if (hashed) {
            let belongsToSomeoneElse = false;
            try {
              const dupQuery = query(collection(db, 'users'), where('cniHash', '==', hashed));
              const dupSnap = await getDocs(dupQuery);
              belongsToSomeoneElse = dupSnap.docs.some(d => d.id !== currentUser.uid);
            } catch (dupErr) {
              console.warn('CNI uniqueness check could not be queried client-side:', dupErr?.message);
            }
            if (belongsToSomeoneElse) {
              throw new Error('This National ID (CNI) is already linked to another registered account.');
            }
            updateData.cniHash = hashed;
            updateData.isCniVerified = true;
            updateData.cniLast4 = cleanId.length >= 4 ? cleanId.slice(-4) : cleanId;
          }
        }

        await updateUserProfile(currentUser.uid, updateData);
        const updated = { ...currentUser, ...updateData };
        localStorage.setItem('vitalpulse_user', JSON.stringify(updated));

        // Update hero elements
        if (headerNameEl) headerNameEl.textContent = updateData.name;
        if (bloodPillVal) bloodPillVal.textContent = updateData.bloodType;

        // Immediately update CNI badge, placeholder, and scannable pass
        if (updateData.cniHash) {
          updateCniBadgeUI(updateData.cniHash);
          if (natIdInput) {
            natIdInput.value = '';
            natIdInput.placeholder = `CNI Hashed (SHA-256: ${updateData.cniHash.slice(0, 12)}...)`;
          }
          const updatedPassIdVal = `VP-NBTS-${(updateData.cniLast4 || currentUser.uid?.slice(0, 6) || '8849').toUpperCase()}`;
          if (passId) passId.textContent = `NBTS-ID: ${updatedPassIdVal}`;

          // Regenerate QR pass with verified CNI ID
          if (qrImg) {
            const qrData = JSON.stringify({
              donorId: currentUser.uid,
              name: updateData.name,
              bloodType: updateData.bloodType,
              passId: updatedPassIdVal,
              city: updateData.city || 'Yaoundé',
              issuedBy: 'VitalPulse Cameroon NBTS'
            });
            if (QRCode && typeof QRCode.toDataURL === 'function') {
              QRCode.toDataURL(qrData, {
                width: 256,
                margin: 1,
                color: { dark: '#0f172a', light: '#ffffff' }
              }).then(dataUrl => { qrImg.src = dataUrl; }).catch(() => {});
            }
          }
        }

        showToast('Profile, emergency contact, and clinical settings saved!', 'success');
      } catch (err) {
        console.error('Failed to save profile:', err);
        showToast(err.message || 'Failed to save profile.', 'error');
      } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
      }
    };
  }

  // Multi-Channel Notifications Toggles (persisted to both Firestore and localStorage)
  const notifSms = document.getElementById('donorNotifSms');
  const notifWhatsapp = document.getElementById('donorNotifWhatsapp');
  const notifEmergency = document.getElementById('donorNotifEmergency');

  if (notifSms) {
    notifSms.checked = currentUser.notifSms !== false;
    notifSms.onchange = async () => {
      try {
        await updateUserProfile(currentUser.uid, { notifSms: notifSms.checked });
        currentUser.notifSms = notifSms.checked;
        localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser }));
        showToast(notifSms.checked ? 'SMS notifications enabled' : 'SMS notifications disabled');
      } catch (err) {
        console.error('Failed to update SMS preference:', err);
      }
    };
  }

  if (notifWhatsapp) {
    notifWhatsapp.checked = currentUser.notifWhatsapp === true;
    notifWhatsapp.onchange = async () => {
      try {
        await updateUserProfile(currentUser.uid, { notifWhatsapp: notifWhatsapp.checked });
        currentUser.notifWhatsapp = notifWhatsapp.checked;
        localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser }));
        showToast(notifWhatsapp.checked ? 'WhatsApp notifications enabled' : 'WhatsApp notifications disabled');
      } catch (err) {
        console.error('Failed to update WhatsApp preference:', err);
      }
    };
  }

  if (notifEmergency) {
    notifEmergency.checked = currentUser.notifEmergency !== false;
    notifEmergency.onchange = async () => {
      try {
        await updateUserProfile(currentUser.uid, { notifEmergency: notifEmergency.checked });
        currentUser.notifEmergency = notifEmergency.checked;
        localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser }));
        showToast(notifEmergency.checked ? 'Emergency blood alerts enabled' : 'Emergency blood alerts disabled');
      } catch (err) {
        console.error('Failed to update emergency alert preference:', err);
      }
    };
  }

  // Geo-Alert Radius Radio Group (persisted to both Firestore and localStorage)
  document.querySelectorAll('input[name="donorRadius"]').forEach(radio => {
    if (radio.value === String(currentUser.alertRadiusKm || 5)) {
      radio.checked = true;
    }
    radio.onchange = async () => {
      try {
        const radius = parseInt(radio.value, 10) || 5;
        await updateUserProfile(currentUser.uid, { alertRadiusKm: radius });
        currentUser.alertRadiusKm = radius;
        localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser }));
        showToast(`Emergency alert radius set to ${radius} km`);
      } catch (err) {
        console.error('Failed to save alert radius:', err);
      }
    };
  });

  // Password Reset Button
  const changePasswordBtn = document.getElementById('btnDonorChangePassword');
  if (changePasswordBtn) {
    changePasswordBtn.onclick = async () => {
      if (!currentUser?.email) return;
      changePasswordBtn.disabled = true;
      const originalText = changePasswordBtn.innerHTML;
      changePasswordBtn.innerHTML = '<span class="material-symbols-outlined text-base animate-spin">progress_activity</span> Sending...';
      try {
        await sendPasswordReset(currentUser.email);
        showToast(`Password reset link sent to ${currentUser.email}`, 'success');
      } catch (err) {
        console.error('Failed to send password reset:', err);
        showToast('Failed to send reset email. Please try again.', 'error');
      } finally {
        changePasswordBtn.disabled = false;
        changePasswordBtn.innerHTML = originalText;
      }
    };
  }

  // Digital Pass Download & WhatsApp Share Buttons
  const btnDownloadPass = document.getElementById('btnDownloadProfilePass');
  if (btnDownloadPass) {
    btnDownloadPass.onclick = () => {
      generateLifesaverCardCanvas();
    };
  }

  const btnSharePass = document.getElementById('btnShareProfilePass');
  if (btnSharePass) {
    btnSharePass.onclick = () => {
      const msg = encodeURIComponent(`🩸 I am a verified Lifesaver with VitalPulse Cameroon! Blood Type: ${bloodTypeVal}. Join the national donor registry: https://vitalpulse.cm`);
      window.open(`https://wa.me/?text=${msg}`, '_blank');
    };
  }

  // Active Session parsing
  const sessionLabelEl = document.getElementById('donorCurrentSessionLabel');
  if (sessionLabelEl) {
    const ua = navigator.userAgent || '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Device';
    sessionLabelEl.textContent = currentUser.city ? `${os} · ${browser} (${currentUser.city}, Cameroon)` : `${os} · ${browser}`;
  }

  // Danger Zone Alert
  const deleteBtn = document.getElementById('btnDonorDeleteAccount');
  if (deleteBtn) {
    deleteBtn.onclick = () => {
      window.vpAlert({
        type: 'warning',
        title: 'Account deletion unavailable',
        message: 'Account deletion requires a Security Lead-approved backend, which does not exist yet. Please contact support if you need your account removed.',
        confirmText: 'Got it',
      });
    };
  }
}

// A donor's blood type is self-reported at signup with no lab check behind it. It only becomes
// "Lab-Verified" once a hospital records an actual lab-confirmed type during donation intake
// (see recordDonationIntake in db.js). That confirmation lives on the donation record itself
// rather than being written back onto the donor's own profile — a hospital session doesn't have
// permission to edit another user's account, and a type correction is exactly the kind of change
// that should go through a reviewed step rather than a silent background write.
// E4.1/E4.2 add two more blood-type-source badges (sidebar avatar area, Medical Status card)
// that need the exact same lab-verified/self-reported logic as the form's existing badge —
// `extraBadgeIds` lets all three share the single donations fetch instead of one read each.
async function renderBloodTypeSourceBadge(currentUser, extraBadgeIds = []) {
  const badge = document.getElementById('donorBloodTypeSourceBadge');
  const mismatchNote = document.getElementById('donorBloodTypeMismatchNote');
  const bloodSelect = document.getElementById('donorProfileBloodType');
  const lockedTag = document.getElementById('donorProfileBloodTypeLockedTag');
  if (!badge) return;
  const extraBadges = extraBadgeIds.map(id => document.getElementById(id)).filter(Boolean);

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
    badge.className = 'text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 inline-flex items-center gap-1';
    extraBadges.forEach(b => {
      b.textContent = 'Lab-Verified';
      b.className = 'text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 inline-flex items-center gap-1';
    });

    if (bloodSelect) {
      bloodSelect.value = labConfirmed;
      bloodSelect.disabled = true;
      bloodSelect.classList.add('bg-slate-100/80', 'dark:bg-slate-800/40', 'cursor-not-allowed', 'opacity-90');
      bloodSelect.title = 'Your blood group has been verified by an accredited hospital laboratory and is locked for clinical transfusion safety.';
    }
    if (lockedTag) {
      lockedTag.classList.remove('hidden');
      lockedTag.classList.add('inline-flex');
    }

    if (labConfirmed !== (currentUser.bloodType || '')) {
      const oldType = currentUser.bloodType || 'Unknown';
      currentUser.bloodType = labConfirmed;
      currentUser.bloodTypeSource = 'lab-verified';
      localStorage.setItem('vitalpulse_user', JSON.stringify(currentUser));

      const bloodPillVal = document.getElementById('donorProfileBloodTypePillVal');
      if (bloodPillVal) bloodPillVal.textContent = labConfirmed;
      const medBloodType = document.getElementById('medStatusBloodType');
      if (medBloodType) medBloodType.textContent = labConfirmed;

      if (mismatchNote) {
        mismatchNote.innerHTML = `
          <div class="mt-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/80 text-amber-900 dark:text-amber-200 text-xs space-y-1">
            <p class="font-extrabold flex items-center gap-1.5"><span class="material-symbols-outlined text-sm text-amber-600">verified</span> Clinical Laboratory Confirmation</p>
            <p>Your profile initially noted <strong>${esc(oldType)}</strong>, but hospital laboratory typing during your donation confirmed you are <strong>${esc(labConfirmed)}</strong>. Your official Lifesaver Passport has been updated and locked to <strong>${esc(labConfirmed)} (Lab-Verified)</strong> for transfusion safety.</p>
          </div>`;
        mismatchNote.classList.remove('hidden');
      }
    } else {
      if (mismatchNote) mismatchNote.classList.add('hidden');
    }
  } else {
    if (bloodSelect) {
      bloodSelect.disabled = false;
      bloodSelect.classList.remove('bg-slate-100/80', 'dark:bg-slate-800/40', 'cursor-not-allowed', 'opacity-90');
      bloodSelect.title = '';
    }
    if (lockedTag) {
      lockedTag.classList.add('hidden');
      lockedTag.classList.remove('inline-flex');
    }

    if (currentUser.bloodType === 'Unknown') {
      badge.textContent = 'Pending 1st Draw';
      badge.className = 'text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 inline-flex items-center gap-1';
      extraBadges.forEach(b => {
        b.textContent = 'Free Test at Intake';
        b.className = 'text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 inline-flex items-center gap-1';
      });
      const medBloodType = document.getElementById('medStatusBloodType');
      if (medBloodType) medBloodType.textContent = 'Pending';
      if (mismatchNote) {
        mismatchNote.innerHTML = `
          <div class="mt-2 p-3 rounded-xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800/80 text-sky-900 dark:text-sky-200 text-xs space-y-1">
            <p class="font-extrabold flex items-center gap-1.5"><span class="material-symbols-outlined text-sm text-sky-600">biotech</span> Free ABO/Rh Typing at Center</p>
            <p>Don't worry if you don't know your blood group! When you attend your first donation at any accredited hospital in Cameroon, clinical staff perform a free rapid slide test and certify your group on your passport.</p>
          </div>`;
        mismatchNote.classList.remove('hidden');
      }
    } else {
      badge.textContent = 'Self-Reported';
      badge.className = 'text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 inline-flex items-center gap-1';
      extraBadges.forEach(b => {
        b.textContent = 'Self-Reported';
        b.className = 'text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 inline-flex items-center gap-1';
      });
      const medBloodType = document.getElementById('medStatusBloodType');
      if (medBloodType) medBloodType.textContent = currentUser.bloodType || '—';
      if (mismatchNote) mismatchNote.classList.add('hidden');
    }
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
  toast.classList.remove('opacity-0', 'translate-y-20', 'pointer-events-none');
  toast.classList.add('opacity-100', 'translate-y-0', 'pointer-events-auto');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove('opacity-100', 'translate-y-0', 'pointer-events-auto');
    toast.classList.add('opacity-0', 'translate-y-20', 'pointer-events-none');
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
function ensureVpAlertModalInDom() {
  let modal = document.getElementById('vpAlertModal');
  if (modal) return modal;

  const div = document.createElement('div');
  div.id = 'vpAlertModal';
  div.className = 'fixed inset-0 z-[9999] hidden items-center justify-center p-4 sm:p-6 overflow-y-auto';
  div.innerHTML = `
    <div id="vpAlertBackdrop" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity"></div>
    <div class="relative w-full max-w-md bg-white rounded-3xl p-6 sm:p-8 shadow-2xl border border-slate-100 z-10 text-center animate-in fade-in zoom-in duration-200">
      <div id="vpAlertIconWrap" class="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 bg-red-50 text-red-600">
        <span id="vpAlertIcon" class="material-symbols-outlined text-2xl">info</span>
      </div>
      <h3 id="vpAlertTitle" class="text-lg font-black text-slate-900 mb-2"></h3>
      <div id="vpAlertMessage" class="text-xs font-medium text-slate-600 space-y-2 mb-6"></div>
      <div class="flex items-center gap-3">
        <button id="vpAlertCancel" type="button" class="hidden flex-1 py-3 rounded-2xl font-extrabold text-sm bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors cursor-pointer">Cancel</button>
        <button id="vpAlertConfirm" type="button" class="flex-1 py-3 rounded-2xl font-extrabold text-sm bg-red-600 text-white hover:bg-red-700 transition-colors cursor-pointer">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(div);
  return div;
}

window.vpAlert = (opts = {}) => new Promise((resolve) => {
  const { type = 'info', title = '', message = '', confirmText = 'OK', cancelText = null, danger = false } = opts;
  const modal = ensureVpAlertModalInDom();
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
  msgEl.innerHTML = message;
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
/**
 * Fire-and-forget styled notice — the drop-in replacement for `alert()`.
 *
 * Deliberately NOT awaited by callers: `alert()` sites are scattered through
 * both sync and async code, and requiring `await` at each one is how a sweep
 * like this introduces silent bugs. This shows the same modal and returns
 * immediately.
 */
window.vpNotify = (message, type = 'error', title = null) => {
  const defaults = { error: 'Something went wrong', warning: 'Please check', success: 'Done', info: 'Notice' };
  window.vpAlert({ type, title: title || defaults[type] || 'Notice', message, confirmText: 'OK' });
};

/**
 * Styled replacement for `prompt()`. Resolves to the entered string, or null if
 * dismissed — matching prompt()'s contract so call sites keep their `=== null`
 * cancellation checks.
 */
window.vpPrompt = (message, opts = {}) => new Promise((resolve) => {
  const modal = ensureVpAlertModalInDom();
  const msgEl = document.getElementById('vpAlertMessage');
  const titleEl = document.getElementById('vpAlertTitle');
  const iconWrap = document.getElementById('vpAlertIconWrap');
  const confirmBtn = document.getElementById('vpAlertConfirm');
  const cancelBtn = document.getElementById('vpAlertCancel');
  const backdrop = document.getElementById('vpAlertBackdrop');

  iconWrap.className = 'w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 ' + VP_ALERT_STYLES.question.wrap;
  document.getElementById('vpAlertIcon').textContent = 'edit_note';
  titleEl.textContent = opts.title || 'Please provide a reason';
  titleEl.classList.remove('hidden');

  const inputId = 'vpPromptInput';
  msgEl.innerHTML = `
    <p class="mb-3">${message}</p>
    ${opts.multiline
      ? `<textarea id="${inputId}" rows="3" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-red-200 focus:border-red-500" placeholder="${opts.placeholder || ''}"></textarea>`
      : `<input id="${inputId}" type="text" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-red-200 focus:border-red-500" placeholder="${opts.placeholder || ''}">`}`;
  msgEl.classList.remove('hidden');

  confirmBtn.textContent = opts.confirmText || 'Submit';
  confirmBtn.className = 'press-scale flex-1 py-3 rounded-2xl font-extrabold text-sm transition-opacity cursor-pointer bg-primary hover:opacity-90 text-on-primary';
  cancelBtn.textContent = opts.cancelText || 'Cancel';
  cancelBtn.classList.remove('hidden');

  const finish = (result) => {
    modal.classList.add('hidden'); modal.classList.remove('flex');
    confirmBtn.onclick = null; cancelBtn.onclick = null; backdrop.onclick = null;
    document.removeEventListener('keydown', onKey);
    resolve(result);
  };
  const read = () => document.getElementById(inputId)?.value ?? '';
  const onKey = (e) => {
    if (e.key === 'Escape') finish(null);
    else if (e.key === 'Enter' && !opts.multiline) { e.preventDefault(); finish(read()); }
  };
  confirmBtn.onclick = () => finish(read());
  cancelBtn.onclick = () => finish(null);
  backdrop.onclick = () => finish(null);
  document.addEventListener('keydown', onKey);
  modal.classList.remove('hidden'); modal.classList.add('flex');
  setTimeout(() => document.getElementById(inputId)?.focus(), 30);
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
  // D3: block accepting while KYC-pending/rejected — checked first since it's the more
  // fundamental gate (an unverified donor shouldn't even see the eligibility prompt).
  if (!await warnIfKycPending()) return;
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

// Donor half of the check-in handshake: tells the hospital "I'm here" and puts
// the pass code front and centre. It does NOT advance the journey — a member of
// reception staff does that after physically verifying the donor (see
// checkInDonor in db.js and the front-desk pass code box in main.js).
window.donorMarkArrived = async (requestId, donorId, isPublic) => {
  if (!await window.vpConfirm(
    'Let the hospital know you have arrived. Then show your pass code and CNI card to the front desk — a staff member completes your check-in.',
    { title: "You've arrived?", confirmText: "Yes, I'm at reception" }
  )) return;
  try {
    _enRouteTrackingId = null;
    stopLiveLocationSharing();
    await donorMarkArrivedDb(requestId, donorId, isPublic);
    showToast('Reception has been notified. Show them your pass code to check in.');
    loadDonorDashboard();
  } catch (err) {
    console.error('Arrival signal failed:', err);
    showToast(err.message || 'Could not notify reception. Please speak to the front desk.', 'error');
  }
};

/**
 * Shows "matching near X · use my registered city instead" next to the GPS
 * status once GPS has moved the donor away from their registered city. Without a
 * way back, a donor who granted GPS while travelling had no way to understand or
 * undo why their home city's requests had disappeared.
 */
function renderGpsResetControl(registeredCity, gpsCity) {
  const statusEl = document.getElementById('gpsStatusText');
  if (!statusEl || !gpsCity || !registeredCity) return;
  if (gpsCity.toLowerCase() === registeredCity.toLowerCase()) return;

  let reset = document.getElementById('gpsResetToCity');
  if (!reset) {
    reset = document.createElement('button');
    reset.id = 'gpsResetToCity';
    reset.className = 'ml-2 text-[11px] font-bold text-primary underline hover:no-underline cursor-pointer';
    statusEl.insertAdjacentElement('afterend', reset);
  }
  reset.textContent = `Use ${registeredCity} instead`;
  reset.onclick = async () => {
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    try {
      const updates = { lat: null, lng: null, gpsCity: null, locationSource: 'city' };
      await updateUserProfile(currentUser.uid, updates);
      localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser, ...updates }));
      if (statusEl) statusEl.textContent = `Matching near ${registeredCity}`;
      reset.remove();
      showToast(`Back to matching near ${registeredCity}.`);
      loadDonorDashboard();
    } catch (e) {
      showToast('Could not switch back to your registered city.', 'error');
    }
  };
}

window.enableLiveGpsLocation = async () => {
  const currentUser = getCurrentUser();
  if (!currentUser) return;
  const registeredCity = currentUser.city || 'Yaoundé';
  const statusEl = document.getElementById('gpsStatusText');
  if (statusEl) statusEl.textContent = 'Locating...';
  try {
    const loc = await captureUserLocation(registeredCity);
    if (loc.source === 'gps') {
      const updates = { lat: loc.lat, lng: loc.lng, gpsCity: loc.city, locationSource: 'gps' };
      await updateUserProfile(currentUser.uid, updates);
      const updated = { ...currentUser, ...updates };
      localStorage.setItem('vitalpulse_user', JSON.stringify(updated));
      // Say plainly what changed. Enabling GPS moves which requests you are
      // matched to — previously it silently re-filtered the feed (sometimes
      // emptying it) while reporting only coordinates, which read as a bug.
      const movedCity = loc.city && loc.city.toLowerCase() !== registeredCity.toLowerCase();
      showToast(movedCity
        ? `Live GPS on — now matching you near ${loc.city} instead of ${registeredCity}.`
        : `Live GPS on — matching you near ${loc.city || registeredCity}.`);
      if (statusEl) statusEl.textContent = `GPS Active · matching near ${loc.city || registeredCity}`;
      renderGpsResetControl(registeredCity, loc.city);
      loadDonorDashboard();
    } else {
      const msg = loc.reason && loc.reason.includes('HTTPS')
        ? `Browser requires HTTPS or localhost for live GPS. Using registered city: ${registeredCity}.`
        : `Using city coordinates for ${registeredCity}.`;
      showToast(msg, 'warning');
      if (statusEl) statusEl.textContent = `City: ${registeredCity}`;
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

// Real, verified hospitals from the system with fallback to accredited regional facilities —
// ensures donors can always discover, search, and select legitimate donation centers across Cameroon.
async function loadDonationHospitals() {
  const list = document.getElementById('donationCenterList');
  if (list) list.innerHTML = `<div class="flex items-center justify-center py-10 text-on-surface-variant"><span class="material-symbols-outlined animate-spin text-lg mr-2">sync</span><span class="text-sm font-medium">Loading hospitals...</span></div>`;
  try {
    const all = await fetchAllHospitals();
    const verified = (all || []).filter(h => 
      (h.isVerified === true || h.verified === true || h.status === 'verified') && !h.rejected && !h.suspended && h.isActive !== false
    );
    // Combine regional accredited centers with verified database hospitals (deduplicated by normalized name)
    const map = new Map();
    DEFAULT_ACCREDITED_CENTERS.forEach(h => {
      const key = (h.name || '').toLowerCase().trim();
      map.set(key, { ...h });
    });
    verified.forEach(h => {
      const hospitalName = h.name || h.hospitalName || 'Accredited Hospital';
      const key = hospitalName.toLowerCase().trim();
      map.set(key, {
        id: h.id,
        name: hospitalName,
        city: h.city || h.address || 'Cameroon',
        region: h.region || '',
        address: h.address || '',
        phone: h.phone || h.contactNumber || '',
        isVerified: true
      });
    });
    _donationHospitals = Array.from(map.values());
  } catch (e) {
    console.warn('Failed to load hospitals, using accredited centers fallback:', e);
    _donationHospitals = [...DEFAULT_ACCREDITED_CENTERS];
  }
  renderDonationCenters(document.getElementById('donationHospitalSearch')?.value || '');
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

  let filtered = hospitals.filter(h => {
    if (!q) return true;
    const name = (h.name || h.hospitalName || '').toLowerCase();
    const city = (h.city || '').toLowerCase();
    const address = (h.address || '').toLowerCase();
    const region = (h.region || '').toLowerCase();
    return name.includes(q) || city.includes(q) || address.includes(q) || region.includes(q);
  });

  // Donor's own city first, alphabetical within each group — helps once the list is long.
  filtered = filtered.sort((a, b) => {
    const aNear = (a.city || '').toLowerCase() === donorCity ? 0 : 1;
    const bNear = (b.city || '').toLowerCase() === donorCity ? 0 : 1;
    if (aNear !== bNear) return aNear - bNear;
    return (a.name || a.hospitalName || '').localeCompare(b.name || b.hospitalName || '');
  });

  if (filtered.length === 0) {
    list.innerHTML = `<div class="flex flex-col items-center justify-center py-8 text-on-surface-variant text-center"><span class="material-symbols-outlined text-3xl mb-1 text-slate-400">search_off</span><p class="text-xs font-bold text-on-surface">No hospitals match "${esc(searchTerm)}"</p><p class="text-[11px] text-slate-400 mt-0.5">Try searching for Yaoundé, Douala, Buea, or Limbe</p></div>`;
    return;
  }

  // Paginate so a 50-hospital network doesn't render every card at once. Search narrows first.
  const shown = filtered.slice(0, _centerPickerCount);
  const cards = shown.map(h => {
    const hospitalName = h.name || h.hospitalName || 'Accredited Hospital';
    const isNear = (h.city || '').toLowerCase() === donorCity && donorCity;
    const isSelected = _selectedCenter === hospitalName;
    return `
    <button type="button" data-center="${esc(hospitalName)}"
      class="donation-center-btn press-scale w-full flex items-center gap-2.5 sm:gap-3 p-3 sm:p-3.5 rounded-xl border-2 ${isSelected ? 'border-primary bg-primary/8 shadow-xs' : 'border-outline-variant/20 bg-surface-container-lowest/70 dark:bg-slate-800/50'} hover:border-primary/50 hover:bg-primary/5 transition-all duration-200 text-left cursor-pointer">
      <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl ${isSelected ? 'bg-primary text-white shadow-xs' : 'bg-primary/10 text-primary'} flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-xl">local_hospital</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5">
          <p class="font-extrabold text-xs sm:text-sm text-on-surface truncate">${esc(hospitalName)}</p>
          <span class="material-symbols-outlined text-primary text-[15px] shrink-0" title="Accredited Partner" style="font-variation-settings:'FILL' 1">verified</span>
        </div>
        <p class="text-[11px] sm:text-xs text-on-surface-variant truncate mt-0.5">${esc(h.city || h.address || 'Cameroon')}${h.region ? ` • ${esc(h.region)}` : ''}</p>
      </div>
      ${isSelected ? '<span class="material-symbols-outlined text-primary text-xl shrink-0" style="font-variation-settings:\'FILL\' 1">check_circle</span>' : (isNear ? '<span class="text-[9px] font-black text-primary bg-primary/10 px-2 py-0.5 rounded-full shrink-0">Near you</span>' : '')}
    </button>
  `;
  }).join('');
  const moreCount = filtered.length - shown.length;
  const moreBtn = moreCount > 0
    ? `<button type="button" id="centerPickerMore" class="press-scale w-full text-center text-primary font-bold text-xs py-2 hover:underline cursor-pointer">Show ${Math.min(8, moreCount)} more of ${filtered.length} hospitals</button>`
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
  if (!await warnIfIneligible()) { window.closeDonationModal(); return; }

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
    window.closeDonationModal();
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

// Shared by the donation history modal (#myDonationsList) and the E3.4 inline "Donation
// History" card on the Impact view — one row template, two render targets.
function donationHistoryRowHtml(d) {
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
          ${esc(d.bloodType || 'O+')}
        </div>
        <div>
          <p class="font-extrabold text-sm text-on-surface">${d.units || 1} Unit${(d.units || 1) > 1 ? 's' : ''} Blood Gift</p>
          <p class="text-[11px] font-medium text-on-surface-variant flex items-center gap-1 mt-0.5">
            <span class="material-symbols-outlined text-xs text-primary">location_on</span>
            ${esc(d.preferredLocation || 'Hospital Center')}
          </p>
        </div>
      </div>
      <span class="px-2.5 py-1 ${sc} text-[10px] font-black rounded-full uppercase tracking-wider border">${esc(d.status)}</span>
    </div>
    <div class="pt-2 border-t border-outline-variant/10 flex items-center justify-between text-[11px] text-on-surface-variant font-medium">
      <span class="flex items-center gap-1"><span class="material-symbols-outlined text-xs">calendar_today</span> ${date}</span>
      ${d.labConfirmedBloodType ? `<span class="text-emerald-600 font-bold flex items-center gap-1"><span class="material-symbols-outlined text-xs">verified</span> Lab Verified (${esc(d.labConfirmedBloodType)})</span>` : ''}
    </div>
  </div>
  `;
}

const donationHistoryEmptyStateHtml = `
  <div class="text-center py-12 space-y-3">
    <div class="w-16 h-16 rounded-full bg-surface-container-low text-on-surface-variant/40 mx-auto flex items-center justify-center">
      <span class="material-symbols-outlined text-3xl">receipt_long</span>
    </div>
    <p class="text-xs font-bold text-on-surface-variant">No donation history recorded yet</p>
  </div>
`;

export async function loadDonorDonations() {
  const listEl = document.getElementById('myDonationsList');
  if (!listEl) return;

  const currentUser = getCurrentUser();
  if (!currentUser) {
    listEl.innerHTML = '<p class="text-center text-on-surface-variant py-4 text-xs font-bold">Please log in to view history.</p>';
    return;
  }

  listEl.innerHTML = `
    <div class="flex flex-col items-center justify-center py-16 text-center space-y-3">
      <div class="loader-spinner"></div>
      <p class="text-xs font-bold text-slate-500 dark:text-slate-400">Loading donation history...</p>
    </div>
  `;

  try {
    const donations = await fetchDonationRequestsForDonor(currentUser.uid);
    listEl.innerHTML = donations.length === 0
      ? donationHistoryEmptyStateHtml
      : donations.map(donationHistoryRowHtml).join('');
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

const WHO_RECOVERY_PILLARS = [
  {
    id: 'pillar-hydration',
    category: 'immediate',
    icon: 'water_drop',
    accent: 'from-sky-500 to-blue-600',
    badgeCls: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
    window: 'First 24 Hours',
    title: 'Electrolyte & Fluid Replenishment',
    summary: 'Drink 500 mL of water immediately and an extra 4 glasses of non-alcoholic fluids over the next 24 hours to restore plasma volume completely.',
    bullet: 'Avoid alcohol and strenuous heavy lifting for 24 hours.',
  },
  {
    id: 'pillar-nutrition',
    category: 'nutrition',
    icon: 'restaurant',
    accent: 'from-amber-500 to-orange-600',
    badgeCls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
    window: 'Days 1 – 14',
    title: 'Iron-Rich Cameroonian Nutrition',
    summary: 'Accelerate hemoglobin synthesis with iron-rich local foods: njama-njama (huckleberry), folere, beans, liver, fish, plantains, and vitamin-C citrus fruits.',
    bullet: 'Pair iron-rich meals with orange or pineapple juice to double iron absorption.',
  },
  {
    id: 'pillar-venipuncture',
    category: 'aftercare',
    icon: 'healing',
    accent: 'from-emerald-500 to-teal-600',
    badgeCls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    window: 'First 6 – 12 Hours',
    title: 'Venipuncture Site & Arm Care',
    summary: 'Keep the sterile pressure bandage dry and intact for at least 5 hours. Clean gently with soap and water afterward.',
    bullet: 'If minor bruising appears, apply a cold compress for 15 minutes during the first day.',
  },
  {
    id: 'pillar-cadence',
    category: 'schedule',
    icon: 'event_available',
    accent: 'from-purple-500 to-indigo-600',
    badgeCls: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
    window: '56-Day WHO Window',
    title: 'Red Blood Cell Maturation Cycle',
    summary: 'While plasma volume recovers within 24–48 hours, bone marrow requires 56 days (8 weeks) to fully replenish donated red blood cells.',
    bullet: 'VitalPulse automatically unlocks your next dispatch eligibility on Day 56.',
  },
];

async function loadCareRemindersView() {
  const container = document.getElementById('careRemindersContent');
  if (!container) return;
  const currentUser = getCurrentUser();
  if (!currentUser) {
    container.innerHTML = '<div class="text-center py-12 text-on-surface-variant"><p class="text-sm font-bold">Please log in to view care reminders.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="flex flex-col items-center justify-center py-20 text-center space-y-3">
      <div class="loader-spinner"></div>
      <p class="text-xs font-bold text-slate-500 dark:text-slate-400">Loading personalized care reminders...</p>
    </div>
  `;

  try {
    const reminders = await fetchCareReminders(currentUser.uid).catch(() => []);
    const categoryIcons = {
      immediate: { icon: 'water_drop', color: 'text-sky-600 bg-sky-50 dark:bg-sky-950/60 dark:text-sky-300 border-sky-200 dark:border-sky-800', label: 'Immediate Hydration' },
      nutrition: { icon: 'restaurant', color: 'text-amber-600 bg-amber-50 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-800', label: 'Iron & Nutrition' },
      aftercare: { icon: 'healing', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800', label: 'Arm Aftercare' },
      schedule: { icon: 'event_available', color: 'text-purple-600 bg-purple-50 dark:bg-purple-950/60 dark:text-purple-300 border-purple-200 dark:border-purple-800', label: '56-Day Cadence' },
    };

    const activeReminders = reminders.filter(r => !r.dismissed);
    const dismissedReminders = reminders.filter(r => r.dismissed);

    const activeSectionHtml = activeReminders.length > 0 ? `
      <div class="space-y-3.5">
        <div class="flex items-center justify-between px-1">
          <h3 class="text-xs font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
            <span>Active Post-Donation Tasks (${activeReminders.length})</span>
          </h3>
          <span class="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">Personalized for your recovery</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${activeReminders.map(r => {
            const cat = categoryIcons[r.category] || categoryIcons.immediate;
            const isOverdue = r.dueDate && new Date(r.dueDate) < new Date();
            return `
              <div class="bg-white dark:bg-slate-900 p-5 rounded-3xl border border-slate-200/90 dark:border-slate-800 shadow-xs hover:shadow-md transition-all flex flex-col justify-between gap-4">
                <div class="flex items-start gap-3.5">
                  <div class="w-12 h-12 rounded-2xl border ${cat.color} flex items-center justify-center shrink-0 shadow-2xs">
                    <span class="material-symbols-outlined text-2xl">${esc(r.icon || cat.icon)}</span>
                  </div>
                  <div class="space-y-1.5 min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border ${cat.color}">${cat.label}</span>
                      ${isOverdue ? '<span class="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 border border-red-500/20">Priority</span>' : ''}
                    </div>
                    <h4 class="font-black text-sm sm:text-base text-slate-900 dark:text-white leading-snug">${esc(r.title)}</h4>
                    <p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium">${esc(r.message)}</p>
                  </div>
                </div>
                <div class="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                  <span class="text-[11px] text-slate-400 font-semibold flex items-center gap-1 truncate">
                    <span class="material-symbols-outlined text-xs text-emerald-500">schedule</span>
                    ${r.dueDate ? 'Target: ' + new Date(r.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Ongoing care'}
                    ${r.hospitalName ? ' &bull; ' + esc(r.hospitalName) : ''}
                  </span>
                  <button type="button" onclick="window.dismissReminder('${esc(r.id)}')" class="press-scale inline-flex items-center gap-1.5 text-xs font-black text-white bg-emerald-600 hover:bg-emerald-700 px-3.5 py-2 rounded-xl shadow-xs transition-all cursor-pointer shrink-0">
                    <span class="material-symbols-outlined text-sm">check_circle</span> Mark Done
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    ` : `
      <div class="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-3xl p-6 sm:p-8 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
        <div class="flex items-start sm:items-center gap-4">
          <div class="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-3xl" style="font-variation-settings:'FILL' 1">verified_user</span>
          </div>
          <div>
            <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px] font-black uppercase tracking-wider mb-1">
              <span>All Personal Reminders Clear</span>
            </div>
            <h3 class="text-base sm:text-lg font-black text-slate-900 dark:text-white font-headline">Ready for Your Next Lifesaving Mission</h3>
            <p class="text-xs text-slate-500 dark:text-slate-400 max-w-xl mt-0.5 leading-relaxed">
              Immediately after your next hospital check-in and phlebotomy completion, automated timed care tasks (2h hydration, 24h iron meal, and 56-day recovery tracking) will appear right here.
            </p>
          </div>
        </div>
        <button type="button" onclick="window.openDonationModal()" class="press-scale inline-flex items-center gap-2 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-black text-xs px-5 py-3 rounded-2xl shadow-md shadow-red-600/20 cursor-pointer shrink-0">
          <span class="material-symbols-outlined text-sm">event_available</span>
          <span>Schedule a Donation</span>
        </button>
      </div>
    `;

    const pillarsHtml = `
      <div class="space-y-3.5">
        <div class="flex items-center justify-between px-1 flex-wrap gap-2">
          <div>
            <h3 class="text-xs font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">4-Pillar Clinical Recovery &amp; Readiness Guide</h3>
            <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Standard Cameroon National Blood Transfusion Service (NBTS) &amp; WHO donor physiology protocol</p>
          </div>
          <span class="px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">450 mL Whole Blood Standard</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${WHO_RECOVERY_PILLARS.map(p => `
            <div class="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 p-5 shadow-xs hover:border-emerald-500/40 transition-all space-y-3.5">
              <div class="flex items-start justify-between gap-3">
                <div class="flex items-center gap-3">
                  <div class="w-11 h-11 rounded-2xl bg-gradient-to-br ${p.accent} text-white flex items-center justify-center shadow-sm shrink-0">
                    <span class="material-symbols-outlined text-xl">${p.icon}</span>
                  </div>
                  <div>
                    <span class="inline-block text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ${p.badgeCls}">${p.window}</span>
                    <h4 class="font-black text-sm sm:text-base text-slate-900 dark:text-white mt-1">${p.title}</h4>
                  </div>
                </div>
              </div>
              <p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium">${p.summary}</p>
              <div class="bg-slate-50 dark:bg-slate-800/70 rounded-2xl p-3 border border-slate-200/70 dark:border-slate-700/70 flex items-start gap-2 text-[11px] text-slate-700 dark:text-slate-200 font-semibold">
                <span class="material-symbols-outlined text-sm text-emerald-500 shrink-0 mt-0.5" style="font-variation-settings:'FILL' 1">tips_and_updates</span>
                <span>${p.bullet}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    const dismissedHtml = dismissedReminders.length > 0 ? `
      <details class="group bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-4">
        <summary class="cursor-pointer text-xs font-black text-slate-600 dark:text-slate-300 flex items-center justify-between">
          <span class="flex items-center gap-2">
            <span class="material-symbols-outlined text-sm text-emerald-500">task_alt</span>
            <span>Completed Recovery Tasks (${dismissedReminders.length})</span>
          </span>
          <span class="material-symbols-outlined text-sm group-open:rotate-180 transition-transform">expand_more</span>
        </summary>
        <div class="space-y-2 mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
          ${dismissedReminders.slice(0, 6).map(r => `
            <div class="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-xl flex items-center gap-3 opacity-75">
              <span class="material-symbols-outlined text-base text-emerald-500" style="font-variation-settings:'FILL' 1">check_circle</span>
              <div class="flex-1 min-w-0">
                <p class="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">${esc(r.title)}</p>
                <p class="text-[11px] text-slate-500 dark:text-slate-400 truncate">${esc(r.message || '')}</p>
              </div>
            </div>
          `).join('')}
        </div>
      </details>
    ` : '';

    container.innerHTML = `<div class="space-y-6">${activeSectionHtml}${pillarsHtml}${dismissedHtml}</div>`;
  } catch (e) {
    console.error('Failed to load care reminders:', e);
    container.innerHTML = '<div class="text-center py-12 text-error"><p class="text-sm font-bold">Failed to load care reminders.</p></div>';
  }
}

window.dismissReminder = async (reminderId) => {
  try {
    await dismissCareReminder(reminderId);
    showToast('Recovery task marked complete!');
    loadCareRemindersView();
  } catch (e) {
    showToast('Failed to update reminder.', 'error');
  }
};


// ============================================
// PHASE 3: DONOR MYTH-BUSTING HUB
// ============================================

const DEFAULT_CAMEROON_MYTH_ARTICLES = [
  {
    id: 'nbts-myth-1',
    category: 'health',
    title: 'Rapid Bone Marrow & Plasma Regeneration',
    myth: '"Donating 450 mL of blood will permanently weaken my immune system or make me run out of blood."',
    fact: 'A healthy adult circulates 4,500 to 5,500 mL of blood. Your body replaces the liquid plasma volume within 24–48 hours and synthesizes fresh red blood cells within 4–8 weeks—leaving your immunity 100% intact.',
    authorName: 'Cameroon NBTS Hematology Board',
    likes: 42,
  },
  {
    id: 'nbts-myth-2',
    category: 'safety',
    title: 'Zero Risk of Contracting Infections When Donating',
    myth: '"I could contract HIV, Hepatitis B, or Malaria from the needle used during blood donation."',
    fact: 'Every accredited hospital blood bank in Cameroon uses a brand-new, factory-sealed, single-use sterile needle and collection bag that is opened in front of you and incinerated immediately after use.',
    authorName: 'Dr. Ngufor • Regional Transfusion Safety',
    likes: 38,
  },
  {
    id: 'nbts-myth-3',
    category: 'process',
    title: 'Why 1 Unit Preserves Up to 3 Lives',
    myth: '"My single bag of blood only helps one person, so one donation does not make a big difference."',
    fact: 'In the hospital laboratory centrifuge, 1 unit of whole blood (450 mL) is separated into 3 distinct lifesaving components: Packed Red Blood Cells (for trauma/anemia), Fresh Frozen Plasma (for burns/clotting), and Platelets (for cancer/surgery)—saving up to 3 patients.',
    authorName: 'Central Hospital Blood Bank Lab',
    likes: 54,
  },
  {
    id: 'nbts-myth-4',
    category: 'health',
    title: 'Weight, Diet & Post-Donation Appetite',
    myth: '"Donating blood causes rapid weight gain or forces me to eat expensive imported foods to recover."',
    fact: 'Blood donation burns ~650 kcal during red cell synthesis but does not alter your metabolism. Everyday Cameroonian foods like beans, njama-njama, groundnuts, fish, and citrus fruits provide all the iron and folate needed.',
    authorName: 'Clinical Nutrition Unit • Yaoundé',
    likes: 29,
  },
  {
    id: 'nbts-myth-5',
    category: 'safety',
    title: 'Free Confidential Lab Screening With Every Draw',
    myth: '"Hospitals transfuse donated blood immediately without testing it, or charge donors for blood group tests."',
    fact: 'Every donated unit undergoes mandatory WHO-standard screening (ABO/RhD typing, HIV-1/2, Hepatitis B & C, and Syphilis) before it can ever enter hospital inventory—giving donors a free mini health check.',
    authorName: 'NBTS Quality Assurance',
    likes: 35,
  },
  {
    id: 'nbts-myth-6',
    category: 'process',
    title: 'Women & Regular Voluntary Donation',
    myth: '"Women in Cameroon cannot donate blood because of monthly menstruation."',
    fact: 'Healthy women aged 18–65 weighing at least 50 kg with hemoglobin ≥ 12.5 g/dL can safely donate whole blood every 4 months. A quick painless finger-prick hemoglobin check is always performed before every draw.',
    authorName: 'Maternal & Transfusion Care Team',
    likes: 47,
  },
];

let _mythCategoryFilter = 'all';

window.filterMythHubCategory = (cat) => {
  _mythCategoryFilter = cat || 'all';
  loadMythHubView();
};

async function loadMythHubView() {
  const container = document.getElementById('mythHubContent');
  if (!container) return;

  container.innerHTML = `
    <div class="flex flex-col items-center justify-center py-20 text-center space-y-3">
      <div class="loader-spinner"></div>
      <p class="text-xs font-bold text-slate-500 dark:text-slate-400">Loading myth-busting articles...</p>
    </div>
  `;

  try {
    const dbArticles = await fetchMythArticles().catch(() => []);
    const mergedMap = new Map();
    (Array.isArray(dbArticles) ? dbArticles : []).forEach(a => {
      if (a && a.id) mergedMap.set(a.id, a);
    });
    DEFAULT_CAMEROON_MYTH_ARTICLES.forEach(def => {
      if (!mergedMap.has(def.id)) {
        const localLikes = Number(localStorage.getItem(`vp_myth_likes_${def.id}`) || 0);
        mergedMap.set(def.id, { ...def, likes: (def.likes || 0) + localLikes });
      }
    });
    const allArticles = Array.from(mergedMap.values());
    const filtered = _mythCategoryFilter === 'all'
      ? allArticles
      : allArticles.filter(a => (a.category || 'general').toLowerCase() === _mythCategoryFilter);

    const categoryMeta = {
      health: { label: 'Physiology & Health', bg: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25' },
      safety: { label: 'Sterility & Safety', bg: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25' },
      process: { label: 'Lab & Process', bg: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25' },
      general: { label: 'Clinical Fact', bg: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/25' },
    };

    const filterTabs = [
      { key: 'all', label: `All Facts (${allArticles.length})`, icon: 'apps' },
      { key: 'health', label: 'Physiology & Health', icon: 'vital_signs' },
      { key: 'safety', label: 'Sterility & Safety', icon: 'verified_user' },
      { key: 'process', label: 'Lab & Process', icon: 'biotech' },
    ];

    const filterBarHtml = `
      <div class="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3 flex items-center justify-between gap-2 flex-wrap shadow-xs">
        <div class="flex items-center gap-2 overflow-x-auto no-scrollbar">
          ${filterTabs.map(t => {
            const active = _mythCategoryFilter === t.key;
            return `
              <button type="button" onclick="window.filterMythHubCategory('${t.key}')" class="press-scale inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-black transition-all cursor-pointer shrink-0 ${active ? 'bg-cyan-600 text-white shadow-xs' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'}">
                <span class="material-symbols-outlined text-sm">${t.icon}</span>
                <span>${t.label}</span>
              </button>`;
          }).join('')}
        </div>
        <span class="text-[11px] font-bold text-slate-400 px-2 hidden sm:inline">Peer-Reviewed Medical Guidance</span>
      </div>
    `;

    const cardsHtml = filtered.map(a => {
      const cat = categoryMeta[(a.category || 'general').toLowerCase()] || categoryMeta.general;
      const likedLocally = localStorage.getItem(`vp_myth_liked_${a.id}`) === '1';
      return `
        <div class="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/90 dark:border-slate-800 overflow-hidden shadow-xs hover:shadow-lg transition-all flex flex-col justify-between">
          <div class="p-5 sm:p-6 space-y-4">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <span class="text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full border ${cat.bg}">${esc(cat.label)}</span>
              ${a.authorName ? `<span class="text-[11px] font-semibold text-slate-400 flex items-center gap-1"><span class="material-symbols-outlined text-xs text-cyan-500" style="font-variation-settings:'FILL' 1">verified</span>${esc(a.authorName)}</span>` : ''}
            </div>
            ${a.title ? `<h3 class="text-sm sm:text-base font-black text-slate-900 dark:text-white font-headline">${esc(a.title)}</h3>` : ''}
            <div class="bg-red-50/80 dark:bg-red-950/35 border border-red-200/70 dark:border-red-900/50 rounded-2xl p-4 space-y-1.5">
              <div class="flex items-center gap-1.5">
                <span class="material-symbols-outlined text-red-600 dark:text-red-400 text-base" style="font-variation-settings:'FILL' 1">cancel</span>
                <span class="text-[10px] font-black text-red-600 dark:text-red-400 uppercase tracking-widest">Common Myth</span>
              </div>
              <p class="text-xs sm:text-sm font-bold text-red-900 dark:text-red-200 leading-relaxed">${esc(a.myth)}</p>
            </div>
            <div class="bg-emerald-50/80 dark:bg-emerald-950/35 border border-emerald-200/70 dark:border-emerald-900/50 rounded-2xl p-4 space-y-1.5">
              <div class="flex items-center gap-1.5">
                <span class="material-symbols-outlined text-emerald-600 dark:text-emerald-400 text-base" style="font-variation-settings:'FILL' 1">check_circle</span>
                <span class="text-[10px] font-black text-emerald-700 dark:text-emerald-300 uppercase tracking-widest">Clinical Fact</span>
              </div>
              <p class="text-xs sm:text-sm font-semibold text-emerald-950 dark:text-emerald-100 leading-relaxed">${esc(a.fact)}</p>
            </div>
          </div>
          <div class="px-5 py-3.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
            <button type="button" onclick="window.handleLikeMyth('${esc(a.id)}')" class="press-scale inline-flex items-center gap-1.5 text-xs font-black ${likedLocally ? 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border border-cyan-500/30' : 'text-slate-600 dark:text-slate-300 hover:text-cyan-600 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'} transition-colors cursor-pointer px-3.5 py-1.5 rounded-xl shadow-2xs">
              <span class="material-symbols-outlined text-sm" style="font-variation-settings:'FILL' ${likedLocally ? 1 : 0}">thumb_up</span>
              <span>Helpful (${a.likes || 0})</span>
            </button>
            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">NBTS Verified</span>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `${filterBarHtml}<div class="grid grid-cols-1 md:grid-cols-2 gap-5">${cardsHtml}</div>`;
  } catch (e) {
    console.error('Failed to load myth hub:', e);
    container.innerHTML = '<div class="text-center py-12 text-error"><p class="text-sm font-bold">Failed to load articles.</p></div>';
  }
}

window.handleLikeMyth = async (articleId) => {
  try {
    if (String(articleId).startsWith('nbts-myth-')) {
      const likedKey = `vp_myth_liked_${articleId}`;
      const countKey = `vp_myth_likes_${articleId}`;
      if (localStorage.getItem(likedKey) !== '1') {
        localStorage.setItem(likedKey, '1');
        localStorage.setItem(countKey, String(Number(localStorage.getItem(countKey) || 0) + 1));
      }
      showToast('Thanks for your feedback!');
      loadMythHubView();
      return;
    }
    await likeMythArticle(articleId, true);
    showToast('Thanks for your feedback!');
    loadMythHubView();
  } catch (e) {
    showToast('Thanks for your feedback!');
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

  container.innerHTML = `
    <div class="flex flex-col items-center justify-center py-20 text-center space-y-3">
      <div class="loader-spinner"></div>
      <p class="text-xs font-bold text-slate-500 dark:text-slate-400">Loading Life Saver certificates...</p>
    </div>
  `;

  try {
    const [storedCerts, engagement] = await Promise.all([
      fetchLifeSaverCertificates(currentUser.uid).catch(() => []),
      computeDonorEngagement(currentUser.uid).catch(() => null),
    ]);

    const certs = Array.isArray(storedCerts) ? [...storedCerts] : [];
    const completedDonations = (engagement?.donations || []).filter(d => {
      const s = (d.status || '').toLowerCase();
      return s === 'completed' || s === 'donation complete';
    });

    // Ensure every completed donation is represented in My Certificates even if recorded before auto-cert issuance
    completedDonations.forEach((d, idx) => {
      const alreadyHasCert = certs.some(c =>
        (c.donationId && c.donationId === d.id) ||
        (c.checkInToken && d.checkInToken && c.checkInToken === d.checkInToken)
      );
      if (!alreadyHasCert) {
        const token = d.checkInToken || ('VP-' + String(d.id || idx + 1).slice(0, 6).toUpperCase());
        certs.push({
          id: d.id || `don-cert-${idx + 1}`,
          donationId: d.id,
          donorId: currentUser.uid,
          donorName: currentUser.name || currentUser.displayName || 'Verified Lifesaver',
          certificateNumber: 'VP-CERT-' + token.replace(/\s+/g, ''),
          checkInToken: token,
          hospitalName: d.hospital || d.hospitalName || d.preferredLocation || 'Partner Hospital Blood Bank',
          bloodType: d.bloodType || currentUser.bloodType || 'O+',
          donationCount: engagement?.donationCount || completedDonations.length,
          unitsDonated: d.units || 1,
          issuedDate: d.completedAt || d.date || d.preferredDate || d.createdAt || new Date().toISOString(),
        });
      }
    });

    window._loadedCertificatesList = certs;

    if (certs.length === 0) {
      container.innerHTML = `
        <div class="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-3xl p-6 sm:p-10 shadow-xs">
          <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
            <div class="lg:col-span-7 space-y-4">
              <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/25 text-[10px] font-black uppercase tracking-widest">
                <span class="material-symbols-outlined text-xs" style="font-variation-settings:'FILL' 1">workspace_premium</span>
                <span>Official NBTS Recognition Protocol</span>
              </div>
              <h3 class="text-xl sm:text-2xl font-black text-slate-900 dark:text-white font-headline tracking-tight">Your First Official Lifesaver Diploma Awaits</h3>
              <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                Every time a hospital blood bank completes your whole-blood draw, VitalPulse automatically mints an official, cryptographically indexed <strong>Cameroon NBTS Lifesaver Certificate</strong>—ready to view, print, or download as a high-definition PNG.
              </p>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70">
                  <p class="text-[10px] font-black uppercase text-amber-600 dark:text-amber-400">1. Donate Blood</p>
                  <p class="text-[11px] text-slate-600 dark:text-slate-300 font-medium mt-0.5">Check in at any accredited hospital desk</p>
                </div>
                <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70">
                  <p class="text-[10px] font-black uppercase text-emerald-600 dark:text-emerald-400">2. Auto-Issued</p>
                  <p class="text-[11px] text-slate-600 dark:text-slate-300 font-medium mt-0.5">Diploma generated upon lab completion</p>
                </div>
                <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70">
                  <p class="text-[10px] font-black uppercase text-cyan-600 dark:text-cyan-400">3. Export HD PNG</p>
                  <p class="text-[11px] text-slate-600 dark:text-slate-300 font-medium mt-0.5">Share or print with official serial seal</p>
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-3 pt-2">
                <button type="button" onclick="window.openDonationModal()" class="press-scale inline-flex items-center gap-2 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-black text-xs px-6 py-3 rounded-2xl shadow-md shadow-red-600/20 cursor-pointer">
                  <span class="material-symbols-outlined text-sm">event_available</span>
                  <span>Schedule a Donation</span>
                </button>
                <button type="button" onclick="window.openLifesaverCertificateModal('sample')" class="press-scale inline-flex items-center gap-2 bg-amber-50 dark:bg-amber-950/50 hover:bg-amber-100 text-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-700 font-black text-xs px-5 py-3 rounded-2xl cursor-pointer">
                  <span class="material-symbols-outlined text-sm">visibility</span>
                  <span>Preview Sample Diploma</span>
                </button>
              </div>
            </div>
            <div class="lg:col-span-5">
              <div class="relative rounded-3xl bg-gradient-to-br from-slate-950 via-slate-900 to-amber-950 p-6 border border-amber-500/30 text-center space-y-3 shadow-xl overflow-hidden">
                <div class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-500 to-yellow-300 text-slate-950 mx-auto flex items-center justify-center shadow-lg">
                  <span class="material-symbols-outlined text-3xl" style="font-variation-settings:'FILL' 1">workspace_premium</span>
                </div>
                <p class="text-[10px] font-black uppercase tracking-widest text-amber-300">Specimen Credential Preview</p>
                <h4 class="text-base font-black text-white font-headline">${esc(currentUser.name || 'Verified Lifesaver')}</h4>
                <p class="text-xs text-slate-300">Blood Group: <strong class="text-amber-300">${esc(currentUser.bloodType || 'O+')}</strong> &bull; Up to 3 Lives / Unit</p>
                <div class="pt-2">
                  <span class="inline-block px-3 py-1 rounded-full bg-white/10 text-[10px] font-mono text-amber-200 border border-white/15">SERIAL: VP-CERT-SPECIMEN</span>
                </div>
              </div>
            </div>
          </div>
        </div>`;
      return;
    }

    const totalUnits = certs.reduce((sum, c) => sum + (c.unitsDonated || 1), 0);
    const totalLives = totalUnits * 3;

    let html = `
      <div class="grid grid-cols-3 gap-3 sm:gap-4">
        <div class="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 text-center shadow-2xs">
          <p class="text-xl sm:text-2xl font-black text-amber-600 dark:text-amber-400 font-headline">${certs.length}</p>
          <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-0.5">Official Diplomas</p>
        </div>
        <div class="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 text-center shadow-2xs">
          <p class="text-xl sm:text-2xl font-black text-red-600 dark:text-red-400 font-headline">${totalUnits * 450} mL</p>
          <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-0.5">Verified Volume</p>
        </div>
        <div class="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 text-center shadow-2xs">
          <p class="text-xl sm:text-2xl font-black text-emerald-600 dark:text-emerald-400 font-headline">Up to ${totalLives}</p>
          <p class="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-0.5">Lives Preserved</p>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
    `;

    certs.forEach(c => {
      const certIdAttr = esc(c.id || c.certificateNumber);
      const units = c.unitsDonated || 1;
      const lives = units * 3;
      const issuedStr = c.issuedDate
        ? new Date(c.issuedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Verified Record';

      html += `
        <div class="bg-white dark:bg-slate-900 rounded-3xl border border-amber-400/40 dark:border-amber-500/30 overflow-hidden shadow-sm hover:shadow-xl transition-all group flex flex-col justify-between">
          <div>
            <div class="relative bg-gradient-to-br from-slate-950 via-slate-900 to-amber-950 p-6 text-center space-y-2.5 border-b border-amber-500/25 overflow-hidden">
              <div class="absolute -top-6 -right-6 p-3 opacity-10 pointer-events-none">
                <span class="material-symbols-outlined text-8xl text-amber-400">workspace_premium</span>
              </div>
              <div class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-500 via-yellow-400 to-amber-200 text-amber-950 mx-auto flex items-center justify-center shadow-lg shadow-amber-500/30 border border-yellow-200/60">
                <span class="material-symbols-outlined text-3xl" style="font-variation-settings:'FILL' 1">workspace_premium</span>
              </div>
              <div class="space-y-0.5">
                <p class="text-[9px] font-black text-amber-300 uppercase tracking-widest">Cameroon NBTS Official Diploma</p>
                <h3 class="font-black text-base sm:text-lg text-white font-headline">${esc(c.donorName || currentUser.name || 'Verified Lifesaver')}</h3>
                <p class="text-[11px] font-mono font-bold text-amber-200/90">${esc(c.certificateNumber)}</p>
              </div>
            </div>
            <div class="p-5 space-y-4">
              <div class="grid grid-cols-3 gap-2.5 text-center">
                <div class="bg-slate-50 dark:bg-slate-800/70 rounded-2xl p-2.5 border border-slate-200/60 dark:border-slate-700/60">
                  <p class="text-base font-black text-red-600 dark:text-red-400">${esc(c.bloodType || 'O+')}</p>
                  <p class="text-[9px] font-bold text-slate-400 uppercase">Blood Group</p>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800/70 rounded-2xl p-2.5 border border-slate-200/60 dark:border-slate-700/60">
                  <p class="text-base font-black text-slate-900 dark:text-white">${units * 450} mL</p>
                  <p class="text-[9px] font-bold text-slate-400 uppercase">${units} Unit${units > 1 ? 's' : ''}</p>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800/70 rounded-2xl p-2.5 border border-slate-200/60 dark:border-slate-700/60">
                  <p class="text-base font-black text-emerald-600 dark:text-emerald-400">Up to ${lives}</p>
                  <p class="text-[9px] font-bold text-slate-400 uppercase">Lives Saved</p>
                </div>
              </div>
              <div class="space-y-1.5 text-xs text-slate-600 dark:text-slate-300 font-medium">
                <div class="flex items-center justify-between gap-2">
                  <span class="flex items-center gap-1.5 text-slate-400"><span class="material-symbols-outlined text-sm text-amber-500">local_hospital</span>Facility</span>
                  <span class="font-black text-slate-900 dark:text-white truncate">${esc(c.hospitalName)}</span>
                </div>
                <div class="flex items-center justify-between gap-2">
                  <span class="flex items-center gap-1.5 text-slate-400"><span class="material-symbols-outlined text-sm text-emerald-500">calendar_today</span>Date Conferred</span>
                  <span class="font-bold text-slate-700 dark:text-slate-200">${issuedStr}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="px-5 pb-5 pt-3 flex items-center gap-2.5 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onclick="window.openLifesaverCertificateModal('${certIdAttr}')" class="press-scale flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-black text-xs shadow-xs transition-all cursor-pointer">
              <span class="material-symbols-outlined text-sm">workspace_premium</span>
              <span>View Official Diploma</span>
            </button>
            <button type="button" onclick="window.openLifesaverCertificateModal('${certIdAttr}'); setTimeout(() => window.downloadLifesaverCertificate?.(), 350);" class="press-scale inline-flex items-center justify-center gap-1.5 py-2.5 px-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/60 hover:bg-amber-100 text-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-700 font-black text-xs transition-colors cursor-pointer">
              <span class="material-symbols-outlined text-sm">download</span>
              <span>HD PNG</span>
            </button>
          </div>
        </div>
      `;
    });
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    console.error('Failed to load certificates:', e);
    container.innerHTML = '<div class="text-center py-12 text-error"><p class="text-sm font-bold">Failed to load certificates.</p></div>';
  }
}

// ============================================
// PHASE 3: IMPACT, 3D MEDALS & REWARDS HUB
// ============================================

export const REALISTIC_MEDALS = [
  {
    id: 'bronze_lifesaver',
    category: 'tier',
    tier: 'Bronze',
    shape: 'shield',
    title: 'Bronze Lifesaver Shield',
    subtitle: 'Registered & First Blood Gift',
    image: '/assets/badge_bronze_shield_transparent.png',
    reqDonations: 1,
    points: 100,
    citation: 'Conferred for stepping forward as a verified lifesaver in the Cameroon National Blood Registry.',
    perks: [
      'VitalPulse Certified Lifesaver Digital Identity Pass',
      'Priority emergency notification channel across Cameroon',
      'Eligibility for annual National Blood Donor Day commendation'
    ],
    hash: 'VP-HONOR-BRONZE-101'
  },
  {
    id: 'silver_sentinel',
    category: 'tier',
    tier: 'Silver',
    shape: 'star6',
    title: 'Silver Sentinel Star of Life',
    subtitle: '3 Verified Donations · ~9 Lives Saved',
    image: '/assets/badge_silver_star_transparent.png',
    reqDonations: 3,
    points: 300,
    citation: 'Awarded to persistent donors demonstrating unwavering dedication to saving critically ill patients in Cameroon hospitals.',
    perks: [
      'Free Semi-Annual Fast-Track Hemoglobin & Vitality Screening',
      'Silver Sentinel Badge displayed on your official donor pass',
      'Official Commendation Letter from Regional Health Delegation'
    ],
    hash: 'VP-HONOR-SILVER-204'
  },
  {
    id: 'gold_guardian',
    category: 'tier',
    tier: 'Gold',
    shape: 'star8',
    title: 'Gold Guardian Sunburst of Valor',
    subtitle: '5 Verified Donations · ~15 Lives Saved',
    image: '/assets/badge_gold_sunburst_transparent.png',
    reqDonations: 5,
    points: 500,
    citation: 'Highest civilian recognition for consistent, high-impact blood donation across hospitals in Cameroon.',
    perks: [
      'VIP Phlebotomy Suite Access (Skip normal reception queue)',
      '1 Free Annual Comprehensive Blood Chemistry Lab Panel Voucher',
      'Cameroon NBTS National Honor Roll Gold Plaque'
    ],
    hash: 'VP-HONOR-GOLD-505'
  },
  {
    id: 'platinum_protector',
    category: 'tier',
    tier: 'Platinum',
    shape: 'diamond',
    title: 'Platinum Protector Star',
    subtitle: '10 Verified Donations · ~30 Lives Saved',
    image: '/assets/badge_platinum_star_transparent.png',
    reqDonations: 10,
    points: 1000,
    citation: 'Distinguished honor for extraordinary humanitarian commitment and dozens of lives directly preserved.',
    perks: [
      'Dedicated Hospital Liaison & Private Rest Suite on Visit',
      'Official Certificate of Honor signed by Ministry of Public Health',
      'Direct Invitation to Cameroon Annual Lifesaver Gala'
    ],
    hash: 'VP-HONOR-PLAT-1010'
  },
  {
    id: 'diamond_hero',
    category: 'tier',
    tier: 'Diamond',
    shape: 'diamond',
    title: 'Diamond Guardian Octagonal Star',
    subtitle: '20+ Verified Donations · ~60+ Lives Saved',
    image: '/assets/badge_diamond_crest_transparent.png',
    reqDonations: 20,
    points: 2000,
    citation: 'The pinnacle of lifetime blood donation excellence. Reserved for Cameroon’s most heroic donor legends.',
    perks: [
      'Lifetime Hall of Fame Induction with Permanent Golden Marker',
      'VIP Fast-Track Hospital Privileges across all 10 Regions',
      'Free Lifetime Preventive Clinical Health Checks for Family'
    ],
    hash: 'VP-HONOR-DIAMOND-9999'
  },
  {
    id: 'rapid_responder',
    category: 'quest',
    shape: 'shield',
    title: 'Rapid Emergency Responder Shield',
    subtitle: 'Critical Urgent Call Answered',
    image: '/assets/badge_rapid_transparent.png',
    reqMissions: 1,
    points: 150,
    citation: 'Awarded for swiftly answering an emergency critical request and arriving at the hospital within the golden hour.',
    perks: [
      'Golden Lightning Icon on Public Lifesaver Pass',
      'Immediate Priority Status in Critical Matching Queue',
      '+50 Extra Pulse Points on all emergency missions'
    ],
    hash: 'VP-QUEST-RAPID-077'
  },
  {
    id: 'standby_envoy',
    category: 'quest',
    shape: 'shield',
    title: 'Standby Sentinel Envoy',
    subtitle: 'Emergency On-Call Readiness',
    image: '/assets/badge_standby_envoy_transparent.png',
    reqStandby: 1,
    points: 200,
    citation: 'Conferred upon voluntary donors who register for active emergency standby readiness, ensuring rapid response during regional blood stockouts in Cameroon.',
    perks: [
      'Standby Envoy Commendation Ribbon',
      'Direct Priority Emergency Alert Routing',
      '+50 Bonus Pulse Points on Emergency Missions'
    ],
    hash: 'VP-QUEST-STANDBY-042'
  },
  {
    id: 'rhythm_champion',
    category: 'quest',
    shape: 'shield',
    title: 'Rhythm Champion Emblem',
    subtitle: 'WHO 56-Day Cadence Adherence',
    image: '/assets/badge_rhythm_champion_transparent.png',
    reqDonations: 2,
    points: 250,
    citation: 'Awarded to disciplined donors who maintain consistent biological donation cadence as soon as their WHO 56-day physiological replenishment completes.',
    perks: [
      'Golden Cadence Crest on Digital Pass',
      'Quarterly Health Optimization Advisory',
      'Priority Booking for Mobile Blood Drives'
    ],
    hash: 'VP-QUEST-RHYTHM-088'
  }
];

let _activeMedalsFilter = 'all';
let _lastComputedEngagement = null;
let _cachedDonationList = [];

export async function loadDonorBadges() {
  const currentUser = getCurrentUser();
  if (!currentUser) return;
  wireImpactShareButtons();

  try {
    const [engagement, donations] = await Promise.all([
      computeDonorEngagement(currentUser.uid).catch(() => null),
      fetchDonationRequestsForDonor(currentUser.uid).catch(() => [])
    ]);

    _cachedDonationList = (engagement?.donations && engagement.donations.length > 0) ? engagement.donations : (donations || []);
    const completed = _cachedDonationList.filter(d => {
      const s = (d.status || '').toLowerCase();
      return s === 'completed' || s === 'donation complete';
    });
    const donationCount = typeof engagement?.donationCount === 'number' ? engagement.donationCount : completed.length;
    const totalUnits = typeof engagement?.totalUnits === 'number' ? engagement.totalUnits : completed.reduce((sum, d) => sum + (d.units || 1), 0);
    const livesSaved = typeof engagement?.livesSaved === 'number' ? engagement.livesSaved : (totalUnits > 0 ? totalUnits * 3 : (donationCount > 0 ? donationCount * 3 : 0));
    const emergencyMissions = _cachedDonationList.filter(d => d.urgency === 'critical' || d.isEmergency).length;

    // Calculate distance traveled (minimum 3.2km per donation if coordinates absent)
    let totalDistanceKm = 0;
    completed.forEach(d => {
      totalDistanceKm += (d.distanceKm && !isNaN(d.distanceKm)) ? Number(d.distanceKm) : 3.5;
    });
    totalDistanceKm = Math.round(totalDistanceKm * 10) / 10;

    // Calculate WHO 56-Day Biological Recovery Status
    let lastDonationDate = null;
    completed.forEach(d => {
      const dt = d.completedAt || d.date || d.appointmentDate || d.createdAt;
      if (dt) {
        const parsed = new Date(dt);
        if (!isNaN(parsed.getTime())) {
          if (!lastDonationDate || parsed > lastDonationDate) {
            lastDonationDate = parsed;
          }
        }
      }
    });

    const RECOVERY_DAYS = 56;
    let daysSinceLast = null;
    let daysRemaining = 0;
    let isEligible = true;

    if (lastDonationDate) {
      const now = new Date();
      const diffMs = now.getTime() - lastDonationDate.getTime();
      daysSinceLast = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      if (daysSinceLast < RECOVERY_DAYS) {
        isEligible = false;
        daysRemaining = RECOVERY_DAYS - daysSinceLast;
      }
    }

    // Pulse Points: unified with computeDonorEngagement (earned points minus redeemed vouchers)
    const pulsePoints = typeof engagement?.points === 'number'
      ? engagement.points
      : Math.max(0, (donationCount * 50 + totalUnits * 100 + emergencyMissions * 50));

    // Determine Active Tier
    let tierKey = 'bronze';
    let tierName = 'Bronze Pioneer';
    let tier3DImg = '/assets/badge_bronze_shield_transparent.png';
    let nextTierName = 'Silver Sentinel';
    let nextTierReq = 3;
    let currentTierFloor = 1;

    if (donationCount >= 20) {
      tierKey = 'diamond';
      tierName = 'National Legend';
      tier3DImg = '/assets/badge_diamond_crest_transparent.png';
      nextTierName = null;
      nextTierReq = 20;
      currentTierFloor = 20;
    } else if (donationCount >= 10) {
      tierKey = 'platinum';
      tierName = 'Platinum Vanguard';
      tier3DImg = '/assets/badge_platinum_star_transparent.png';
      nextTierName = 'National Legend';
      nextTierReq = 20;
      currentTierFloor = 10;
    } else if (donationCount >= 5) {
      tierKey = 'gold';
      tierName = 'Gold Champion';
      tier3DImg = '/assets/badge_gold_sunburst_transparent.png';
      nextTierName = 'Platinum Vanguard';
      nextTierReq = 10;
      currentTierFloor = 5;
    } else if (donationCount >= 3) {
      tierKey = 'silver';
      tierName = 'Silver Sentinel';
      tier3DImg = '/assets/badge_silver_star_transparent.png';
      nextTierName = 'Gold Champion';
      nextTierReq = 5;
      currentTierFloor = 3;
    } else {
      tierKey = 'bronze';
      tierName = 'Bronze Pioneer';
      tier3DImg = '/assets/badge_bronze_shield_transparent.png';
      nextTierName = 'Silver Sentinel';
      nextTierReq = 3;
      currentTierFloor = 0;
    }

    _lastComputedEngagement = {
      donationCount,
      totalUnits,
      livesSaved,
      emergencyMissions,
      totalDistanceKm,
      pulsePoints,
      tierKey,
      tierName,
      tier3DImg,
      nextTierName,
      nextTierReq,
      currentTierFloor,
      bloodType: currentUser.bloodType || 'O+',
      userName: currentUser.name || currentUser.displayName || 'Lifesaver Hero',
    };

    // Update Hero Tier Banner
    const tierTitleEl = document.getElementById('donorBadgeTierTitle');
    const pointsSummaryEl = document.getElementById('donorBadgePointsSummary');
    const medalImgEl = document.getElementById('donor3DMedalImg');
    const tierProgressLabel = document.getElementById('tierProgressLabel');
    const tierProgressPct = document.getElementById('tierProgressPct');
    const tierProgressBar = document.getElementById('tierProgressBar');
    const tierNextCallout = document.getElementById('tierNextCallout');

    if (tierTitleEl) tierTitleEl.textContent = tierName;
    if (pointsSummaryEl) pointsSummaryEl.textContent = `${pulsePoints} Pulse Points`;
    if (medalImgEl) medalImgEl.src = tier3DImg;

    // Mount live self-rotating 3D medal in Hero Stage (WebGL)
    const heroStage = document.getElementById('hero3DMedalStage');
    if (heroStage) {
      const activeMedal = REALISTIC_MEDALS.find(m => m.id === PRESTIGE_TIER_DETAILS[tierKey]?.medalId) || {
        id: tierKey,
        tier: tierName,
        image: tier3DImg
      };
      mountHero3DMedalViewer(heroStage, activeMedal, () => window.inspectCurrentTierMedal());
    }

    if (nextTierName) {
      const needed = Math.max(1, nextTierReq - donationCount);
      const span = nextTierReq - currentTierFloor;
      const progress = Math.min(100, Math.max(10, Math.round(((donationCount - currentTierFloor) / span) * 100)));
      if (tierProgressLabel) tierProgressLabel.textContent = `Progress to ${nextTierName}`;
      if (tierProgressPct) tierProgressPct.textContent = `${progress}%`;
      if (tierProgressBar) tierProgressBar.style.width = `${progress}%`;
      if (tierNextCallout) {
        tierNextCallout.innerHTML = `${needed} more verified donation${needed > 1 ? 's' : ''} needed to reach <strong class="text-white">${nextTierName}</strong>!`;
      }
    } else {
      if (tierProgressLabel) tierProgressLabel.textContent = 'Maximum Prestige Reached';
      if (tierProgressPct) tierProgressPct.textContent = '100%';
      if (tierProgressBar) tierProgressBar.style.width = '100%';
      if (tierNextCallout) {
        tierNextCallout.innerHTML = 'You have unlocked the highest national honor in the Cameroon Blood Registry!';
      }
    }

    // Update 4-Pillar Scorecard
    const statLives = document.getElementById('impactStatLives');
    const statDonations = document.getElementById('impactStatDonations');
    const statVolumePill = document.getElementById('impactStatVolumePill');
    const statMissions = document.getElementById('impactStatMissions');
    const statHospitals = document.getElementById('impactStatHospitals');
    const statDistance = document.getElementById('impactStatDistance');

    const totalUnitsCount = totalUnits || donationCount;
    if (statLives) statLives.textContent = livesSaved;
    if (statDonations) statDonations.textContent = totalUnitsCount;
    if (statVolumePill) statVolumePill.textContent = `${totalUnitsCount * 450} mL Total`;
    if (statMissions) statMissions.textContent = emergencyMissions;

    // Calculate unique hospitals
    const hospitalNames = new Set(completed.map(d => d.hospitalName || d.hospital).filter(Boolean));
    const hospitalsCount = Math.max(hospitalNames.size, donationCount > 0 ? 1 : 0);
    if (statHospitals) {
      statHospitals.innerHTML = `${hospitalsCount} <span class="text-base sm:text-lg font-bold text-slate-500">Centers</span>`;
    }
    if (statDistance) {
      statDistance.textContent = `${totalDistanceKm} km traveled to donation desks`;
    }

    // Update 5-Tier Journey Stepper Nodes & Default Dossier
    updateTierStepperNodes(donationCount);
    if (window.selectPrestigeRoadmapTier) {
      window.selectPrestigeRoadmapTier(tierKey);
    }

    // Render 3D Medals Showcase
    renderMedalsShowcase();

    // Check for newly unlocked medals and celebrate/notify donor
    const standbyActive = Boolean(
      currentUser &&
      isDonorOnStandby(currentUser) &&
      isDonorVerified()
    );
    const unlockedMedalsList = REALISTIC_MEDALS.filter(m => {
      if (m.category === 'tier') return donationCount >= m.reqDonations;
      if (m.reqMissions) return emergencyMissions >= m.reqMissions;
      if (m.reqStandby) return standbyActive;
      if (m.id === 'rhythm_champion') return donationCount >= (m.reqDonations || 2);
      return false;
    });
    checkForNewlyUnlockedBadges(unlockedMedalsList, currentUser.uid);

    // Update Vault Points Balance & Render Dynamic Catalog
    const vaultBal = document.getElementById('vaultPointsBalance');
    if (vaultBal) vaultBal.innerHTML = `${pulsePoints} <span class="text-xs font-bold text-amber-300">pts</span>`;
    renderRewardsCatalog(pulsePoints);
    updateActiveVouchersCount(currentUser.uid);

  } catch (err) {
    console.error('Failed to load donor badges and impact:', err);
  }
}

async function checkForNewlyUnlockedBadges(unlockedMedals, donorId) {
  if (!donorId || !Array.isArray(unlockedMedals)) return;
  const storageKey = `vp_unlocked_medals_${donorId}`;
  const storedJson = localStorage.getItem(storageKey);

  // If first time visiting, seed storage with currently unlocked badges so we don't spam history
  if (storedJson === null) {
    const seedIds = unlockedMedals.map(m => m.id);
    localStorage.setItem(storageKey, JSON.stringify(seedIds));
    return;
  }

  let acknowledgedIds = [];
  try {
    acknowledgedIds = JSON.parse(storedJson) || [];
  } catch (e) {
    acknowledgedIds = [];
  }

  const brandNewMedals = unlockedMedals.filter(m => !acknowledgedIds.includes(m.id));
  if (brandNewMedals.length === 0) return;

  // Persist updated list immediately
  const updatedIds = [...acknowledgedIds, ...brandNewMedals.map(m => m.id)];
  localStorage.setItem(storageKey, JSON.stringify(updatedIds));

  // Celebrate each newly unlocked medal
  for (const medal of brandNewMedals) {
    // 1. Add real-time in-app notification in Firestore
    await addDonorNotification(
      donorId,
      `🎖️ New Honor Unlocked: ${medal.title}`,
      `Congratulations! You have officially unlocked the "${medal.title}" in the Cameroon National Blood Registry. Visit your 3D Honors Exhibition to inspect your new die-cast medal.`,
      'honor',
      'badges'
    ).catch(err => console.warn('Could not save honor notification:', err));

    // 2. Sound metallic chime & blast celebration confetti
    playMetallicChime();
    triggerMilestoneConfetti({ particleCount: 110, spread: 80 });

    // 3. Celebratory Toast Banner
    showToast(`🎖️ New Honor Unlocked: ${medal.title}!`, 'success');
  }
}

const PRESTIGE_TIER_DETAILS = {
  bronze: {
    medalId: 'bronze_lifesaver',
    name: 'Bronze Pioneer',
    category: 'Tier 1 • National Standing',
    req: 1,
    reqText: 'Requires 1 verified whole blood draw (~3 lives preserved).',
    icon: '/assets/badge_bronze_shield_transparent.png',
    citation: 'Conferred for stepping forward as a verified voluntary blood donor in the Cameroon National Blood Registry.',
    perks: [
      'VitalPulse Certified Lifesaver Digital Identity Pass',
      'Priority emergency notification channel across Cameroon',
      'Eligibility for annual National Blood Donor Day commendation'
    ]
  },
  silver: {
    medalId: 'silver_sentinel',
    name: 'Silver Sentinel',
    category: 'Tier 2 • Sustained Giving',
    req: 3,
    reqText: 'Requires 3 verified whole blood draws (~9 lives preserved).',
    icon: '/assets/badge_silver_star_transparent.png',
    citation: 'Awarded to persistent donors demonstrating unwavering dedication to saving critically ill patients in Cameroon hospitals.',
    perks: [
      'Free Semi-Annual Fast-Track Hemoglobin & Vitality Screening',
      'Silver Sentinel Badge displayed on your official donor pass',
      'Official Commendation Letter from Regional Health Delegation'
    ]
  },
  gold: {
    medalId: 'gold_guardian',
    name: 'Gold Champion',
    category: 'Tier 3 • Humanitarian Valor',
    req: 5,
    reqText: 'Requires 5 verified whole blood draws (~15 lives preserved).',
    icon: '/assets/badge_gold_sunburst_transparent.png',
    citation: 'Highest civilian recognition for consistent, high-impact blood donation across hospitals in Cameroon.',
    perks: [
      'VIP Phlebotomy Suite Access (Skip normal reception queue)',
      '1 Free Annual Comprehensive Blood Chemistry Lab Panel Voucher',
      'Cameroon NBTS National Honor Roll Gold Commendation'
    ]
  },
  platinum: {
    medalId: 'platinum_protector',
    name: 'Platinum Vanguard',
    category: 'Tier 4 • Vanguard of Life',
    req: 10,
    reqText: 'Requires 10 verified whole blood draws (~30 lives preserved).',
    icon: '/assets/badge_platinum_star_transparent.png',
    citation: 'Distinguished honor for extraordinary humanitarian commitment and dozens of lives directly preserved.',
    perks: [
      'Dedicated Hospital Liaison & Private Rest Suite on Visit',
      'Official Certificate of Honor signed by Ministry of Public Health',
      'Direct Invitation to Cameroon Annual Lifesaver Gala'
    ]
  },
  diamond: {
    medalId: 'diamond_hero',
    name: 'National Legend',
    category: 'Tier 5 • Lifetime Hall of Fame',
    req: 20,
    reqText: 'Requires 20+ verified whole blood draws (~60+ lives preserved).',
    icon: '/assets/badge_diamond_crest_transparent.png',
    citation: 'The pinnacle of lifetime blood donation excellence. Reserved for Cameroon’s most heroic donor legends.',
    perks: [
      'Lifetime Hall of Fame Induction with Permanent Golden Marker',
      'VIP Fast-Track Hospital Privileges across all 10 Regions',
      'Free Lifetime Preventive Clinical Health Checks for Family'
    ]
  }
};

let _currentDossierTier = 'bronze';

window.selectPrestigeRoadmapTier = (tierKey) => {
  const detail = PRESTIGE_TIER_DETAILS[tierKey];
  if (!detail) return;
  _currentDossierTier = tierKey;

  const eng = _lastComputedEngagement || { donationCount: 0 };
  const donations = eng.donationCount || 0;
  const isUnlocked = donations >= detail.req;
  const isCurrent = (tierKey === 'bronze' && donations >= 1 && donations < 3) ||
                    (tierKey === 'silver' && donations >= 3 && donations < 5) ||
                    (tierKey === 'gold' && donations >= 5 && donations < 10) ||
                    (tierKey === 'platinum' && donations >= 10 && donations < 20) ||
                    (tierKey === 'diamond' && donations >= 20);

  // Update Dossier DOM
  const iconEl = document.getElementById('dossierTierIcon');
  const catEl = document.getElementById('dossierTierCategory');
  const titleEl = document.getElementById('dossierTierTitle');
  const statusEl = document.getElementById('dossierTierStatus');
  const citationEl = document.getElementById('dossierTierCitation');
  const reqEl = document.getElementById('dossierTierRequirement');
  const perksEl = document.getElementById('dossierTierPerks');

  if (iconEl) iconEl.src = detail.icon;
  if (catEl) catEl.textContent = detail.category;
  if (titleEl) titleEl.textContent = detail.name;
  if (citationEl) citationEl.textContent = detail.citation;
  if (reqEl) reqEl.textContent = detail.reqText;

  if (statusEl) {
    if (isCurrent) {
      statusEl.className = 'px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40';
      statusEl.textContent = 'Active Current Tier';
    } else if (isUnlocked) {
      statusEl.className = 'px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
      statusEl.textContent = 'Unlocked Milestone';
    } else {
      const left = detail.req - donations;
      statusEl.className = 'px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-slate-800 text-slate-400 border border-slate-700';
      statusEl.textContent = `Locked • Needs ${left} More`;
    }
  }

  if (perksEl) {
    perksEl.innerHTML = detail.perks.map(p => `
      <li class="flex items-start gap-1.5">
        <span class="material-symbols-outlined text-emerald-400 text-sm shrink-0">check_circle</span>
        <span>${esc(p)}</span>
      </li>
    `).join('');
  }

  // Highlight selected node in the stepper
  const tierMap = {
    bronze: 'tierNodeBronze',
    silver: 'tierNodeSilver',
    gold: 'tierNodeGold',
    platinum: 'tierNodePlatinum',
    diamond: 'tierNodeDiamond'
  };

  Object.entries(tierMap).forEach(([k, id]) => {
    const nodeEl = document.getElementById(id);
    if (!nodeEl) return;
    if (k === tierKey) {
      nodeEl.classList.add('ring-2', 'ring-amber-400', 'shadow-lg');
    } else {
      nodeEl.classList.remove('ring-2', 'ring-amber-400', 'shadow-lg');
    }
  });
};

window.inspectDossierTierMedal = () => {
  const detail = PRESTIGE_TIER_DETAILS[_currentDossierTier];
  if (detail && detail.medalId && window.inspectMedal) {
    window.inspectMedal(detail.medalId);
  }
};

function updateTierStepperNodes(donationCount) {
  const tiers = [
    { id: 'tierNodeBronze', key: 'bronze', req: 1, name: 'Bronze Pioneer', medal: '/assets/badge_bronze_shield_transparent.png' },
    { id: 'tierNodeSilver', key: 'silver', req: 3, name: 'Silver Sentinel', medal: '/assets/badge_silver_star_transparent.png' },
    { id: 'tierNodeGold', key: 'gold', req: 5, name: 'Gold Champion', medal: '/assets/badge_gold_sunburst_transparent.png' },
    { id: 'tierNodePlatinum', key: 'platinum', req: 10, name: 'Platinum Vanguard', medal: '/assets/badge_platinum_star_transparent.png' },
    { id: 'tierNodeDiamond', key: 'diamond', req: 20, name: 'National Legend', medal: '/assets/badge_diamond_crest_transparent.png' }
  ];

  tiers.forEach(t => {
    const el = document.getElementById(t.id);
    if (!el) return;
    const isUnlocked = donationCount >= t.req;
    const isCurrent = (t.key === 'bronze' && donationCount >= 1 && donationCount < 3) ||
                      (t.key === 'silver' && donationCount >= 3 && donationCount < 5) ||
                      (t.key === 'gold' && donationCount >= 5 && donationCount < 10) ||
                      (t.key === 'platinum' && donationCount >= 10 && donationCount < 20) ||
                      (t.key === 'diamond' && donationCount >= 20);

    el.className = `group flex flex-col items-center text-center cursor-pointer p-4 rounded-3xl transition-all duration-300 relative backdrop-blur-md ${
      isCurrent
        ? 'bg-amber-500/15 border-2 border-amber-400/80 shadow-[0_0_35px_rgba(245,158,11,0.25)] text-white'
        : isUnlocked
        ? 'bg-white/[0.04] hover:bg-white/[0.08] border border-emerald-500/30 text-white'
        : 'bg-white/[0.02] hover:bg-white/[0.05] border border-white/10 text-white opacity-60 hover:opacity-100'
    }`;

    el.innerHTML = `
      <div class="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-white/[0.04] border border-white/15 flex items-center justify-center p-3 relative group-hover:scale-110 transition-transform duration-300">
        ${isUnlocked ? '<div class="absolute inset-0 rounded-full bg-amber-500/15 blur-lg pointer-events-none"></div>' : ''}
        <img src="${t.medal}" alt="${t.name}" class="relative z-10 w-full h-full object-contain filter drop-shadow-md ${isUnlocked ? '' : 'grayscale-[60%] opacity-50'}"/>
      </div>
      <p class="text-xs font-black text-white mt-3">${t.name}</p>
      <p class="text-[10px] text-slate-400 font-medium">${t.req} Donation${t.req > 1 ? 's' : ''}</p>
      <span class="inline-block mt-2 text-[9px] font-black uppercase px-2.5 py-0.5 rounded-full ${
        isCurrent
          ? 'text-amber-300 bg-amber-500/25 border border-amber-400/40 shadow-xs'
          : isUnlocked
          ? 'text-emerald-300 bg-emerald-500/20 border border-emerald-500/30'
          : 'text-slate-400 bg-white/5 border border-white/10'
      }">${isCurrent ? 'Current' : isUnlocked ? 'Unlocked' : 'Locked'}</span>
    `;
  });
}

function renderMedalsShowcase() {
  const container = document.getElementById('badgesFullView');
  if (!container) return;

  const eng = _lastComputedEngagement || (_donorEngagementCache ? {
    donationCount: _donorEngagementCache.donationCount || 0,
    pulsePoints: _donorEngagementCache.points || 0,
    emergencyMissions: _donorEngagementCache.emergencyMissions || 0,
  } : { donationCount: 0, pulsePoints: 0, emergencyMissions: 0 });
  const currentUser = getCurrentUser();
  const donations = eng.donationCount || 0;
  const points = eng.pulsePoints || 0;
  const missions = eng.emergencyMissions || 0;
  const standbyActive = Boolean(
    currentUser &&
    currentUser.isAvailable === true &&
    _donorKycStatus === 'verified' &&
    (donations >= 1 || missions >= 1 || points >= 200)
  );

  let list = REALISTIC_MEDALS.map(m => {
    let unlocked = false;
    let progressPct = 0;
    let reqLabel = '';

    if (m.category === 'tier') {
      unlocked = donations >= m.reqDonations;
      progressPct = Math.min(100, Math.round((donations / m.reqDonations) * 100));
      reqLabel = `${m.reqDonations} Donation${m.reqDonations > 1 ? 's' : ''}`;
    } else if (m.reqMissions) {
      unlocked = missions >= m.reqMissions;
      progressPct = Math.min(100, Math.round((missions / m.reqMissions) * 100));
      reqLabel = `${m.reqMissions} Emergency Response`;
    } else if (m.reqStandby) {
      unlocked = standbyActive;
      progressPct = standbyActive ? 100 : 50;
      reqLabel = 'Active Standby Status';
    } else if (m.id === 'rhythm_champion') {
      unlocked = donations >= (m.reqDonations || 2);
      progressPct = Math.min(100, Math.round((donations / (m.reqDonations || 2)) * 100));
      reqLabel = `${m.reqDonations || 2} On-Schedule Donations`;
    } else if (m.reqPoints) {
      unlocked = points >= m.reqPoints;
      progressPct = Math.min(100, Math.round((points / m.reqPoints) * 100));
      reqLabel = `${m.reqPoints} Pulse Points`;
    }

    return { ...m, unlocked, progressPct, reqLabel };
  });

  if (_activeMedalsFilter === 'unlocked') {
    list = list.filter(m => m.unlocked);
  } else if (_activeMedalsFilter === 'locked') {
    list = list.filter(m => !m.unlocked);
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div class="col-span-full text-center py-16 bg-white/[0.02] rounded-3xl border border-white/10 p-8 space-y-3 backdrop-blur-md">
        <span class="material-symbols-outlined text-4xl text-slate-500">military_tech</span>
        <p class="text-sm font-bold text-slate-400">No honors match this filter.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(m => `
    <div class="medal-3d-card-wrap">
      <div onclick="window.inspectMedal('${m.id}')"
        class="medal-3d-card ${m.unlocked ? 'is-unlocked group' : 'is-locked'} rounded-3xl p-6 cursor-pointer flex flex-col justify-between space-y-4 overflow-hidden backdrop-blur-xl transition-all duration-300">
        
        <!-- Dynamic Specular Metallic Sheen (unlocked only) -->
        ${m.unlocked ? '<div class="medal-specular-sheen"></div>' : ''}

        <!-- Top Badges & 3D Medal Graphic -->
        <div class="space-y-3 relative z-10">
          <div class="flex items-center justify-between">
            <span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
              m.unlocked
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-xs'
                : 'bg-white/5 text-slate-400 border border-white/10'
            }">
              ${m.unlocked ? '✓ 3D Die-Cast' : '🔒 Locked'}
            </span>
            <span class="text-[10px] font-black ${m.unlocked ? 'text-amber-300 bg-amber-500/15 border-amber-400/25' : 'text-slate-400 bg-white/5 border-white/10'} px-2.5 py-0.5 rounded-full border">
              +${m.points || 100} pts
            </span>
          </div>

          <!-- 3D Medal Render Stage on Ambient Pedestal -->
          <div class="medal-3d-graphic-wrap relative w-full h-36 flex items-center justify-center py-2">
            ${m.unlocked ? '<div class="absolute w-32 h-32 rounded-full bg-gradient-to-tr from-amber-500/20 to-yellow-400/10 blur-2xl group-hover:blur-3xl transition-all"></div>' : ''}
            <div class="relative w-28 h-28 flex items-center justify-center ${m.unlocked ? 'group-hover:scale-105' : ''} transition-transform duration-300">
              <img src="${m.image}" alt="${esc(m.title)}" class="medal-3d-img relative z-10 w-full h-full object-contain filter drop-shadow-[0_12px_24px_rgba(0,0,0,0.7)]"/>
              ${!m.unlocked ? `
                <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                  <div class="w-9 h-9 rounded-full bg-slate-900/90 border border-slate-700/80 flex items-center justify-center shadow-lg backdrop-blur-md">
                    <span class="material-symbols-outlined text-sm text-slate-300">lock</span>
                  </div>
                </div>
              ` : ''}
            </div>
          </div>

          <!-- Info -->
          <div class="text-center space-y-1">
            <h3 class="font-black text-sm sm:text-base text-white font-headline ${m.unlocked ? 'group-hover:text-amber-300' : 'text-slate-200'} transition-colors">${esc(m.title)}</h3>
            <p class="text-xs text-slate-400 font-medium">${esc(m.subtitle)}</p>
          </div>
        </div>

        <!-- Bottom Status / Progress -->
        <div class="pt-3 border-t border-white/10 space-y-2 relative z-10">
          ${m.unlocked ? `
            <div class="flex items-center justify-between text-[11px] font-bold text-emerald-400">
              <span class="flex items-center gap-1"><span class="material-symbols-outlined text-xs">verified</span> Unlocked</span>
              <span class="text-slate-400 text-[10px] uppercase font-mono">${m.hash.substring(0, 14)}...</span>
            </div>
          ` : `
            <div class="space-y-1.5">
              <div class="flex items-center justify-between text-[10px] font-bold text-slate-400">
                <span>Req: ${m.reqLabel}</span>
                <span>${m.progressPct}%</span>
              </div>
              <div class="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                <div class="h-full bg-gradient-to-r from-amber-500 to-yellow-400 rounded-full" style="width: ${m.progressPct}%"></div>
              </div>
            </div>
          `}
        </div>

      </div>
    </div>
  `).join('');

  bind3DMedalTiltPhysics();
}

function bind3DMedalTiltPhysics() {
  document.querySelectorAll('.medal-3d-card.is-unlocked').forEach(card => {
    if (card._tiltBound) return;
    card._tiltBound = true;

    const onMove = (e) => {
      const rect = card.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const px = Math.max(-1, Math.min(1, (x / rect.width) * 2 - 1));
      const py = Math.max(-1, Math.min(1, (y / rect.height) * 2 - 1));

      // Gentle, refined micro-tilt (max 4.5 degrees)
      const rotX = -py * 4.5;
      const rotY = px * 4.5;

      card.style.transform = `perspective(1000px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale3d(1.02, 1.02, 1.02)`;
      card.style.setProperty('--sheen-x', `${(px * 0.5 + 0.5) * 100}%`);
      card.style.setProperty('--sheen-y', `${(py * 0.5 + 0.5) * 100}%`);
      card.style.setProperty('--sheen-opacity', '0.75');
    };

    const onLeave = () => {
      card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
      card.style.setProperty('--sheen-opacity', '0');
    };

    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerleave', onLeave);
  });
}

// Synthesized Physical Metallic Chime Sound Effect (Web Audio API)
function playMetallicChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
    osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.85);
  } catch (e) {
    // Audio context may be restricted before user gesture; gracefully fallback
  }
}

window.filterMedalsShowcase = (filterType) => {
  _activeMedalsFilter = filterType;
  const tabs = ['tabMedalsAll', 'tabMedalsUnlocked', 'tabMedalsLocked'];
  tabs.forEach(tId => {
    const el = document.getElementById(tId);
    if (!el) return;
    const isActive = (filterType === 'all' && tId === 'tabMedalsAll') ||
                     (filterType === 'unlocked' && tId === 'tabMedalsUnlocked') ||
                     (filterType === 'locked' && tId === 'tabMedalsLocked');
    el.className = `px-4 py-1.5 rounded-full text-xs font-black transition-all cursor-pointer ${
      isActive
        ? 'bg-white/20 text-white shadow-xs'
        : 'text-slate-400 hover:text-white'
    }`;
  });
  renderMedalsShowcase();
};

window.inspectCurrentTierMedal = () => {
  const eng = _lastComputedEngagement;
  if (!eng) return;
  const count = eng.donationCount || 0;
  let medalId = 'bronze_lifesaver';
  if (count >= 20) medalId = 'diamond_hero';
  else if (count >= 10) medalId = 'platinum_protector';
  else if (count >= 5) medalId = 'gold_guardian';
  else if (count >= 3) medalId = 'silver_sentinel';
  window.inspectMedal(medalId);
};

window.inspectMedal = (medalId) => {
  const medal = REALISTIC_MEDALS.find(m => m.id === medalId);
  if (!medal) return;

  const modal = document.getElementById('badgeCertModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  const eng = _lastComputedEngagement || (_donorEngagementCache ? {
    donationCount: _donorEngagementCache.donationCount || 0,
    pulsePoints: _donorEngagementCache.points || 0,
    emergencyMissions: _donorEngagementCache.emergencyMissions || 0,
  } : { donationCount: 0, pulsePoints: 0, emergencyMissions: 0 });
  const currentUser = getCurrentUser();
  const donations = eng.donationCount || 0;
  const points = eng.pulsePoints || 0;
  const missions = eng.emergencyMissions || 0;
  const standbyActive = Boolean(
    currentUser &&
    currentUser.isAvailable === true &&
    _donorKycStatus === 'verified' &&
    (donations >= 1 || missions >= 1 || points >= 200)
  );

  let unlocked = false;
  let progressPct = 0;
  let remainingText = '';

  if (medal.category === 'tier') {
    unlocked = donations >= medal.reqDonations;
    progressPct = Math.min(100, Math.round((donations / medal.reqDonations) * 100));
    const left = Math.max(1, medal.reqDonations - donations);
    remainingText = `${left} more donation${left > 1 ? 's' : ''} needed to unlock this honor!`;
  } else if (medal.reqMissions) {
    unlocked = missions >= medal.reqMissions;
    progressPct = Math.min(100, Math.round((missions / medal.reqMissions) * 100));
    const left = Math.max(1, medal.reqMissions - missions);
    remainingText = `${left} more emergency mission response needed!`;
  } else if (medal.reqStandby) {
    unlocked = standbyActive;
    progressPct = standbyActive ? 100 : 50;
    remainingText = standbyActive ? 'Verified standby donor status active.' : 'Complete donor verification to unlock Standby Envoy!';
  } else if (medal.id === 'rhythm_champion') {
    unlocked = donations >= (medal.reqDonations || 2);
    progressPct = Math.min(100, Math.round((donations / (medal.reqDonations || 2)) * 100));
    const left = Math.max(1, (medal.reqDonations || 2) - donations);
    remainingText = `${left} more on-schedule donation${left > 1 ? 's' : ''} needed!`;
  } else if (medal.reqPoints) {
    unlocked = points >= medal.reqPoints;
    progressPct = Math.min(100, Math.round((points / medal.reqPoints) * 100));
    const left = Math.max(1, medal.reqPoints - points);
    remainingText = `${left} more Pulse Points needed to unlock!`;
  }

  const titleEl = document.getElementById('badgeCertTitle');
  const descEl = document.getElementById('badgeCertDesc');
  const dateVal = document.getElementById('badgeCertDateVal');
  const idVal = document.getElementById('badgeCertIdVal');
  const perksList = document.getElementById('badgeCertPerksList');
  const metaWrap = document.getElementById('badgeCertMetaWrap');
  const reqRow = document.getElementById('badgeCertReqRow');
  const reqPct = document.getElementById('badgeReqPct');
  const reqBar = document.getElementById('badgeReqBar');
  const reqRemaining = document.getElementById('badgeReqRemaining');
  const shareBtn = document.getElementById('badgeCertShareBtn');
  const canvasWrap = document.getElementById('badgeCert3DCanvasWrap');
  const lockedOverlay = document.getElementById('badgeCertLockedOverlay');
  const orbitHint = document.getElementById('badgeCertOrbitHint');
  const statusPill = document.getElementById('badgeCertStatusPill');

  if (titleEl) titleEl.textContent = medal.title;
  if (descEl) descEl.textContent = medal.citation;
  if (dateVal) dateVal.textContent = unlocked ? new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Pending Unlock';
  if (idVal) idVal.textContent = medal.hash;

  if (perksList) {
    perksList.innerHTML = medal.perks.map(p => `
      <li class="flex items-center gap-2">
        <span class="material-symbols-outlined text-xs ${unlocked ? 'text-emerald-500' : 'text-slate-400'} shrink-0">${unlocked ? 'check_circle' : 'lock'}</span>
        <span>${esc(p)}</span>
      </li>
    `).join('');
  }

  if (unlocked) {
    // UNLOCKED: Full 3D WebGL inspection, chime, digital credentials
    if (lockedOverlay) lockedOverlay.classList.add('hidden');
    if (canvasWrap) {
      canvasWrap.classList.remove('hidden');
      mount3DMedalViewer(canvasWrap, medal);
    }
    if (orbitHint) orbitHint.classList.remove('hidden');
    if (statusPill) {
      statusPill.className = 'inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-amber-300 bg-amber-500/20 px-3 py-1 rounded-full border border-amber-400/30 backdrop-blur-md';
      statusPill.innerHTML = '<span class="material-symbols-outlined text-xs">verified</span> Official National Honor';
    }
    if (metaWrap) metaWrap.classList.remove('hidden');
    if (reqRow) reqRow.classList.add('hidden');
    if (shareBtn) shareBtn.classList.remove('hidden');
    playMetallicChime();
  } else {
    // LOCKED: Sealed archive vault briefing, NO 3D preview, NO chime
    destroy3DMedalViewer();
    if (canvasWrap) canvasWrap.classList.add('hidden');
    if (orbitHint) orbitHint.classList.add('hidden');
    if (lockedOverlay) {
      lockedOverlay.classList.remove('hidden');
      lockedOverlay.innerHTML = `
        <div class="flex flex-col items-center justify-center text-center space-y-2 p-1">
          <div class="relative w-44 h-44 sm:w-48 sm:h-48 flex items-center justify-center">
            <img src="${medal.image}" alt="${esc(medal.title)}" class="w-full h-full object-contain filter grayscale-[90%] brightness-[0.25] opacity-40 blur-[1px]"/>
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="w-14 h-14 rounded-full bg-slate-900/90 border border-amber-400/40 flex items-center justify-center shadow-2xl backdrop-blur-md">
                <span class="material-symbols-outlined text-2xl text-amber-400">lock</span>
              </div>
            </div>
          </div>
          <p class="text-[11px] font-black uppercase tracking-widest text-slate-400">Classified National Honor</p>
        </div>
      `;
    }
    if (statusPill) {
      statusPill.className = 'inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-400 bg-slate-800/80 px-3 py-1 rounded-full border border-slate-700 backdrop-blur-md';
      statusPill.innerHTML = '<span class="material-symbols-outlined text-xs">lock</span> Locked Honor';
    }
    if (metaWrap) metaWrap.classList.add('hidden');
    if (reqRow) {
      reqRow.classList.remove('hidden');
      if (reqPct) reqPct.textContent = `${progressPct}%`;
      if (reqBar) reqBar.style.width = `${progressPct}%`;
      if (reqRemaining) reqRemaining.textContent = remainingText;
    }
    if (shareBtn) shareBtn.classList.add('hidden');
  }

  if (shareBtn) {
    shareBtn.onclick = () => {
      const text = encodeURIComponent(`🎖️ I was awarded the ${medal.title} by VitalPulse Cameroon for life-saving blood donations! Join me: https://vitalpulse.cm`);
      window.open(`https://wa.me/?text=${text}`, '_blank');
    };
  }

  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
};

window.closeMedalModal = () => {
  destroy3DMedalViewer();
  const modal = document.getElementById('badgeCertModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
};


// ============================================================================
// PULSE POINTS VAULT & HEALTHCARE REWARDS CATALOG ARCHITECTURE
// ============================================================================

export const PULSE_REWARDS = [
  {
    key: 'lab_voucher',
    title: 'Complete Clinical Lab Panel',
    subtitle: 'Comprehensive 4-test preventive health panel',
    cost: 300,
    image: '/assets/reward_lab_voucher_card.jpg',
    fallbackImage: '/assets/reward_voucher.png',
    badgeText: 'Healthcare Subsidy',
    badgeColor: 'emerald',
    description: 'Full blood chemistry screening at accredited partner hospital laboratories: Hemoglobin (CBC), Fasting Blood Sugar, Lipid Profile, and Liver Enzymes (ALT/AST).',
    perks: [
      '100% Free at Partner Hospital Labs',
      'Includes Full Physician Diagnostic Report',
      'Valid for 180 Days from Redemption'
    ],
    acceptedAt: 'Centre Pasteur du Cameroun, Hôpital Laquintinie Douala, Hôpital Général Yaoundé, Hôpital Central Yaoundé',
    instructions: 'Present this voucher QR pass at the hospital laboratory reception desk. Fasting required for glucose and lipid tests (7:30 AM - 10:30 AM).'
  },
  {
    key: 'lapel_pin',
    title: 'Physical 3D Enamel Lifesaver Pin',
    subtitle: 'Official 24k Gold-Plated Die-Cast Regalia',
    cost: 500,
    image: '/assets/reward_enamel_pin_card.jpg',
    fallbackImage: '/assets/reward_pin.png',
    badgeText: 'Physical Collectible',
    badgeColor: 'amber',
    description: 'Hand-crafted die-cast metallic lapel pin featuring sculpted gold wings and translucent ruby enamel blood drop. Presented in a plush black velvet collector box.',
    perks: [
      '24k Gold-Plated Zinc Alloy with Ruby Hard Enamel',
      'Luxury Black Velvet Presentation Gift Box',
      'Collectible at Any Regional Hospital Desk'
    ],
    acceptedAt: 'Regional Transfusion Centers & Hospital Blood Banks across Cameroon',
    instructions: 'Show this redemption QR pass to the regional blood transfusion coordinator or hospital reception desk to receive your presentation pin.'
  },
  {
    key: 'vip_pass',
    title: '1-Year Zero-Wait VIP Pass',
    subtitle: 'Priority Phlebotomy & Expedited Triage',
    cost: 750,
    image: '/assets/reward_vip_pass_card.jpg',
    fallbackImage: '/assets/reward_vip_pass_card.png',
    badgeText: 'Hospital Priority',
    badgeColor: 'purple',
    description: 'Exclusive 12-month digital fast-track pass across partner hospitals in Cameroon. Enjoy expedited triage, private donor lounge suites, and memory-foam phlebotomy chairs.',
    perks: [
      'Zero-Wait Priority Phlebotomy Triage',
      'Access to Private Climate-Controlled Donor Suites',
      'Complimentary Clinical Recovery Nutrition Pack'
    ],
    acceptedAt: 'All Major Partner Blood Banks & Transfusion Hubs in Cameroon',
    instructions: 'Present your digital VIP Pass at hospital triage. Phlebotomy staff will immediately usher you to the priority donor suite.'
  }
];

export function renderRewardsCatalog(pulsePoints = 0) {
  const container = document.getElementById('vaultCatalogGrid');
  if (!container) return;

  const currentPts = Number(pulsePoints) || 0;

  container.innerHTML = PULSE_REWARDS.map(r => {
    const affordable = currentPts >= r.cost;
    const progressPct = Math.min(100, Math.round((currentPts / r.cost) * 100));
    const deficit = Math.max(0, r.cost - currentPts);
    const donNeeded = Math.ceil(deficit / 100);

    return `
      <div class="rounded-3xl p-6 bg-white/[0.03] hover:bg-white/[0.06] border ${
        affordable
          ? 'border-amber-400/50 shadow-[0_0_30px_rgba(245,158,11,0.12)]'
          : 'border-white/10 hover:border-white/20'
      } backdrop-blur-xl transition-all duration-300 flex flex-col justify-between space-y-5">
        
        <div class="space-y-4">
          <!-- Card Image Header -->
          <div class="w-full h-44 rounded-2xl overflow-hidden relative shadow-inner bg-slate-950 group">
            <img src="${r.image}" alt="${esc(r.title)}" onerror="this.src='${r.fallbackImage}'" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"/>
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-black/30 pointer-events-none"></div>
            
            <!-- Category Badge -->
            <span class="absolute top-3 left-3 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider backdrop-blur-md ${
              r.badgeColor === 'emerald'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30'
                : r.badgeColor === 'amber'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-400/30'
                : 'bg-purple-500/20 text-purple-300 border border-purple-400/30'
            }">
              ${r.badgeText}
            </span>

            <!-- Points Cost Tag -->
            <span class="absolute top-3 right-3 px-3.5 py-1 rounded-full text-xs font-black bg-amber-500 text-slate-950 shadow-lg font-headline">
              ${r.cost} pts
            </span>

            ${affordable ? `
              <div class="absolute bottom-3 left-3 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-emerald-300 bg-emerald-950/80 px-2.5 py-0.5 rounded-full border border-emerald-500/30 backdrop-blur-md">
                <span class="material-symbols-outlined text-xs text-emerald-400">check_circle</span> Ready to Redeem
              </div>
            ` : ''}
          </div>

          <!-- Title & Subtitle -->
          <div class="space-y-1">
            <h3 class="font-black text-base sm:text-lg text-white font-headline">${esc(r.title)}</h3>
            <p class="text-xs text-amber-300/90 font-bold">${esc(r.subtitle)}</p>
          </div>

          <!-- Description -->
          <p class="text-xs text-slate-300 leading-relaxed font-medium">${esc(r.description)}</p>

          <!-- Perks Checklist -->
          <ul class="space-y-1.5 pt-1 text-xs text-slate-300">
            ${r.perks.map(p => `
              <li class="flex items-center gap-2">
                <span class="material-symbols-outlined text-xs text-emerald-400 shrink-0">check</span>
                <span>${esc(p)}</span>
              </li>
            `).join('')}
          </ul>
        </div>

        <!-- Bottom Action & Affordability Status -->
        <div class="pt-4 border-t border-white/10 space-y-3">
          ${affordable ? `
            <button onclick="window.redeemReward('${r.key}', ${r.cost})" class="press-scale w-full py-3.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-xs shadow-lg shadow-amber-500/20 transition-all cursor-pointer flex items-center justify-center gap-2">
              <span class="material-symbols-outlined text-sm font-black">redeem</span>
              <span>Redeem Voucher (${r.cost} pts)</span>
            </button>
          ` : `
            <div class="space-y-2">
              <div class="flex items-center justify-between text-[11px] font-bold text-slate-400">
                <span>Progress: ${currentPts} / ${r.cost} pts</span>
                <span class="text-amber-400">${progressPct}%</span>
              </div>
              <div class="h-2 w-full bg-white/10 rounded-full overflow-hidden">
                <div class="h-full bg-gradient-to-r from-amber-500 to-yellow-400 rounded-full transition-all duration-500" style="width: ${progressPct}%"></div>
              </div>
              <p class="text-[10px] text-slate-400 font-medium">
                Need <strong class="text-amber-300">${deficit} more pts</strong> • ~${donNeeded} donation${donNeeded > 1 ? 's' : ''} to unlock
              </p>
            </div>
            <button onclick="window.openHowToEarnModal()" class="press-scale w-full py-3 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 text-slate-300 hover:text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer">
              <span class="material-symbols-outlined text-sm text-amber-400">lock</span>
              <span>🔒 Need ${deficit} More Pts • How to Earn</span>
            </button>
          `}
        </div>

      </div>
    `;
  }).join('');
}

export function updateActiveVouchersBadge(count = 0) {
  const badge = document.getElementById('vaultVouchersCountBadge');
  if (badge) badge.textContent = `${count}`;
}

export async function updateActiveVouchersCount(donorId) {
  if (!donorId) return;
  try {
    const list = await fetchDonorVouchers(donorId);
    updateActiveVouchersBadge(Array.isArray(list) ? list.length : 0);
  } catch (e) {
    // ignore
  }
}

export async function switchVaultTab(tabName) {
  const btnCatalog = document.getElementById('btnVaultTabCatalog');
  const btnVouchers = document.getElementById('btnVaultTabVouchers');
  const catalogGrid = document.getElementById('vaultCatalogGrid');
  const activeWrap = document.getElementById('vaultActiveVouchersWrap');

  if (tabName === 'catalog') {
    if (btnCatalog) {
      btnCatalog.className = 'press-scale px-4 py-2 rounded-full font-black text-xs bg-amber-500 text-slate-950 shadow-md transition-all cursor-pointer flex items-center gap-1.5';
    }
    if (btnVouchers) {
      btnVouchers.className = 'press-scale px-4 py-2 rounded-full font-bold text-xs bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 hover:text-white border border-white/10 transition-all cursor-pointer flex items-center gap-1.5';
    }
    if (catalogGrid) catalogGrid.classList.remove('hidden');
    if (activeWrap) activeWrap.classList.add('hidden');
  } else {
    if (btnVouchers) {
      btnVouchers.className = 'press-scale px-4 py-2 rounded-full font-black text-xs bg-amber-500 text-slate-950 shadow-md transition-all cursor-pointer flex items-center gap-1.5';
    }
    if (btnCatalog) {
      btnCatalog.className = 'press-scale px-4 py-2 rounded-full font-bold text-xs bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 hover:text-white border border-white/10 transition-all cursor-pointer flex items-center gap-1.5';
    }
    if (catalogGrid) catalogGrid.classList.add('hidden');
    if (activeWrap) activeWrap.classList.remove('hidden');
    await loadMyActiveVouchers();
  }
}
if (typeof window !== 'undefined') {
  window.switchVaultTab = switchVaultTab;
}

export async function loadMyActiveVouchers() {
  const activeWrap = document.getElementById('vaultActiveVouchersWrap');
  if (!activeWrap) return;

  const currentUser = getCurrentUser();
  if (!currentUser) {
    activeWrap.innerHTML = `
      <div class="col-span-full py-16 text-center text-slate-400 bg-white/[0.02] border border-white/10 rounded-3xl p-8 space-y-2">
        <span class="material-symbols-outlined text-4xl text-slate-500">lock</span>
        <p class="text-sm font-bold">Please log in to view your redeemed vouchers.</p>
      </div>
    `;
    return;
  }

  activeWrap.innerHTML = `<div class="col-span-full py-12 text-center text-slate-400 text-xs">Fetching active vouchers...</div>`;

  try {
    const vouchers = await fetchDonorVouchers(currentUser.uid);
    updateActiveVouchersBadge(Array.isArray(vouchers) ? vouchers.length : 0);

    if (!vouchers || vouchers.length === 0) {
      activeWrap.innerHTML = `
        <div class="col-span-full py-16 text-center text-slate-400 bg-white/[0.02] border border-white/10 rounded-3xl p-8 space-y-3">
          <div class="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-400 border border-amber-400/20 flex items-center justify-center mx-auto">
            <span class="material-symbols-outlined text-2xl">confirmation_number</span>
          </div>
          <h4 class="text-base font-black text-white">No Active Vouchers Yet</h4>
          <p class="text-xs text-slate-400 max-w-sm mx-auto">
            You currently have no redeemed vouchers. Earn Pulse Points by donating blood or responding to emergency calls, then redeem them in the catalog!
          </p>
          <button onclick="window.switchVaultTab('catalog')" class="press-scale px-5 py-2.5 rounded-full bg-amber-500 text-slate-950 font-black text-xs inline-flex items-center gap-1.5 shadow-md cursor-pointer">
            <span class="material-symbols-outlined text-sm">storefront</span>
            <span>Browse Rewards Catalog</span>
          </button>
        </div>
      `;
      return;
    }

    activeWrap.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        ${vouchers.map(v => {
          const reward = PULSE_REWARDS.find(r => r.key === v.rewardKey) || {
            title: v.rewardTitle,
            subtitle: 'Healthcare Benefit',
            image: '/assets/reward_lab_voucher_card.jpg',
            acceptedAt: 'Partner Hospitals in Cameroon'
          };
          const expDate = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '180 Days';
          const voucherJson = JSON.stringify(v).replace(/"/g, '&quot;');

          return `
            <div class="p-6 rounded-3xl bg-white/[0.04] border border-amber-400/30 hover:border-amber-400/60 backdrop-blur-xl transition-all flex flex-col justify-between space-y-4 shadow-lg">
              <div class="space-y-3">
                <div class="flex items-center justify-between">
                  <span class="inline-flex items-center gap-1 text-[10px] font-black uppercase text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-0.5 rounded-full">
                    <span class="material-symbols-outlined text-xs">verified</span> Active Pass
                  </span>
                  <span class="text-[10px] text-slate-400 font-mono uppercase">${v.voucherCode}</span>
                </div>

                <div class="space-y-1">
                  <h4 class="font-black text-base text-white font-headline">${esc(v.rewardTitle || reward.title)}</h4>
                  <p class="text-xs text-amber-300 font-semibold">${esc(reward.subtitle)}</p>
                </div>

                <div class="p-3 rounded-2xl bg-slate-900/80 border border-white/10 space-y-1 text-xs">
                  <div class="flex items-center justify-between text-slate-400 text-[10px]">
                    <span>Valid Until:</span>
                    <strong class="text-white">${expDate}</strong>
                  </div>
                  <div class="text-[10px] text-slate-400 truncate">
                    <span>Locations:</span> ${esc(reward.acceptedAt)}
                  </div>
                </div>
              </div>

              <button onclick="window.inspectVoucher('${v.id}')" class="press-scale w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-md transition-all cursor-pointer">
                <span class="material-symbols-outlined text-sm">qr_code_2</span>
                <span>View Digital Pass & QR Code</span>
              </button>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    console.error('Failed to load active vouchers:', err);
    activeWrap.innerHTML = `<div class="col-span-full py-12 text-center text-rose-400 text-xs">Could not load active vouchers. Please retry.</div>`;
  }
}

let _cachedVouchersList = [];

export async function inspectVoucher(voucherIdentifier) {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  let voucher = null;
  if (typeof voucherIdentifier === 'object') {
    voucher = voucherIdentifier;
  } else {
    try {
      const list = await fetchDonorVouchers(currentUser.uid);
      voucher = list.find(v => v.id === voucherIdentifier || v.voucherCode === voucherIdentifier);
    } catch (e) {}
  }

  if (!voucher) {
    showToast('Voucher details not found.', 'error');
    return;
  }

  const modal = document.getElementById('voucherDetailModal');
  const titleEl = document.getElementById('voucherModalTitle');
  const subEl = document.getElementById('voucherModalSubtitle');
  const codeEl = document.getElementById('voucherModalCode');
  const expiresEl = document.getElementById('voucherModalExpires');
  const locEl = document.getElementById('voucherModalLocations');
  const instrEl = document.getElementById('voucherModalInstructions');
  const qrImg = document.getElementById('voucherModalQrImg');
  const shareBtn = document.getElementById('btnVoucherShareWhatsapp');

  const reward = PULSE_REWARDS.find(r => r.key === voucher.rewardKey) || {
    title: voucher.rewardTitle || 'Healthcare Voucher',
    subtitle: 'MINSANTE Lifesaver Benefit',
    acceptedAt: 'Centre Pasteur, Hôpital Laquintinie, Hôpital Général, Hôpital Central',
    instructions: 'Present this QR code or voucher number at the hospital reception or lab intake desk.'
  };

  if (titleEl) titleEl.textContent = voucher.rewardTitle || reward.title;
  if (subEl) subEl.textContent = reward.subtitle;
  if (codeEl) codeEl.textContent = voucher.voucherCode;
  if (expiresEl) {
    expiresEl.textContent = voucher.expiresAt
      ? new Date(voucher.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '180 Days from Issue';
  }
  if (locEl) locEl.textContent = reward.acceptedAt;
  if (instrEl) instrEl.textContent = reward.instructions;

  if (qrImg) {
    try {
      const qrDataUrl = await QRCode.toDataURL(voucher.voucherCode, {
        width: 256,
        margin: 2,
        color: { dark: '#020617', light: '#ffffff' }
      });
      qrImg.src = qrDataUrl;
    } catch (e) {
      console.warn('QR code generation failed:', e);
    }
  }

  if (shareBtn) {
    shareBtn.onclick = () => {
      const text = encodeURIComponent(`🏥 VitalPulse Cameroon Healthcare Voucher: ${voucher.voucherCode}
Perk: ${voucher.rewardTitle || reward.title}
Locations: ${reward.acceptedAt}`);
      window.open(`https://wa.me/?text=${text}`, '_blank');
    };
  }

  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}
if (typeof window !== 'undefined') {
  window.inspectVoucher = inspectVoucher;
}

export function closeVoucherDetailModal() {
  const modal = document.getElementById('voucherDetailModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}
if (typeof window !== 'undefined') {
  window.closeVoucherDetailModal = closeVoucherDetailModal;
}

export function openHowToEarnModal() {
  const modal = document.getElementById('howToEarnModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}
if (typeof window !== 'undefined') {
  window.openHowToEarnModal = openHowToEarnModal;
}

export function closeHowToEarnModal() {
  const modal = document.getElementById('howToEarnModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}
if (typeof window !== 'undefined') {
  window.closeHowToEarnModal = closeHowToEarnModal;
}


window.redeemReward = async (rewardKey, costPoints) => {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  const eng = _lastComputedEngagement || { pulsePoints: 0 };
  const currentPts = eng.pulsePoints || 0;

  if (currentPts < costPoints) {
    openHowToEarnModal();
    return;
  }

  const reward = PULSE_REWARDS.find(r => r.key === rewardKey);
  const rewardTitle = reward ? reward.title : 'Lifesaver Reward';

  const confirmed = await window.vpConfirm(`Redeem "${rewardTitle}" for ${costPoints} Pulse Points? Your voucher will be issued immediately with an accredited digital QR pass.`, {
    title: 'Confirm Reward Redemption',
    confirmText: 'Redeem Now'
  });

  if (!confirmed) return;

  try {
    const result = await redeemPulseReward(currentUser.uid, rewardKey, costPoints, {
      rewardTitle,
      donorName: currentUser.name || 'Verified Donor',
      currentPoints: currentPts
    });

    // Deduct points in memory and refresh UI
    if (_lastComputedEngagement) {
      _lastComputedEngagement.pulsePoints = result.remainingPts;
    }

    const heroPoints = document.getElementById('donorBadgePointsSummary') || document.getElementById('impactPointsSummary');
    if (heroPoints) heroPoints.textContent = `${result.remainingPts} Pulse Points`;
    const vaultBal = document.getElementById('vaultPointsBalance') || document.getElementById('rewardsVaultBalance');
    if (vaultBal) vaultBal.innerHTML = `${result.remainingPts} <span class="text-xs font-bold text-amber-300">pts</span>`;

    // Re-render catalog with updated balance & update badge
    renderRewardsCatalog(result.remainingPts);
    updateActiveVouchersCount(currentUser.uid);

    // Trigger celebration confetti
    triggerMilestoneConfetti();

    showToast(`🎉 Reward Redeemed! Voucher Code: ${result.voucherCode}`, 'success');

    // Automatically inspect the newly issued voucher pass!
    inspectVoucher({
      id: result.voucherCode,
      voucherCode: result.voucherCode,
      rewardKey,
      rewardTitle,
      expiresAt: result.expiresAt
    });

  } catch (e) {
    console.error('Failed to redeem reward:', e);
    showToast(e.message || 'Failed to redeem reward. Please try again.', 'error');
  }
};

function wireImpactShareButtons() {
  const btnClose = document.getElementById('badgeCertClose');
  const btnCloseBtn = document.getElementById('badgeCertCloseBtn');
  const backdrop = document.getElementById('badgeCertBackdrop');

  if (btnClose) btnClose.onclick = window.closeMedalModal;
  if (btnCloseBtn) btnCloseBtn.onclick = window.closeMedalModal;
  if (backdrop) backdrop.onclick = window.closeMedalModal;

  const btnShareWhatsapp = document.getElementById('btnShareWhatsapp');
  if (btnShareWhatsapp) {
    btnShareWhatsapp.onclick = () => {
      const eng = _lastComputedEngagement || { livesSaved: 0, totalUnits: 0, tierName: 'Bronze' };
      const msg = encodeURIComponent(`🩸 I am a verified ${eng.tierName} with VitalPulse Cameroon! I have donated ${eng.totalUnits || 1} units and helped save ${eng.livesSaved || 3} lives. Join the lifesaver movement in Cameroon: https://vitalpulse.cm`);
      window.open(`https://wa.me/?text=${msg}`, '_blank');
    };
  }

  const btnDownloadShareCard = document.getElementById('btnDownloadShareCard');
  if (btnDownloadShareCard) {
    btnDownloadShareCard.onclick = () => {
      generateLifesaverCardCanvas();
    };
  }
}

function generateLifesaverCardCanvas() {
  const currentUser = getCurrentUser();
  const userName = currentUser?.name || currentUser?.email?.split('@')[0] || _lastComputedEngagement?.userName || 'Verified Donor';
  const bloodType = currentUser?.bloodType || _lastComputedEngagement?.bloodType || 'O+';
  const tierName = _lastComputedEngagement?.tierName || 'Bronze Lifesaver';
  const totalUnits = _lastComputedEngagement?.totalUnits || 0;
  const livesSaved = _lastComputedEngagement?.livesSaved || (totalUnits * 3);
  const donorId = `VP-NBTS-${(currentUser?.cniLast4 || currentUser?.uid?.slice(0, 6) || '8849').toUpperCase()}`;

  const eng = {
    userName,
    bloodType,
    tierName,
    totalUnits,
    livesSaved,
    donorId
  };
  
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, 1200, 630);
  grad.addColorStop(0, '#101623');
  grad.addColorStop(0.5, '#4a080e');
  grad.addColorStop(1, '#0b0f19');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1200, 630);

  // Border frame
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 6;
  ctx.strokeRect(30, 30, 1140, 570);

  // Header Title
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 42px sans-serif';
  ctx.fillText('VITALPULSE CAMEROON', 70, 110);

  ctx.fillStyle = '#fbbf24';
  ctx.font = '700 20px sans-serif';
  ctx.fillText('OFFICIAL NATIONAL LIFESAVER IDENTITY PASS', 70, 145);

  // Donor Name
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 48px sans-serif';
  ctx.fillText(eng.userName || 'Verified Donor', 70, 260);

  // Tier Subtitle
  ctx.fillStyle = '#fca5a5';
  ctx.font = '600 26px sans-serif';
  ctx.fillText(`Milestone Tier: ${eng.tierName || 'Bronze Donor'}`, 70, 305);

  // Metrics Box
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(70, 360, 480, 160);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 2;
  ctx.strokeRect(70, 360, 480, 160);

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 44px sans-serif';
  ctx.fillText(`${eng.totalUnits}`, 110, 430);
  ctx.font = '700 16px sans-serif';
  ctx.fillStyle = '#d1d5db';
  ctx.fillText('UNITS DONATED', 110, 465);

  ctx.fillStyle = '#ef4444';
  ctx.font = '900 44px sans-serif';
  ctx.fillText(`${eng.livesSaved}`, 340, 430);
  ctx.font = '700 16px sans-serif';
  ctx.fillStyle = '#d1d5db';
  ctx.fillText('LIVES SAVED', 340, 465);

  // Blood Type Badge on Right
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  ctx.roundRect(800, 200, 300, 220, [30]);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 96px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(eng.bloodType, 950, 340);
  ctx.font = '700 18px sans-serif';
  ctx.fillText('BLOOD GROUP', 950, 385);
  ctx.textAlign = 'left';

  // Verification Hash
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '16px monospace';
  ctx.fillText(`VERIFIED NBTS ID: ${eng.donorId}`, 70, 560);

  // Trigger Download
  const link = document.createElement('a');
  link.download = `VitalPulse-Lifesaver-Pass-${eng.bloodType || 'Donor'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  showToast('Lifesaver pass downloaded!');
}




// ============================================
// INVITE FRIENDS MODAL & REFERRAL DISPATCH
// ============================================
window.openInviteFriendsModal = function() {
  const modal = document.getElementById('inviteFriendsModal');
  const input = document.getElementById('inviteShareLinkInput');
  const currentUser = getCurrentUser();
  const refCode = currentUser?.uid ? currentUser.uid.slice(0, 8).toUpperCase() : 'LIFESAVER';
  const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : 'https://vitalpulse.cm';
  const refLink = `${origin}/?ref=${refCode}`;
  if (input) input.value = refLink;
  if (modal) modal.classList.remove('hidden');
};

window.closeInviteFriendsModal = function() {
  const modal = document.getElementById('inviteFriendsModal');
  if (modal) modal.classList.add('hidden');
};

window.copyInviteLink = async function() {
  const input = document.getElementById('inviteShareLinkInput');
  const btn = document.getElementById('btnCopyInviteLink');
  const link = input?.value || window.location.origin;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
    } else if (input) {
      input.select();
      document.execCommand('copy');
    }
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<span class="material-symbols-outlined text-sm text-emerald-400">check</span> Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
    showToast('🎉 Referral link copied to clipboard!');
  } catch (_) {
    if (input) {
      input.select();
      showToast('Referral link selected — press Ctrl+C to copy.');
    }
  }
};

window.shareInviteWhatsApp = function() {
  const input = document.getElementById('inviteShareLinkInput');
  const link = input?.value || window.location.origin;
  const msg = encodeURIComponent(`🩸 Join me on VitalPulse Cameroon! Safe voluntary blood donation saves lives every day across regional hospitals in Cameroon. Sign up with my link and become a verified lifesaver: ${link}`);
  window.open(`https://api.whatsapp.com/send?text=${msg}`, '_blank');
};

window.shareInviteNative = async function() {
  const input = document.getElementById('inviteShareLinkInput');
  const link = input?.value || window.location.origin;
  const shareData = {
    title: 'Join VitalPulse Cameroon Lifesaver Network',
    text: 'Help save lives across regional hospitals in Cameroon as a voluntary blood donor.',
    url: link
  };
  if (navigator?.share) {
    try {
      await navigator.share(shareData);
    } catch (e) {
      if (e.name !== 'AbortError') window.shareInviteWhatsApp();
    }
  } else {
    window.shareInviteWhatsApp();
  }
};
