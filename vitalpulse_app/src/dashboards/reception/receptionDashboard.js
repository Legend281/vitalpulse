import { getCurrentUser } from '../../auth.js';
import { fetchIncomingDonors } from '../../db.js';
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
  const hospitalName = currentUser?.name || 'General Hospital';

  try {
    const donors = await fetchIncomingDonors(hospitalName);
    const requisitions = await fetchPatientRequisitions(hospitalName);

    const checkedInDonors = donors.filter(d => (d.receptionStatus || d.status) === 'Checked In' || (d.receptionStatus || d.status) === 'Calling');
    const enRouteDonors = donors.filter(d => (d.receptionStatus || d.status) === 'En Route' || d.status === 'Accepted');

    // Update KPI Tiles
    const checkedInEl = document.getElementById('recCheckedInCount');
    const lobbyEl = document.getElementById('recLobbyCount');
    const enRouteEl = document.getElementById('recEnRouteCount');
    const reqEl = document.getElementById('recReqCount');

    if (checkedInEl) checkedInEl.textContent = checkedInDonors.length;
    if (lobbyEl) lobbyEl.textContent = checkedInDonors.length;
    if (enRouteEl) enRouteEl.textContent = enRouteDonors.length;
    if (reqEl) reqEl.textContent = requisitions.length;

    // Render Live Lobby Queue
    renderLobbyWaitingQueue(donors);
  } catch (e) {
    console.warn('loadReceptionOverview failed:', e);
  }

  // Also refresh stock lookup, requisitions & activity stream if active
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

  const activeWaiting = donors.filter(d => ['Checked In', 'Calling', 'En Route', 'Accepted'].includes(d.receptionStatus || d.status));

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
    const isCheckedIn = (d.receptionStatus || d.status) === 'Checked In';
    const isCalling = (d.receptionStatus || d.status) === 'Calling';
    const statusBadge = isCalling ? 'bg-indigo-100 text-indigo-800 border-indigo-200' : isCheckedIn ? 'bg-amber-100 text-amber-800 border-amber-200' : 'bg-sky-100 text-sky-800 border-sky-200';
    const statusText = isCalling ? `Calling to ${d.calledToRoom || 'Screening Room 1'}` : isCheckedIn ? 'Checked In / In Lobby' : 'En Route to Hospital';

    const donorName = d.donorName || d.name || 'Donor';
    const bloodType = d.bloodType || 'O+';
    const token = d.checkInToken || d.code || 'VP-9482';
    const reqId = d.requestId || d.id;

    return `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/80 p-4 rounded-2xl border border-slate-200/80 hover:border-indigo-200 transition-all">
        <div class="flex items-center gap-3.5">
          <div class="w-11 h-11 rounded-2xl bg-red-50 text-red-700 font-black text-sm flex items-center justify-center border border-red-100 shrink-0">
            ${bloodType}
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h4 class="font-extrabold text-sm text-slate-900">${donorName}</h4>
              <span class="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-slate-200 text-slate-700">${token}</span>
            </div>
            <p class="text-xs font-semibold text-slate-500 mt-0.5 flex items-center gap-2">
              <span class="px-2 py-0.5 rounded-md text-[9px] font-extrabold uppercase border ${statusBadge}">${statusText}</span>
              ${d.phone ? '<span>📞 ' + d.phone + '</span>' : ''}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button onclick="window.openReceptionEtaModal('${reqId}', '${donorName}')" class="px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs rounded-xl border border-slate-200 transition-all cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-sm text-slate-500">call</span>
            Note
          </button>
          <button onclick="window.callNextDonorAction('${reqId}', '${donorName}')" class="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1.5">
            <span class="material-symbols-outlined text-sm">volume_up</span>
            Call to Room 1
          </button>
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
      const currentUser = getCurrentUser();
      const result = await verifyAndCheckInToken(val, currentUser?.name);
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
      renderPatientRequisitionsList(currentUser?.name);
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
      renderPatientRequisitionsList(currentUser?.name);
    } catch (e) {
      showToast('Could not remove requisition', 'error');
    }
  };
}
