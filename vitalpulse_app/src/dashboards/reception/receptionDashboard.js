import { getCurrentUser, getEffectiveHospitalName } from '../../auth.js';
import { fetchIncomingDonors } from '../../db.js';
import { esc } from '../../donor-dashboard.js';
import { verifyAndCheckInToken, callNextDonor, saveDonorEtaNote } from './receptionCheckIn.js';
import { fetchReceptionStockSummary, savePatientRequisitionHold, fetchPatientRequisitions, deletePatientRequisition } from './receptionStockLookup.js';
import { renderReceptionActivityStream } from './receptionActivity.js';
import { showToast } from '../../main.js';

let isReceptionInitialized = false;

/**
 * initReceptionDashboard - Main lifecycle initialization for Receptionist Dashboard
 */
export function initReceptionDashboard() {
  if (isReceptionInitialized) return;
  isReceptionInitialized = true;

  bindReceptionPasscodeCheckIn();
  bindPatientRequisitionModal();
  bindGlobalReceptionActions();
}

/**
 * loadReceptionOverview - Renders reception KPIs and Live Lobby Queue
 */
export async function loadReceptionOverview() {
  const currentUser = getCurrentUser();
  const hospitalName = getEffectiveHospitalName(currentUser);

  // Without a resolved hospital every query below silently returns nothing, which
  // is exactly how this dashboard used to fail: it fell back to the receptionist's
  // own name and rendered a permanently empty lobby with no error.
  if (!hospitalName) {
    const container = document.getElementById('receptionLobbyQueue');
    if (container) {
      container.innerHTML = `
        <div class="text-center py-10 text-slate-500">
          <span class="material-symbols-outlined text-3xl text-amber-500">domain_disabled</span>
          <p class="text-xs font-bold mt-2 text-slate-700">Your account isn't linked to a hospital yet</p>
          <p class="text-[11px] text-slate-400 mt-1">Ask your Hospital Admin to link this staff account before checking donors in.</p>
        </div>`;
    }
    return;
  }

  try {
    const donors = await fetchIncomingDonors(hospitalName);
    const requisitions = await fetchPatientRequisitions(hospitalName);

    // These MUST match the real lifecycle values written by db.js (see
    // REQUEST_ACTIVE_STATUSES). The previous filters looked for 'En Route' and
    // 'Accepted', which no code path ever writes — the real values are
    // 'Donor En Route' and 'Donor Assigned' — so the en-route count was always 0
    // and an approaching donor never appeared at the front desk.
    const isCheckedIn = d => d.status === 'Checked In' || d.receptionStatus === 'Calling';
    const isEnRoute = d => d.status === 'Donor En Route';
    const isAssigned = d => d.status === 'Donor Assigned';

    const checkedInDonors = donors.filter(isCheckedIn);
    const enRouteDonors = donors.filter(isEnRoute);
    // A donor who has pressed "I've arrived" but not yet been verified at the
    // desk — the queue reception actually has to act on.
    const awaitingVerification = donors.filter(d => isEnRoute(d) && d.receptionStatus === 'Awaiting Verification');

    const checkedInEl = document.getElementById('recCheckedInCount');
    const lobbyEl = document.getElementById('recLobbyCount');
    const enRouteEl = document.getElementById('recEnRouteCount');
    const reqEl = document.getElementById('recReqCount');

    if (checkedInEl) checkedInEl.textContent = checkedInDonors.length;
    if (lobbyEl) lobbyEl.textContent = checkedInDonors.length + awaitingVerification.length;
    if (enRouteEl) enRouteEl.textContent = enRouteDonors.length;
    if (reqEl) reqEl.textContent = requisitions.length;

    renderLobbyWaitingQueue(donors.filter(d => isCheckedIn(d) || isEnRoute(d) || isAssigned(d)));
  } catch (e) {
    console.warn('loadReceptionOverview failed:', e);
  }

  renderReceptionStockWidget(hospitalName);
  renderPatientRequisitionsList(hospitalName);
  renderReceptionActivityStream();
}

/**
 * renderLobbyWaitingQueue - Renders scannable card list of waiting donors in lobby
 */
