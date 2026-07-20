import './style.css'
import { registerUser, loginUser, getCurrentUser, logoutUser, sendPasswordReset, sendEmailVerificationLink, isEmailVerified } from './auth';
import { doc, getDoc } from "firebase/firestore";
import { db } from './firebase';
import { fetchActiveRequests, fetchPendingHospitals, verifyHospital, rejectHospital, fetchClinicsOnlineCount, fetchRecentLogs, createEmergencyRequest, logActivity, fetchAllHospitals, fetchHospitalById, fetchAllDonors, fetchDonorById, suspendDonor, reactivateDonor, fetchAllSystemRequests, fetchInventory, fetchGlobalInventory, updateInventoryStock, setInventoryThreshold, getBloodTypeDisplayInfo, getCompatibleBloodTypes, fetchDonationRequestsForDonor, fetchAllDonationRequests, fetchPendingDonationRequests, approveDonationRequest, rejectDonationRequest, completeDonationRequest, fetchSystemSettings, updateSystemSettings, updateUserProfile, fetchAllCampaigns, createCampaign, updateCampaign, deleteCampaign, fetchHospitalRequests, fetchIncomingDonors, completeDonorArrival, subscribeToRequests, issueBloodToPatient, deductInventoryStock, fetchInventoryMovements, computeDonorEngagement, sendSmsNotification, sendWhatsAppNotification, fetchNotificationLog, joinCampaign, leaveCampaign, fetchHospitalCampaigns, acceptRequest as acceptRequestDb, fetchHospitalNotifications, fetchUnreadHospitalNotificationCount, markHospitalNotificationRead, markAllHospitalNotificationsRead } from './db';
import { initDonorNavigation, initDonorDonationFlow, loadDonorDashboard, switchDonorView, loadDonorDonations } from './donor-dashboard.js';
import { injectLangToggle, getLang } from './i18n';
import { shouldShowOnboarding, startOnboarding, markOnboardingComplete } from './onboarding';
import Chart from 'chart.js/auto';

window.addEventListener('load', () => {
    const loader = document.getElementById('global-loader');
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 400); // Wait for transition
    }
});

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, checking page...');
    
    // Check if we are on a page that requires auth
    const path = window.location.pathname;
    console.log('Current path:', path);
    const isDashboard = path.includes('donor.html') || path.includes('hospital.html') || path.includes('admin.html');
    const currentUser = getCurrentUser();

    // Protective Routing
    if (isDashboard && !currentUser) {
        window.location.href = '/login.html';
        return;
    }

    // Handle Login Form
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const errorMsg = document.getElementById('errorMessage');
            const submitBtn = loginForm.querySelector('button[type="submit"]');
            
            try {
                errorMsg.classList.add('hidden');
                submitBtn.disabled = true;
                submitBtn.innerHTML = 'Connecting...';
                
                const user = await loginUser(email, password);
                
                // Route based on role
                if (user.role === 'admin') window.location.href = '/admin.html';
                else if (user.role === 'hospital') window.location.href = '/hospital.html';
                else window.location.href = '/donor.html';
                
            } catch (error) {
                errorMsg.textContent = "Invalid credentials. Please try again.";
                errorMsg.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Log In <span class="material-symbols-outlined text-sm" data-icon="arrow_forward">arrow_forward</span>';
            }
        });

        // Forgot Password handler
        const forgotLink = document.querySelector('#loginForm a[href="#"]');
        if (forgotLink) {
            forgotLink.addEventListener('click', async (e) => {
                e.preventDefault();
                const email = document.getElementById('email').value;
                if (!email || !email.includes('@')) {
                    showToast('Please enter your email address first');
                    return;
                }
                try {
                    await sendPasswordReset(email);
                    showToast('Password reset link sent to your email');
                } catch (err) {
                    console.error('Reset password error:', err);
                    showToast('Failed to send reset email. Please try again.');
                }
            });
        }
    }

    // Handle Signup Form
    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fullName = document.getElementById('fullName').value;
            const email = document.getElementById('email').value;
            let role = document.querySelector('input[name="role"]:checked').value;
            const city = document.getElementById('city').value;
            const password = document.getElementById('password').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            const errorMsg = document.getElementById('errorMessage');
            const submitBtn = signupForm.querySelector('button[type="submit"]');

            if (password !== confirmPassword) {
                errorMsg.textContent = "Passwords do not match!";
                errorMsg.classList.remove('hidden');
                return;
            }

            try {
                errorMsg.classList.add('hidden');
                submitBtn.disabled = true;
                submitBtn.innerHTML = 'Creating Account...';
                
                const extraData = { name: fullName, city };
                
                // Check secret code OR email for admin access
                const secretCode = document.getElementById('secretCode');
                if ((secretCode && secretCode.value === 'ADMIN2024') || (email && email.toLowerCase().includes('admin@vitalpulse'))) {
                    role = 'admin';
                }
                
                if (role === 'donor') {
                    const bt = document.getElementById('bloodType');
                    if(bt) extraData.bloodType = bt.value;
                } else if (role === 'hospital') {
                    const phoneInput = document.getElementById('phone');
                    const licenseUrlInput = document.getElementById('licenseUrl');
                    if (phoneInput && phoneInput.value) extraData.phone = phoneInput.value;
                    if (licenseUrlInput && licenseUrlInput.value) extraData.licenseUrl = licenseUrlInput.value;
                    extraData.isVerified = false;
                }

                const user = await registerUser(email, password, role, extraData);

                showToast('Account created! A verification email has been sent. Please verify your email before donating.');

                setTimeout(() => {
                    if (user.role === 'admin') window.location.href = '/admin.html';
                    else if (user.role === 'hospital') window.location.href = '/hospital.html';
                    else window.location.href = '/donor.html';
                }, 2000);

            } catch (error) {
                const msg = error.code === 'auth/email-already-in-use' ? 'This email is already registered. Try logging in instead.'
                    : error.code === 'auth/weak-password' ? 'Password must be at least 6 characters.'
                    : error.code === 'auth/invalid-email' ? 'Invalid email address.'
                    : error.code === 'auth/operation-not-allowed' ? 'Email/password sign-up is currently disabled.'
                    : error.message || 'Registration failed. Try again.';
                errorMsg.textContent = msg;
                errorMsg.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Create Account <span class="material-symbols-outlined text-sm" data-icon="arrow_forward">arrow_forward</span>';
            }
        });
    }

    // Handle Logouts (Assuming there might be a logout button added to dashboards later)
    const logoutBtns = document.querySelectorAll('.logout-btn');
    logoutBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            logoutUser();
        });
    });

    // Handle Profile/Dashboard hydration based on currentUser
    if (isDashboard && currentUser) {
        if (path.includes('donor.html')) {
            const welcomeEl = document.getElementById('donorWelcomeMsg');
            if (welcomeEl) {
                const firstName = (currentUser.name || currentUser.email?.split('@')[0] || 'Donor').split(' ')[0];
                welcomeEl.textContent = `Welcome back, ${firstName} 👋`;
            }
            // blood type is rendered by donor-dashboard.js hero section
        } else if (path.includes('hospital.html')) {
            const hName = document.getElementById('hospitalName');
            const hLoc = document.getElementById('hospitalLocation');
            if (hName) hName.textContent = currentUser.name || 'General Hospital';
            if (hLoc) hLoc.innerHTML = `<span class="material-symbols-outlined text-sm" data-icon="location_on">location_on</span> ${currentUser.city || 'Yaoundé'} Network`;
        } else if (path.includes('admin.html')) {
            const adminName = document.getElementById('adminName');
            const adminRole = document.getElementById('adminRole');
            if (adminName) adminName.textContent = currentUser.name || 'Super Admin';
        }
        
        // Data hydration logic
        try {
            if (path.includes('donor.html')) {
                // Email verification check (async: reloads user from Firebase first)
                window.sendEmailVerificationLink = sendEmailVerificationLink;
                (async () => {
                    try {
                        const verified = await isEmailVerified();
                        if (verified) return;
                        const heroContainer = document.getElementById('donorHeroMessage')?.parentElement;
                        if (!heroContainer || document.getElementById('emailVerifyBanner')) return;
                        async function handleVerifyResend() {
                            try {
                                const nowVerified = await isEmailVerified();
                                if (nowVerified) {
                                    const b = document.getElementById('emailVerifyBanner');
                                    if (b) b.remove();
                                    showToast('Email verified!');
                                    return;
                                }
                                await sendEmailVerificationLink();
                                showToast('Verification email sent!');
                            } catch (e) {
                                showToast('Failed to send verification email.');
                            }
                        }
                        window.handleVerifyResend = handleVerifyResend;
                        const banner = document.createElement('div');
                        banner.id = 'emailVerifyBanner';
                        banner.className = 'flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3';
                        banner.innerHTML = '<span class="material-symbols-outlined text-amber-600 shrink-0">mark_email_unread</span><div class="flex-1 min-w-0"><p class="text-xs font-bold text-amber-800">Email not verified</p><p class="text-[10px] text-amber-600">Please check your inbox and verify your email to receive donation requests.</p></div><button onclick="handleVerifyResend()" class="text-[10px] font-bold text-amber-700 bg-amber-100 hover:bg-amber-200 px-3 py-1.5 rounded-lg transition-colors shrink-0">Verify</button>';
                        heroContainer.after(banner);
                    } catch (e) {
                        console.warn('Email verification check failed:', e);
                    }
                })();
                initDonorNavigation();
                loadDonorDashboard();
                initDonorDonationFlow();
                window.switchDonorView = switchDonorView;
                window.loadDonorDonations = loadDonorDonations;
                window.markOnboardingComplete = markOnboardingComplete;
            } else if (path.includes('hospital.html')) {
                initHospitalNavigation();
                loadHospitalDashboard();
                initHospitalNotifications();
                window.markOnboardingComplete = markOnboardingComplete;
                if (shouldShowOnboarding()) startOnboarding('hospital');
            } else if (path.includes('admin.html')) {
                loadAdminDashboard();
            }
            // After auth check, inject language toggle and onboarding for donor
            if (path.includes('donor.html')) {
                injectLangToggle();
                if (shouldShowOnboarding()) startOnboarding('donor');
            }

            // Inject lang toggle for hospital too
            if (path.includes('hospital.html')) {
                injectLangToggle();
            }
        } catch (initError) {
            console.error('Dashboard init failed:', initError);
            showFallbackError();
        }
    }

});

// Fallback for donor dashboard if initialization fails
function showFallbackError() {
  const path = window.location.pathname;
  if (!path.includes('donor.html')) return;

  const spinners = [
    'donorTierProgress', 'donorEligibilityBar', 'requestsFeed',
    'donorBadgesSummary', 'donorCampaigns', 'donorMapPreview',
    'donorRecentActivity', 'donorRequestsList', 'badgesFullView',
  ];
  spinners.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.querySelector('.animate-spin')) {
      el.innerHTML = '<div class="flex items-center justify-center py-4 text-on-surface-variant"><span class="text-sm">Could not load data.</span></div>';
    }
  });

  // Wire buttons with basic implementations as safety net
  document.querySelectorAll('[onclick*="switchDonorView"]').forEach(el => {
    const match = el.getAttribute('onclick')?.match(/switchDonorView\('(\w+)'\)/);
    if (match) {
      el.removeAttribute('onclick');
      el.addEventListener('click', () => {
        document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden'));
        const target = document.getElementById('view-' + match[1]);
        if (target) { target.classList.remove('hidden'); target.classList.add('block'); }
      });
    }
  });

  // Fallback: open donation modal for FAB and schedule buttons
  const showDonationModal = () => {
    const m = document.getElementById('donationModal');
    if (m) { m.classList.remove('hidden'); m.classList.add('flex'); }
  };
  document.getElementById('btnDonateFAB')?.addEventListener('click', showDonationModal);
  document.getElementById('btnScheduleDonationDesktop')?.addEventListener('click', showDonationModal);
  document.getElementById('btnCancelDonation')?.addEventListener('click', () => {
    const m = document.getElementById('donationModal');
    if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
  });
  document.getElementById('donationBackdrop')?.addEventListener('click', () => {
    const m = document.getElementById('donationModal');
    if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
  });
}

// Safety timeout: if loading spinners are still visible after 20s, clear them
setTimeout(() => showFallbackError(), 20000);

// ============================================
// DONOR DASHBOARD (moved to donor-dashboard.js)
// ============================================

// ============================================
// HOSPITAL DASHBOARD
// ============================================




// ============================================
// HOSPITAL DASHBOARD
// ============================================

let hospitalNavigationInitialized = false;

function initHospitalNavigation() {
    if (hospitalNavigationInitialized) return;

    const navIds = ['dashboard', 'requests', 'inventory', 'donors', 'settings', 'campaigns'];
    const viewIds = ['dashboard', 'requests', 'inventory', 'donors', 'settings', 'campaigns'];

    const globalTitle = document.getElementById('globalHeaderTitle');
    const globalSubtitle = document.getElementById('globalHeaderSubtitle');

    const titles = {
        dashboard: { title: 'Dashboard', sub: 'Hospital Control Center' },
        requests: { title: 'My Requests', sub: 'Blood Request Management' },
        inventory: { title: 'Inventory', sub: 'Blood Stock Management' },
        donors: { title: 'Incoming Donors', sub: 'Donor Coordination' },
        settings: { title: 'Settings', sub: 'Hospital Profile & Preferences' },
        campaigns: { title: 'Campaigns', sub: 'Donation Drives' }
    };

    const activeClass = 'bg-red-50 text-red-700 font-bold shadow-sm';
    const inactiveClass = 'text-slate-500 hover:bg-red-50 hover:text-red-700';

    const switchView = (target) => {
        viewIds.forEach(id => {
            const el = document.getElementById('view-' + id);
            if (el) {
                el.classList.add('hidden');
                el.classList.remove('block');
            }
        });
        navIds.forEach(id => {
            const nav = document.getElementById('nav-' + id);
            if (nav) {
                nav.className = `flex items-center gap-3 px-4 py-2.5 rounded-xl ${inactiveClass} transition-all duration-200 cursor-pointer`;
            }
        });

        const activeView = document.getElementById('view-' + target);
        if (activeView) {
            activeView.classList.remove('hidden');
            activeView.classList.add('block');
        }
        const activeNav = document.getElementById('nav-' + target);
        if (activeNav) {
            activeNav.className = `flex items-center gap-3 px-4 py-2.5 rounded-xl ${activeClass} transition-all duration-200 cursor-pointer`;
        }

        if (globalTitle) globalTitle.textContent = titles[target].title;
        if (globalSubtitle) globalSubtitle.textContent = titles[target].sub;

        // Lazy load data
        switch (target) {
            case 'dashboard': loadHospitalDashboard(); break;
            case 'requests': loadHospitalRequests(); break;
            case 'inventory': loadHospitalInventoryData(); break;
            case 'donors': loadHospitalDonors(); break;
            case 'settings': loadHospitalSettings(); break;
            case 'campaigns': loadHospitalCampaignsView(); break;
        }
    };

    navIds.forEach(id => {
        const nav = document.getElementById('nav-' + id);
        if (nav) {
            nav.addEventListener('click', (e) => {
                e.preventDefault();
                switchView(id);
            });
        }
    });

    // Wire up refresh button
    const refreshBtn = document.getElementById('btnRefresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            const activeView = viewIds.find(id => !document.getElementById('view-' + id)?.classList.contains('hidden'));
            if (activeView) switchView(activeView);
        });
    }

    // Wire up new request modal
    initNewRequestModal();
    initUrgentRequestModal();
    initHospitalAddStockModal();
    initIssueBloodModal();
    initCompatibilityGuideModal();
    initThresholdModal();

    // Wire mobile bottom nav
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.nav;
            // Update active state for mobile nav
            document.querySelectorAll('.mobile-nav-btn').forEach(b => {
                b.classList.remove('text-red-600', 'bg-red-50');
                b.classList.add('text-slate-400');
                const icon = b.querySelector('.material-symbols-outlined');
                if (icon) icon.style.fontVariationSettings = "'FILL' 0";
                const label = b.querySelector('span:last-child');
                if (label) label.classList.remove('font-bold');
            });
            btn.classList.remove('text-slate-400');
            btn.classList.add('text-red-600', 'bg-red-50');
            const icon = btn.querySelector('.material-symbols-outlined');
            if (icon) icon.style.fontVariationSettings = "'FILL' 1";
            const label = btn.querySelector('span:last-child');
            if (label) label.classList.add('font-bold');
            switchView(target);
        });
    });

    // Init new features
    initTimelineModal();
    initRemoveStockModal();
    initRemoveStockModalButtons();

    // Wire compatibility guide button
    const compatBtn = document.getElementById('btnOpenCompatGuide');
    if (compatBtn) {
        compatBtn.addEventListener('click', () => {
            const modal = document.getElementById('compatModal');
            if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
        });
    }

    // Wire dashboard 'Go to Inventory' button
    const dashInvBtn = document.getElementById('dashInventoryBtn');
    if (dashInvBtn) {
        dashInvBtn.addEventListener('click', () => switchView('inventory'));
    }

    hospitalNavigationInitialized = true;
}

async function loadHospitalDashboard() {
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const [allRequests, inventory, recentLogs] = await Promise.all([
            fetchActiveRequests(),
            fetchInventory(hospitalName),
            fetchRecentLogs(5)
        ]);

        const myRequests = allRequests.filter(r => r.hospital === hospitalName);
        const totalUnits = Object.values(inventory).reduce((s, i) => s + (i.unitsAvailable || 0), 0);
        const lowStockTypes = Object.values(inventory).filter(i => (i.unitsAvailable || 0) <= (i.minimumThreshold || 5));

        document.getElementById('dashActiveRequests').textContent = myRequests.length;
        document.getElementById('dashLowStock').textContent = lowStockTypes.length;
        document.getElementById('dashIncomingDonors').textContent = myRequests.filter(r => ['Donor Assigned', 'Donor En Route'].includes(r.status)).length;
        document.getElementById('dashTotalUnits').textContent = totalUnits;

        // Requests feed — show only this hospital's requests
        const feedEl = document.getElementById('dashRequestsFeed');
        if (feedEl) {
            const myActiveRequests = allRequests.filter(r => r.hospital === hospitalName);
            if (myActiveRequests.length === 0) {
                feedEl.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">check_circle</span><p class="text-sm">No active requests from your hospital</p></div>';
            } else {
                feedEl.innerHTML = myActiveRequests.slice(0, 8).map(req => {
                    const isMine = true;
                    const statusColor = req.status === 'Donor Assigned' || req.status === 'Donor En Route' ? 'bg-amber-500' : 'bg-blue-500';
                    const statusLabel = ['Donor Assigned', 'Donor En Route'].includes(req.status) ? req.status : 'Open';
                    return `
                    <div class="flex items-center justify-between p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors ${isMine ? 'ring-2 ring-red-200' : ''}">
                        <div class="flex items-center gap-3 min-w-0">
                            <span class="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm shrink-0">${req.type || req.bloodType || '?'}</span>
                            <div class="min-w-0">
                                <p class="text-sm font-bold text-on-surface truncate">${req.hospital}</p>
                                <p class="text-xs text-slate-500">${req.units || 1} unit${(req.units || 1) > 1 ? 's' : ''} needed</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <span class="w-2 h-2 rounded-full ${statusColor} ${['Donor Assigned', 'Donor En Route'].includes(req.status) ? 'animate-pulse' : ''}"></span>
                            <span class="text-[10px] font-bold text-slate-500 uppercase">${statusLabel}</span>
                        </div>
                    </div>
                    `;
                }).join('');
            }
        }

        // Activity feed
        const activityEl = document.getElementById('dashActivityFeed');
        if (activityEl) {
            if (recentLogs.length === 0) {
                activityEl.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">No recent activity</p></div>';
            } else {
                activityEl.innerHTML = recentLogs.map(log => {
                    const icon = log.type === 'success' ? 'check_circle' : log.type === 'warning' ? 'warning' : log.type === 'error' ? 'error' : 'info';
                    const color = log.type === 'success' ? 'text-emerald-600' : log.type === 'warning' ? 'text-amber-600' : log.type === 'error' ? 'text-red-600' : 'text-slate-600';
                    return `
                    <div class="flex items-start gap-3">
                        <span class="material-symbols-outlined text-sm ${color} mt-0.5">${icon}</span>
                        <div class="min-w-0">
                            <p class="text-sm font-bold text-on-surface truncate">${log.title}</p>
                            <p class="text-xs text-slate-500 truncate">${log.description}</p>
                            <p class="text-[10px] text-slate-400 mt-0.5">${new Date(log.timestamp).toLocaleString()}</p>
                        </div>
                    </div>
                    `;
                }).join('');
            }
        }
    } catch (e) {
        console.error('Failed to load hospital dashboard:', e);
    }

    // Load dashboard chart (Feature 9)
    loadDashboardChart();

    // Wire quick action button
    const dashUrgentBtn = document.getElementById('dashUrgentBtn');
    if (dashUrgentBtn) {
        dashUrgentBtn.onclick = () => {
            const modal = document.getElementById('urgentModal');
            if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
        };
    }
}

