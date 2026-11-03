// ============================================================================
// VITALPULSE PUBLIC HOMEPAGE CONTROLLER (src/home.js)
//
// Responsibilities:
// 1. Initialize Framer Motion spring physics & reveals (motionEffects.js).
// 2. Hydrate realtime platform emergency dispatch status from public_stats/overview.
// 3. Render ultra-sleek, compact verified hospital network capsules.
// 4. Update the interactive Blood Compatibility Matrix with live regional demand.
// 5. Provide smooth, seamless transitions across all public pages.
// ============================================================================

import { fetchPublicSnapshot, BLOOD_TYPES } from './publicStats.js';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase.js';
import { initMotionEffects } from './motionEffects.js';

// Realistic baseline seed data for regional hospital coordination in Cameroon
const SEED_HOSPITALS = [
    { name: 'CHU de Yaoundé', city: 'Yaoundé • Centre', icon: 'local_hospital' },
    { name: 'Hôpital Général Douala', city: 'Douala • Littoral', icon: 'emergency' },
    { name: 'Hôpital Laquintinie', city: 'Douala • Littoral', icon: 'child_care' },
    { name: 'Regional Hospital Buea', city: 'Buea • Southwest', icon: 'bloodtype' },
    { name: 'HR Bafoussam', city: 'Bafoussam • West', icon: 'medical_services' },
    { name: 'Hôpital Central de Yaoundé', city: 'Yaoundé • Centre', icon: 'domain' },
    { name: 'HR Garoua', city: 'Garoua • North', icon: 'health_and_safety' },
    { name: 'Regional Hospital Limbe', city: 'Limbe • Southwest', icon: 'local_hospital' }
];

export async function initHomePage() {
    // 1. Initialize Framer Motion spring physics, reveals, and micro-motion
    try {
        initMotionEffects();
    } catch (e) {
        console.debug('[home] Motion effects init skipped:', e?.message);
    }

    // 2. Initial hydration from snapshot
    let snapshot = null;
    try {
        snapshot = await fetchPublicSnapshot();
    } catch (e) {
        console.debug('[home] Snapshot read fallback:', e?.message);
    }

    applySnapshotToUI(snapshot);

    // 3. Real-time updates if available
    try {
        onSnapshot(doc(db, 'public_stats', 'overview'), (docSnap) => {
            if (docSnap.exists()) {
                applySnapshotToUI(docSnap.data());
            }
        }, (err) => {
            console.debug('[home] Snapshot realtime listener:', err?.message);
        });
    } catch (_) {}
}

function applySnapshotToUI(snap) {
    // A. Live Emergency Needs Pill (Dynamic based on realtime dispatch)
    const liveNeedBadge = document.getElementById('heroLiveNeedBadge');
    if (liveNeedBadge) {
        const count = snap?.openNeedCount || 0;
        if (count > 0) {
            liveNeedBadge.innerHTML = `
                <span class="relative flex w-2 h-2">
                    <span class="animate-ping absolute inline-flex w-full h-full rounded-full bg-red-400 opacity-75"></span>
                    <span class="relative inline-flex w-2 h-2 rounded-full bg-red-500"></span>
                </span>
                <span>${count} Active Regional Emergency ${count === 1 ? 'Dispatch' : 'Dispatches'}</span>
            `;
            liveNeedBadge.className = 'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-red-600/90 text-white text-[11px] sm:text-xs font-bold uppercase tracking-wider shadow-lg shadow-red-600/30 backdrop-blur-md border border-white/20 mb-5 animate-pulse';
        } else {
            liveNeedBadge.innerHTML = `
                <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>Active National Blood Network &bull; Cameroon</span>
            `;
            liveNeedBadge.className = 'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-900/80 text-emerald-300 text-[11px] sm:text-xs font-bold uppercase tracking-wider backdrop-blur-md border border-emerald-500/30 mb-5';
        }
    }

    // B. Verified Hospital Network Capsules
    renderHospitalMarquee(snap?.hospitals);

    // C. Matrix Live Demand Indicators
    if (snap?.demandByType) {
        window._liveDemandByType = snap.demandByType;
        if (typeof window.updateMatrixDemandUI === 'function') {
            window.updateMatrixDemandUI();
        }
    }
}

function renderHospitalMarquee(hospitals) {
    const track = document.getElementById('hospitalMarqueeTrack');
    if (!track) return;

    const list = (hospitals && hospitals.length >= 4)
        ? hospitals.map(h => ({
            name: h.name,
            city: h.city ? `${h.city} • Cameroon` : 'Cameroon',
            icon: 'local_hospital'
        }))
        : SEED_HOSPITALS;

    // Render items twice for continuous infinite loop
    const renderCard = (h, isDup = false) => `
        <div class="w-[240px] sm:w-[260px] bg-slate-50/80 hover:bg-white rounded-2xl p-3.5 border border-slate-200/80 hover:border-red-300 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 shrink-0 flex items-center gap-3.5 group cursor-default" ${isDup ? 'aria-hidden="true"' : ''}>
            <div class="w-10 h-10 rounded-xl bg-red-50 text-red-600 border border-red-100/80 flex items-center justify-center shrink-0 group-hover:scale-105 group-hover:bg-red-600 group-hover:text-white transition-all duration-200 shadow-xs">
                <span class="material-symbols-outlined text-xl">${h.icon || 'local_hospital'}</span>
            </div>
            <div class="min-w-0 flex-1">
                <h3 class="font-headline font-bold text-xs sm:text-sm text-slate-900 tracking-tight leading-snug truncate">${h.name}</h3>
                <div class="flex items-center gap-1 text-[11px] text-slate-500 mt-0.5">
                    <span class="material-symbols-outlined text-xs text-red-500 shrink-0">location_on</span>
                    <span class="truncate">${h.city}</span>
                </div>
                <div class="flex items-center gap-1.5 text-[10px] font-bold text-emerald-600 mt-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span>Connected Node</span>
                </div>
            </div>
        </div>
    `;

    const html1 = list.map(h => renderCard(h, false)).join('');
    const html2 = list.map(h => renderCard(h, true)).join('');
    track.innerHTML = html1 + html2;
}
