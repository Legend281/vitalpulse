import { getCurrentUser } from './auth';
import {
  fetchMatchedRequestsForDonor,
  fetchActiveRequests,
  fetchAllCampaigns,
  fetchAllDonors,
  fetchDonationRequestsForDonor,
  submitDonationRequest,
  computeDonorEngagement,
  updateUserProfile,
  acceptRequest as acceptRequestDb,
  getCompatibleBloodTypes,
  getBloodTypeDisplayInfo,
  logActivity,
} from './db';

let donorNavigationInitialized = false;

// Inline onclick handlers — always available even if init code fails
window.openDonationModal = () => {
  const modal = document.getElementById('donationModal');
  if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
};
window.closeDonationModal = () => {
  const modal = document.getElementById('donationModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
};

export function switchDonorView(view) {
  window.scrollTo(0, 0);
  const views = ['dashboard', 'requests', 'badges', 'profile'];
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
  const activeNav = document.querySelector(`.donor-mobile-nav[data-view="${view}"]`);
  if (activeNav) {
    activeNav.classList.remove('text-on-surface-variant');
    activeNav.classList.add('text-primary');
    const icon = activeNav.querySelector('.material-symbols-outlined');
    if (icon) icon.style.fontVariationSettings = "'FILL' 1";
  }

  switch (view) {
    case 'dashboard': loadDonorDashboard(); break;
    case 'requests': loadDonorRequests(); break;
    case 'badges': loadDonorBadges(); break;
    case 'profile': loadDonorProfile(); break;
  }
}

export function initDonorNavigation() {
  if (donorNavigationInitialized) return;

  document.querySelectorAll('.donor-mobile-nav').forEach(btn => {
    btn.addEventListener('click', () => switchDonorView(btn.dataset.view));
  });

  document.getElementById('btnViewAllRequests')?.addEventListener('click', () => switchDonorView('requests'));
  document.getElementById('btnViewDonationHistory')?.addEventListener('click', () => {
    const modal = document.getElementById('myDonationsModal');
    if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
    loadDonorDonations();
  });
  document.getElementById('btnDonorProfile')?.addEventListener('click', () => switchDonorView('profile'));

  document.querySelectorAll('[data-action="switch-view"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;
      if (target) switchDonorView(target);
    });
  });

  // Notification bell: show simple panel with recent activity
  const notifBtn = document.getElementById('btnDonorNotifications');
  if (notifBtn) {
    notifBtn.addEventListener('click', async () => {
      const currentUser = getCurrentUser();
      if (!currentUser) return;
      try {
        const engagement = await computeDonorEngagement(currentUser.uid);
        const recentCount = engagement?.donations?.length || 0;
        const badge = document.getElementById('donorNotifBadge');
        if (badge) badge.classList.add('hidden');
        const msg = recentCount > 0
          ? `You have ${recentCount} donation record${recentCount > 1 ? 's' : ''}. ${engagement.tier} Tier · ${engagement.points} pts`
          : 'No notifications yet. Schedule your first donation!';
        showToast(msg);
      } catch (e) {
        showToast('No new notifications');
      }
    });
  }

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
  if (!lastDonationDate) return { eligible: true, daysUntil: 0, label: 'Eligible', color: 'text-tertiary', barPct: 100 };
  const last = new Date(lastDonationDate);
  const next = new Date(last);
  next.setDate(next.getDate() + 56);
  const now = new Date();
  if (now >= next) return { eligible: true, daysUntil: 0, label: 'Eligible', color: 'text-tertiary', barPct: 100 };
  const diffMs = next - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  const totalDays = 56;
  const elapsed = totalDays - diffDays;
  const pct = Math.min(100, Math.round((elapsed / totalDays) * 100));
  return { eligible: false, daysUntil: diffDays, label: `${diffDays} days`, color: 'text-amber-600', barPct: pct };
}