async function loadHospitalRequests() {
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';
    const tableBody = document.getElementById('requestsTableBody');
    if (!tableBody) return;

    try {
        const requests = await fetchHospitalRequests(hospitalName);

        document.getElementById('reqTotal').textContent = requests.length;
        document.getElementById('reqPending').textContent = requests.filter(r => ['Open', 'Matching', 'Donor Assigned', 'Donor En Route'].includes(r.status)).length;
        document.getElementById('reqResolved').textContent = requests.filter(r => r.status === 'Resolved').length;

        if (requests.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="px-6 py-12 text-center text-slate-400"><span class="material-symbols-outlined block text-3xl mb-2">assignment</span><p class="text-sm">No requests yet. Click "New Request" to create one.</p></td></tr>';
            return;
        }

        tableBody.innerHTML = requests.map(req => {
            const statusColors = {
                'Open': { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
                'Matching': { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
                'Donor Assigned': { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
                'Donor En Route': { bg: 'bg-indigo-100', text: 'text-indigo-700', dot: 'bg-indigo-500' },
                'Resolved': { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' }
            };
            const sc = statusColors[req.status] || { bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-500' };
            const urgencyColor = req.urgency === 'critical' ? 'text-red-600 bg-red-50' : req.urgency === 'urgent' ? 'text-amber-600 bg-amber-50' : 'text-slate-600 bg-slate-50';
            return `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="px-6 py-4"><span class="text-xs font-mono font-bold text-slate-700">#${req.id.slice(0, 8).toUpperCase()}</span></td>
                <td class="px-6 py-4"><span class="font-black text-red-700 bg-red-50 px-2 py-1 rounded text-xs">${req.type || req.bloodType || '?'}</span></td>
                <td class="px-6 py-4 text-sm font-semibold">${req.units || 1}</td>
                <td class="px-6 py-4"><span class="text-[10px] font-bold uppercase ${urgencyColor} px-2 py-1 rounded-lg">${req.urgency || 'standard'}</span></td>
                <td class="px-6 py-4">
                    <div class="flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full ${sc.dot} ${['Donor Assigned', 'Donor En Route'].includes(req.status) ? 'animate-pulse' : ''}"></span>
                        <span class="text-xs font-bold ${sc.text} ${sc.bg} px-2 py-1 rounded-md">${req.status}</span>
                    </div>
                </td>
                <td class="px-6 py-4 text-xs text-slate-500">${new Date(req.requestedAt || req.requestedAt).toLocaleDateString()}</td>
                <td class="px-6 py-4 text-right">
                    <div class="flex items-center justify-end gap-1">
                        <button onclick="window.openRequestTimeline('${req.id}')" class="text-[9px] font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors" title="View Timeline">
                            <span class="material-symbols-outlined text-xs">timeline</span>
                        </button>
                        <button onclick="window.printRequestSlip('${req.id}')" class="text-[9px] font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors" title="Print Slip">
                            <span class="material-symbols-outlined text-xs">print</span>
                        </button>
                        ${req.status === 'Resolved' ? '<span class="text-xs text-emerald-600 font-medium ml-1">Done</span>' : req.status === 'Donor En Route' ? '<span class="text-xs text-indigo-600 font-medium ml-1 animate-pulse">🔄 En Route</span>' : '<span class="text-xs text-slate-400 ml-1">Open</span>'}
                    </div>
                </td>
            </tr>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load hospital requests:', e);
        tableBody.innerHTML = '<tr><td colspan="7" class="text-center text-error py-8">Failed to load requests.</td></tr>';
    }
}

async function loadHospitalInventoryData() {
    const gridEl = document.getElementById('inventoryGrid');
    if (!gridEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const inventory = await fetchInventory(hospitalName);
        const allTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

        let totalUnits = 0;
        let lowStockCount = 0;
        let healthyCount = 0;

        let totalExpiring = 0;

        gridEl.innerHTML = allTypes.map(type => {
            const inv = inventory[type] || { unitsAvailable: 0, minimumThreshold: 5, batches: [], componentTotals: {}, expiringSoon: 0, expiredUnits: 0 };
            const info = getBloodTypeDisplayInfo(type);
            totalUnits += inv.unitsAvailable || 0;
            totalExpiring += inv.expiringSoon || 0;
            const isLow = (inv.unitsAvailable || 0) <= (inv.minimumThreshold || 5);
            if (isLow) lowStockCount++; else healthyCount++;

            const pct = Math.min(100, Math.round(((inv.unitsAvailable || 0) / Math.max(inv.minimumThreshold || 5, 1)) * 100));
            const borderColor = isLow ? 'border-red-200' : 'border-slate-100';
            const bgCard = isLow ? 'bg-red-50' : 'bg-white';
            const barColor = isLow ? 'bg-red-500' : pct > 75 ? 'bg-emerald-500' : 'bg-amber-500';

            let badge = '';
            if (inv.expiredUnits > 0) badge = '<span class="text-[9px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full uppercase tracking-wider">Expired</span>';
            else if (inv.expiringSoon > 0) badge = '<span class="text-[9px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full uppercase tracking-wider">Expiring</span>';
            else if (isLow) badge = '<span class="text-[9px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full uppercase tracking-wider">Low Stock</span>';
            else badge = '<span class="text-[9px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full uppercase tracking-wider">In Stock</span>';

            const comps = inv.componentTotals && Object.keys(inv.componentTotals).length > 0
                ? Object.entries(inv.componentTotals).filter(([_, u]) => u > 0).map(([comp, u]) =>
                    `<span class="text-[9px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">${comp.slice(0, 6)} ${u}u</span>`
                  ).join('')
                : '';

            return `
            <div class="${bgCard} rounded-2xl p-5 shadow-sm border ${borderColor} hover:shadow-md transition-all group">
                <div class="flex items-center justify-between mb-4">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl flex items-center justify-center font-black text-lg" style="background-color: ${info.color}15; color: ${info.color}">${type}</div>
                        <div>
                            <p class="text-2xl font-black text-on-surface">${inv.unitsAvailable || 0}</p>
                            <p class="text-[10px] text-slate-500 font-medium">units</p>
                        </div>
                    </div>
                    ${badge}
                </div>
                ${comps ? `<div class="flex flex-wrap gap-1 mb-2">${comps}</div>` : ''}
                <div class="space-y-2">
                    <div class="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                        <div class="${barColor} h-full rounded-full" style="width: ${pct}%"></div>
                    </div>
                    <div class="flex justify-between text-[10px] text-slate-500">
                        <span>Threshold: ${inv.minimumThreshold || 5}</span>
                        <span class="font-bold">${pct}%</span>
                    </div>
                </div>
                ${inv.expiringSoon > 0 ? `<div class="mt-2 text-[9px] font-bold text-amber-600 flex items-center gap-1"><span class="material-symbols-outlined text-xs">schedule</span>${inv.expiringSoon} unit(s) expiring within 30 days</div>` : ''}
                ${inv.expiredUnits > 0 ? `<div class="mt-2 text-[9px] font-bold text-red-600 flex items-center gap-1"><span class="material-symbols-outlined text-xs">dangerous</span>${inv.expiredUnits} unit(s) expired</div>` : ''}
                <div class="mt-3 pt-3 border-t border-slate-100 grid grid-cols-4 gap-1">
                    <button onclick="window.openHospitalAddStock('${type}')" class="text-[9px] font-bold text-red-600 bg-red-50 hover:bg-red-100 py-1.5 rounded-lg transition-colors">Add</button>
                    <button onclick="window.openHospitalIssueBlood('${type}', ${inv.unitsAvailable || 0})" class="text-[9px] font-bold text-amber-600 bg-amber-50 hover:bg-amber-100 py-1.5 rounded-lg transition-colors">Issue</button>
                    <button onclick="window.openHospitalRemoveStock('${type}')" class="text-[9px] font-bold text-red-700 bg-red-50 hover:bg-red-100 py-1.5 rounded-lg transition-colors">Remove</button>
                    <button onclick="window.openHospitalSetThreshold('${type}')" class="text-[9px] font-bold text-slate-600 bg-slate-50 hover:bg-slate-100 py-1.5 rounded-lg transition-colors">Thresh</button>
                </div>
            </div>
            `;
        }).join('');

        document.getElementById('invTotalUnits').textContent = totalUnits;
        document.getElementById('invLowStock').textContent = lowStockCount;
        document.getElementById('invHealthy').textContent = healthyCount;
        document.getElementById('invExpiring').textContent = totalExpiring;

        // Low stock alerts
        const alertsEl = document.getElementById('lowStockAlerts');
        if (alertsEl) {
            const lowItems = allTypes.filter(type => {
                const inv = inventory[type] || { unitsAvailable: 0, minimumThreshold: 5 };
                return (inv.unitsAvailable || 0) <= (inv.minimumThreshold || 5);
            });
            if (lowItems.length === 0) {
                alertsEl.innerHTML = '<div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 flex items-center gap-3"><span class="material-symbols-outlined text-emerald-600">check_circle</span><p class="text-sm font-bold text-emerald-700">All blood types are adequately stocked</p></div>';
            } else {
                alertsEl.innerHTML = `<div class="bg-red-50 border border-red-200 rounded-2xl p-5">
                    <div class="flex items-center gap-2 mb-4"><span class="material-symbols-outlined text-red-600">warning</span><span class="text-sm font-bold text-red-700">Low Stock Alerts</span></div>
                    <div class="space-y-2">
                        ${lowItems.map(type => {
                            const inv = inventory[type] || {};
                            return `<div class="flex items-center justify-between p-3 bg-white rounded-xl">
                                <div class="flex items-center gap-3">
                                    <span class="w-8 h-8 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm">${type}</span>
                                    <div><p class="text-sm font-bold text-on-surface">${inv.unitsAvailable || 0} units available</p><p class="text-[10px] text-slate-500">Min threshold: ${inv.minimumThreshold || 5}</p></div>
                                </div>
                                <button onclick="window.openHospitalAddStock('${type}')" class="text-xs font-bold text-red-600 hover:underline">Add Stock</button>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            }
        }

        // Load inventory movement history (Feature 7)
        loadInventoryMovements();
    } catch (e) {
        console.error('Failed to load inventory:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-12">Failed to load inventory data.</div>';
    }
}

async function loadHospitalDonors() {
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';
    const gridEl = document.getElementById('donorsGrid');
    if (!gridEl) return;

    try {
        const donors = await fetchIncomingDonors(hospitalName);

        document.getElementById('donTotal').textContent = donors.length;
        document.getElementById('donEnRoute').textContent = donors.length;
        document.getElementById('donArrived').textContent = 0;

        if (donors.length === 0) {
            gridEl.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-16 text-slate-400"><span class="material-symbols-outlined text-4xl mb-3">groups</span><p class="text-sm font-medium">No incoming donors</p><p class="text-xs text-slate-400 mt-1">Donors will appear here when they accept your requests</p></div>';
            return;
        }

        gridEl.innerHTML = donors.map(d => {
            const donor = d.donorInfo || {};
            const matchedTime = d.matchedAt ? new Date(d.matchedAt).toLocaleString() : 'Unknown';
            const donorCity = donor.city || 'Unknown';
            const isSameCity = donorCity.toLowerCase() === (currentUser?.city || '').toLowerCase();
            return `
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition-all">
                <div class="flex items-center gap-4 mb-4">
                    <div class="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center text-red-700 font-black text-lg shrink-0">
                        ${(donor.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div class="min-w-0">
                        <p class="font-bold text-on-surface truncate">${donor.name || 'Unknown Donor'}</p>
                        <p class="text-xs text-slate-500 truncate">${donor.email || 'No email'}</p>
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold ${isSameCity ? 'text-emerald-600' : 'text-slate-500'} mt-0.5">
                            <span class="material-symbols-outlined text-xs">location_on</span>
                            ${donorCity} ${isSameCity ? '<span class="text-emerald-600 font-bold">• Nearby</span>' : ''}
                        </span>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3 mb-4">
                    <div class="bg-slate-50 rounded-xl p-3 text-center">
                        <p class="text-lg font-black text-red-700">${d.type || d.bloodType || '?'}</p>
                        <p class="text-[9px] text-slate-500 uppercase tracking-wider">Blood Type</p>
                    </div>
                    <div class="bg-slate-50 rounded-xl p-3 text-center">
                        <p class="text-lg font-black text-on-surface">${d.units || 1}</p>
                        <p class="text-[9px] text-slate-500 uppercase tracking-wider">Units</p>
                    </div>
                </div>
                <div class="space-y-2">
                    <div class="flex items-center justify-between text-xs">
                        <span class="text-slate-500">Matched at</span>
                        <span class="font-bold text-on-surface">${matchedTime}</span>
                    </div>
                    <div class="flex items-center justify-between text-xs">
                        <span class="text-slate-500">Phone</span>
                        <span class="font-bold text-on-surface">${donor.phone || 'N/A'}</span>
                    </div>
                </div>
                <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                    <button onclick="window.openDonorEngagement('${d.matchedDonor}')" class="text-[10px] font-bold text-amber-600 bg-amber-50 hover:bg-amber-100 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                        <span class="material-symbols-outlined text-xs">military_tech</span>
                        Profile
                    </button>
                    <button onclick="window.completeDonorArrival('${d.id}', '${d.matchedDonor}')" class="text-[10px] font-bold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1">
                        <span class="material-symbols-outlined text-xs">check</span>
                        Complete
                    </button>
                </div>
            </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load donors:', e);
        gridEl.innerHTML = '<div class="col-span-full text-center text-error py-12">Failed to load incoming donors.</div>';
    }
}

async function loadHospitalSettings() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    document.getElementById('setHospitalName').value = currentUser.name || '';
    document.getElementById('setHospitalCity').value = currentUser.city || '';
    document.getElementById('setHospitalEmail').value = currentUser.email || '';
    document.getElementById('setHospitalPhone').value = currentUser.phone || '';

    const sidebarName = document.getElementById('hospitalSidebarName');
    const sidebarLoc = document.getElementById('hospitalSidebarLocation');
    if (sidebarName) sidebarName.textContent = currentUser.name || 'Hospital';
    if (sidebarLoc) sidebarLoc.textContent = (currentUser.city || 'Cameroon') + ' Network';

    // Settings form
    const form = document.getElementById('settingsForm');
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Saving...';
            btn.disabled = true;

            try {
                await updateUserProfile(currentUser.uid, {
                    name: document.getElementById('setHospitalName').value,
                    city: document.getElementById('setHospitalCity').value,
                    email: document.getElementById('setHospitalEmail').value,
                    phone: document.getElementById('setHospitalPhone').value
                });
                // Update local storage
                const updated = { ...currentUser, name: document.getElementById('setHospitalName').value, city: document.getElementById('setHospitalCity').value, email: document.getElementById('setHospitalEmail').value, phone: document.getElementById('setHospitalPhone').value };
                localStorage.setItem('vitalpulse_user', JSON.stringify(updated));
                await logActivity('Profile Updated', `${updated.name} updated their hospital profile`, 'info');
                showToast('Profile saved successfully!');
                if (sidebarName) sidebarName.textContent = updated.name;
                if (sidebarLoc) sidebarLoc.textContent = (updated.city || 'Cameroon') + ' Network';
            } catch (err) {
                console.error('Failed to save settings:', err);
                alert('Failed to save settings.');
            } finally {
                btn.innerHTML = 'Save Changes';
                btn.disabled = false;
            }
        };
    }
}

function initNewRequestModal() {
    const openBtn = document.getElementById('btnNewRequest');
    const modal = document.getElementById('newRequestModal');
    const backdrop = document.getElementById('newRequestBackdrop');
    const closeBtn = document.getElementById('btnCloseNewRequest');
    const form = document.getElementById('newRequestForm');

    const open = () => { if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); } };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };

    if (openBtn) openBtn.addEventListener('click', open);
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Blood type selector
    const typeBtns = document.querySelectorAll('#requestBloodTypeGroup button');
    const selectedInput = document.getElementById('requestSelectedType');
    typeBtns.forEach(btn => {
        btn.onclick = () => {
            typeBtns.forEach(b => { b.className = 'px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold hover:border-red-300 hover:text-red-700 transition-all'; });
            btn.className = 'px-4 py-2 rounded-lg border-2 border-red-500 bg-red-50 text-red-700 text-sm font-bold transition-all';
            selectedInput.value = btn.dataset.type;
        };
    });

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            if (!currentUser) return;
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Submitting...';
            btn.disabled = true;

            try {
                await createEmergencyRequest({
                    hospital: currentUser.name || 'General Hospital',
                    city: currentUser.city || 'Cameroon',
                    type: selectedInput.value,
                    bloodType: selectedInput.value,
                    componentType: document.getElementById('reqComponent')?.value || 'Whole Blood',
                    units: parseInt(document.getElementById('requestUnits').value, 10),
                    urgency: document.getElementById('requestUrgency').value,
                    patientName: document.getElementById('reqPatientName')?.value || '',
                    ward: document.getElementById('reqWard')?.value || '',
                    requestingDoctor: document.getElementById('reqDoctor')?.value || '',
                    diagnosis: document.getElementById('reqDiagnosis')?.value || '',
                    requiredBy: document.getElementById('reqRequiredBy')?.value || '',
                    notes: document.getElementById('requestNotes').value,
                    distance: 'Local'
                });
                close();
                showToast('Request submitted successfully!');
                loadHospitalRequests();
            } catch (err) {
                console.error('Failed to create request:', err);
                alert('Failed to create request.');
            } finally {
                btn.innerHTML = 'Submit Request';
                btn.disabled = false;
            }
        };
    }
}

function initUrgentRequestModal() {
    const openBtns = document.querySelectorAll('#btnUrgentRequest, #dashUrgentBtn');
    const modal = document.getElementById('urgentModal');
    const backdrop = document.getElementById('urgentBackdrop');
    const closeBtn = document.getElementById('btnCloseUrgent');
    const form = document.getElementById('urgentRequestForm');

    const open = () => { if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); } };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };

    openBtns.forEach(btn => { if (btn) btn.addEventListener('click', open); });
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    const typeBtns = document.querySelectorAll('#urgentBloodTypeGroup button');
    const selectedInput = document.getElementById('urgentSelectedType');
    typeBtns.forEach(btn => {
        btn.onclick = () => {
            typeBtns.forEach(b => { b.className = 'px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold hover:border-red-300 hover:text-red-700 transition-all'; });
            btn.className = 'px-4 py-2 rounded-lg border-2 border-red-500 bg-red-50 text-red-700 text-sm font-bold transition-all';
            selectedInput.value = btn.dataset.type;
        };
    });

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            if (!currentUser) return;
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Broadcasting...';
            btn.disabled = true;

            try {
                await createEmergencyRequest({
                    hospital: currentUser.name || 'General Hospital',
                    city: currentUser.city || 'Cameroon',
                    type: selectedInput.value,
                    bloodType: selectedInput.value,
                    units: parseInt(document.getElementById('urgentUnits').value, 10),
                    urgency: document.getElementById('urgentLevel').value,
                    notes: document.getElementById('urgentNotes').value,
                    distance: 'System-wide'
                });
                await logActivity('Emergency Broadcast', `${selectedInput.value} urgently requested by ${currentUser.name}`, 'error');
                close();
                showToast('Emergency broadcast sent!');
            } catch (err) {
                console.error('Failed to broadcast:', err);
                alert('Failed to broadcast emergency.');
            } finally {
                btn.innerHTML = 'Broadcast Emergency';
                btn.disabled = false;
            }
        };
    }
}