function renderLobbyWaitingQueue(donors = []) {
  const container = document.getElementById('receptionLobbyQueue');
  if (!container) return;

  // Callers already filter to the lifecycle statuses reception acts on; the
  // previous second filter here used the same nonexistent status strings as the
  // KPI tiles and dropped everything except already-checked-in donors.
  // Order: people standing at the desk first, then arriving, then committed.
  const rank = (d) => {
    if (d.status === 'Donor En Route' && d.receptionStatus === 'Awaiting Verification') return 0;
    if (d.status === 'Checked In') return 1;
    if (d.status === 'Donor En Route') return 2;
    return 3;
  };
  const activeWaiting = [...donors].sort((a, b) => rank(a) - rank(b));

  if (activeWaiting.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 text-slate-400">
        <span class="material-symbols-outlined text-3xl text-slate-300">deck</span>
        <p class="text-xs font-semibold mt-2">No donors currently waiting in the lobby</p>
        <p class="text-[11px] text-slate-400">Checked in donors will appear here for screening room calls</p>
      </div>
    `;
    return;
  }

  container.innerHTML = activeWaiting.map(d => {
    // fetchIncomingDonors nests the donor's profile under `donorInfo`. Reading
    // these flat (d.donorName / d.bloodType / d.phone) always missed, so every
    // row rendered the placeholder values below — including a hardcoded
    // 'VP-9482' pass code on a check-in screen, which invites staff to verify
    // against a code that belongs to nobody.
    const donor = d.donorInfo || {};
    const donorName = donor.name || d.donorName || 'Unnamed donor';
    const bloodType = donor.bloodType || d.bloodType || d.type || '—';
    const phone = donor.phone || d.contactPhone || null;
    const token = d.checkInToken || null;
    const reqId = d.id;

    const isCheckedIn = d.status === 'Checked In';
    const isCalling = d.receptionStatus === 'Calling';
    const isAwaiting = d.status === 'Donor En Route' && d.receptionStatus === 'Awaiting Verification';

    const statusBadge = isCalling ? 'bg-indigo-100 text-indigo-800 border-indigo-200'
      : isAwaiting ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : isCheckedIn ? 'bg-amber-100 text-amber-800 border-amber-200'
      : 'bg-sky-100 text-sky-800 border-sky-200';
    const statusText = isCalling ? `Calling to ${esc(d.calledToRoom || 'Screening Room 1')}`
      : isAwaiting ? 'At desk — verify pass code'
      : isCheckedIn ? 'Checked In / In Lobby'
      : d.status === 'Donor En Route' ? 'En Route to Hospital'
      : 'Committed — not yet travelling';

    // "Call to room" only makes sense once they're actually checked in.
    const canCall = isCheckedIn || isCalling;

    return `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/80 p-4 rounded-2xl border ${isAwaiting ? 'border-emerald-300 ring-1 ring-emerald-100' : 'border-slate-200/80'} hover:border-indigo-200 transition-all">
        <div class="flex items-center gap-3.5">
          <div class="w-11 h-11 rounded-2xl bg-red-50 text-red-700 font-black text-sm flex items-center justify-center border border-red-100 shrink-0">
            ${esc(bloodType)}
          </div>
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <h4 class="font-extrabold text-sm text-slate-900">${esc(donorName)}</h4>
              ${token ? `<span class="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-slate-200 text-slate-700">${esc(token)}</span>` : ''}
              ${d.isPublicRequest ? '<span class="px-2 py-0.5 rounded-md text-[9px] font-black uppercase bg-orange-50 text-orange-600 border border-orange-200">Public</span>' : ''}
            </div>
            <p class="text-xs font-semibold text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
              <span class="px-2 py-0.5 rounded-md text-[9px] font-extrabold uppercase border ${statusBadge}">${statusText}</span>
              ${phone ? `<a href="tel:${esc(String(phone).replace(/\s+/g, ''))}" class="hover:text-red-600">📞 ${esc(phone)}</a>` : ''}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button onclick="window.openReceptionEtaModal('${esc(reqId)}', '${esc(donorName).replace(/'/g, "\\'")}')" class="px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs rounded-xl border border-slate-200 transition-all cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-sm text-slate-500">call</span>
            Note
          </button>
          ${canCall ? `
          <button onclick="window.callNextDonorAction('${esc(reqId)}', '${esc(donorName).replace(/'/g, "\\'")}')" class="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1.5">
            <span class="material-symbols-outlined text-sm">volume_up</span>
            Call to Room 1
          </button>` : `
          <span class="px-3 py-2 text-[11px] font-bold text-slate-400">Awaiting check-in</span>`}
        </div>
      </div>
    `;
  }).join('');
}

/**
 * bindReceptionPasscodeCheckIn - Connects passcode inputs (VP-XXXX) to verifyAndCheckInToken
 */
function bindReceptionPasscodeCheckIn() {
  const heroBtn = document.getElementById('dashBtnReceptionCheckIn');
  const heroInput = document.getElementById('dashReceptionCheckInInput');

  const handleCheckIn = async (inputEl) => {
    const val = inputEl ? inputEl.value : '';
    if (!val) {
      showToast('Please enter a donor passcode (e.g. VP-9482)', 'warning');
      return;
    }
    try {
      // The HOSPITAL's name, not the receptionist's — the desk must only be able
      // to check in its own facility's donors.
      const result = await verifyAndCheckInToken(val, getEffectiveHospitalName(getCurrentUser()));
      showToast(`✅ Checked in ${result.donorName} (${result.code})`);
      if (inputEl) inputEl.value = '';

      // Refresh incoming donors view if open
      if (typeof window.loadIncomingDonors === 'function') {
        window.loadIncomingDonors();
      }
    } catch (err) {
      showToast(err.message || 'Check-in failed', 'error');
    }
  };

  if (heroBtn && heroInput) {
    heroBtn.onclick = () => handleCheckIn(heroInput);
    heroInput.onkeypress = (e) => {
      if (e.key === 'Enter') handleCheckIn(heroInput);
    };
  }

  const tabBtn = document.getElementById('btnVerifyCheckInToken');
  const tabInput = document.getElementById('donorCheckInTokenInput');
  if (tabBtn && tabInput) {
    tabBtn.onclick = () => handleCheckIn(tabInput);
    tabInput.onkeypress = (e) => {
      if (e.key === 'Enter') handleCheckIn(tabInput);
    };
  }
}

/**
 * renderReceptionStockWidget - Renders read-only stock lookup on reception dashboard
 */
async function renderReceptionStockWidget(hospitalName) {
  const container = document.getElementById('receptionStockSummaryGrid');
  if (!container) return;

  try {
    const summary = await fetchReceptionStockSummary(hospitalName);
    const types = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

    container.innerHTML = types.map(type => {
      const data = summary[type] || { unitsAvailable: 0, status: 'Out of Stock' };
      const isOut = data.unitsAvailable === 0;
      const isLow = data.unitsAvailable > 0 && data.unitsAvailable <= 3;

      const badgeColor = isOut ? 'bg-red-50 text-red-700 border-red-200' : isLow ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200';

      return `
        <div class="bg-white rounded-2xl p-5 border border-slate-100 shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all space-y-3">
          <div class="flex items-center justify-between">
            <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-rose-600 text-white font-black text-sm flex items-center justify-center shadow-md shadow-red-200">${type}</span>
            <span class="px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider border ${badgeColor}">${data.status}</span>
          </div>
          <div>
            <p class="text-2xl font-black text-slate-900 tracking-tight">${data.unitsAvailable} <span class="text-xs font-bold text-slate-400 uppercase">Units</span></p>
            <p class="text-[11px] font-semibold text-slate-400 mt-0.5 flex items-center gap-1">
              <span class="material-symbols-outlined text-xs text-emerald-500">verified</span>
              Lab Verified & Cleared
            </p>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.warn('renderReceptionStockWidget failed:', e);
  }
}