function clearDonorLoadingStates() {
  const loaders = [
    'donorTierProgress', 'donorEligibilityBar', 'requestsFeed',
    'donorBadgesSummary', 'donorCampaigns', 'donorMapPreview',
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
    const activeRequests = await fetchMatchedRequestsForDonor(currentUser.bloodType, currentUser.city).catch(() => []);

    const firstName = (currentUser.name || currentUser.email?.split('@')[0] || 'Donor').split(' ')[0];
    const city = currentUser.city || 'Yaoundé';
    const bloodType = currentUser.bloodType || '—';
    const bloodInfo = getBloodTypeDisplayInfo(bloodType);

    // Hero welcome message
    const heroMsgEl = document.getElementById('donorHeroMessage');
    if (heroMsgEl) {
      heroMsgEl.innerHTML = `<span class="font-black text-primary">${firstName}</span>, la communauté de <span class="font-black text-primary">${city}</span> a besoin de ton groupe <span class="font-black text-primary">${bloodType}</span> aujourd'hui. 💉`;
    }

    // Blood type card
    const bloodTypeCard = document.getElementById('donorBloodTypeCard');
    if (bloodTypeCard) {
      bloodTypeCard.innerHTML = `
        <div class="flex items-center justify-center size-16 rounded-2xl" style="background-color: ${bloodInfo.color}20;">
          <span class="text-3xl font-black" style="color: ${bloodInfo.color}">${bloodType}</span>
        </div>
        <div class="flex flex-col">
          <span class="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Blood Type</span>
          <span class="text-lg font-black text-on-surface">${bloodType}</span>
          <span class="text-[10px] font-medium text-on-surface-variant">${bloodInfo.label}</span>
        </div>
      `;
    }

    // Stats
    if (engagement) {
      document.getElementById('statDonations').textContent = engagement.donationCount;
      document.getElementById('statLivesSaved').textContent = engagement.totalUnits * 3;
      document.getElementById('statPoints').textContent = engagement.points;
      document.getElementById('statRank').textContent = engagement.tier;

      const lastDonation = engagement.donations.filter(d => d.status === 'completed' || d.status === 'approved');
      const last = lastDonation[0];
      document.getElementById('statLastDonation').textContent = last?.preferredDate
        ? new Date(last.preferredDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '—';

      // Tier progress
      const tierEl = document.getElementById('donorTierProgress');
      if (tierEl) {
        const pct = engagement.nextTier ? Math.min(100, engagement.nextTierProgress) : 100;
        tierEl.innerHTML = `
          <div class="flex items-center gap-4">
            <div class="flex items-center justify-center size-14 rounded-full bg-primary-fixed text-primary shadow-inner">
              <span class="material-symbols-outlined text-3xl">${engagement.tierIcon}</span>
            </div>
            <div class="flex-1">
              <div class="flex justify-between items-center mb-1">
                <span class="font-black text-lg text-on-surface">${engagement.tier} Tier</span>
                <span class="text-xs font-bold text-primary">${engagement.points} pts</span>
              </div>
              ${engagement.nextTier ? `
              <div class="flex justify-between text-[10px] font-bold text-on-surface-variant mb-1">
                <span>${engagement.tier}</span>
                <span>Next: ${engagement.nextTier}</span>
              </div>
              <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                <div class="h-full bg-primary rounded-full" style="width: ${pct}%"></div>
              </div>
              <p class="text-[10px] text-on-surface-variant mt-1 font-medium">${Math.max(1, getNextTierDonationsNeeded(engagement))} more donation${engagement.donationCount >= 4 ? 's' : ''} to reach ${engagement.nextTier}!</p>
              ` : '<p class="text-xs text-primary font-bold">Max tier reached!</p>'}
            </div>
          </div>
          <div class="flex gap-3 mt-4 pt-4 border-t border-outline-variant/10">
            <div class="flex-1 text-center">
              <p class="text-2xl font-black text-primary">${engagement.donationCount}</p>
              <p class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Donations</p>
            </div>
            <div class="flex-1 text-center">
              <p class="text-2xl font-black text-tertiary">${engagement.totalUnits * 3}</p>
              <p class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Lives Saved</p>
            </div>
            <div class="flex-1 text-center">
              <p class="text-2xl font-black text-on-surface">${engagement.points}</p>
              <p class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Points</p>
            </div>
          </div>
        `;
      }
    }

    // Eligibility countdown
    const eligEl = document.getElementById('donorEligibilityBar');
    if (eligEl && engagement) {
      const sorted = engagement.donations.filter(d => d.status === 'completed' || d.status === 'approved');
      const lastDonationDate = sorted[0]?.preferredDate || sorted[0]?.completedAt || null;
      const elig = getEligibilityInfo(lastDonationDate);
      eligEl.innerHTML = `
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Eligibility</span>
          <span class="text-sm font-bold ${elig.color}">${elig.label}</span>
        </div>
        <div class="h-2 w-full bg-surface-container-high rounded-full overflow-hidden">
          <div class="h-full ${elig.eligible ? 'bg-tertiary' : 'bg-amber-400'} rounded-full transition-all duration-500" style="width: ${elig.barPct}%"></div>
        </div>
        <p class="text-[10px] text-on-surface-variant mt-1">${elig.eligible ? 'You are eligible to donate now! 🩸' : `Next donation available in ${elig.daysUntil} days (56-day deferral period)`}</p>
      `;
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
          <button onclick="switchDonorView('badges')" class="mt-3 text-xs font-bold text-primary hover:underline">View all badges →</button>
        `;
      }
    }

    // Handle null engagement — clear remaining loading spinners
    if (!engagement) {
      clearDonorLoadingStates();
    }

    // Emergency alert
    const criticalRequest = activeRequests.find(r => r.urgency === 'critical');
    const alertEl = document.getElementById('emergencyAlert');
    if (alertEl) {
      if (criticalRequest) {
        alertEl.classList.remove('hidden');
        document.getElementById('emergencyBloodType').textContent = criticalRequest.bloodType || criticalRequest.type || '?';
        document.getElementById('emergencyHospital').textContent = `${criticalRequest.city || 'Yaoundé'} • ${criticalRequest.hospital}`;
        document.getElementById('emergencyTime').textContent = getTimeAgo(criticalRequest.requestedAt);
        document.getElementById('emergencyRespondBtn').onclick = () => {
          if (confirm(`Accept urgent request for ${criticalRequest.bloodType} at ${criticalRequest.hospital}?`)) {
            acceptAndRedirect(criticalRequest.id, currentUser.uid);
          }
        };
      } else {
        alertEl.classList.add('hidden');
      }
    }

    // Nearby requests feed
    const feedEl = document.getElementById('requestsFeed');
    if (feedEl) {
      if (activeRequests.length === 0) {
        feedEl.innerHTML = '<div class="text-center py-8 text-on-surface-variant"><span class="material-symbols-outlined text-4xl mb-2">check_circle</span><p class="text-sm">No nearby requests currently</p></div>';
      } else {
        feedEl.innerHTML = activeRequests.slice(0, 3).map(req => {
          const isCritical = req.urgency === 'critical';
          return `
          <div class="group bg-surface-container-lowest p-4 rounded-xl flex items-center justify-between gap-4 transition-all hover:shadow-lg border border-transparent hover:border-outline-variant/20">
            <div class="flex items-center gap-4 min-w-0">
              <div class="flex flex-col items-center justify-center size-14 rounded-xl ${isCritical ? 'bg-error/10 text-error' : 'bg-surface-container-low text-on-surface-variant'} font-black">
                <span class="text-xl font-black font-headline">${req.bloodType || req.type || '?'}</span>
              </div>
              <div class="min-w-0">
                <p class="font-bold text-sm text-on-surface truncate">${req.hospital}</p>
                <div class="flex items-center gap-2 text-xs text-on-surface-variant">
                  <span>${req.distance || req.city || 'Local'}</span>
                  ${isCritical ? '<span class="text-error font-bold text-[10px]">● Critical</span>' : ''}
                </div>
              </div>
            </div>
            <button onclick="window.donorAcceptRequest('${req.id}', '${currentUser.uid}')" class="shrink-0 px-4 py-2 rounded-lg bg-primary text-white font-bold text-xs hover:opacity-90 transition-opacity">Accept</button>
          </div>
          `;
        }).join('');
        if (activeRequests.length > 3) {
          feedEl.innerHTML += `<button onclick="switchDonorView('requests')" class="w-full text-center text-primary font-bold text-sm hover:underline py-2">View all ${activeRequests.length} requests →</button>`;
        }
      }
    }

    // Recent activity
    const activityEl = document.getElementById('donorRecentActivity');
    if (activityEl && engagement) {
      const recent = engagement.donations.slice(0, 5);
      if (recent.length === 0) {
        activityEl.innerHTML = '<div class="flex items-center justify-center py-8 text-on-surface-variant"><p class="text-sm">No activity yet</p></div>';
      } else {
        activityEl.innerHTML = recent.map(d => {
          const isNew = d.status === 'pending';
          const dotColor = isNew ? 'bg-primary' : 'bg-surface-container-highest';
          const statusLabels = { 'completed': 'Donation Completed', 'approved': 'Donation Approved', 'rejected': 'Donation Rejected', 'cancelled': 'Cancelled', 'pending': 'Request Submitted' };
          return `
          <div class="flex gap-3">
            <div class="size-2 mt-1.5 ${dotColor} rounded-full shrink-0"></div>
            <div class="flex flex-col gap-0.5 min-w-0">
              <p class="text-sm font-bold text-on-surface leading-tight">${statusLabels[d.status] || d.status}</p>
              <p class="text-xs text-on-surface-variant truncate">${d.bloodType} • ${d.units || 1} unit${(d.units || 1) > 1 ? 's' : ''} at ${d.preferredLocation || '—'}</p>
              <span class="text-[10px] font-medium text-outline">${d.preferredDate ? new Date(d.preferredDate).toLocaleDateString() : ''}</span>
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
        const campaigns = await fetchAllCampaigns();
        const active = campaigns.filter(c => c.status === 'active').slice(0, 3);
        if (active.length === 0) {
          campaignsEl.innerHTML = '<p class="text-sm text-on-surface-variant text-center py-4">No active campaigns</p>';
        } else {
          campaignsEl.innerHTML = active.map(c => {
            const pct = c.targetUnits ? Math.round((c.unitsCollected || 0) / c.targetUnits * 100) : 0;
            return `
            <div class="bg-surface-container-lowest p-4 rounded-xl border border-outline-variant/10">
              <div class="flex justify-between items-start mb-2">
                <h4 class="font-bold text-sm text-on-surface">${c.title}</h4>
                <span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Active</span>
              </div>
              <p class="text-xs text-on-surface-variant mb-3">${c.location || ''}</p>
              <div class="flex justify-between text-xs font-bold text-on-surface mb-1">
                <span>${c.unitsCollected || 0} / ${c.targetUnits || 0} units</span>
                <span class="text-primary">${pct}%</span>
              </div>
              <div class="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
                <div class="h-full bg-primary rounded-full" style="width: ${pct}%"></div>
              </div>
            </div>
            `;
          }).join('');
        }
      } catch (e) {
        campaignsEl.innerHTML = '';
      }
    }

    // Nearby centers map preview
    const mapEl = document.getElementById('donorMapPreview');
    if (mapEl) {
      const centerInfo = getNearbyCenters(currentUser.city);
      mapEl.innerHTML = `
        <div class="relative rounded-xl overflow-hidden bg-surface-container-high h-40">
          <div class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary/5 to-tertiary/5">
            <div class="text-center">
              <span class="material-symbols-outlined text-4xl text-primary/30">map</span>
              <p class="text-xs text-on-surface-variant mt-1">Centers near ${currentUser.city || 'Yaoundé'}</p>
            </div>
          </div>
          <div class="absolute bottom-3 left-3 right-3 flex flex-wrap gap-2">
            ${centerInfo.slice(0, 3).map(c => `
              <div class="bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-lg text-xs font-bold text-on-surface shadow-sm">
                ${c.name} · ${c.distance}
              </div>
            `).join('')}
          </div>
        </div>
        <button class="mt-2 text-primary font-bold text-xs hover:underline flex items-center gap-1" onclick="switchDonorView('requests')">
          <span class="material-symbols-outlined text-sm">list_alt</span> View all requests
        </button>
      `;
    }

    // Availability toggle
    const track = document.getElementById('availabilityTrack');
    const thumb = document.getElementById('availabilityThumb');
    const statusLabel = document.getElementById('donorStatusLabel');
    if (track && thumb && statusLabel) {
      const isAvail = currentUser.isAvailable !== false;
      track.className = `relative inline-block w-12 h-6 transition duration-200 ease-in rounded-full ${isAvail ? 'bg-tertiary' : 'bg-slate-300'}`;
      thumb.className = `absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${isAvail ? 'translate-x-6' : ''}`;
      statusLabel.textContent = isAvail ? 'Available' : 'Busy';
      const toggleEl = document.getElementById('availabilityToggle');
      if (toggleEl) {
        toggleEl.onclick = async () => {
          const newState = !(currentUser.isAvailable !== false);
          try {
            await updateUserProfile(currentUser.uid, { isAvailable: newState });
            currentUser.isAvailable = newState;
            localStorage.setItem('vitalpulse_user', JSON.stringify({ ...currentUser }));
            track.className = `relative inline-block w-12 h-6 transition duration-200 ease-in rounded-full ${newState ? 'bg-tertiary' : 'bg-slate-300'}`;
            thumb.className = `absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${newState ? 'translate-x-6' : ''}`;
            statusLabel.textContent = newState ? 'Available' : 'Busy';
          } catch (e) { console.error('Failed to update availability:', e); }
        };
      }
    }
  } catch (e) {
    console.error('Failed to load donor dashboard:', e);
    ['donorTierProgress', 'donorEligibilityBar', 'requestsFeed',
     'donorBadgesSummary', 'donorCampaigns', 'donorMapPreview',
     'donorRecentActivity'].forEach(id => showDonorErrorState(document.getElementById(id)));
  }
}