function initHospitalAddStockModal() {
    const openBtn = document.getElementById('btnAddStock');
    const modal = document.getElementById('addStockModal');
    const backdrop = document.getElementById('addStockBackdrop');
    const cancelBtn = document.getElementById('btnCancelStock');
    const form = document.getElementById('addStockForm');

    const open = (preselected = '') => {
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            if (preselected) {
                const select = document.getElementById('stockBloodType');
                if (select) select.value = preselected;
            }
        }
    };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };

    if (openBtn) openBtn.addEventListener('click', () => open());
    if (backdrop) backdrop.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Adding...';
            btn.disabled = true;

            const currentUser = getCurrentUser();
            const hospName = currentUser?.name || 'General Hospital';
            try {
                await updateInventoryStock(
                    document.getElementById('stockBloodType').value,
                    document.getElementById('stockUnits').value,
                    'add',
                    hospName,
                    {
                        componentType: document.getElementById('stockComponent')?.value || 'Whole Blood',
                        expiresAt: document.getElementById('stockExpiry')?.value || null
                    }
                );
                await logActivity('Inventory Added', `${document.getElementById('stockUnits').value} units of ${document.getElementById('stockBloodType').value} added via hospital portal`, 'success');
                close();
                showToast('Stock added successfully!');
                loadHospitalInventoryData();
            } catch (err) {
                console.error('Failed to add stock:', err);
                alert('Failed to add stock.');
            } finally {
                btn.innerHTML = 'Add to Inventory';
                btn.disabled = false;
            }
        };
    }

    // Export button
    const exportBtn = document.getElementById('btnExportInventory');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            // Simple CSV export of the inventory grid data
            const cards = document.querySelectorAll('#inventoryGrid > div');
            if (!cards.length) return;
            let csv = 'Blood Type,Units,Status\n';
            cards.forEach(card => {
                const type = card.querySelector('.font-black.text-lg')?.textContent || '';
                const units = card.querySelector('.text-2xl.font-black')?.textContent || '0';
                const badge = card.querySelector('.text-\\[9px\\]')?.textContent?.trim() || '';
                csv += `${type},${units},${badge}\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `inventory_${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }
}

window.openHospitalAddStock = (type) => {
    const modal = document.getElementById('addStockModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        const select = document.getElementById('stockBloodType');
        if (select) select.value = type;
    }
};

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
window.showToast = showToast;

async function loadAdminDashboard() {
    try {
        // 1. Load System Health Metrics
        const requests = await fetchActiveRequests();
        const activeCountEl = document.getElementById('adminActiveRequests');
        if (activeCountEl) activeCountEl.textContent = requests.length;

        // Calculate True Avg Response Time
        const allRequests = await fetchAllSystemRequests();
        const resolvedReqs = allRequests.filter(r => (r.status === 'Resolved' || r.status === 'resolved') && r.timestamp && r.resolvedAt);
        const avgResponseEl = document.getElementById('adminAvgResponse');
        
        if (avgResponseEl) {
            if (resolvedReqs.length === 0) {
                avgResponseEl.innerHTML = '--<span class="text-lg ml-1">m</span>';
            } else {
                const totalMins = resolvedReqs.reduce((acc, r) => {
                    return acc + ((new Date(r.resolvedAt) - new Date(r.timestamp)) / 60000);
                }, 0);
                const avgMins = (totalMins / resolvedReqs.length).toFixed(1);
                avgResponseEl.innerHTML = `${avgMins}<span class="text-lg ml-1">m</span>`;
            }
        }

        const verifiedClinicsCount = await fetchClinicsOnlineCount();
        const clinicsOnlineEl = document.getElementById('adminClinicsOnline');
        const clinicsOnlineBar = document.getElementById('adminClinicsOnlineBar');
        
        // Let's assume an arbitrary target of 20 clinics for 100% capacity for MVP logic.
        const targetClinics = 20; 
        const percentage = Math.min(100, Math.round((verifiedClinicsCount / targetClinics) * 100));
        if (clinicsOnlineEl) clinicsOnlineEl.textContent = percentage + '%';
        if (clinicsOnlineBar) clinicsOnlineBar.style.width = percentage + '%';

        // 2. Load Hospital Verifications
        const tableBody = document.getElementById('adminPendingHospitals');
        if (tableBody) {
            const pendingHospitals = await fetchPendingHospitals();
            if (pendingHospitals.length === 0) {
                 tableBody.innerHTML = '<tr><td colspan="4" class="px-6 py-8 text-center text-slate-500 font-medium">No pending verifications.</td></tr>';
            } else {
                 tableBody.innerHTML = pendingHospitals.map(h => `
                 <tr class="hover:bg-surface-container-low/50 transition-colors">
                     <td class="px-6 py-5">
                         <div class="font-bold text-on-surface">${h.name}</div>
                         <div class="text-[11px] text-slate-400">ID: ${h.id.slice(0,8).toUpperCase()}</div>
                     </td>
                     <td class="px-6 py-5 text-sm text-slate-600">${h.city || 'Cameroon'}</td>
                     <td class="px-6 py-5">
                         <button class="flex items-center gap-1.5 text-xs font-bold text-tertiary hover:bg-tertiary-container/10 px-2 py-1 rounded transition-colors">
                             <span class="material-symbols-outlined text-sm" data-icon="description">description</span> Review PDF
                         </button>
                     </td>
                     <td class="px-6 py-5 text-right space-x-2">
                         <button onclick="window.handleAdminReject('${h.id}', '${h.name}')" class="text-xs font-bold px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors">Reject</button>
                         <button onclick="window.handleAdminApprove('${h.id}', '${h.name}')" class="text-xs font-bold px-4 py-2 rounded-lg bg-primary-container text-on-primary-container hover:shadow-md transition-all">Approve</button>
                     </td>
                 </tr>
                 `).join('');
            }
        }

        // 3. Load Recent Activity Feed
        const activityFeed = document.getElementById('adminActivityFeed');
        if (activityFeed) {
            const logs = await fetchRecentLogs(4);
            if (logs.length === 0) {
                 activityFeed.innerHTML = '<div class="text-center text-slate-400 text-sm italic py-4">System is quiet. No logs yet.</div>';
            } else {
                 activityFeed.innerHTML = logs.map(log => {
                     let icon = 'info';
                     let colorClass = 'bg-slate-100 text-slate-600';
                     if (log.type === 'success') { icon = 'check_circle'; colorClass = 'bg-green-100 text-green-600'; }
                     if (log.type === 'warning') { icon = 'warning'; colorClass = 'bg-amber-100 text-amber-600'; }
                     if (log.type === 'error') { icon = 'error'; colorClass = 'bg-red-100 text-red-600'; }

                     return `
                     <div class="relative pl-8">
                         <div class="absolute left-0 top-1 w-6 h-6 rounded-full ${colorClass} flex items-center justify-center">
                             <span class="material-symbols-outlined text-xs" data-icon="${icon}">${icon}</span>
                         </div>
                         <div>
                             <p class="text-sm font-bold text-on-surface">${log.title}</p>
                             <p class="text-xs text-slate-500 mt-1">${log.description}</p>
                             <p class="text-[10px] text-slate-400 mt-2 font-medium">${new Date(log.timestamp).toLocaleTimeString()}</p>
                         </div>
                     </div>
                     `;
                 }).join('');
            }
        }

        // 4. Load Overview Campaigns from DB
        const overviewCampaignsGrid = document.getElementById('overviewCampaignsGrid');
        if (overviewCampaignsGrid) {
            const campaigns = await fetchAllCampaigns();
            const activeCampaigns = campaigns.filter(c => c.status === 'active' || c.status === 'planning').slice(0, 3);
            
            if (activeCampaigns.length === 0) {
                overviewCampaignsGrid.innerHTML = `
                    <div class="col-span-full text-center py-8">
                        <span class="material-symbols-outlined text-4xl text-slate-300 mb-2">campaign</span>
                        <p class="text-slate-500 text-sm">No active campaigns</p>
                    </div>
                `;
            } else {
                overviewCampaignsGrid.innerHTML = activeCampaigns.map(c => {
                    const progress = c.targetUnits ? Math.round((c.unitsCollected || 0) / c.targetUnits * 100) : 0;
                    const statusColors = c.status === 'active' 
                        ? { badge: 'bg-green-500', text: 'text-green-600' }
                        : { badge: 'bg-blue-500', text: 'text-blue-600' };
                    
                    return `
                    <div class="bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm border border-outline-variant/10 group">
                        <div class="h-32 overflow-hidden relative bg-gradient-to-br from-red-50 to-red-100">
                            <div class="absolute inset-0 flex items-center justify-center">
                                <span class="material-symbols-outlined text-4xl text-red-200">campaign</span>
                            </div>
                            <div class="absolute top-3 right-3 px-2 py-1 ${statusColors.badge} text-white text-[9px] font-black uppercase rounded-sm">${c.status}</div>
                        </div>
                        <div class="p-5">
                            <h3 class="font-black text-base text-on-surface leading-tight mb-1 truncate">${c.title}</h3>
                            <p class="text-xs text-slate-500 mb-4 flex items-center gap-1">
                                <span class="material-symbols-outlined text-[12px]">location_on</span> ${c.location}
                            </p>
                            <div class="space-y-2">
                                <div class="flex justify-between text-xs font-bold text-on-surface">
                                    <span>${c.unitsCollected || 0} / ${c.targetUnits || 0} units</span>
                                    <span class="${statusColors.text}">${progress}%</span>
                                </div>
                                <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                                    <div class="${statusColors.badge} h-full rounded-full" style="width: ${progress}%"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    `;
                }).join('');
            }
        }

        // 5. Emergency Broadcast Modal Logic
        const openBtn = document.getElementById('openUrgentModalBtn');
        const closeBtn = document.getElementById('btnCancelUrgent');
        const backdrop = document.getElementById('urgentRequestBackdrop');
        const modal = document.getElementById('urgentRequestModal');
        
        const openModal = () => {
            modal?.classList.remove('hidden');
            modal?.classList.add('flex');
        };
        const closeModal = () => {
            modal?.classList.add('hidden');
            modal?.classList.remove('flex');
        };
        
        // Remove old listeners to prevent duplication on multiple loadAdminDashboard calls
        const newOpenBtn = openBtn?.cloneNode(true);
        if (openBtn && newOpenBtn) openBtn.parentNode.replaceChild(newOpenBtn, openBtn);
        const newCloseBtn = closeBtn?.cloneNode(true);
        if (closeBtn && newCloseBtn) closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        const newBackdrop = backdrop?.cloneNode(true);
        if (backdrop && newBackdrop) backdrop.parentNode.replaceChild(newBackdrop, backdrop);

        const activeOpenBtn = document.getElementById('openUrgentModalBtn');
        const activeCloseBtn = document.getElementById('btnCancelUrgent');
        const activeBackdrop = document.getElementById('urgentRequestBackdrop');

        if (activeOpenBtn) activeOpenBtn.addEventListener('click', openModal);
        if (activeCloseBtn) activeCloseBtn.addEventListener('click', closeModal);
        if (activeBackdrop) activeBackdrop.addEventListener('click', closeModal);

        const typeBtns = document.querySelectorAll('#urgentBloodTypeGroup button');
        const selectedTypeInput = document.getElementById('urgentSelectedType');
        
        typeBtns.forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                // Reset all
                typeBtns.forEach(b => {
                    b.classList.remove('border-primary-container', 'bg-primary-container/10', 'text-primary');
                    b.classList.add('border-slate-100', 'text-slate-700');
                });
                // Highlight clicked
                btn.classList.add('border-primary-container', 'bg-primary-container/10', 'text-primary');
                btn.classList.remove('border-slate-100', 'text-slate-700');
                selectedTypeInput.value = btn.dataset.type;
            };
        });

        const form = document.getElementById('urgentRequestForm');
        if (form) {
            form.onsubmit = async (e) => {
                e.preventDefault();
                const btn = form.querySelector('button[type="submit"]');
                btn.innerHTML = 'Broadcasting...';
                btn.disabled = true;

                const bloodType = document.getElementById('urgentSelectedType').value;
                const units = document.getElementById('urgentUnits').value;
                const urgency = document.getElementById('urgentLevel').value;
                const notes = document.getElementById('urgentNotes').value;

                try {
                    await createEmergencyRequest({
                        hospital: 'Central Command',
                        city: 'National',
                        type: bloodType,
                        units: parseInt(units, 10),
                        distance: 'System-wide',
                        urgency: urgency,
                        notes: notes
                    });
                    
                    await logActivity(
                        'Emergency Broadcast',
                        `${units} units of ${bloodType} urgently requested. Level: ${urgency}`,
                        'error'
                    );

                    form.reset();
                    // select O- default visually
                    document.querySelector('#urgentBloodTypeGroup button[data-type="O-"]').click();
                    closeModal();
                    loadAdminDashboard(); // refresh dashboard metrics
                } catch(err) {
                    console.error("Failed to broadcast", err);
                    alert("Failure to push to system.");
                } finally {
                    btn.innerHTML = 'Broadcast Request';
                    btn.disabled = false;
                }
            };
        }

        initHospitalDetailModal();
        initDonorDetailModal();
        initAdminNavigation();
        initNotificationSystem();
        initCampaignModal();
        
        // Overview page campaign buttons
        const overviewNewCampaignBtn = document.getElementById('btnNewCampaignOverview');
        const overviewScheduleCampaignBtn = document.getElementById('btnScheduleNewCampaign');
        
        if (overviewNewCampaignBtn) {
            overviewNewCampaignBtn.onclick = () => {
                const modal = document.getElementById('campaignModal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                    document.getElementById('campaignModalTitle').textContent = 'Create Campaign';
                    document.getElementById('campaignForm').reset();
                    document.getElementById('campaignId').value = '';
                }
            };
        }
        
        if (overviewScheduleCampaignBtn) {
            overviewScheduleCampaignBtn.onclick = () => {
                const modal = document.getElementById('campaignModal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                    document.getElementById('campaignModalTitle').textContent = 'Create Campaign';
                    document.getElementById('campaignForm').reset();
                    document.getElementById('campaignId').value = '';
                }
            };
        }
    } catch (e) {
        console.error("Failed to load admin dashboard", e);
    }
}

// Global SPA Router Logic
let adminNavigationInitialized = false;
function initAdminNavigation() {
    if(adminNavigationInitialized) return;
    
    const btnOverview = document.getElementById('nav-overview');
    const btnVerifications = document.getElementById('nav-verifications');
    const btnUsers = document.getElementById('nav-users');
    const btnLogs = document.getElementById('nav-logs');
    const btnDonations = document.getElementById('nav-donations');
    const btnInventory = document.getElementById('nav-inventory');
    const btnAnalytics = document.getElementById('nav-analytics');
    const btnCampaigns = document.getElementById('nav-campaigns');
    const btnSettings = document.getElementById('nav-settings');
    
    const viewOverview = document.getElementById('view-overview');
    const viewVerifications = document.getElementById('view-verifications');
    const viewUsers = document.getElementById('view-users');
    const viewLogs = document.getElementById('view-logs');
    const viewDonations = document.getElementById('view-donations');
    const viewInventory = document.getElementById('view-inventory');
    const viewAnalytics = document.getElementById('view-analytics');
    const viewCampaigns = document.getElementById('view-campaigns');
    const viewSettings = document.getElementById('view-settings');
    
    if(!btnOverview || !btnVerifications || !btnUsers || !btnLogs || !btnDonations || !btnInventory || !btnCampaigns || !btnSettings) return;

    const globalTitle = document.getElementById('globalHeaderTitle');
    const globalSubtitle = document.getElementById('globalHeaderSubtitle');

    const resetViews = () => {
        viewOverview.classList.add('hidden');
        viewOverview.classList.remove('block');
        viewVerifications.classList.add('hidden');
        viewVerifications.classList.remove('block');
        viewUsers.classList.add('hidden');
        viewUsers.classList.remove('block');
        viewLogs.classList.add('hidden');
        viewLogs.classList.remove('block');
        viewDonations.classList.add('hidden');
        viewDonations.classList.remove('block');
        viewInventory.classList.add('hidden');
        viewInventory.classList.remove('block');
        viewAnalytics.classList.add('hidden');
        viewAnalytics.classList.remove('block');
        viewCampaigns.classList.add('hidden');
        viewCampaigns.classList.remove('block');
        viewSettings.classList.add('hidden');
        viewSettings.classList.remove('block');

        const inactiveClass = 'text-slate-500 dark:text-slate-400 px-4 py-3 flex items-center gap-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200 cursor-pointer';
        btnOverview.className = inactiveClass;
        btnVerifications.className = inactiveClass;
        btnUsers.className = inactiveClass;
        btnLogs.className = inactiveClass;
        btnDonations.className = inactiveClass;
        btnInventory.className = inactiveClass;
        btnAnalytics.className = inactiveClass;
        btnCampaigns.className = inactiveClass;
        btnSettings.className = inactiveClass;
    };

    const activeClass = 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 font-bold rounded-r-full px-4 py-3 flex items-center gap-3 transition-all duration-200 cursor-default';

    const switchView = (target) => {
        resetViews();

        if(target === 'overview') {
            viewOverview.classList.remove('hidden');
            viewOverview.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'System Overview';
            if(globalSubtitle) globalSubtitle.textContent = 'Global Dashboard';
            btnOverview.className = activeClass;
        } else if(target === 'verifications') {
            viewVerifications.classList.remove('hidden');
            viewVerifications.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Hospital Verifications';
            if(globalSubtitle) globalSubtitle.textContent = 'Institutional Management';
            btnVerifications.className = activeClass;
            window.renderHospitalVerificationsTab(document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending');
        } else if(target === 'users') {
            viewUsers.classList.remove('hidden');
            viewUsers.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'User Management';
            if(globalSubtitle) globalSubtitle.textContent = 'Donor Directory';
            btnUsers.className = activeClass;
            window.renderUserManagementTab(document.querySelector('#userTabs button.text-primary')?.dataset.tab || 'all');
        } else if(target === 'logs') {
            viewLogs.classList.remove('hidden');
            viewLogs.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Emergency Operations Audits';
            if(globalSubtitle) globalSubtitle.textContent = 'Global Requests Log';
            btnLogs.className = activeClass;
            window.renderRequestLogsTab(document.querySelector('#logTabs button.text-primary')?.dataset.tab || 'all');
        } else if(target === 'donations') {
            viewDonations.classList.remove('hidden');
            viewDonations.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Donation Requests';
            if(globalSubtitle) globalSubtitle.textContent = 'Donor Submissions';
            btnDonations.className = activeClass;
            window.renderDonationsTab(document.querySelector('#donationTabs button.text-primary')?.dataset.tab || 'all');
        } else if(target === 'inventory') {
            viewInventory.classList.remove('hidden');
            viewInventory.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Blood Inventory';
            if(globalSubtitle) globalSubtitle.textContent = 'Stock Management';
            btnInventory.className = activeClass;
            loadInventoryDashboard();
        } else if(target === 'analytics') {
            viewAnalytics.classList.remove('hidden');
            viewAnalytics.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Analytics & Insights';
            if(globalSubtitle) globalSubtitle.textContent = 'System Performance';
            btnAnalytics.className = activeClass;
            loadAnalyticsDashboard();
        } else if(target === 'campaigns') {
            viewCampaigns.classList.remove('hidden');
            viewCampaigns.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'Network Campaigns';
            if(globalSubtitle) globalSubtitle.textContent = 'Broadcast Coordination';
            btnCampaigns.className = activeClass;
            loadCampaignsDashboard();
        } else if(target === 'settings') {
            viewSettings.classList.remove('hidden');
            viewSettings.classList.add('block');
            if(globalTitle) globalTitle.textContent = 'System Settings';
            if(globalSubtitle) globalSubtitle.textContent = 'Global Configurations';
            btnSettings.className = activeClass;
            loadSettingsDashboard();
        }
    };

    btnOverview.addEventListener('click', (e) => { e.preventDefault(); switchView('overview'); });
    btnVerifications.addEventListener('click', (e) => { e.preventDefault(); switchView('verifications'); });
    btnUsers.addEventListener('click', (e) => { e.preventDefault(); switchView('users'); });
    btnLogs.addEventListener('click', (e) => { e.preventDefault(); switchView('logs'); });
    btnDonations.addEventListener('click', (e) => { e.preventDefault(); switchView('donations'); });
    btnInventory.addEventListener('click', (e) => { e.preventDefault(); switchView('inventory'); });
    btnAnalytics.addEventListener('click', (e) => { e.preventDefault(); switchView('analytics'); });
    btnCampaigns.addEventListener('click', (e) => { e.preventDefault(); switchView('campaigns'); });
    btnSettings.addEventListener('click', (e) => { e.preventDefault(); switchView('settings'); });

    // Shortcuts & UI Hacks
    const btnSkipVerifications = document.getElementById('btnOverviewSkipVerifications');
    if(btnSkipVerifications) {
        btnSkipVerifications.addEventListener('click', (e) => { e.preventDefault(); switchView('verifications'); });
    }

    const btnNotifs = document.getElementById('btnAdminNotifications');
    if(btnNotifs) {
        btnNotifs.addEventListener('click', (e) => { 
            e.preventDefault(); 
            // Briefly pulse icon and reset to simulate empty notifications
            btnNotifs.innerHTML = '<span class="material-symbols-outlined text-primary" data-icon="circle">circle</span>';
            setTimeout(() => {
                btnNotifs.innerHTML = '<span class="material-symbols-outlined" data-icon="notifications">notifications</span>';
            }, 800);
        });
    }

    const searchInput = document.getElementById('inputAdminSearch');
    if(searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if(e.key === 'Enter') {
                e.preventDefault();
                searchInput.value = ''; // clear out placeholder search
                searchInput.blur();
            }
        });
    }

    // Internal Sub-Tabs for Hospitals
    const hospitalTabBtns = document.querySelectorAll('#hospitalTabs button');
    hospitalTabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            hospitalTabBtns.forEach(b => {
                b.className = 'cursor-pointer pb-3 px-2 text-sm font-bold border-b-2 border-transparent text-slate-500 hover:text-slate-700 transition-colors';
            });
            btn.className = 'cursor-pointer pb-3 px-2 text-sm font-bold border-b-2 border-primary text-primary transition-colors';
            window.renderHospitalVerificationsTab(btn.dataset.tab);
        });
    });

    // Internal Sub-Tabs for Users
    const userTabBtns = document.querySelectorAll('#userTabs button');
    userTabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            userTabBtns.forEach(b => {
                b.className = 'cursor-pointer pb-3 px-2 text-sm font-bold border-b-2 border-transparent text-slate-500 hover:text-slate-700 transition-colors';
            });
            btn.className = 'cursor-pointer pb-3 px-2 text-sm font-bold border-b-2 border-primary text-primary transition-colors';
            window.renderUserManagementTab(btn.dataset.tab);
        });
    });

    // Internal Sub-Tabs for Logs
    const logTabBtns = document.querySelectorAll('#logTabs button');
    logTabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            logTabBtns.forEach(b => {
                b.className = 'cursor-pointer pb-3 px-2 text-sm font-bold border-b-2 border-transparent text-slate-500 hover:text-slate-700 transition-colors';
            });
            btn.className = 'cursor-pointer pb-3 px-2 text-sm font-bold border-b-2 border-primary text-primary transition-colors';
            window.renderRequestLogsTab(btn.dataset.tab);
        });
    });

    // Internal Sub-Tabs for Donations
    const donationTabBtns = document.querySelectorAll('#donationTabs button');
    donationTabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            donationTabBtns.forEach(b => {
                b.className = 'cursor-pointer pb-3 px-2 text-sm font-bold border-b-2 border-transparent text-slate-500 hover:text-slate-700 transition-colors';
            });
            btn.className = 'cursor-pointer pb-3 px-2 text-sm font-bold border-b-2 border-primary text-primary transition-colors';
            window.renderDonationsTab(btn.dataset.tab);
        });
    });

    adminNavigationInitialized = true;
}