/**
 * renderPatientRequisitionsList - Renders active patient ward requisitions list
 */
async function renderPatientRequisitionsList(hospitalName) {
  const container = document.getElementById('receptionPatientRequisitionsList');
  if (!container) return;

  try {
    const reqs = await fetchPatientRequisitions(hospitalName);
    if (reqs.length === 0) {
      container.innerHTML = `
        <div class="text-center py-6 text-slate-400">
          <span class="material-symbols-outlined text-2xl text-slate-300">receipt_long</span>
          <p class="text-xs font-semibold mt-1">No active patient ward requisitions logged</p>
        </div>
      `;
      return;
    }

    container.innerHTML = reqs.map(r => `
      <div class="flex items-center justify-between bg-slate-50 rounded-xl p-3 border border-slate-200/80">
        <div>
          <div class="flex items-center gap-2">
            <span class="font-extrabold text-xs text-slate-900">${r.patientName}</span>
            <span class="px-2 py-0.5 bg-blue-100 text-blue-800 text-[10px] font-black rounded-md">Ward ${r.wardNumber}</span>
            <span class="px-2 py-0.5 bg-red-100 text-red-700 text-[10px] font-black rounded-md">${r.bloodTypeNeeded} (${r.unitsNeeded} unit)</span>
          </div>
          <p class="text-[11px] text-slate-500 font-medium mt-0.5">Dr. ${r.attendingDoctor} · Slip #${r.requisitionSlipNumber || 'None'} ${r.notes ? '· Note: ' + r.notes : ''}</p>
        </div>
        <button onclick="window.fulfillReceptionRequisition('${r.id}')" class="text-xs text-slate-500 hover:text-red-600 font-bold p-1 cursor-pointer" title="Remove / Clear Requisition">
          <span class="material-symbols-outlined text-sm">check_circle</span>
        </button>
      </div>
    `).join('');
  } catch (e) {
    console.warn('renderPatientRequisitionsList failed:', e);
  }
}