function getNextTierDonationsNeeded(engagement) {
  if (!engagement.nextTier) return 0;
  const map = { 'Silver': 5, 'Gold': 10, 'Platinum': 20 };
  const needed = map[engagement.nextTier] || 5;
  return Math.max(1, needed - engagement.donationCount);
}

function getNearbyCenters(city) {
  const centers = {
    'Yaoundé': [
      { name: 'Central Hospital', distance: '1.2 km' },
      { name: 'CHU Yaoundé', distance: '3.8 km' },
      { name: 'Mfoundi District', distance: '5.1 km' },
    ],
    'Douala': [
      { name: 'General Hospital', distance: '0.9 km' },
      { name: 'Laquintinie', distance: '2.5 km' },
      { name: 'Deido District', distance: '4.2 km' },
    ],
  };
  return centers[city] || centers['Yaoundé'];
}

async function loadDonorRequests() {
  const container = document.getElementById('donorRequestsList');
  if (!container) return;

  const currentUser = getCurrentUser();
  if (!currentUser) return;

  try {
    const engagement = await computeDonorEngagement(currentUser.uid);
    const myRequests = engagement?.donations?.filter(d => d.status === 'approved' || d.status === 'completed') || [];
    const allRequests = await fetchActiveRequests();
    const matchedByMe = allRequests.filter(r => r.matchedDonor === currentUser.uid);

    if (myRequests.length === 0 && matchedByMe.length === 0) {
      container.innerHTML = '<div class="flex flex-col items-center justify-center py-16 text-on-surface-variant"><span class="material-symbols-outlined text-4xl mb-3">bloodtype</span><p class="text-sm font-medium">No requests yet</p></div>';
      return;
    }

    let html = '';
    if (matchedByMe.length > 0) {
      html += '<h3 class="font-extrabold text-lg text-on-surface mb-3">Accepted Requests</h3>';
      html += matchedByMe.map(r => `
        <div class="bg-surface-container-lowest p-4 rounded-xl border border-outline-variant/10 flex items-center justify-between mb-2">
          <div class="flex items-center gap-3">
            <span class="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-black">${r.bloodType || r.type || '?'}</span>
            <div>
              <p class="font-bold text-sm text-on-surface">${r.hospital}</p>
              <p class="text-xs text-on-surface-variant">${r.city || 'Cameroon'}</p>
            </div>
          </div>
          <span class="text-[10px] font-bold text-amber-600 bg-amber-50 px-2 py-1 rounded-full">${r.status}</span>
        </div>
      `).join('');
    }

    if (myRequests.length > 0) {
      html += '<h3 class="font-extrabold text-lg text-on-surface mt-4 mb-3">My Donations</h3>';
      html += myRequests.map(d => {
        const st = { 'pending': 'bg-amber-50 text-amber-700', 'approved': 'bg-emerald-50 text-emerald-700', 'completed': 'bg-blue-50 text-blue-700', 'rejected': 'bg-red-50 text-red-700', 'cancelled': 'bg-slate-50 text-slate-700' };
        const sc = st[d.status] || st.pending;
        return `
        <div class="bg-surface-container-lowest p-4 rounded-xl border border-outline-variant/10 flex items-center justify-between mb-2">
          <div class="flex items-center gap-3">
            <span class="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-black">${d.bloodType}</span>
            <div>
              <p class="font-bold text-sm text-on-surface">${d.units || 1} Unit${(d.units || 1) > 1 ? 's' : ''}</p>
              <p class="text-xs text-on-surface-variant">${d.preferredLocation || '—'} · ${d.preferredDate ? new Date(d.preferredDate).toLocaleDateString() : '—'}</p>
            </div>
          </div>
          <span class="text-[10px] font-bold px-2 py-1 rounded-full ${sc}">${d.status}</span>
        </div>
        `;
      }).join('');
    }

    container.innerHTML = html;
  } catch (e) {
    console.error('Failed to load donor requests:', e);
    container.innerHTML = '<div class="text-center text-error py-8">Failed to load requests.</div>';
  }
}