// ----------------------------------------------------
// NATIVE CSV EXPORT ENGINE
// By directly extracting the visual DOM, we guarantee 
// exactly what the Admin is currently looking at (Filtered)
// is what gets exported.
// ----------------------------------------------------

window.downloadCSVFromTable = (tableBodyId, filename) => {
    const tableData = [];
    const rows = document.querySelectorAll(`#${tableBodyId} tr`);
    
    if (rows.length === 0 || (rows.length === 1 && rows[0].innerText.includes('No '))) {
        alert("No data available to export.");
        return;
    }

    // Extract headers dynamically by looking at the previous sibling thead
    const thead = document.querySelector(`#${tableBodyId}`).closest('table').querySelector('thead');
    if (thead) {
        const headers = Array.from(thead.querySelectorAll('th')).map(th => th.innerText.trim());
        tableData.push(headers.join(","));
    }

    rows.forEach(row => {
        const cols = row.querySelectorAll('td');
        const rowData = Array.from(cols).map(col => {
            // Scrub out any extra inner text formatting, button labels, or newlines
            let text = col.innerText.replace(/(\r\n|\n|\r)/gm, " ").trim();
            // Handle quotes properly in CSV format
            return `"${text.replace(/"/g, '""')}"`;
        });
        tableData.push(rowData.join(","));
    });

    const csvContent = "data:text/csv;charset=utf-8," + tableData.join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${filename}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

document.addEventListener('DOMContentLoaded', () => {
    const btnExportUsers = document.getElementById('btnExportUsersCSV');
    if(btnExportUsers) {
        btnExportUsers.addEventListener('click', (e) => {
            e.preventDefault();
            window.downloadCSVFromTable('adminUsersTableBody', 'VitalPulse_Donor_Directory');
        });
    }

    const btnExportLogs = document.getElementById('btnExportLogsCSV');
    if(btnExportLogs) {
        btnExportLogs.addEventListener('click', (e) => {
            e.preventDefault();
            window.downloadCSVFromTable('adminLogsTableBody', 'VitalPulse_Emergency_Audit_Logs');
        });
    }
});

window.renderRequestLogsTab = async (tab) => {
    const tableBody = document.getElementById('adminLogsTableBody');
    if (!tableBody) return;
    
    tableBody.innerHTML = '<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500">Retrieving operational logs...</td></tr>';
    
    try {
        const allRequests = await fetchAllSystemRequests();
        let filtered = [];
        if (tab === 'open') {
            filtered = allRequests.filter(r => ['Open', 'open', 'Matching', 'matched', 'Donor Assigned', 'Donor En Route'].includes(r.status));
        } else if (tab === 'resolved') {
            filtered = allRequests.filter(r => r.status === 'Resolved' || r.status === 'resolved');
        } else {
            filtered = allRequests;
        }

        if (filtered.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500 font-medium tracking-wide">No ${tab} requests logged.</td></tr>`;
            return;
        }

        tableBody.innerHTML = filtered.map(r => {
             let statusUI = '';
             if (r.status === 'Open' || r.status === 'open') {
                 statusUI = '<span class="px-2 py-1 bg-amber-100 text-amber-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Open (Searching)</span>';
             } else if (r.status === 'Donor Assigned' || r.status === 'Matching' || r.status === 'matched') {
                 statusUI = '<span class="px-2 py-1 bg-amber-100 text-amber-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Donor Assigned</span>';
             } else if (r.status === 'Donor En Route') {
                 statusUI = '<span class="px-2 py-1 bg-indigo-100 text-indigo-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Donor En Route</span>';
             } else if (r.status === 'Resolved' || r.status === 'resolved') {
                 statusUI = '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Resolved</span>';
             } else {
                 statusUI = `<span class="px-2 py-1 bg-slate-100 text-slate-700 rounded-md text-[10px] font-bold tracking-widest uppercase">${r.status}</span>`;
             }

             // Handle relative time logic
             const reqDate = r.timestamp ? new Date(r.timestamp) : new Date();
             const now = new Date();
             const diffMs = now - reqDate;
             const diffMins = Math.floor(diffMs / 60000);
             let timeString = '';
             if(diffMins < 60) {
                 timeString = `${diffMins} mins ago`;
             } else if(diffMins < 1440) {
                 timeString = `${Math.floor(diffMins / 60)} hrs ago`;
             } else {
                 timeString = `${Math.floor(diffMins / 1440)} days ago`;
             }

             const origin = r.hospitalName || 'Central Command';
             
             return `
             <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4">
                    <p class="font-mono text-xs font-bold text-slate-700">${r.id.slice(0,8).toUpperCase()}</p>
                </td>
                <td class="p-4"><span class="font-black text-primary bg-primary/5 px-2 py-1 rounded text-xs">${r.bloodType || 'Any'}</span></td>
                <td class="p-4">
                    <div class="flex items-center gap-2">
                        <span class="material-symbols-outlined text-[14px] text-slate-400" data-icon="${origin === 'Central Command' ? 'admin_panel_settings' : 'local_hospital'}">${origin === 'Central Command' ? 'admin_panel_settings' : 'local_hospital'}</span>
                        <span class="text-xs font-bold text-on-surface truncate max-w-[150px]">${origin}</span>
                    </div>
                </td>
                <td class="p-4"><span class="text-xs font-semibold whitespace-nowrap">${r.unitsRequired || 1} Units</span></td>
                <td class="p-4">${statusUI}</td>
                <td class="p-4 text-right">
                    <span class="text-[11px] font-bold text-slate-400">${timeString}</span>
                </td>
             </tr>
             `;
        }).join('');
    } catch (err) {
        console.error(err);
        tableBody.innerHTML = '<tr><td colspan="6" class="text-center text-error py-4">Failed to load request logs.</td></tr>';
    }
};

window.renderHospitalVerificationsTab = async (tab) => {
    const tableBody = document.getElementById('adminHospitalsTableBody');
    if (!tableBody) return;
    
    tableBody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500">Loading directory...</td></tr>';
    
    try {
        const allHospitals = await fetchAllHospitals();
        let filtered = [];
        if (tab === 'verified') {
            filtered = allHospitals.filter(h => h.isVerified === true);
        } else if (tab === 'rejected') {
            filtered = allHospitals.filter(h => h.rejected === true);
        } else {
            filtered = allHospitals.filter(h => h.isVerified === false && !h.rejected);
        }

        if (filtered.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500 font-medium tracking-wide">No ${tab} institutions found.</td></tr>`;
            return;
        }

        tableBody.innerHTML = filtered.map(h => {
             const statusBadge = h.rejected ? '<span class="px-2 py-1 bg-red-100 text-red-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Rejected</span>' :
                                 h.isVerified ? '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Verified</span>' : 
                                 '<span class="px-2 py-1 bg-amber-100 text-amber-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Pending</span>';
             
             let actions = '';
             if(!h.rejected && !h.isVerified) {
                 actions = `<div class="flex items-center justify-end gap-2">
                     <button onclick="window.handleAdminApprove('${h.id}', '${h.name}')" class="cursor-pointer w-8 h-8 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100 flex items-center justify-center transition-colors shadow-sm" title="Approve">
                         <span class="material-symbols-outlined text-sm" data-icon="check">check</span>
                     </button>
                     <button onclick="window.handleAdminReject('${h.id}', '${h.name}')" class="cursor-pointer w-8 h-8 rounded bg-red-50 text-red-600 hover:bg-red-100 flex items-center justify-center transition-colors shadow-sm" title="Reject">
                         <span class="material-symbols-outlined text-sm" data-icon="close">close</span>
                     </button>
                 </div>`;
             } else {
                 actions = `<div class="text-right text-xs text-slate-400 font-medium">Processed</div>`;
             }

             return `
             <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4">
                    <div class="flex items-center gap-3">
                        <div class="hidden sm:flex w-9 h-9 rounded bg-slate-100 items-center justify-center text-slate-400 shrink-0">
                            <span class="material-symbols-outlined text-sm" data-icon="local_hospital">local_hospital</span>
                        </div>
                        <div class="min-w-0">
                            <p class="font-bold text-on-surface truncate">${h.name}</p>
                            <p class="text-[10px] text-slate-500 font-mono">ID: ${h.id.slice(0,8).toUpperCase()}</p>
                        </div>
                    </div>
                </td>
                <td class="p-4"><span class="text-xs font-semibold whitespace-nowrap">${h.city || 'Unspecified'}</span></td>
                <td class="p-4">
                    <button onclick="window.viewHospitalDetail('${h.id}')" class="cursor-pointer bg-slate-100 text-slate-600 px-2 py-1 rounded text-[10px] font-bold flex items-center gap-1 hover:bg-slate-200 transition-colors">
                        <span class="material-symbols-outlined text-[12px]" data-icon="description">description</span> License
                    </button>
                </td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 text-right">${actions}</td>
             </tr>
             `;
        }).join('');
    } catch (err) {
        console.error(err);
        tableBody.innerHTML = '<tr><td colspan="5" class="text-center text-error py-4">Failed to load directory.</td></tr>';
    }
};

// Global exposure for onClick handlers
window.handleAdminApprove = async (id, name) => {
    if(confirm(`Approve ${name}?`)) {
        await verifyHospital(id, name, true);
        loadAdminDashboard();
        const activeTab = document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending';
        if (window.renderHospitalVerificationsTab) window.renderHospitalVerificationsTab(activeTab);
    }
};

window.handleAdminReject = async (id, name) => {
    if(confirm(`Reject ${name}?`)) {
        await rejectHospital(id, name);
        loadAdminDashboard();
        const activeTab = document.querySelector('#hospitalTabs button.text-primary')?.dataset.tab || 'pending';
        if (window.renderHospitalVerificationsTab) window.renderHospitalVerificationsTab(activeTab);
    }
};

function initHospitalDetailModal() {
    const modal = document.getElementById('hospitalDetailModal');
    const backdrop = document.getElementById('hospitalDetailBackdrop');
    const closeBtn = document.getElementById('btnCloseHospitalDetail');
    const contentEl = document.getElementById('hospitalDetailContent');
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    };
    
    if (backdrop) {
        backdrop.addEventListener('click', closeModal);
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }
}

window.viewHospitalDetail = async (hospitalId) => {
    const modal = document.getElementById('hospitalDetailModal');
    const contentEl = document.getElementById('hospitalDetailContent');
    
    if (!modal || !contentEl) return;
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    
    contentEl.innerHTML = `
        <div class="flex items-center justify-center py-12">
            <div class="flex items-center gap-3 text-slate-500">
                <span class="material-symbols-outlined animate-spin">sync</span>
                <span>Loading details...</span>
            </div>
        </div>
    `;
    
    try {
        const hospital = await fetchHospitalById(hospitalId);
        
        if (!hospital) {
            contentEl.innerHTML = '<p class="text-center text-red-500 py-8">Hospital not found.</p>';
            return;
        }
        
        const statusBadge = hospital.isVerified 
            ? '<span class="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">Verified</span>'
            : hospital.rejected
            ? '<span class="px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold">Rejected</span>'
            : '<span class="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold">Pending</span>';
        
        const createdDate = hospital.createdAt ? new Date(hospital.createdAt).toLocaleDateString() : 'N/A';
        
        contentEl.innerHTML = `
            <div class="space-y-6">
                <div class="flex items-start gap-4">
                    <div class="w-16 h-16 rounded-xl bg-slate-100 flex items-center justify-center text-primary shrink-0">
                        <span class="material-symbols-outlined text-3xl">local_hospital</span>
                    </div>
                    <div class="flex-1">
                        <h3 class="text-xl font-black text-on-surface">${hospital.name || 'Unnamed Hospital'}</h3>
                        <p class="text-sm text-slate-500">${hospital.city || 'No city specified'}, Cameroon</p>
                        <div class="mt-2">${statusBadge}</div>
                    </div>
                </div>
                
                <div class="grid grid-cols-2 gap-4">
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Email</p>
                        <p class="text-sm font-medium text-on-surface">${hospital.email || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Phone</p>
                        <p class="text-sm font-medium text-on-surface">${hospital.phone || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Registration Date</p>
                        <p class="text-sm font-medium text-on-surface">${createdDate}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Hospital ID</p>
                        <p class="text-sm font-medium text-on-surface font-mono">${hospital.id.slice(0,12).toUpperCase()}</p>
                    </div>
                </div>
                
                <div class="bg-surface-container-low p-4 rounded-lg">
                    <div class="flex items-center justify-between mb-3">
                        <p class="text-sm font-bold text-on-surface">License Document</p>
                        <span class="material-symbols-outlined text-slate-400">description</span>
                    </div>
                    ${hospital.licenseUrl 
                        ? `<a href="${hospital.licenseUrl}" target="_blank" class="text-primary text-sm font-bold hover:underline flex items-center gap-2">
                            <span class="material-symbols-outlined text-sm">open_in_new</span> View Document
                           </a>`
                        : `<div class="flex items-center gap-2 text-slate-500 text-sm">
                            <span class="material-symbols-outlined text-sm">warning</span>
                            No license document uploaded
                           </div>`
                    }
                </div>
                
                ${!hospital.isVerified && !hospital.rejected ? `
                <div class="flex gap-3 pt-4 border-t border-slate-200">
                    <button onclick="window.handleAdminApprove('${hospital.id}', '${hospital.name}'); document.getElementById('hospitalDetailModal').classList.add('hidden');" class="flex-1 bg-emerald-500 text-white py-3 px-4 rounded-lg font-bold text-sm hover:bg-emerald-600 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">check</span> Approve
                    </button>
                    <button onclick="window.handleAdminReject('${hospital.id}', '${hospital.name}'); document.getElementById('hospitalDetailModal').classList.add('hidden');" class="flex-1 bg-red-500 text-white py-3 px-4 rounded-lg font-bold text-sm hover:bg-red-600 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">close</span> Reject
                    </button>
                </div>
                ` : ''}
            </div>
        `;
    } catch (err) {
        console.error('Failed to load hospital detail:', err);
        contentEl.innerHTML = '<p class="text-center text-red-500 py-8">Failed to load hospital details.</p>';
    }
};

window.renderUserManagementTab = async (tab) => {
    const tableBody = document.getElementById('adminUsersTableBody');
    if (!tableBody) return;
    
    tableBody.innerHTML = '<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500">Loading donor directory...</td></tr>';
    
    try {
        const allDonors = await fetchAllDonors();
        let filtered = [];
        if (tab === 'active') {
            filtered = allDonors.filter(u => u.isSuspended !== true);
        } else if (tab === 'suspended') {
            filtered = allDonors.filter(u => u.isSuspended === true);
        } else {
            filtered = allDonors;
        }

        if (filtered.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-slate-500 font-medium tracking-wide">No ${tab} donors found.</td></tr>`;
            return;
        }

        tableBody.innerHTML = filtered.map(u => {
             const isSuspended = u.isSuspended === true;
             const isAvailable = u.isAvailable === true;

             const statusBadge = isSuspended ? '<span class="px-2 py-1 bg-red-100 text-red-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Suspended</span>' :
                                 '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-md text-[10px] font-bold tracking-widest uppercase">Active</span>';
             
             const availBadge = isSuspended ? '<span class="text-xs text-slate-400 font-semibold italic">Locked</span>' :
                                (isAvailable ? '<span class="text-xs text-emerald-600 font-semibold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Ready</span>' : '<span class="text-xs text-amber-600 font-semibold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>Busy</span>');
             
             const registeredOn = u.registeredAt ? new Date(u.registeredAt).toLocaleDateString() : 'Legacy';
             const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleDateString() : 'Unknown';

let actions = '';
              if(!isSuspended) {
                  actions = `<div class="flex items-center gap-2 justify-end">
                      <button onclick="window.viewDonorDetail('${u.id}')" class="cursor-pointer bg-slate-100 text-slate-600 px-2 py-1.5 rounded text-xs font-bold hover:bg-slate-200 transition-colors shadow-sm" title="View Profile">
                          <span class="material-symbols-outlined text-sm">visibility</span>
                      </button>
                      <button onclick="window.handleAdminSuspendUser('${u.id}', '${u.name}')" class="cursor-pointer bg-red-50 text-red-600 px-3 py-1.5 rounded text-xs font-bold hover:bg-red-100 transition-colors shadow-sm">Suspend</button>
                  </div>`;
              } else {
                  actions = `<div class="flex items-center gap-2 justify-end">
                      <button onclick="window.viewDonorDetail('${u.id}')" class="cursor-pointer bg-slate-100 text-slate-600 px-2 py-1.5 rounded text-xs font-bold hover:bg-slate-200 transition-colors shadow-sm" title="View Profile">
                          <span class="material-symbols-outlined text-sm">visibility</span>
                      </button>
                      <button onclick="window.handleAdminReactivateUser('${u.id}', '${u.name}')" class="cursor-pointer bg-emerald-50 text-emerald-600 px-3 py-1.5 rounded text-xs font-bold hover:bg-emerald-100 transition-colors shadow-sm">Reactivate</button>
                  </div>`;
              }

             return `
             <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-full bg-slate-200 border-2 border-white shadow-sm overflow-hidden shrink-0">
                            <img src="https://api.dicebear.com/7.x/initials/svg?seed=${u.name}" alt="${u.name}" class="w-full h-full object-cover"/>
                        </div>
                        <div class="min-w-0">
                            <p class="font-bold text-on-surface truncate">${u.name}</p>
                            <p class="text-[10px] text-slate-500 font-mono">ID: ${u.id.slice(0,8).toUpperCase()}</p>
                        </div>
                    </div>
                </td>
                <td class="p-4"><span class="font-black text-primary bg-primary/5 px-2 py-1 rounded text-xs">${u.bloodType || 'N/A'}</span></td>
                <td class="p-4"><span class="text-xs font-semibold whitespace-nowrap">${u.city || 'Unspecified'}</span></td>
                <td class="p-4">
                    <p class="text-[10px] text-slate-500 font-medium">Joined: ${registeredOn}</p>
                    <div class="mt-0.5">${availBadge}</div>
                </td>
                <td class="p-4">${statusBadge}</td>
                <td class="p-4 flex items-center justify-end h-full">
                    ${actions}
                </td>
             </tr>
             `;
        }).join('');
    } catch (err) {
        console.error(err);
        tableBody.innerHTML = '<tr><td colspan="6" class="text-center text-error py-4">Failed to load directory.</td></tr>';
    }
};

window.handleAdminSuspendUser = async (id, name) => {
    if(confirm(`WARNING: Are you sure you want to suspend ${name}?\n\nThey will be immediately removed from the matchmaking pool.`)) {
        await suspendDonor(id, name);
        loadAdminDashboard();
        const activeTab = document.querySelector('#userTabs button.text-primary')?.dataset.tab || 'all';
        if (window.renderUserManagementTab) window.renderUserManagementTab(activeTab);
    }
};

window.handleAdminReactivateUser = async (id, name) => {
    if(confirm(`Reactivate ${name}?\n\nThey will become eligible for blood requests again.`)) {
        await reactivateDonor(id, name);
        loadAdminDashboard();
        const activeTab = document.querySelector('#userTabs button.text-primary')?.dataset.tab || 'all';
        if (window.renderUserManagementTab) window.renderUserManagementTab(activeTab);
    }
};

function initDonorDetailModal() {
    const modal = document.getElementById('donorDetailModal');
    const backdrop = document.getElementById('donorDetailBackdrop');
    const closeBtn = document.getElementById('btnCloseDonorDetail');
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    };
    
    if (backdrop) backdrop.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
}