/**
 * bindPatientRequisitionModal - Binds patient ward requisition form submit
 */
function bindPatientRequisitionModal() {
  const form = document.getElementById('formPatientRequisition');
  if (!form) return;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;

    try {
      await savePatientRequisitionHold({
        patientName: document.getElementById('reqPatientName')?.value,
        wardNumber: document.getElementById('reqWardNumber')?.value,
        attendingDoctor: document.getElementById('reqAttendingDoctor')?.value,
        bloodTypeNeeded: document.getElementById('reqBloodType')?.value,
        unitsNeeded: document.getElementById('reqUnits')?.value,
        requisitionSlipNumber: document.getElementById('reqSlipNumber')?.value,
        notes: document.getElementById('reqNotes')?.value
      });

      showToast('✅ Patient Ward Requisition logged at Reception');
      if (typeof window.closeModal === 'function') window.closeModal('patientRequisitionModal');
      form.reset();

      const currentUser = getCurrentUser();
      renderPatientRequisitionsList(getEffectiveHospitalName(currentUser));
    } catch (err) {
      showToast(err.message || 'Failed to log requisition', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

/**
 * bindGlobalReceptionActions - Attaches window action helpers for reception UI
 */
function bindGlobalReceptionActions() {
  window.callNextDonorAction = async (requestId, donorName) => {
    try {
      const res = await callNextDonor(requestId, donorName);
      showToast(`📢 Called ${donorName} to ${res.roomNumber}`);
      if (typeof window.loadIncomingDonors === 'function') window.loadIncomingDonors();
    } catch (e) {
      showToast(e.message || 'Call failed', 'error');
    }
  };

  window.openReceptionEtaModal = (requestId, donorName) => {
    const modal = document.getElementById('donorEtaModal');
    if (!modal) return;
    document.getElementById('etaDonorName').textContent = donorName;
    document.getElementById('etaRequestId').value = requestId;
    if (typeof window.openModal === 'function') window.openModal('donorEtaModal');
  };

  window.submitReceptionEtaNote = async () => {
    const reqId = document.getElementById('etaRequestId')?.value;
    const donorName = document.getElementById('etaDonorName')?.textContent;
    const note = document.getElementById('etaNoteInput')?.value;

    try {
      await saveDonorEtaNote(reqId, donorName, note);
      showToast(`📞 Phone note saved for ${donorName}`);
      if (typeof window.closeModal === 'function') window.closeModal('donorEtaModal');
      document.getElementById('etaNoteInput').value = '';
    } catch (e) {
      showToast(e.message || 'Could not save note', 'error');
    }
  };

  window.fulfillReceptionRequisition = async (reqId) => {
    try {
      await deletePatientRequisition(reqId);
      showToast('Requisition updated');
      const currentUser = getCurrentUser();
      renderPatientRequisitionsList(getEffectiveHospitalName(currentUser));
    } catch (e) {
      showToast('Could not remove requisition', 'error');
    }
  };
}