async function loadDonorBadges() {
  const container = document.getElementById('badgesFullView');
  if (!container) return;

  const currentUser = getCurrentUser();
  if (!currentUser) return;

  try {
    const engagement = await computeDonorEngagement(currentUser.uid);
    if (!engagement || engagement.badges.length === 0) {
      container.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-16 text-on-surface-variant"><span class="material-symbols-outlined text-4xl mb-3">military_tech</span><p class="text-sm font-medium">No badges yet</p></div>';
      return;
    }

    container.innerHTML = engagement.badges.map(b => `
      <div class="bg-surface-container-lowest p-5 rounded-xl border border-outline-variant/10 text-center hover:shadow-md transition-all">
        <div class="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center" style="background-color: ${b.color}20;">
          <span class="material-symbols-outlined text-3xl" style="color: ${b.color}">${b.icon}</span>
        </div>
        <p class="font-bold text-sm text-on-surface">${b.name}</p>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load badges:', e);
    container.innerHTML = '<div class="col-span-full text-center text-error py-8">Failed to load badges.</div>';
  }
}

async function loadDonorProfile() {
  const currentUser = getCurrentUser();
  if (!currentUser) return;

  document.getElementById('donorProfileName').value = currentUser.name || '';
  document.getElementById('donorProfileEmail').value = currentUser.email || '';
  document.getElementById('donorProfileBloodType').value = currentUser.bloodType || 'O+';
  document.getElementById('donorProfileCity').value = currentUser.city || '';
  document.getElementById('donorProfilePhone').value = currentUser.phone || '';

  const form = document.getElementById('donorProfileForm');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      btn.innerHTML = 'Saving...';
      btn.disabled = true;
      try {
        await updateUserProfile(currentUser.uid, {
          name: document.getElementById('donorProfileName').value,
          bloodType: document.getElementById('donorProfileBloodType').value,
          city: document.getElementById('donorProfileCity').value,
          phone: document.getElementById('donorProfilePhone').value,
        });
        const updated = { ...currentUser,
          name: document.getElementById('donorProfileName').value,
          bloodType: document.getElementById('donorProfileBloodType').value,
          city: document.getElementById('donorProfileCity').value,
          phone: document.getElementById('donorProfilePhone').value,
        };
        localStorage.setItem('vitalpulse_user', JSON.stringify(updated));
        showToast('Profile saved!');
      } catch (err) {
        console.error('Failed to save profile:', err);
        alert('Failed to save profile.');
      } finally {
        btn.innerHTML = 'Save Changes';
        btn.disabled = false;
      }
    };
  }
}

function showToast(message) {
  const toast = document.getElementById('successToast');
  const msgEl = document.getElementById('toastMessage');
  if (!toast || !msgEl) return;
  msgEl.textContent = message;
  toast.classList.remove('opacity-0', 'translate-y-20');
  toast.classList.add('opacity-100', 'translate-y-0');
  setTimeout(() => {
    toast.classList.remove('opacity-100', 'translate-y-0');
    toast.classList.add('opacity-0', 'translate-y-20');
  }, 3000);
}

window.donorAcceptRequest = async (requestId, donorId) => {
  if (!confirm('Accept this blood request?')) return;
  try {
    await acceptRequestDb(requestId, donorId);
    showToast('Request accepted! The hospital will be notified.');
    loadDonorDashboard();
  } catch (err) {
    console.error('Failed to accept request:', err);
    alert('Failed to accept request. Please try again.');
  }
};

async function acceptAndRedirect(requestId, donorId) {
  try {
    await acceptRequestDb(requestId, donorId);
    showToast('Request accepted! The hospital will be notified.');
    loadDonorDashboard();
  } catch (err) {
    console.error('Failed to accept request:', err);
    alert('Failed to accept request. Please try again.');
  }
}

// Donation flow
export function initDonorDonationFlow() {
  const fabBtn = document.getElementById('btnDonateFAB');
  const modal = document.getElementById('donationModal');
  const backdrop = document.getElementById('donationBackdrop');
  const cancelBtn = document.getElementById('btnCancelDonation');
  const form = document.getElementById('donationForm');

  const openModal = () => {
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      const today = new Date().toISOString().split('T')[0];
      const dateInput = document.getElementById('donationDate');
      if (dateInput) dateInput.min = today;
    }
  };

  const closeModal = () => {
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (form) form.reset();
    }
  };

  if (fabBtn) fabBtn.addEventListener('click', openModal);
  const desktopBtn = document.getElementById('btnScheduleDonationDesktop');
  if (desktopBtn) desktopBtn.addEventListener('click', openModal);

  if (backdrop) backdrop.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentUser = getCurrentUser();
      if (!currentUser) return;

      const btn = form.querySelector('button[type="submit"]');
      btn.innerHTML = 'Submitting...';
      btn.disabled = true;

      try {
        await submitDonationRequest(currentUser.uid, {
          donorId: currentUser.uid,
          donorName: currentUser.name || currentUser.email?.split('@')[0] || 'Donor',
          donorEmail: currentUser.email,
          donorPhone: currentUser.phone || null,
          bloodType: document.getElementById('donationBloodType').value,
          units: parseInt(document.getElementById('donationUnits').value, 10),
          preferredDate: document.getElementById('donationDate').value,
          preferredLocation: document.getElementById('donationLocation').value,
          notes: document.getElementById('donationNotes').value,
        });
        closeModal();
        showToast('Donation request submitted!');
        loadDonorDonations();
      } catch (err) {
        console.error('Failed to submit donation:', err);
        alert('Failed to submit request.');
      } finally {
        btn.innerHTML = 'Submit Request';
        btn.disabled = false;
      }
    });
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

  document.getElementById('btnDonationHistory')?.addEventListener('click', openModal);
  if (backdrop) backdrop.addEventListener('click', closeModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
}

export async function loadDonorDonations() {
  const listEl = document.getElementById('myDonationsList');
  if (!listEl) return;

  const currentUser = getCurrentUser();
  if (!currentUser) {
    listEl.innerHTML = '<p class="text-center text-slate-500 py-4">Please log in.</p>';
    return;
  }

  try {
    const donations = await fetchDonationRequestsForDonor(currentUser.uid);
    if (donations.length === 0) {
      listEl.innerHTML = '<div class="text-center py-8"><span class="material-symbols-outlined text-4xl text-slate-300 mb-2">bloodtype</span><p class="text-slate-500">No donations yet</p></div>';
      return;
    }

    listEl.innerHTML = donations.map(d => {
      const statusColors = {
        'pending': 'bg-amber-50 text-amber-700',
        'approved': 'bg-emerald-50 text-emerald-700',
        'rejected': 'bg-red-50 text-red-700',
        'completed': 'bg-blue-50 text-blue-700',
        'cancelled': 'bg-slate-50 text-slate-700',
      };
      const sc = statusColors[d.status] || statusColors['pending'];
      const date = d.preferredDate ? new Date(d.preferredDate).toLocaleDateString() : 'Not set';
      return `
      <div class="p-4 bg-surface-container-low rounded-xl border border-outline-variant/10">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-black">${d.bloodType}</div>
            <div>
              <p class="font-bold text-sm text-on-surface">${d.units} Unit${d.units > 1 ? 's' : ''}</p>
              <p class="text-xs text-slate-500">${date} at ${d.preferredLocation}</p>
            </div>
          </div>
          <span class="px-2 py-1 ${sc} text-[10px] font-bold rounded-full">${d.status}</span>
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