window.viewDonorDetail = async (donorId) => {
    const modal = document.getElementById('donorDetailModal');
    const contentEl = document.getElementById('donorDetailContent');
    
    if (!modal || !contentEl) return;
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    
    contentEl.innerHTML = `
        <div class="flex items-center justify-center py-12">
            <div class="flex items-center gap-3 text-slate-500">
                <span class="material-symbols-outlined animate-spin">sync</span>
                <span>Loading profile...</span>
            </div>
        </div>
    `;
    
    try {
        const donor = await fetchDonorById(donorId);
        
        if (!donor) {
            contentEl.innerHTML = '<p class="text-center text-red-500 py-8">Donor not found.</p>';
            return;
        }
        
        const isSuspended = donor.isSuspended === true;
        const statusBadge = isSuspended 
            ? '<span class="px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold">Suspended</span>'
            : '<span class="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">Active</span>';
        
        const createdDate = donor.createdAt ? new Date(donor.createdAt).toLocaleDateString() : 'N/A';
        
        const donations = donor.donations || [];
        const completedDonations = donations.filter(d => d.status === 'completed' || d.status === 'approved');
        
        let donationsHtml = '';
        if (donations.length === 0) {
            donationsHtml = '<p class="text-sm text-slate-500 text-center py-4">No donation requests yet.</p>';
        } else {
            donationsHtml = donations.slice(0, 5).map(d => {
                const statusColors = {
                    'pending': 'bg-amber-100 text-amber-700',
                    'approved': 'bg-emerald-100 text-emerald-700',
                    'completed': 'bg-blue-100 text-blue-700',
                    'rejected': 'bg-red-100 text-red-700',
                    'cancelled': 'bg-slate-100 text-slate-700'
                };
                const date = d.preferredDate ? new Date(d.preferredDate).toLocaleDateString() : 'N/A';
                return `
                <div class="flex items-center justify-between p-3 bg-surface-container-low rounded-lg">
                    <div class="flex items-center gap-3">
                        <span class="font-black text-primary bg-primary/5 px-2 py-1 rounded text-xs">${d.bloodType}</span>
                        <div>
                            <p class="text-sm font-medium text-on-surface">${d.units || 1} Unit${(d.units || 1) > 1 ? 's' : ''}</p>
                            <p class="text-[10px] text-slate-500">${d.preferredLocation || 'No location'}</p>
                        </div>
                    </div>
                    <div class="text-right">
                        <span class="px-2 py-1 ${statusColors[d.status] || 'bg-slate-100 text-slate-700'} rounded text-[10px] font-bold capitalize">${d.status}</span>
                        <p class="text-[10px] text-slate-400 mt-1">${date}</p>
                    </div>
                </div>
                `;
            }).join('');
            
            if (donations.length > 5) {
                donationsHtml += `<p class="text-center text-xs text-slate-500 mt-3">+ ${donations.length - 5} more requests</p>`;
            }
        }
        
        contentEl.innerHTML = `
            <div class="space-y-6">
                <div class="flex items-start gap-4">
                    <div class="w-16 h-16 rounded-full bg-slate-200 border-2 border-white shadow-sm overflow-hidden shrink-0">
                        <img src="https://api.dicebear.com/7.x/initials/svg?seed=${donor.name}" alt="${donor.name}" class="w-full h-full object-cover"/>
                    </div>
                    <div class="flex-1">
                        <h3 class="text-xl font-black text-on-surface">${donor.name || 'Unknown Donor'}</h3>
                        <p class="text-sm text-slate-500">${donor.city || 'No city'}, Cameroon</p>
                        <div class="mt-2 flex items-center gap-2">${statusBadge}</div>
                    </div>
                </div>
                
                <div class="grid grid-cols-2 gap-4">
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Blood Type</p>
                        <p class="text-2xl font-black text-primary">${donor.bloodType || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Donations</p>
                        <p class="text-2xl font-black text-on-surface">${completedDonations.length}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Email</p>
                        <p class="text-sm font-medium text-on-surface truncate">${donor.email || 'N/A'}</p>
                    </div>
                    <div class="bg-surface-container-low p-4 rounded-lg">
                        <p class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Member Since</p>
                        <p class="text-sm font-medium text-on-surface">${createdDate}</p>
                    </div>
                </div>
                
                <div>
                    <h4 class="text-sm font-bold text-on-surface mb-3">Recent Donations</h4>
                    <div class="space-y-2 max-h-64 overflow-y-auto">
                        ${donationsHtml}
                    </div>
                </div>
                
                ${!isSuspended ? `
                <div class="flex gap-3 pt-4 border-t border-slate-200">
                    <button onclick="window.handleAdminSuspendUser('${donor.id}', '${donor.name}'); document.getElementById('donorDetailModal').classList.add('hidden');" class="flex-1 bg-red-500 text-white py-3 px-4 rounded-lg font-bold text-sm hover:bg-red-600 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">block</span> Suspend
                    </button>
                </div>
                ` : `
                <div class="flex gap-3 pt-4 border-t border-slate-200">
                    <button onclick="window.handleAdminReactivateUser('${donor.id}', '${donor.name}'); document.getElementById('donorDetailModal').classList.add('hidden');" class="flex-1 bg-emerald-500 text-white py-3 px-4 rounded-lg font-bold text-sm hover:bg-emerald-600 transition-colors flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-sm">check_circle</span> Reactivate
                    </button>
                </div>
                `}
            </div>
        `;
    } catch (err) {
        console.error('Failed to load donor detail:', err);
        contentEl.innerHTML = '<p class="text-center text-red-500 py-8">Failed to load donor profile.</p>';
    }
};

// ============================================
// BLOOD INVENTORY DASHBOARD
// ============================================

async function loadInventoryDashboard() {
    const gridEl = document.getElementById('inventoryGrid');
    const totalEl = document.getElementById('invTotalUnits');
    const lowStockEl = document.getElementById('invLowStock');
    const pendingEl = document.getElementById('invPendingDonations');
    const thisWeekEl = document.getElementById('invThisWeek');
    const logFeedEl = document.getElementById('inventoryLogFeed');
    const alertsEl = document.getElementById('lowStockAlerts');
    
    if (!gridEl) return;
    
    try {
        const inventory = await fetchGlobalInventory();
        const allBloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
        
        let totalUnits = 0;
        let lowStockCount = 0;
        let lowStockList = [];
        
        gridEl.innerHTML = allBloodTypes.map(type => {
            const inv = inventory[type] || { unitsAvailable: 0, minimumThreshold: 5 };
            const info = getBloodTypeDisplayInfo(type);
            totalUnits += inv.unitsAvailable || 0;
            
            const isLow = (inv.unitsAvailable || 0) <= inv.minimumThreshold;
            if (isLow) {
                lowStockCount++;
                lowStockList.push({ type, units: inv.unitsAvailable, threshold: inv.minimumThreshold });
            }
            
            return `
            <div class="bg-white rounded-xl p-4 border ${isLow ? 'border-red-200 bg-red-50' : 'border-slate-200'} hover:shadow-md transition-shadow">
                <div class="text-center">
                    <div class="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center" style="background-color: ${info.color}20; color: ${info.color}">
                        <span class="text-xl font-black">${type}</span>
                    </div>
                    <div class="text-2xl font-black text-on-surface">${inv.unitsAvailable || 0}</div>
                    <div class="text-[10px] text-slate-500 uppercase tracking-wide">units</div>
                    ${isLow ? '<div class="mt-2 text-[10px] font-bold text-red-600">LOW STOCK</div>' : ''}
                </div>
                <div class="mt-3 pt-3 border-t border-slate-100">
                    <div class="flex justify-between text-[10px] text-slate-500">
                        <span>Min:</span>
                        <span class="font-bold">${inv.minimumThreshold || 5}</span>
                    </div>
                </div>
            </div>
            `;
        }).join('');
        
        if (totalEl) totalEl.textContent = totalUnits;
        if (lowStockEl) lowStockEl.textContent = lowStockCount;
        if (pendingEl) pendingEl.textContent = '0';
        if (thisWeekEl) thisWeekEl.textContent = '+' + Math.floor(totalUnits * 0.1);
        
        // Low stock alerts
        if (alertsEl) {
            if (lowStockList.length === 0) {
                alertsEl.innerHTML = '<div class="flex items-center gap-3 p-3 bg-emerald-50 rounded-lg"><span class="material-symbols-outlined text-emerald-600 text-lg">check_circle</span><span class="text-sm text-emerald-700 font-medium">All blood types are adequately stocked</span></div>';
            } else {
                alertsEl.innerHTML = lowStockList.map(item => `
                    <div class="flex items-center justify-between p-3 bg-red-50 rounded-lg border border-red-100">
                        <div class="flex items-center gap-3">
                            <span class="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-black text-sm">${item.type}</span>
                            <div>
                                <p class="text-sm font-bold text-on-surface">${item.units} units available</p>
                                <p class="text-[10px] text-slate-500">Minimum threshold: ${item.threshold}</p>
                            </div>
                        </div>
                        <button onclick="window.openAddStockModal('${item.type}')" class="text-xs font-bold text-primary hover:underline">Add Stock</button>
                    </div>
                `).join('');
            }
        }
        
        // Load recent inventory logs
        const logs = await fetchRecentLogs(10);
        const inventoryLogs = logs.filter(l => l.title?.toLowerCase().includes('inventory') || l.title?.toLowerCase().includes('stock'));
        
        if (logFeedEl) {
            if (inventoryLogs.length === 0) {
                logFeedEl.innerHTML = '<p class="text-sm text-slate-500 text-center py-4">No recent inventory activity</p>';
            } else {
                logFeedEl.innerHTML = inventoryLogs.map(log => {
                    let icon = 'info';
                    let colorClass = 'bg-slate-100 text-slate-600';
                    if (log.type === 'success') { icon = 'check_circle'; colorClass = 'bg-green-100 text-green-600'; }
                    if (log.type === 'warning') { icon = 'warning'; colorClass = 'bg-amber-100 text-amber-600'; }
                    if (log.type === 'error') { icon = 'error'; colorClass = 'bg-red-100 text-red-600'; }
                    
                    return `
                    <div class="flex items-start gap-3">
                        <div class="w-8 h-8 rounded-full ${colorClass} flex items-center justify-center shrink-0">
                            <span class="material-symbols-outlined text-sm" data-icon="${icon}">${icon}</span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="text-sm font-bold text-on-surface">${log.title}</p>
                            <p class="text-xs text-slate-500 truncate">${log.description}</p>
                            <p class="text-[10px] text-slate-400 mt-1">${new Date(log.timestamp).toLocaleString()}</p>
                        </div>
                    </div>
                    `;
                }).join('');
            }
        }
        
        initInventoryModals();
        
    } catch (e) {
        console.error('Failed to load inventory:', e);
        gridEl.innerHTML = '<div class="col-span-8 text-center text-error py-8">Failed to load inventory data</div>';
    }
}

function initInventoryModals() {
    const addStockBtn = document.getElementById('btnAddStock');
    const modal = document.getElementById('addStockModal');
    const backdrop = document.getElementById('addStockBackdrop');
    const cancelBtn = document.getElementById('btnCancelStock');
    const form = document.getElementById('addStockForm');
    
    const openModal = async (preselectedType = '') => {
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            if (preselectedType) {
                const select = document.getElementById('stockBloodType');
                if (select) select.value = preselectedType;
            }
            const hospSelect = document.getElementById('stockHospital');
            if (hospSelect && hospSelect.options.length <= 1) {
                try {
                    const hospitals = await fetchAllHospitals();
                    hospitals.forEach(h => {
                        const opt = document.createElement('option');
                        opt.value = h.name;
                        opt.textContent = h.name;
                        hospSelect.appendChild(opt);
                    });
                } catch (err) {
                    console.error('Failed to load hospitals:', err);
                }
            }
        }
    };
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            if (form) form.reset();
        }
    };
    
    if (addStockBtn) {
        const newBtn = addStockBtn.cloneNode(true);
        addStockBtn.parentNode.replaceChild(newBtn, addStockBtn);
        document.getElementById('btnAddStock').addEventListener('click', () => openModal());
    }
    
    if (backdrop) {
        const newBackdrop = backdrop.cloneNode(true);
        backdrop.parentNode.replaceChild(newBackdrop, backdrop);
        document.getElementById('addStockBackdrop').addEventListener('click', closeModal);
    }
    
    if (cancelBtn) {
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        document.getElementById('btnCancelStock').addEventListener('click', closeModal);
    }
    
    if (form) {
        const newForm = form.cloneNode(true);
        form.parentNode.replaceChild(newForm, form);
        document.getElementById('addStockForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.querySelector('#addStockForm button[type="submit"]');
            btn.innerHTML = 'Adding...';
            btn.disabled = true;
            
            const bloodType = document.getElementById('stockBloodType').value;
            const units = document.getElementById('stockUnits').value;
            const source = document.getElementById('stockSource').value;
            const hospitalName = document.getElementById('stockHospital').value;
            if (!hospitalName) { alert('Please select a hospital.'); btn.innerHTML = 'Add to Inventory'; btn.disabled = false; return; }
            
            try {
                await updateInventoryStock(bloodType, units, 'add', hospitalName, {
                    componentType: document.getElementById('stockComponent')?.value || 'Whole Blood',
                    expiresAt: document.getElementById('stockExpiry')?.value || null
                });
                closeModal();
                loadInventoryDashboard();
            } catch (err) {
                console.error('Failed to add stock:', err);
                alert('Failed to add stock. Please try again.');
            } finally {
                btn.innerHTML = 'Add to Inventory';
                btn.disabled = false;
            }
        });
    }
}

window.openAddStockModal = (type) => {
    const modal = document.getElementById('addStockModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        const select = document.getElementById('stockBloodType');
        if (select) select.value = type;
    }
};

// ============================================
// ANALYTICS DASHBOARD
// ============================================

async function loadAnalyticsDashboard() {
    const totalStockEl = document.getElementById('analyticsTotalStock');
    const totalDonorsEl = document.getElementById('analyticsTotalDonors');
    const totalHospitalsEl = document.getElementById('analyticsTotalHospitals');
    const thisMonthEl = document.getElementById('analyticsThisMonth');

    const bloodStockChartEl = document.getElementById('bloodStockChart');
    const donationTrendsChartEl = document.getElementById('donationTrendsChart');
    const stockDistributionChartEl = document.getElementById('stockDistributionChart');
    const bloodTypeDemandChartEl = document.getElementById('bloodTypeDemandChart');
    const mostRequestedChartEl = document.getElementById('mostRequestedChart');
    const regionalShortageChartEl = document.getElementById('regionalShortageChart');
    const donorTrendChartEl = document.getElementById('donorTrendChart');
    const responseTimeChartEl = document.getElementById('responseTimeChart');

    try {
        const [inventory, allDonors, allHospitals, allDonations] = await Promise.all([
            fetchGlobalInventory(),
            fetchAllDonors(),
            fetchAllHospitals(),
            fetchAllDonationRequests()
        ]);

        const totalStock = Object.values(inventory).reduce((sum, inv) => sum + (inv.unitsAvailable || 0), 0);
        if (totalStockEl) totalStockEl.textContent = totalStock;
        if (totalDonorsEl) totalDonorsEl.textContent = allDonors.length;
        if (totalHospitalsEl) totalHospitalsEl.textContent = allHospitals.length;

        const thisMonth = allDonations.filter(d => {
            const created = new Date(d.createdAt);
            const now = new Date();
            return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
        }).length;
        if (thisMonthEl) thisMonthEl.textContent = thisMonth;

        if (bloodStockChartEl) {
            const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
            const stockData = bloodTypes.map(type => inventory[type]?.unitsAvailable || 0);
            new Chart(bloodStockChartEl, {
                type: 'bar', data: {
                    labels: bloodTypes, datasets: [{
                        label: 'Units', data: stockData,
                        backgroundColor: ['#EF4444', '#F97316', '#EAB308', '#84CC16', '#22C55E', '#14B8A6', '#8B5CF6', '#A78BFA'],
                        borderRadius: 6
                    }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

        if (donationTrendsChartEl) {
            const days = [];
            const donationsPerDay = [];
            for (let i = 6; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                const dateStr = date.toISOString().split('T')[0];
                days.push(date.toLocaleDateString('en-US', { weekday: 'short' }));
                donationsPerDay.push(allDonations.filter(d => d.createdAt && d.createdAt.startsWith(dateStr)).length);
            }
            new Chart(donationTrendsChartEl, {
                type: 'line', data: {
                    labels: days, datasets: [{
                        label: 'Donations', data: donationsPerDay,
                        borderColor: '#af101a', backgroundColor: 'rgba(175,16,26,0.1)', fill: true, tension: 0.4
                    }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

        if (stockDistributionChartEl) {
            const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
            const stockData = bloodTypes.map(type => inventory[type]?.unitsAvailable || 0);
            new Chart(stockDistributionChartEl, {
                type: 'doughnut', data: {
                    labels: bloodTypes, datasets: [{
                        data: stockData,
                        backgroundColor: ['#EF4444', '#F97316', '#EAB308', '#84CC16', '#22C55E', '#14B8A6', '#8B5CF6', '#A78BFA'],
                        borderWidth: 0
                    }]
                }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
            });
        }

        if (bloodTypeDemandChartEl) {
            const allRequests = await fetchAllSystemRequests();
            const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
            const demandData = bloodTypes.map(type => allRequests.filter(r => r.bloodType === type).length);
            new Chart(bloodTypeDemandChartEl, {
                type: 'bar', data: {
                    labels: bloodTypes, datasets: [{
                        label: 'Requests', data: demandData, backgroundColor: '#005f7b', borderRadius: 6
                    }]
                }, options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { x: { beginAtZero: true, grid: { color: '#e5e7eb' } }, y: { grid: { display: false } } }
                }
            });
        }

        if (mostRequestedChartEl) {
            const existing = Chart.getChart(mostRequestedChartEl);
            if (existing) existing.destroy();
            const allRequests = await fetchAllSystemRequests();
            const colors = ['#EF4444', '#F97316', '#EAB308', '#84CC16', '#22C55E', '#14B8A6', '#8B5CF6', '#A78BFA'];
            const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
            const sorted = bloodTypes.map((t, i) => ({ t, count: allRequests.filter(r => r.bloodType === t).length, c: colors[i] })).sort((a, b) => b.count - a.count);
            new Chart(mostRequestedChartEl, {
                type: 'bar', data: {
                    labels: sorted.map(s => s.t), datasets: [{
                        label: 'Requests', data: sorted.map(s => s.count), backgroundColor: sorted.map(s => s.c), borderRadius: 6
                    }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

        if (regionalShortageChartEl) {
            const existing = Chart.getChart(regionalShortageChartEl);
            if (existing) existing.destroy();
            const hospitalCities = {};
            allHospitals.forEach(h => { if (h.name) hospitalCities[h.name] = h.city || 'Unknown'; });
            const cityShortages = {};
            Object.values(inventory).forEach(inv => {
                if (inv.hospital) {
                    const city = hospitalCities[inv.hospital] || 'Unknown';
                    if (!cityShortages[city]) cityShortages[city] = 0;
                    if ((inv.unitsAvailable || 0) < (inv.minimumThreshold || 5)) cityShortages[city]++;
                }
            });
            const sorted = Object.entries(cityShortages).sort((a, b) => b[1] - a[1]).slice(0, 6);
            new Chart(regionalShortageChartEl, {
                type: 'bar', data: {
                    labels: sorted.map(s => s[0]), datasets: [{
                        label: 'Shortages', data: sorted.map(s => s[1]),
                        backgroundColor: ['#DC2626', '#EA580C', '#D97706', '#CA8A04', '#A16207', '#92400E'],
                        borderRadius: 6
                    }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

        if (donorTrendChartEl) {
            const existing = Chart.getChart(donorTrendChartEl);
            if (existing) existing.destroy();
            const months = [];
            const uniqueDonorsPerMonth = [];
            const now = new Date();
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                months.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric' }));
                const donors = new Set(allDonations.filter(don => {
                    const created = new Date(don.createdAt);
                    return created.getMonth() === d.getMonth() && created.getFullYear() === d.getFullYear();
                }).map(don => don.donorId));
                uniqueDonorsPerMonth.push(donors.size);
            }
            new Chart(donorTrendChartEl, {
                type: 'line', data: {
                    labels: months, datasets: [{
                        label: 'Donors', data: uniqueDonorsPerMonth,
                        borderColor: '#22C55E', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.4
                    }]
                }, options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, grid: { color: '#e5e7eb' } }, x: { grid: { display: false } } }
                }
            });
        }

        if (responseTimeChartEl) {
            const existing = Chart.getChart(responseTimeChartEl);
            if (existing) existing.destroy();
            const allRequests = await fetchAllSystemRequests();
            const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
            const filtered = bloodTypes.map(type => {
                const resolved = allRequests.filter(r => r.bloodType === type && r.resolvedAt && r.requestedAt);
                if (resolved.length === 0) return null;
                const totalHours = resolved.reduce((sum, r) => sum + (new Date(r.resolvedAt) - new Date(r.requestedAt)) / (1000 * 60 * 60), 0);
                return { type, time: Math.round((totalHours / resolved.length) * 10) / 10 };
            }).filter(Boolean);
            new Chart(responseTimeChartEl, {
                type: 'bar', data: {
                    labels: filtered.map(t => t.type), datasets: [{
                        label: 'Avg Hours', data: filtered.map(t => t.time), backgroundColor: '#3B82F6', borderRadius: 6
                    }]
                }, options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: { x: { beginAtZero: true, grid: { color: '#e5e7eb' } }, y: { grid: { display: false } } }
                }
            });
        }

    } catch (e) {
        console.error('Failed to load analytics:', e);
    }
}

// ============================================
// ADMIN DONATION APPROVAL TAB
// ============================================

window.renderDonationsTab = async (tab) => {
    const tableBody = document.getElementById('donationsTableBody');
    const pendingCountEl = document.getElementById('donationsPendingCount');
    const approvedCountEl = document.getElementById('donationsApprovedCount');
    const thisMonthEl = document.getElementById('donationsThisMonth');
    const totalUnitsEl = document.getElementById('donationsTotalUnits');
    
    if (!tableBody) return;
    
    tableBody.innerHTML = '<tr><td colspan="7" class="px-6 py-8 text-center text-slate-500">Loading donation requests...</td></tr>';
    
    try {
        const allDonations = await fetchAllDonationRequests();
        
        let filtered = [];
        if (tab === 'pending') {
            filtered = allDonations.filter(d => d.status === 'pending');
        } else if (tab === 'approved') {
            filtered = allDonations.filter(d => d.status === 'approved');
        } else if (tab === 'completed') {
            filtered = allDonations.filter(d => d.status === 'completed');
        } else {
            filtered = allDonations;
        }
        
        // Update stats
        const pendingCount = allDonations.filter(d => d.status === 'pending').length;
        const approvedCount = allDonations.filter(d => d.status === 'approved').length;
        const completedCount = allDonations.filter(d => d.status === 'completed').length;
        const thisMonth = allDonations.filter(d => {
            const created = new Date(d.createdAt);
            const now = new Date();
            return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
        }).length;
        const totalUnits = allDonations.reduce((acc, d) => acc + (d.units || 1), 0);
        
        if (pendingCountEl) pendingCountEl.textContent = pendingCount;
        if (approvedCountEl) approvedCountEl.textContent = approvedCount + completedCount;
        if (thisMonthEl) thisMonthEl.textContent = thisMonth;
        if (totalUnitsEl) totalUnitsEl.textContent = totalUnits;
        
        if (filtered.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="7" class="px-6 py-8 text-center text-slate-500 font-medium tracking-wide">No ${tab} donation requests.</td></tr>`;
            return;
        }
        
        tableBody.innerHTML = filtered.map(d => {
            const statusColors = {
                'pending': { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Pending' },
                'approved': { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Approved' },
                'rejected': { bg: 'bg-red-100', text: 'text-red-700', label: 'Rejected' },
                'completed': { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Completed' },
                'cancelled': { bg: 'bg-slate-100', text: 'text-slate-700', label: 'Cancelled' }
            };
            const status = statusColors[d.status] || statusColors['pending'];
            const date = d.preferredDate ? new Date(d.preferredDate).toLocaleDateString() : 'Not set';
            const createdDate = d.createdAt ? new Date(d.createdAt).toLocaleDateString() : 'Unknown';
            
            let actions = '';
            if (d.status === 'pending') {
                actions = `
                    <button onclick="window.approveDonation('${d.id}', '${d.bloodType}', ${d.units || 1})" class="cursor-pointer bg-emerald-50 text-emerald-600 px-3 py-1.5 rounded text-xs font-bold hover:bg-emerald-100 transition-colors shadow-sm">Approve</button>
                    <button onclick="window.rejectDonation('${d.id}', '${d.bloodType}', '${d.donorName}')" class="cursor-pointer bg-red-50 text-red-600 px-3 py-1.5 rounded text-xs font-bold hover:bg-red-100 transition-colors shadow-sm">Reject</button>
                `;
            } else if (d.status === 'approved') {
                actions = `<button onclick="window.completeDonation('${d.id}', '${d.bloodType}', ${d.units || 1})" class="cursor-pointer bg-blue-50 text-blue-600 px-3 py-1.5 rounded text-xs font-bold hover:bg-blue-100 transition-colors shadow-sm">Mark Complete</button>`;
            } else {
                actions = '<span class="text-xs text-slate-400">-</span>';
            }
            
            return `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-bold text-sm">
                            ${d.donorName?.charAt(0).toUpperCase() || '?'}
                        </div>
                        <div>
                            <p class="font-bold text-on-surface">${d.donorName}</p>
                            <p class="text-[10px] text-slate-500">${d.donorEmail}</p>
                        </div>
                    </div>
                </td>
                <td class="p-4"><span class="font-black text-primary bg-primary/5 px-2 py-1 rounded text-xs">${d.bloodType}</span></td>
                <td class="p-4"><span class="text-xs font-semibold">${d.units || 1} Unit${(d.units || 1) > 1 ? 's' : ''}</span></td>
                <td class="p-4"><span class="text-xs text-slate-600">${date}</span></td>
                <td class="p-4"><span class="text-xs text-slate-600 max-w-[150px] truncate block">${d.preferredLocation}</span></td>
                <td class="p-4"><span class="px-2 py-1 ${status.bg} ${status.text} text-[10px] font-bold rounded-full">${status.label}</span></td>
                <td class="p-4 text-right space-x-2">${actions}</td>
            </tr>
            `;
        }).join('');
        
    } catch (err) {
        console.error('Failed to load donations:', err);
        tableBody.innerHTML = '<tr><td colspan="7" class="text-center text-error py-4">Failed to load donation requests.</td></tr>';
    }
};

window.approveDonation = async (id, bloodType, units) => {
    if (confirm(`Approve donation request for ${bloodType} (${units} unit${units > 1 ? 's' : ''})? This will add ${units} unit(s) to inventory.`)) {
        try {
            const donation = { bloodType, units };
            await approveDonationRequest(id, donation);
            const activeTab = document.querySelector('#donationTabs button.text-primary')?.dataset.tab || 'all';
            window.renderDonationsTab(activeTab);
        } catch (err) {
            console.error('Failed to approve:', err);
            alert('Failed to approve donation. Please try again.');
        }
    }
};

window.rejectDonation = async (id, bloodType, donorName) => {
    const reason = prompt(`Reject donation request for ${bloodType} from ${donorName}?\n\nEnter rejection reason:`);
    if (reason !== null) {
        try {
            await rejectDonationRequest(id, { bloodType }, reason || 'Not specified');
            const activeTab = document.querySelector('#donationTabs button.text-primary')?.dataset.tab || 'all';
            window.renderDonationsTab(activeTab);
        } catch (err) {
            console.error('Failed to reject:', err);
            alert('Failed to reject donation. Please try again.');
        }
    }
};

window.completeDonation = async (id, bloodType, units) => {
    if (confirm(`Mark donation as completed? Blood type: ${bloodType}, Units: ${units}`)) {
        try {
            await completeDonationRequest(id, { bloodType, units });
            const activeTab = document.querySelector('#donationTabs button.text-primary')?.dataset.tab || 'all';
            window.renderDonationsTab(activeTab);
        } catch (err) {
            console.error('Failed to complete:', err);
            alert('Failed to complete donation. Please try again.');
        }
    }
};

// ============================================
// SETTINGS DASHBOARD
// ============================================

async function loadSettingsDashboard() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    
    const displayNameInput = document.getElementById('adminDisplayName');
    const emailInput = document.getElementById('adminEmail');
    const saveBtn = document.getElementById('btnSaveSettings');
    
    if (displayNameInput) displayNameInput.value = currentUser.name || '';
    if (emailInput) emailInput.value = currentUser.email || '';
    
    try {
        const settings = await fetchSystemSettings();
        
        const criticalSms = document.getElementById('settingCriticalSms');
        const hospitalDigest = document.getElementById('settingHospitalDigest');
        const donorAlerts = document.getElementById('settingDonorAlerts');
        const autoMatch = document.getElementById('settingAutoMatch');
        const emergencyBroadcast = document.getElementById('settingEmergencyBroadcast');
        const registrationApproval = document.getElementById('settingRegistrationApproval');
        const lowStockThreshold = document.getElementById('settingLowStockThreshold');
        
        if (criticalSms) criticalSms.checked = settings.criticalSupplySms !== false;
        if (hospitalDigest) hospitalDigest.checked = settings.hospitalDigest === true;
        if (donorAlerts) donorAlerts.checked = settings.donorAlerts !== false;
        if (autoMatch) autoMatch.checked = settings.autoMatchDonors !== false;
        if (emergencyBroadcast) emergencyBroadcast.checked = settings.emergencyBroadcastEnabled !== false;
        if (registrationApproval) registrationApproval.checked = settings.registrationApprovalRequired === true;
        if (lowStockThreshold) lowStockThreshold.value = settings.lowStockThreshold || 5;
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const currentUser = getCurrentUser();
            const newDisplayName = document.getElementById('adminDisplayName')?.value;
            
            // Update user profile if name changed
            if (currentUser && newDisplayName && newDisplayName !== currentUser.name) {
                try {
                    await updateUserProfile(currentUser.uid, { name: newDisplayName });
                    // Update localStorage
                    const updatedUser = { ...currentUser, name: newDisplayName };
                    localStorage.setItem('vitalpulse_user', JSON.stringify(updatedUser));
                } catch (e) {
                    console.error('Failed to update profile:', e);
                }
            }
            
            const settings = {
                criticalSupplySms: document.getElementById('settingCriticalSms')?.checked || false,
                hospitalDigest: document.getElementById('settingHospitalDigest')?.checked || false,
                donorAlerts: document.getElementById('settingDonorAlerts')?.checked || false,
                autoMatchDonors: document.getElementById('settingAutoMatch')?.checked || false,
                emergencyBroadcastEnabled: document.getElementById('settingEmergencyBroadcast')?.checked || false,
                registrationApprovalRequired: document.getElementById('settingRegistrationApproval')?.checked || false,
                lowStockThreshold: parseInt(document.getElementById('settingLowStockThreshold')?.value || '5', 10)
            };
            
            try {
                await updateSystemSettings(settings);
                
                const notification = document.getElementById('settingsSaveNotification');
                if (notification) {
                    notification.classList.remove('hidden');
                    setTimeout(() => {
                        notification.classList.add('hidden');
                    }, 3000);
                }
            } catch (e) {
                console.error('Failed to save settings:', e);
                alert('Failed to save settings. Please try again.');
            }
        };
    }
}

// ============================================
// NOTIFICATION SYSTEM
// ============================================

let notifications = [];
const NOTIFICATION_KEY = 'vitalpulse_notifications';

function initNotificationSystem() {
    const notifBtn = document.getElementById('btnAdminNotifications');
    const notifDropdown = document.getElementById('notificationDropdown');
    const notifList = document.getElementById('notificationList');
    const notifBadge = document.getElementById('notificationBadge');
    const clearBtn = document.getElementById('btnClearNotifications');
    const settingsBtn = document.getElementById('btnNotificationSettings');
    
    // Load stored notifications
    const stored = localStorage.getItem(NOTIFICATION_KEY);
    if (stored) {
        notifications = JSON.parse(stored);
        updateNotificationBadge();
    }
    
    if (notifBtn && notifDropdown) {
        notifBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            notifDropdown.classList.toggle('hidden');
            renderNotificationList();
        });
        
        document.addEventListener('click', (e) => {
            if (!notifDropdown.contains(e.target) && e.target !== notifBtn) {
                notifDropdown.classList.add('hidden');
            }
        });
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            notifications = [];
            saveNotifications();
            renderNotificationList();
            updateNotificationBadge();
        });
    }
    
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            document.getElementById('notificationDropdown')?.classList.add('hidden');
            switchView('settings');
        });
    }
    
    // Add sample notifications for demo
    addSampleNotifications();
}

function addSampleNotifications() {
    const now = new Date();
    if (notifications.length === 0) {
        notifications = [
            {
                id: 1,
                title: 'New Hospital Registration',
                message: 'Douala Central Hospital has registered and needs verification.',
                type: 'info',
                time: new Date(now - 1000 * 60 * 30).toISOString(),
                read: false
            },
            {
                id: 2,
                title: 'Low Stock Alert',
                message: 'Blood type O- is below minimum threshold (3 units).',
                type: 'warning',
                time: new Date(now - 1000 * 60 * 60 * 2).toISOString(),
                read: false
            },
            {
                id: 3,
                title: 'Donation Approved',
                message: 'Mai Randy\'s donation of A+ has been processed.',
                type: 'success',
                time: new Date(now - 1000 * 60 * 60 * 5).toISOString(),
                read: true
            }
        ];
        saveNotifications();
        updateNotificationBadge();
    }
}

function saveNotifications() {
    localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(notifications));
}

function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    const unread = notifications.filter(n => !n.read).length;
    if (badge) {
        if (unread > 0) {
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
}

function renderNotificationList() {
    const list = document.getElementById('notificationList');
    if (!list) return;
    
    if (notifications.length === 0) {
        list.innerHTML = '<p class="text-center text-slate-500 py-8 text-sm">No notifications</p>';
        return;
    }
    
    list.innerHTML = notifications.map(n => {
        const timeAgo = getTimeAgo(n.time);
        const icon = n.type === 'warning' ? 'warning' : n.type === 'success' ? 'check_circle' : 'info';
        const iconClass = n.type === 'warning' ? 'text-amber-500' : n.type === 'success' ? 'text-emerald-500' : 'text-blue-500';
        
        return `
        <div class="p-3 rounded-lg hover:bg-surface-container-low cursor-pointer transition-colors ${n.read ? 'opacity-60' : ''}" onclick="window.markNotificationRead(${n.id})">
            <div class="flex items-start gap-3">
                <span class="material-symbols-outlined ${iconClass} text-lg">${icon}</span>
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm text-on-surface">${n.title}</p>
                    <p class="text-xs text-slate-500 truncate">${n.message}</p>
                    <p class="text-[10px] text-slate-400 mt-1">${timeAgo}</p>
                </div>
                ${!n.read ? '<span class="w-2 h-2 bg-primary rounded-full"></span>' : ''}
            </div>
        </div>
        `;
    }).join('');
}

function getTimeAgo(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

window.markNotificationRead = (id) => {
    const notif = notifications.find(n => n.id === id);
    if (notif) {
        notif.read = true;
        saveNotifications();
        updateNotificationBadge();
        renderNotificationList();
    }
};

window.addNotification = (title, message, type = 'info') => {
    notifications.unshift({
        id: Date.now(),
        title,
        message,
        type,
        time: new Date().toISOString(),
        read: false
    });
    saveNotifications();
    updateNotificationBadge();
    renderNotificationList();
};

// ============================================
// CAMPAIGN MANAGEMENT
// ============================================

async function loadCampaignsDashboard() {
    const gridEl = document.getElementById('campaignsGrid');
    const activeCountEl = document.getElementById('campaignsActiveCount');
    const planningCountEl = document.getElementById('campaignsPlanningCount');
    const completedCountEl = document.getElementById('campaignsCompletedCount');
    const totalUnitsEl = document.getElementById('campaignsTotalUnits');
    
    if (!gridEl) return;
    
    try {
        const campaigns = await fetchAllCampaigns();
        
        // Update stats
        const active = campaigns.filter(c => c.status === 'active').length;
        const planning = campaigns.filter(c => c.status === 'planning').length;
        const completed = campaigns.filter(c => c.status === 'completed').length;
        const units = campaigns.reduce((sum, c) => sum + (c.unitsCollected || 0), 0);
        
        if (activeCountEl) activeCountEl.textContent = active;
        if (planningCountEl) planningCountEl.textContent = planning;
        if (completedCountEl) completedCountEl.textContent = completed;
        if (totalUnitsEl) totalUnitsEl.textContent = units;
        
        if (campaigns.length === 0) {
            gridEl.innerHTML = `
                <div class="col-span-full text-center py-12">
                    <span class="material-symbols-outlined text-5xl text-slate-300 mb-4">campaign</span>
                    <p class="text-slate-500 font-medium">No campaigns yet</p>
                    <p class="text-xs text-slate-400 mt-2">Click "New Campaign" to create your first campaign</p>
                </div>
            `;
            return;
        }
        
        gridEl.innerHTML = campaigns.map(c => {
            const progress = c.targetUnits ? Math.round((c.unitsCollected || 0) / c.targetUnits * 100) : 0;
            const statusColors = {
                'active': { bg: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-800', text: 'text-emerald-600' },
                'planning': { bg: 'bg-blue-500', badge: 'bg-blue-100 text-blue-800', text: 'text-blue-600' },
                'completed': { bg: 'bg-slate-500', badge: 'bg-slate-100 text-slate-800', text: 'text-slate-600' },
                'cancelled': { bg: 'bg-red-500', badge: 'bg-red-100 text-red-800', text: 'text-red-600' }
            };
            const colors = statusColors[c.status] || statusColors.planning;
            const startDate = c.startDate ? new Date(c.startDate).toLocaleDateString() : 'TBD';
            
            return `
            <div class="bg-surface-container-lowest border border-outline-variant/20 rounded-2xl p-6 shadow-sm flex flex-col relative overflow-hidden group">
                <div class="absolute top-0 left-0 w-full h-1 ${colors.bg}"></div>
                <div class="flex justify-between items-start mb-4">
                    <div class="p-3 ${colors.text.replace('text-', 'bg-').replace('600', '50').replace('800', '100')} rounded-xl ${colors.text}">
                        <span class="material-symbols-outlined" data-icon="celebration">celebration</span>
                    </div>
                    <span class="${colors.badge} text-[10px] font-bold px-2 py-1 rounded-md uppercase tracking-widest">${c.status}</span>
                </div>
                <h3 class="font-black text-xl text-on-surface mb-1">${c.title}</h3>
                <p class="text-xs text-slate-500 flex items-center gap-1 mb-2"><span class="material-symbols-outlined text-[14px]" data-icon="location_on">location_on</span> ${c.location}</p>
                <p class="text-xs text-slate-400 mb-4">Start: ${startDate}</p>
                
                <div class="mt-auto space-y-2">
                    <div class="flex justify-between text-xs font-bold text-on-surface">
                        <span>Target: ${c.targetUnits || 0} Units</span>
                        <span class="${colors.text}">${progress}%</span>
                    </div>
                    <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                        <div class="${colors.bg} h-full rounded-full" style="width: ${progress}%"></div>
                    </div>
                </div>
                
                <div class="flex gap-2 mt-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onclick="window.editCampaign('${c.id}')" class="flex-1 bg-slate-100 text-slate-600 py-2 px-3 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors">Edit</button>
                    <button onclick="window.deleteCampaign('${c.id}', '${c.title}')" class="flex-1 bg-red-50 text-red-600 py-2 px-3 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors">Delete</button>
                </div>
            </div>
            `;
        }).join('');
        
        initCampaignModal();
        
    } catch (e) {
        console.error('Failed to load campaigns:', e);
        gridEl.innerHTML = '<p class="col-span-full text-center text-error py-8">Failed to load campaigns</p>';
    }
}

function initCampaignModal() {
    const newBtn = document.getElementById('btnNewCampaign');
    const modal = document.getElementById('campaignModal');
    const backdrop = document.getElementById('campaignBackdrop');
    const cancelBtn = document.getElementById('btnCancelCampaign');
    const form = document.getElementById('campaignForm');
    
    const openModal = (campaign = null) => {
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        
        const titleEl = document.getElementById('campaignModalTitle');
        const idInput = document.getElementById('campaignId');
        const titleInput = document.getElementById('campaignTitle');
        const locationInput = document.getElementById('campaignLocation');
        const targetInput = document.getElementById('campaignTargetUnits');
        const statusSelect = document.getElementById('campaignStatus');
        const startDateInput = document.getElementById('campaignStartDate');
        const descInput = document.getElementById('campaignDescription');
        
        if (campaign) {
            if (titleEl) titleEl.textContent = 'Edit Campaign';
            if (idInput) idInput.value = campaign.id;
            if (titleInput) titleInput.value = campaign.title || '';
            if (locationInput) locationInput.value = campaign.location || '';
            if (targetInput) targetInput.value = campaign.targetUnits || '';
            if (statusSelect) statusSelect.value = campaign.status || 'planning';
            if (startDateInput) startDateInput.value = campaign.startDate || '';
            if (descInput) descInput.value = campaign.description || '';
        } else {
            if (titleEl) titleEl.textContent = 'Create Campaign';
            if (form) form.reset();
            if (idInput) idInput.value = '';
            const today = new Date().toISOString().split('T')[0];
            if (startDateInput) startDateInput.min = today;
        }
    };
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            if (form) form.reset();
        }
    };
    
    if (newBtn) {
        newBtn.onclick = () => openModal();
    }
    
    if (backdrop) {
        backdrop.onclick = closeModal;
    }
    
    if (cancelBtn) {
        cancelBtn.onclick = closeModal;
    }
    
    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Saving...';
            btn.disabled = true;
            
            const id = document.getElementById('campaignId').value;
            const campaignData = {
                title: document.getElementById('campaignTitle').value,
                location: document.getElementById('campaignLocation').value,
                targetUnits: parseInt(document.getElementById('campaignTargetUnits').value, 10),
                status: document.getElementById('campaignStatus').value,
                startDate: document.getElementById('campaignStartDate').value,
                description: document.getElementById('campaignDescription').value,
                unitsCollected: 0
            };
            
            try {
                if (id) {
                    await updateCampaign(id, campaignData);
                } else {
                    await createCampaign(campaignData);
                }
                closeModal();
                loadCampaignsDashboard();
            } catch (err) {
                console.error('Failed to save campaign:', err);
                alert('Failed to save campaign. Please try again.');
            } finally {
                btn.innerHTML = 'Save Campaign';
                btn.disabled = false;
            }
        };
    }
}

window.editCampaign = async (id) => {
    const campaigns = await fetchAllCampaigns();
    const campaign = campaigns.find(c => c.id === id);
    if (campaign) {
        const modal = document.getElementById('campaignModal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            
            document.getElementById('campaignId').value = campaign.id;
            document.getElementById('campaignTitle').value = campaign.title || '';
            document.getElementById('campaignLocation').value = campaign.location || '';
            document.getElementById('campaignTargetUnits').value = campaign.targetUnits || '';
            document.getElementById('campaignStatus').value = campaign.status || 'planning';
            document.getElementById('campaignStartDate').value = campaign.startDate || '';
            document.getElementById('campaignDescription').value = campaign.description || '';
            
            document.getElementById('campaignModalTitle').textContent = 'Edit Campaign';
        }
    }
};

window.deleteCampaign = async (id, title) => {
    if (confirm(`Delete campaign "${title}"? This action cannot be undone.`)) {
        try {
            await deleteCampaign(id);
            loadCampaignsDashboard();
        } catch (err) {
            console.error('Failed to delete campaign:', err);
            alert('Failed to delete campaign.');
        }
    }
};

// ============================================
// HOSPITAL: completeDonorArrival
// ============================================
window.completeDonorArrival = async (requestId, donorId) => {
    if (!confirm('Mark this donor as arrived and the donation as completed?')) return;
    try {
        await completeDonorArrival(requestId);

        // Send SMS notification to hospital
        const currentUser = getCurrentUser();
        if (currentUser?.phone) {
            try {
                await sendSmsNotification(currentUser.phone, `[VitalPulse] Donation completed at ${currentUser.name}. Donor ID: ${donorId?.slice(0, 8)}. Thank you for saving lives!`);
            } catch (e) { console.warn('SMS notification failed:', e); }
        }

        showToast('Donation completed successfully!');
        loadHospitalDonors();
        loadHospitalDashboard();
    } catch (err) {
        console.error('Failed to complete donation:', err);
        alert('Failed to complete donation.');
    }
};

// ============================================
// HOSPITAL: notification toggle save
// ============================================
function initHospitalNotificationToggles() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    // Load saved preferences from user profile
    const prefs = currentUser.notificationPrefs || { urgent: true, donor: true, stock: true };
    const urgentToggle = document.getElementById('notifUrgent');
    const donorToggle = document.getElementById('notifDonor');
    const stockToggle = document.getElementById('notifStock');

    if (urgentToggle) urgentToggle.checked = prefs.urgent !== false;
    if (donorToggle) donorToggle.checked = prefs.donor !== false;
    if (stockToggle) stockToggle.checked = prefs.stock !== false;

    const savePrefs = async () => {
        try {
            await updateUserProfile(currentUser.uid, {
                notificationPrefs: {
                    urgent: urgentToggle?.checked ?? true,
                    donor: donorToggle?.checked ?? true,
                    stock: stockToggle?.checked ?? true
                }
            });
            const updated = JSON.parse(localStorage.getItem('vitalpulse_user') || '{}');
            updated.notificationPrefs = {
                urgent: urgentToggle?.checked ?? true,
                donor: donorToggle?.checked ?? true,
                stock: stockToggle?.checked ?? true
            };
            localStorage.setItem('vitalpulse_user', JSON.stringify(updated));
        } catch (e) {
            console.error('Failed to save notification prefs:', e);
        }
    };

    if (urgentToggle) urgentToggle.addEventListener('change', savePrefs);
    if (donorToggle) donorToggle.addEventListener('change', savePrefs);
    if (stockToggle) stockToggle.addEventListener('change', savePrefs);
}

// ============================================
// HOSPITAL: real-time dashboard subscription
// ============================================
let hospitalRequestsUnsub = null;

function subscribeHospitalDashboard() {
    // Unsubscribe previous listener
    if (hospitalRequestsUnsub) {
        hospitalRequestsUnsub();
        hospitalRequestsUnsub = null;
    }

    const feedEl = document.getElementById('dashRequestsFeed');
    if (!feedEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        hospitalRequestsUnsub = subscribeToRequests((requests) => {
            const myRequests = requests.filter(r => r.hospital === hospitalName);
            if (myRequests.length === 0) {
                feedEl.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">check_circle</span><p class="text-sm">No active requests from your hospital</p></div>';
                return;
            }
            feedEl.innerHTML = myRequests.slice(0, 8).map(req => {
                const statusColor = req.status === 'Donor Assigned' || req.status === 'Donor En Route' ? 'bg-amber-500' : 'bg-blue-500';
                const statusLabel = ['Donor Assigned', 'Donor En Route'].includes(req.status) ? req.status : 'Open';
                return `
                <div class="flex items-center justify-between p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors ring-2 ring-red-200">
                    <div class="flex items-center gap-3 min-w-0">
                        <span class="w-9 h-9 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm shrink-0">${req.type || req.bloodType || '?'}</span>
                        <div class="min-w-0">
                            <p class="text-sm font-bold text-on-surface truncate">${req.hospital}</p>
                            <p class="text-xs text-slate-500">${req.units || 1} unit${(req.units || 1) > 1 ? 's' : ''} needed</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="w-2 h-2 rounded-full ${statusColor} ${['Donor Assigned', 'Donor En Route'].includes(req.status) ? 'animate-pulse' : ''}"></span>
                        <span class="text-[10px] font-bold text-slate-500 uppercase">${statusLabel}</span>
                    </div>
                </div>
                `;
            }).join('');
        });
    } catch (e) {
        console.error('Failed to subscribe to requests:', e);
    }
}

// Patch loadHospitalDashboard to include subscription, notification init, and activity log
const _origLoadHospitalDashboard = loadHospitalDashboard;
loadHospitalDashboard = async function() {
    if (_origLoadHospitalDashboard) await _origLoadHospitalDashboard();
    subscribeHospitalDashboard();
    loadHospitalActivityLog();
};

// Patch loadHospitalSettings to include notification toggle init, history, and modals
const _origLoadHospitalSettings = loadHospitalSettings;
loadHospitalSettings = async function() {
    if (_origLoadHospitalSettings) await _origLoadHospitalSettings();
    initHospitalNotificationToggles();
    loadNotificationHistory();
    initNotificationFeatures();
    initDonorEngagementModal();
};

// ============================================
// HOSPITAL NOTIFICATION SYSTEM (in-app bell)
// ============================================

function initHospitalNotifications() {
    const notifBtn = document.getElementById('btnHospitalNotifications');
    if (!notifBtn) return;

    notifBtn.addEventListener('click', async () => {
        const currentUser = getCurrentUser();
        if (!currentUser) return;
        try {
            const notifications = await fetchHospitalNotifications(currentUser.uid, 10);
            const unreadCount = await fetchUnreadHospitalNotificationCount(currentUser.uid);
            const badge = document.getElementById('hospitalNotifBadge');
            if (badge) {
                if (unreadCount > 0) {
                    badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
                    badge.classList.remove('hidden');
                    badge.classList.add('flex', 'items-center', 'justify-center', 'text-[8px]', 'font-bold', 'text-white');
                } else {
                    badge.classList.add('hidden');
                    badge.classList.remove('flex', 'items-center', 'justify-center', 'text-[8px]', 'font-bold', 'text-white');
                }
            }
            if (notifications.length === 0) {
                showToast('No notifications yet.');
            } else {
                const panel = document.createElement('div');
                panel.id = 'hospitalNotifPanel';
                panel.className = 'fixed inset-0 z-50 flex items-end sm:items-start sm:justify-end sm:pt-16 sm:pr-4';
                panel.innerHTML = `
                    <div class="absolute inset-0 bg-black/20" onclick="document.getElementById('hospitalNotifPanel')?.remove()"></div>
                    <div class="relative bg-white w-full sm:w-96 max-h-[70vh] rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col">
                        <div class="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
                            <h3 class="font-black text-on-surface flex items-center gap-2">
                                <span class="material-symbols-outlined text-primary">notifications</span>
                                Notifications
                            </h3>
                            <div class="flex items-center gap-2">
                                ${unreadCount > 0 ? `<button onclick="(async () => { const cu = getCurrentUser(); if(cu){await markAllHospitalNotificationsRead(cu.uid); document.getElementById('hospitalNotifPanel')?.remove();} })()" class="text-[10px] font-bold text-primary hover:underline">Mark all read</button>` : ''}
                                <button onclick="document.getElementById('hospitalNotifPanel')?.remove()" class="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition-colors">
                                    <span class="material-symbols-outlined text-sm">close</span>
                                </button>
                            </div>
                        </div>
                        <div class="overflow-y-auto flex-1 p-3 space-y-1">
                            ${notifications.map(n => {
                                const icons = { 'error': 'emergency', 'success': 'check_circle', 'info': 'info', 'warning': 'warning' };
                                const colors = { 'error': 'text-red-600 bg-red-50', 'success': 'text-emerald-600 bg-emerald-50', 'info': 'text-blue-600 bg-blue-50', 'warning': 'text-amber-600 bg-amber-50' };
                                const c = colors[n.type] || colors.info;
                                const icon = icons[n.type] || icons.info;
                                return `
                                    <div class="flex items-start gap-3 p-3 rounded-xl ${n.read ? 'opacity-60' : 'bg-surface-container-low'} hover:bg-slate-50 transition-colors cursor-pointer" onclick="${!n.read ? `(async () => { await markHospitalNotificationRead('${n.id}'); this.classList.remove('bg-surface-container-low'); this.style.opacity='0.6'; })()` : ''}">
                                        <span class="material-symbols-outlined text-sm mt-0.5 ${c.split(' ')[0]}">${icon}</span>
                                        <div class="min-w-0 flex-1">
                                            <p class="text-xs font-bold text-on-surface ${n.read ? '' : ''}">${n.title}</p>
                                            <p class="text-[11px] text-on-surface-variant mt-0.5 line-clamp-2">${n.message}</p>
                                            <p class="text-[9px] text-slate-400 mt-1">${new Date(n.createdAt).toLocaleString()}</p>
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

    // Poll every 30 seconds
    const poll = async () => {
        const cu = getCurrentUser();
        if (!cu) return;
        try {
            const count = await fetchUnreadHospitalNotificationCount(cu.uid);
            const badge = document.getElementById('hospitalNotifBadge');
            if (badge) {
                if (count > 0) {
                    badge.textContent = count > 9 ? '9+' : count;
                    badge.classList.remove('hidden');
                    badge.classList.add('flex', 'items-center', 'justify-center', 'text-[8px]', 'font-bold', 'text-white');
                    badge.style.width = '18px';
                    badge.style.height = '18px';
                } else {
                    badge.classList.add('hidden');
                    badge.classList.remove('flex', 'items-center', 'justify-center', 'text-[8px]', 'font-bold', 'text-white');
                    badge.style.width = '';
                    badge.style.height = '';
                }
            }
        } catch (e) { /* silent */ }
    };
    poll();
    setInterval(poll, 30000);
}

// ============================================
// HOSPITAL ACTIVITY LOG
// ============================================
async function loadHospitalActivityLog() {
    const logEl = document.getElementById('dashHospitalLog');
    const countEl = document.getElementById('dashLogCount');
    if (!logEl) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const logs = await fetchRecentLogs(15);
        if (countEl) countEl.textContent = `${logs.length} events`;

        if (logs.length === 0) {
            logEl.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-2xl mb-2">history</span><p class="text-sm">No activity recorded yet</p></div>';
            return;
        }

        logEl.innerHTML = logs.map(log => {
            const iconMap = {
                'success': { icon: 'check_circle', bg: 'bg-emerald-100', text: 'text-emerald-600' },
                'warning': { icon: 'warning', bg: 'bg-amber-100', text: 'text-amber-600' },
                'error': { icon: 'error', bg: 'bg-red-100', text: 'text-red-600' },
                'info': { icon: 'info', bg: 'bg-blue-100', text: 'text-blue-600' }
            };
            const style = iconMap[log.type] || iconMap.info;
            const time = log.timestamp ? new Date(log.timestamp).toLocaleString() : '';
            return `
            <div class="flex items-start gap-3 p-2 hover:bg-slate-50 rounded-lg transition-colors">
                <div class="w-7 h-7 rounded-full ${style.bg} flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-xs ${style.text}">${style.icon}</span>
                </div>
                <div class="min-w-0 flex-1">
                    <p class="text-xs font-bold text-on-surface truncate">${log.title}</p>
                    <p class="text-[10px] text-slate-500 leading-tight line-clamp-2">${log.description || ''}</p>
                    <p class="text-[9px] text-slate-400 mt-0.5">${time}</p>
                </div>
            </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Failed to load activity log:', e);
        logEl.innerHTML = '<div class="text-center text-error text-sm py-8">Failed to load activity log.</div>';
    }
}

// ============================================
// ISSUE BLOOD TO PATIENT MODAL
// ============================================
function initIssueBloodModal() {
    const modal = document.getElementById('issueModal');
    const backdrop = document.getElementById('issueBackdrop');
    const closeBtn = document.getElementById('btnCloseIssue');
    const form = document.getElementById('issueForm');

    const close = () => {
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); }
    };

    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const currentUser = getCurrentUser();
            if (!currentUser) return;

            const bloodType = document.getElementById('issueBloodType').value;
            const units = parseInt(document.getElementById('issueUnits').value, 10);
            const currentStock = parseInt(document.getElementById('issueCurrentQty').value, 10);

            if (!bloodType) { alert('Please select a blood type from the inventory.'); return; }
            if (units > currentStock) {
                if (!confirm(`Only ${currentStock} units of ${bloodType} available. Issue ${units} anyway? This will result in negative stock.`)) return;
            }

            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Issuing...';
            btn.disabled = true;

            try {
                await issueBloodToPatient(bloodType, units, {
                    patientName: document.getElementById('issuePatientName').value,
                    patientId: document.getElementById('issuePatientId').value,
                    ward: document.getElementById('issueWard').value,
                    requestingDoctor: document.getElementById('issueDoctor').value,
                    diagnosis: document.getElementById('issueDiagnosis').value,
                    hospital: currentUser.name || 'General Hospital'
                });
                close();
                showToast(`Issued ${units} unit(s) of ${bloodType} to patient`);
                loadHospitalInventoryData();
                loadHospitalDashboard();
            } catch (err) {
                console.error('Failed to issue blood:', err);
                alert('Failed to issue blood. Please try again.');
            } finally {
                btn.innerHTML = 'Confirm Issue to Patient';
                btn.disabled = false;
            }
        };
    }
}

window.openHospitalIssueBlood = (type, currentStock) => {
    const modal = document.getElementById('issueModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('issueBloodType').value = type;
    document.getElementById('issueCurrentQty').value = currentStock || 0;
    document.getElementById('issueBloodTypeLabel').textContent = `${type} — Issue to Patient`;
    document.getElementById('issueCurrentStock').textContent = `Current stock: ${currentStock || 0} units`;
    document.getElementById('issueUnits').max = currentStock || 0;
};

// ============================================
// BLOOD COMPATIBILITY GUIDE MODAL
// ============================================
function initCompatibilityGuideModal() {
    const modal = document.getElementById('compatModal');
    const backdrop = document.getElementById('compatBackdrop');
    const closeBtn = document.getElementById('btnCloseCompat');

    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Build compatibility grids when modal opens
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
    }

    // Pre-fill compatibility data when modal is about to open
    const fillCompatData = () => {
        const allTypes = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
        const donorGrid = document.getElementById('compatDonorGrid');
        const recipientGrid = document.getElementById('compatRecipientGrid');

        if (!donorGrid || !recipientGrid) return;

        donorGrid.innerHTML = allTypes.map(type => {
            const canDonateTo = getCompatibleBloodTypes(type);
            return `
            <div class="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <div class="flex items-center gap-2 mb-2">
                    <span class="w-8 h-8 rounded-lg bg-red-100 text-red-700 flex items-center justify-center font-black text-sm">${type}</span>
                    <span class="text-xs font-bold text-on-surface">Donates to</span>
                </div>
                <div class="flex flex-wrap gap-1">
                    ${canDonateTo.map(t => `<span class="text-[10px] font-bold px-2 py-0.5 rounded-md ${t === type ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}">${t}</span>`).join('')}
                </div>
            </div>
            `;
        }).join('');

        recipientGrid.innerHTML = allTypes.map(type => {
            const canReceiveFrom = getCompatibleBloodTypes(type);
            const recipients = allTypes.filter(t => getCompatibleBloodTypes(t).includes(type));
            return `
            <div class="p-3 bg-blue-50 rounded-xl border border-blue-100">
                <div class="flex items-center gap-2 mb-2">
                    <span class="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-black text-sm">${type}</span>
                    <span class="text-xs font-bold text-on-surface">Receives from</span>
                </div>
                <div class="flex flex-wrap gap-1">
                    ${canDonateTo.map(t => `<span class="text-[10px] font-bold px-2 py-0.5 rounded-md ${t === type ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'}">${t}</span>`).join('')}
                </div>
            </div>
            `;
        }).join('');
    };

    // Fill data when modal opens
    const observer = new MutationObserver(() => {
        if (!modal.classList.contains('hidden')) fillCompatData();
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
}

// ============================================
// THRESHOLD SETTINGS MODAL
// ============================================
function initThresholdModal() {
    const modal = document.getElementById('thresholdModal');
    const backdrop = document.getElementById('thresholdBackdrop');
    const closeBtn = document.getElementById('btnCloseThreshold');
    const form = document.getElementById('thresholdForm');

    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const bloodType = document.getElementById('thresholdBloodType').value;
            const value = parseInt(document.getElementById('thresholdValue').value, 10);

            if (!bloodType || isNaN(value) || value < 0) { alert('Please enter a valid threshold value.'); return; }

            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Saving...';
            btn.disabled = true;

            const currentUser = getCurrentUser();
            const hospName = currentUser?.name || 'General Hospital';
            try {
                await setInventoryThreshold(bloodType, value, hospName);
                close();
                showToast(`Minimum threshold for ${bloodType} set to ${value} units`);
                loadHospitalInventoryData();
            } catch (err) {
                console.error('Failed to set threshold:', err);
                alert('Failed to set threshold.');
            } finally {
                btn.innerHTML = 'Save Threshold';
                btn.disabled = false;
            }
        };
    }
}

window.openHospitalSetThreshold = (type) => {
    const modal = document.getElementById('thresholdModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('thresholdBloodType').value = type;
    document.getElementById('thresholdTypeDisplay').textContent = type;
    document.getElementById('thresholdTypeLabel').textContent = type;
    document.getElementById('thresholdValue').value = 5;
};

// ============================================
// REQUEST TIMELINE MODAL (Feature 6)
// ============================================

function initTimelineModal() {
    const modal = document.getElementById('timelineModal');
    const backdrop = document.getElementById('timelineBackdrop');
    const closeBtn = document.getElementById('btnCloseTimeline');
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
}

window.openRequestTimeline = async (requestId) => {
    const modal = document.getElementById('timelineModal');
    const content = document.getElementById('timelineContent');
    const reqIdLabel = document.getElementById('timelineRequestId');
    if (!modal || !content) return;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (reqIdLabel) reqIdLabel.textContent = `#${requestId.slice(0, 8).toUpperCase()}`;
    content.innerHTML = '<div class="flex items-center justify-center py-12 text-slate-400"><span class="material-symbols-outlined animate-spin mr-3">sync</span><span class="text-sm">Loading timeline...</span></div>';

    try {
        const reqDoc = await getDoc(doc(db, 'requests', requestId));
        if (!reqDoc.exists()) {
            content.innerHTML = '<div class="text-center py-12 text-slate-400"><span class="material-symbols-outlined block text-3xl mb-2">timeline</span><p class="text-sm">Request not found</p></div>';
            return;
        }
        const req = reqDoc.data();
        const timeline = [
            { status: 'Opened', description: 'Request was created', timestamp: req.timestamp || req.createdAt, color: 'text-blue-500', icon: 'add_circle' },
            { status: 'Matching', description: `Looking for ${req.bloodType} donors in ${req.city}`, timestamp: req.matchedAt, color: 'text-amber-500', icon: 'search' },
            { status: 'Donor Assigned', description: 'A donor accepted the request', timestamp: req.assignedAt, color: 'text-indigo-500', icon: 'person_pin' },
            { status: 'Donor En Route', description: 'Donor is heading to the hospital', timestamp: req.enRouteAt, color: 'text-purple-500', icon: 'directions_car' },
            { status: 'Resolved', description: 'Request fulfilled — donation completed', timestamp: req.resolvedAt || req.updatedAt, color: 'text-emerald-500', icon: 'check_circle' },
        ].filter(e => e.timestamp);
        if (timeline.length === 0) {
            content.innerHTML = '<div class="text-center py-12 text-slate-400"><span class="material-symbols-outlined block text-3xl mb-2">timeline</span><p class="text-sm">No timeline available</p></div>';
            return;
        }

        content.innerHTML = timeline.map((entry, i) => {
            const isLast = i === timeline.length - 1;
            const dotColor = entry.color.replace('text-', 'bg-').replace('500', '500');
            return `
            <div class="relative flex gap-4 pb-8 ${isLast ? '' : ''}">
                ${!isLast ? '<div class="absolute left-[17px] top-8 bottom-0 w-0.5 bg-slate-200"></div>' : ''}
                <div class="shrink-0">
                    <div class="w-9 h-9 rounded-full ${dotColor} bg-opacity-20 flex items-center justify-center ${entry.color}">
                        <span class="material-symbols-outlined text-sm">${entry.icon}</span>
                    </div>
                </div>
                <div class="flex-1 min-w-0 pt-1">
                    <p class="font-bold text-sm text-on-surface">${entry.status}</p>
                    <p class="text-xs text-slate-500">${entry.description}</p>
                    <p class="text-[10px] text-slate-400 mt-1">${entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '—'}</p>
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load timeline:', err);
        content.innerHTML = '<div class="text-center text-error py-8">Failed to load timeline.</div>';
    }
};

// ============================================
// REMOVE STOCK MODAL (Feature 8)
// ============================================

function initRemoveStockModal() {
    const modal = document.getElementById('removeStockModal');
    const backdrop = document.getElementById('removeStockBackdrop');
    const closeBtn = document.getElementById('btnCloseRemoveStock');
    const form = document.getElementById('removeStockForm');

    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); if (form) form.reset(); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);

    if (form) {
        form.onsubmit = async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            btn.innerHTML = 'Removing...';
            btn.disabled = true;

            const currentUser = getCurrentUser();
            const hospName = currentUser?.name || 'General Hospital';
            try {
                const bloodType = document.getElementById('removeStockBloodType').value;
                const units = parseInt(document.getElementById('removeStockUnits').value, 10);
                const reason = document.getElementById('removeStockReason').value;
                await deductInventoryStock(bloodType, units, reason, hospName);
                await logActivity('Stock Removed', `${units} unit(s) of ${bloodType} removed — Reason: ${reason}`, 'warning');
                close();
                showToast(`${units} unit(s) of ${bloodType} removed`);
                loadHospitalInventoryData();
            } catch (err) {
                console.error('Failed to remove stock:', err);
                alert('Failed to remove stock.');
            } finally {
                btn.innerHTML = 'Remove from Inventory';
                btn.disabled = false;
            }
        };
    }
}

function initRemoveStockModalButtons() {
    // Wire the "Remove" button on inventory cards (done via window.openHospitalRemoveStock)
}

// ============================================
// INVENTORY MOVEMENT HISTORY (Feature 7)
// ============================================

async function loadInventoryMovements() {
    const container = document.getElementById('movementHistoryBody');
    if (!container) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const movements = await fetchInventoryMovements(hospitalName);

        if (movements.length === 0) {
            container.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">swap_vert</span><p class="text-sm">No inventory movements recorded yet</p></div>';
            return;
        }

        container.innerHTML = movements.map(m => {
            const icon = m.type === 'addition' ? 'add_circle' : m.type === 'issuance' ? 'bloodtype' : m.type === 'removal' ? 'remove_circle' : 'info';
            const color = m.type === 'addition' ? 'text-emerald-600 bg-emerald-50' : m.type === 'issuance' ? 'text-amber-600 bg-amber-50' : m.type === 'removal' ? 'text-red-600 bg-red-50' : 'text-slate-600 bg-slate-50';
            const label = m.type === 'addition' ? 'Addition' : m.type === 'issuance' ? 'Issued' : m.type === 'removal' ? 'Removal' : 'Other';
            return `
            <div class="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                <div class="w-8 h-8 rounded-lg ${color} flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-sm">${icon}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <p class="text-sm font-bold text-on-surface truncate">${m.bloodType || '—'}</p>
                        <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${color}">${label}</span>
                        ${m.units ? `<span class="text-xs font-bold text-slate-600">${m.units} unit${m.units > 1 ? 's' : ''}</span>` : ''}
                    </div>
                    <p class="text-xs text-slate-500 truncate mt-0.5">${m.description}</p>
                    <p class="text-[10px] text-slate-400 mt-0.5">${m.timestamp ? new Date(m.timestamp).toLocaleString() : '—'}</p>
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load movements:', err);
        container.innerHTML = '<div class="text-center text-error py-8">Failed to load movement history.</div>';
    }
}

// ============================================
// DASHBOARD MINI CHART (Feature 9)
// ============================================

let dashChartInstance = null;

async function loadDashboardChart() {
    const canvas = document.getElementById('dashChart');
    if (!canvas) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const requests = await fetchHospitalRequests(hospitalName);

        const days = [];
        const counts = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            days.push(date.toLocaleDateString('en-US', { weekday: 'short' }));
            const count = requests.filter(r =>
                r.requestedAt && r.requestedAt.startsWith(dateStr)
            ).length;
            counts.push(count);
        }

        if (dashChartInstance) dashChartInstance.destroy();

        dashChartInstance = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: days,
                datasets: [{
                    label: 'Requests',
                    data: counts,
                    backgroundColor: counts.map(c => c > 0 ? '#dc2626' : '#fecaca'),
                    borderRadius: 4,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.parsed.y} request${ctx.parsed.y !== 1 ? 's' : ''}`
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { stepSize: 1 } },
                    x: { grid: { display: false } }
                }
            }
        });
    } catch (err) {
        console.error('Failed to load dashboard chart:', err);
    }
}

// ============================================
// PRINT REQUEST SLIP (Feature 10)
// ============================================

window.printRequestSlip = async (requestId) => {
    try {
        const docRef = doc(db, 'requests', requestId);
        const snapshot = await getDoc(docRef);
        if (!snapshot.exists()) { alert('Request not found.'); return; }

        const reqData = { id: snapshot.id, ...snapshot.data() };

        const printWindow = window.open('', '_blank', 'width=600,height=800');
        printWindow.document.write(`
            <html>
            <head><title>Blood Request Slip</title>
            <style>
                body { font-family: 'Courier New', monospace; padding: 40px; max-width: 500px; margin: 0 auto; }
                .header { text-align: center; border-bottom: 2px dashed #333; padding-bottom: 16px; margin-bottom: 16px; }
                .header h1 { font-size: 24px; font-weight: 900; color: #991b1b; margin: 0; }
                .header p { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0; }
                .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dotted #ddd; font-size: 13px; }
                .row-label { font-weight: bold; color: #333; }
                .row-value { color: #555; }
                .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #ccc; font-size: 10px; color: #999; text-align: center; }
                @media print { body { padding: 20px; } }
            </style>
            </head>
            <body>
                <div class="header">
                    <h1>VITALPULSE</h1>
                    <p>Blood Request Slip</p>
                </div>
                <div class="row"><span class="row-label">Request ID</span><span class="row-value">#${reqData.id.slice(0, 8).toUpperCase()}</span></div>
                <div class="row"><span class="row-label">Hospital</span><span class="row-value">${reqData.hospital || '—'}</span></div>
                <div class="row"><span class="row-label">Blood Type</span><span class="row-value">${reqData.bloodType || reqData.type || '—'}</span></div>
                <div class="row"><span class="row-label">Component</span><span class="row-value">${reqData.componentType || 'Whole Blood'}</span></div>
                <div class="row"><span class="row-label">Units</span><span class="row-value">${reqData.units || 1}</span></div>
                <div class="row"><span class="row-label">Urgency</span><span class="row-value">${(reqData.urgency || 'standard').toUpperCase()}</span></div>
                <div class="row"><span class="row-label">Status</span><span class="row-value">${reqData.status || 'Open'}</span></div>
                <div class="row"><span class="row-label">Patient Name</span><span class="row-value">${reqData.patientName || '—'}</span></div>
                <div class="row"><span class="row-label">Ward</span><span class="row-value">${reqData.ward || '—'}</span></div>
                <div class="row"><span class="row-label">Doctor</span><span class="row-value">${reqData.requestingDoctor || '—'}</span></div>
                <div class="row"><span class="row-label">Diagnosis</span><span class="row-value">${reqData.diagnosis || '—'}</span></div>
                <div class="row"><span class="row-label">Required By</span><span class="row-value">${reqData.requiredBy || '—'}</span></div>
                <div class="row"><span class="row-label">Requested At</span><span class="row-value">${reqData.requestedAt ? new Date(reqData.requestedAt).toLocaleString() : '—'}</span></div>
                <div class="footer">
                    <p>VitalPulse Blood Donation System — vitalpulse.cm</p>
                    <p>Generated: ${new Date().toLocaleString()}</p>
                </div>
                <script>
                    window.onload = function() { window.print(); window.close(); }
                <\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    } catch (err) {
        console.error('Failed to print slip:', err);
        alert('Failed to generate print slip.');
    }
};

window.printDonorSlip = async (donationId) => {
    try {
        const docRef = doc(db, 'donation_requests', donationId);
        const snapshot = await getDoc(docRef);
        if (!snapshot.exists()) { alert('Donation not found.'); return; }
        const data = { id: snapshot.id, ...snapshot.data() };
        const printWindow = window.open('', '_blank', 'width=600,height=800');
        printWindow.document.write(`
            <html><head><title>Donation Receipt</title>
            <style>
                body { font-family: 'Courier New', monospace; padding: 40px; max-width: 500px; margin: 0 auto; }
                .header { text-align: center; border-bottom: 2px dashed #333; padding-bottom: 16px; margin-bottom: 16px; }
                .header h1 { font-size: 24px; font-weight: 900; color: #991b1b; margin: 0; }
                .header p { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 2px; margin: 4px 0 0; }
                .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dotted #ddd; font-size: 13px; }
                .row-label { font-weight: bold; color: #333; }
                .row-value { color: #555; }
                .thank-you { text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #ccc; font-size: 14px; color: #991b1b; font-weight: bold; }
                .footer { margin-top: 8px; font-size: 10px; color: #999; text-align: center; }
                @media print { body { padding: 20px; } }
            </style></head><body>
                <div class="header"><h1>VITALPULSE</h1><p>Donation Receipt</p></div>
                <div class="row"><span class="row-label">Donation ID</span><span class="row-value">#${data.id.slice(0, 8).toUpperCase()}</span></div>
                <div class="row"><span class="row-label">Donor Name</span><span class="row-value">${data.donorName || '—'}</span></div>
                <div class="row"><span class="row-label">Blood Type</span><span class="row-value">${data.bloodType || '—'}</span></div>
                <div class="row"><span class="row-label">Units</span><span class="row-value">${data.units || 1}</span></div>
                <div class="row"><span class="row-label">Component</span><span class="row-value">${data.componentType || 'Whole Blood'}</span></div>
                <div class="row"><span class="row-label">Date</span><span class="row-value">${data.preferredDate ? new Date(data.preferredDate).toLocaleString() : data.createdAt ? new Date(data.createdAt).toLocaleString() : '—'}</span></div>
                <div class="row"><span class="row-label">Hospital</span><span class="row-value">${data.hospital || data.preferredLocation || '—'}</span></div>
                <div class="row" style="border-bottom:none;"><span class="row-label">Status</span><span class="row-value">${data.status || 'Pending'}</span></div>
                <div class="thank-you">Thank you for your life-saving donation!</div>
                <div class="footer"><p>VitalPulse Blood Donation System — vitalpulse.cm</p><p>Generated: ${new Date().toLocaleString()}</p></div>
                <script>window.onload=function(){window.print();window.close();}<\/script>
            </body></html>
        `);
        printWindow.document.close();
    } catch (err) {
        console.error('Failed to print donation slip:', err);
        alert('Failed to generate donation slip.');
    }
};

// ============================================
// DONOR ENGAGEMENT — Hospital View (Feature)
// ============================================

function initDonorEngagementModal() {
    const modal = document.getElementById('donorEngagementModal');
    const backdrop = document.getElementById('donorEngagementBackdrop');
    const closeBtn = document.getElementById('btnCloseDonorEngagement');
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); } };
    if (backdrop) backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
}

window.openDonorEngagement = async (donorId) => {
    const modal = document.getElementById('donorEngagementModal');
    const content = document.getElementById('donorEngagementContent');
    const nameLabel = document.getElementById('donorEngagementName');
    if (!modal || !content) return;

    modal.classList.remove('hidden');
    modal.classList.add('flex');

    content.innerHTML = '<div class="flex items-center justify-center py-12 text-slate-400"><span class="material-symbols-outlined animate-spin mr-3">sync</span><span class="text-sm">Loading donor profile...</span></div>';

    try {
        const engagement = await computeDonorEngagement(donorId);
        if (!engagement) {
            content.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">Donor not found</p></div>';
            return;
        }

        if (nameLabel) nameLabel.textContent = engagement.donations[0]?.donorName || 'Donor';

        const badgesHtml = engagement.badges.length > 0
            ? engagement.badges.map(b => `
                <div class="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                    <span class="material-symbols-outlined text-sm" style="color:${b.color}">${b.icon}</span>
                    <span class="text-xs font-bold text-slate-700">${b.name}</span>
                </div>
            `).join('')
            : '<p class="text-xs text-slate-400">No badges earned yet</p>';

        const tierBadge = `
            <div class="flex items-center gap-3 p-4 rounded-xl" style="background-color: ${engagement.tierColor}15;">
                <span class="material-symbols-outlined text-2xl" style="color: ${engagement.tierColor}">${engagement.tierIcon}</span>
                <div>
                    <p class="font-black text-lg" style="color: ${engagement.tierColor}">${engagement.tier} Tier</p>
                    <p class="text-xs text-slate-500">${engagement.donationCount} donation${engagement.donationCount !== 1 ? 's' : ''}</p>
                </div>
            </div>
        `;

        content.innerHTML = `
            ${tierBadge}

            <div class="grid grid-cols-3 gap-3">
                <div class="bg-slate-50 rounded-xl p-3 text-center">
                    <p class="text-xl font-black text-on-surface">${engagement.donationCount}</p>
                    <p class="text-[9px] text-slate-500 uppercase">Donations</p>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center">
                    <p class="text-xl font-black text-on-surface">${engagement.totalUnits}</p>
                    <p class="text-[9px] text-slate-500 uppercase">Units</p>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center">
                    <p class="text-xl font-black text-amber-600">${engagement.points}</p>
                    <p class="text-[9px] text-slate-500 uppercase">Points</p>
                </div>
            </div>

            ${engagement.nextTier ? `
            <div>
                <div class="flex justify-between text-xs font-bold text-slate-500 mb-1">
                    <span>Progress to ${engagement.nextTier}</span>
                    <span>${Math.round(engagement.nextTierProgress)}%</span>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div class="h-full rounded-full" style="width: ${Math.min(100, engagement.nextTierProgress)}%; background: ${engagement.tierColor}"></div>
                </div>
            </div>
            ` : ''}

            <div>
                <h4 class="text-sm font-bold text-on-surface mb-3 flex items-center gap-2">
                    <span class="material-symbols-outlined text-sm text-amber-600">badge</span>
                    Badges (${engagement.badges.length})
                </h4>
                <div class="space-y-2">
                    ${badgesHtml}
                </div>
            </div>
        `;
    } catch (err) {
        console.error('Failed to load donor engagement:', err);
        content.innerHTML = '<div class="text-center text-error py-8">Failed to load donor profile.</div>';
    }
};

// ============================================
// CAMPAIGNS VIEW — Hospital Participation
// ============================================

async function loadHospitalCampaignsView() {
    const grid = document.getElementById('campaignsGrid');
    if (!grid) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';
    const hospitalCity = currentUser?.city || '';

    try {
        const campaigns = await fetchHospitalCampaigns(hospitalName);

        if (campaigns.length === 0) {
            grid.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-16 text-slate-400"><span class="material-symbols-outlined text-4xl mb-3">campaign</span><p class="text-sm font-medium">No campaigns available</p><p class="text-xs text-slate-400 mt-1">Campaigns will appear here when admins create them</p></div>';
            return;
        }

        grid.innerHTML = campaigns.map(c => {
            const progress = c.targetUnits ? Math.round(((c.unitsCollected || 0) / c.targetUnits) * 100) : 0;
            const statusColors = {
                'active': { bg: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-800' },
                'planning': { bg: 'bg-blue-500', badge: 'bg-blue-100 text-blue-800' },
                'completed': { bg: 'bg-slate-500', badge: 'bg-slate-100 text-slate-800' },
                'cancelled': { bg: 'bg-red-500', badge: 'bg-red-100 text-red-800' }
            };
            const colors = statusColors[c.status] || statusColors.planning;
            const startDate = c.startDate ? new Date(c.startDate).toLocaleDateString() : 'TBD';

            return `
            <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition-all flex flex-col relative overflow-hidden">
                <div class="absolute top-0 left-0 w-full h-1 ${colors.bg}"></div>
                <div class="flex justify-between items-start mb-4">
                    <div>
                        <h3 class="font-extrabold text-base text-on-surface leading-tight">${c.title}</h3>
                        <p class="text-xs text-slate-500 mt-1 flex items-center gap-1">
                            <span class="material-symbols-outlined text-xs">location_on</span>
                            ${c.location}
                        </p>
                    </div>
                    <span class="${colors.badge} text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">${c.status}</span>
                </div>
                <div class="space-y-2 mb-4">
                    <div class="flex justify-between text-xs font-bold text-on-surface">
                        <span>${c.unitsCollected || 0} / ${c.targetUnits || 0} units</span>
                        <span>${progress}%</span>
                    </div>
                    <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                        <div class="${colors.bg} h-full rounded-full" style="width: ${progress}%"></div>
                    </div>
                </div>
                <div class="text-xs text-slate-500 mb-4">
                    <span class="font-medium">Start:</span> ${startDate}
                    ${c.participantCount > 0 ? ` • <span class="font-medium">${c.participantCount}</span> hospital${c.participantCount > 1 ? 's' : ''} participating` : ''}
                </div>
                <div class="mt-auto pt-3 border-t border-slate-100">
                    ${c.hasJoined
                        ? `<button onclick="window.handleLeaveCampaign('${c.id}', '${hospitalName}')" class="w-full text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 py-2 rounded-lg transition-colors flex items-center justify-center gap-1">
                            <span class="material-symbols-outlined text-xs">logout</span>
                            Leave Campaign
                        </button>`
                        : (c.status === 'active' || c.status === 'planning')
                        ? `<button onclick="window.handleJoinCampaign('${c.id}', '${hospitalName}', '${hospitalCity}')" class="w-full text-xs font-bold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 py-2 rounded-lg transition-colors flex items-center justify-center gap-1">
                            <span class="material-symbols-outlined text-xs">add_circle</span>
                            Join Campaign
                        </button>`
                        : `<span class="block text-center text-xs text-slate-400 font-medium py-2">Campaign ${c.status}</span>`
                    }
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load campaigns:', err);
        grid.innerHTML = '<div class="col-span-full text-center text-error py-12">Failed to load campaigns.</div>';
    }
}

window.handleJoinCampaign = async (campaignId, hospitalName, hospitalCity) => {
    try {
        await joinCampaign(campaignId, hospitalName, hospitalCity);
        showToast('Successfully joined campaign!');
        loadHospitalCampaignsView();
    } catch (err) {
        console.error('Failed to join campaign:', err);
        alert(err.message || 'Failed to join campaign.');
    }
};

window.handleLeaveCampaign = async (campaignId, hospitalName) => {
    try {
        await leaveCampaign(campaignId, hospitalName);
        showToast('Left campaign.');
        loadHospitalCampaignsView();
    } catch (err) {
        console.error('Failed to leave campaign:', err);
        alert(err.message || 'Failed to leave campaign.');
    }
};

// ============================================
// NOTIFICATION HISTORY + SMS/WhatsApp
// ============================================

async function loadNotificationHistory() {
    const container = document.getElementById('notificationHistoryBody');
    if (!container) return;

    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    try {
        const logs = await fetchNotificationLog(hospitalName);

        if (logs.length === 0) {
            container.innerHTML = '<div class="flex flex-col items-center justify-center py-8 text-slate-400"><span class="material-symbols-outlined text-3xl mb-2">notifications_off</span><p class="text-sm">No notifications sent yet</p><p class="text-xs text-slate-400 mt-1">Enable SMS/WhatsApp and perform actions to trigger notifications</p></div>';
            return;
        }

        container.innerHTML = logs.map(log => {
            const icon = log.channel === 'sms' ? 'sms' : log.channel === 'whatsapp' ? 'chat' : 'notifications';
            const color = log.status === 'pending' ? 'text-amber-600 bg-amber-50' : log.status === 'sent' ? 'text-emerald-600 bg-emerald-50' : 'text-red-600 bg-red-50';
            const statusText = log.status === 'pending' ? 'Tap to Send' : log.status;
            return `
            <div class="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors">
                <div class="w-8 h-8 rounded-lg ${color} flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-sm">${icon}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${color}">${statusText}</span>
                        <span class="text-[9px] text-slate-400">${new Date(log.sentAt).toLocaleString()}</span>
                    </div>
                    <p class="text-xs text-slate-600 mt-1 line-clamp-2">${log.message}</p>
                    <div class="flex gap-2 mt-2">
                        ${log.link ? `<a href="${log.link}" target="_blank" class="inline-flex items-center gap-1 text-[10px] font-bold ${log.channel === 'whatsapp' ? 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100' : 'text-blue-600 bg-blue-50 hover:bg-blue-100'} px-2.5 py-1 rounded-lg transition-colors">
                            <span class="material-symbols-outlined text-xs">${log.channel === 'whatsapp' ? 'chat' : 'sms'}</span>
                            Open ${log.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}
                        </a>` : ''}
                    </div>
                </div>
            </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load notifications:', err);
        container.innerHTML = '<div class="text-center text-error py-8">Failed to load notifications.</div>';
    }
}

function initNotificationFeatures() {
    // Wire send test notification button
    const testBtn = document.getElementById('btnSendTestNotification');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            const currentUser = getCurrentUser();
            const phone = currentUser?.phone || '+237 6XX XXX XXX';
            try {
                const result = await sendWhatsAppNotification(phone, `[VitalPulse] Test notification from ${currentUser?.name || 'Hospital'} — All systems operational.`);
                if (result.link) {
                    showToast('Opening WhatsApp with your test message...');
                    setTimeout(() => window.open(result.link, '_blank'), 500);
                }
                loadNotificationHistory();
            } catch (err) {
                console.error('Failed to send test:', err);
                alert('Failed to send test notification.');
            }
        });
    }

    // Wire SMS/WhatsApp toggles to save preferences
    const notifSms = document.getElementById('notifSms');
    const notifWhatsapp = document.getElementById('notifWhatsapp');
    const currentUser = getCurrentUser();

    if (notifSms && currentUser) {
        notifSms.addEventListener('change', async () => {
            try {
                await updateUserProfile(currentUser.uid, { notifSms: notifSms.checked });
                showToast(notifSms.checked ? 'SMS notifications enabled' : 'SMS notifications disabled');
            } catch (e) { console.error(e); }
        });
    }

    if (notifWhatsapp && currentUser) {
        notifWhatsapp.addEventListener('change', async () => {
            try {
                await updateUserProfile(currentUser.uid, { notifWhatsapp: notifWhatsapp.checked });
                showToast(notifWhatsapp.checked ? 'WhatsApp notifications enabled' : 'WhatsApp notifications disabled');
            } catch (e) { console.error(e); }
        });
    }
}




