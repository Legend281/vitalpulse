import { getCurrentUser, getEffectiveHospitalName } from '../../auth.js';
import { createNursePatientRequest, fetchNurseActiveRequests } from './nurseClinicalRequest.js';
import { verifyAndIssueBloodBag } from './nurseBedsideVerification.js';
import { logTransfusionVitals, fetchActiveTransfusions } from './nurseVitalsMonitor.js';
import { stopTransfusionAndReportReaction, fetchNurseReactionLogs } from './nurseReactionReport.js';
import { showToast } from '../../main.js';

let isNurseInitialized = false;

/**
 * initNurseDashboard - Main lifecycle initialization for Nurse Care Station
 */
export function initNurseDashboard() {
  if (isNurseInitialized) return;
  isNurseInitialized = true;

  bindNurseModalForms();
  bindNurseGlobalActions();
}

/**
 * loadNurseOverview - Renders Nurse KPIs, Active Clinical Requests, and Transfusions
 */
export async function loadNurseOverview() {
  const currentUser = getCurrentUser();
  const hospitalName = getEffectiveHospitalName(currentUser);

  try {
    const requests = await fetchNurseActiveRequests(hospitalName);
    const transfusions = await fetchActiveTransfusions(hospitalName);
    const reactions = await fetchNurseReactionLogs(hospitalName);

    const activeReqs = requests.filter(r => r.status !== 'Fulfilled' && r.status !== 'Cancelled' && r.status !== 'Completed' && r.status !== 'Closed');
    const pendingCrossmatch = activeReqs.filter(r => r.status === 'Pending Crossmatch' || r.status === 'Open' || r.status === 'Donor En Route');

    // Update KPI Tiles
    const activeEl = document.getElementById('nurseActiveReqCount');
    const issuedEl = document.getElementById('nurseIssuedCount');
    const pendingCrossEl = document.getElementById('nursePendingCrossCount');
    const reactionEl = document.getElementById('nurseReactionCount');

    if (activeEl) activeEl.textContent = activeReqs.length;
    if (issuedEl) issuedEl.textContent = transfusions.length;
    if (pendingCrossEl) pendingCrossEl.textContent = pendingCrossmatch.length;
    if (reactionEl) reactionEl.textContent = reactions.length;

    // Render Active Clinical Requests List
    renderActiveClinicalRequestsList(requests);
    renderNurseTransfusionsList(transfusions);
    renderNurseReactionReportsList(reactions);
  } catch (e) {
    console.warn('loadNurseOverview failed:', e);
  }
}

/**
 * renderActiveClinicalRequestsList - Renders active patient clinical requests queue
 */
function renderActiveClinicalRequestsList(requests = []) {
  const container = document.getElementById('nurseActiveRequestsList');
  if (!container) return;

  const activeReqs = requests.filter(r => r.status !== 'Fulfilled' && r.status !== 'Cancelled' && r.status !== 'Completed' && r.status !== 'Closed');

  if (activeReqs.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 text-slate-400">
        <span class="material-symbols-outlined text-3xl text-slate-300">medical_services</span>
        <p class="text-xs font-semibold mt-2">No active clinical patient requests</p>
      </div>
    `;
    return;
  }

  container.innerHTML = activeReqs.map(r => {
    const isEmergency = r.isTrackA || r.urgency === 'Emergency' || r.urgency === 'Immediate';
    const badgeColor = isEmergency ? 'bg-red-100 text-red-800 border-red-200 animate-pulse' : 'bg-blue-100 text-blue-800 border-blue-200';
    const trackLabel = r.isTrackA ? 'Track A (Emergency Release)' : 'Track B (Standard Crossmatch)';
    const patientName = r.patientName || r.reason || 'Emergency Patient';
    const safePatientName = patientName.replace(/'/g, "\\'");
    const ward = r.wardNumber || 'ICU/ER';
    const bloodType = r.bloodType || 'O+';
    const units = r.unitsNeeded || r.units || 1;

    return `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/80 p-4 rounded-2xl border border-slate-200/80 hover:border-rose-200 transition-all">
        <div class="flex items-center gap-3.5">
          <div class="w-11 h-11 rounded-2xl bg-rose-50 text-rose-700 font-black text-sm flex items-center justify-center border border-rose-100 shrink-0">
            ${bloodType}
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h4 class="font-extrabold text-sm text-slate-900">${patientName}</h4>
              <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-200 text-slate-700">Ward ${ward}</span>
              <span class="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border ${badgeColor}">${trackLabel}</span>
            </div>
            <p class="text-xs font-semibold text-slate-500 mt-0.5">
              ${units} unit(s) needed · Dr. ${r.attendingDoctor || 'On Duty'} ${r.clinicalDiagnosis ? '· ' + r.clinicalDiagnosis : ''}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button onclick="window.openNurseBedsideModal('${r.id}', '${safePatientName}', '${ward}', '${bloodType}')" class="px-4 py-2 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1.5">
            <span class="material-symbols-outlined text-sm">bloodtype</span>
            Bedside Issue Bag
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * renderNurseTransfusionsList - Renders active transfusions log for Tab 3
 */
function renderNurseTransfusionsList(transfusions = []) {
  const container = document.getElementById('nurseTransfusionsList');
  if (!container) return;

  if (transfusions.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 text-slate-400">
        <span class="material-symbols-outlined text-3xl text-slate-300">monitor_heart</span>
        <p class="text-xs font-semibold mt-2">No active patient transfusions</p>
      </div>
    `;
    return;
  }

  container.innerHTML = transfusions.map(t => {
    const isTransfusing = t.status === 'Transfusing';
    const badgeColor = isTransfusing ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-slate-100 text-slate-700 border-slate-200';

    return `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/80 p-4 rounded-2xl border border-slate-200/80">
        <div>
          <div class="flex items-center gap-2">
            <span class="font-extrabold text-sm text-slate-900">${t.patientName}</span>
            <span class="px-2 py-0.5 bg-blue-100 text-blue-800 text-[10px] font-black rounded-md">Ward ${t.wardNumber}</span>
            <span class="px-2 py-0.5 bg-red-100 text-red-700 text-[10px] font-black rounded-md">${t.bloodType} (Bag #${t.bloodBagBarcode})</span>
            <span class="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase border ${badgeColor}">${t.status}</span>
          </div>
          <p class="text-xs text-slate-500 font-medium mt-1">Verifiers: ${t.firstVerifier} & ${t.secondVerifier || 'Verified'}</p>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button onclick="window.openNurseVitalsModal('${t.id}', '${t.patientName}')" class="px-3 py-2 bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs rounded-xl shadow-xs transition-all cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-sm">monitor_heart</span>
            Log Vitals
          </button>
          <button onclick="window.openNurseReactionModal('${t.id}', '${t.patientName}', '${t.wardNumber}', '${t.bloodType}', '${t.bloodBagBarcode}')" class="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-xl shadow-xs transition-all cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-sm">report_problem</span>
            Stop & Reaction
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * renderNurseReactionReportsList - Renders adverse reaction reports for Tab 4
 */
function renderNurseReactionReportsList(reactions = []) {
  const container = document.getElementById('nurseReactionReportsList');
  if (!container) return;

  if (reactions.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 text-slate-400">
        <span class="material-symbols-outlined text-3xl text-slate-300">verified_user</span>
        <p class="text-xs font-semibold mt-2">No adverse transfusion reactions reported</p>
      </div>
    `;
    return;
  }

  container.innerHTML = reactions.map(r => `
    <div class="bg-red-50/50 rounded-2xl p-4 border border-red-200 space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="font-extrabold text-sm text-slate-900">${r.patientName}</span>
          <span class="px-2 py-0.5 bg-red-100 text-red-800 text-[10px] font-black rounded-md">Ward ${r.wardNumber}</span>
          <span class="px-2.5 py-0.5 bg-red-600 text-white text-[9px] font-black uppercase rounded-full">${r.reactionType}</span>
        </div>
        <span class="text-[10px] font-bold text-slate-400">${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : 'Recent'}</span>
      </div>
      <p class="text-xs text-slate-700 font-medium">Symptoms: ${r.symptoms || 'Fever, chills reported'} · Action: ${r.actionTaken || 'Transfusion stopped'}</p>
    </div>
  `).join('');
}

/**
 * bindNurseModalForms - Connects modal form submit handlers for nurse care station
 */
function bindNurseModalForms() {
  // New Patient Request Form
  const reqForm = document.getElementById('formNurseNewRequest');
  if (reqForm) {
    reqForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await createNursePatientRequest({
          patientName: document.getElementById('nurseReqPatientName')?.value,
          patientIdNumber: document.getElementById('nurseReqPatientId')?.value,
          wardNumber: document.getElementById('nurseReqWard')?.value,
          attendingDoctor: document.getElementById('nurseReqDoctor')?.value,
          bloodTypeNeeded: document.getElementById('nurseReqBloodType')?.value,
          unitsNeeded: document.getElementById('nurseReqUnits')?.value,
          emergencyTrack: document.getElementById('nurseReqTrack')?.value,
          clinicalDiagnosis: document.getElementById('nurseReqDiagnosis')?.value,
          emergencyWaiverSigned: document.getElementById('nurseReqWaiver')?.checked
        });

        showToast('✅ Patient Blood Request Submitted');
        if (typeof window.closeModal === 'function') window.closeModal('nurseNewRequestModal');
        reqForm.reset();
        loadNurseOverview();
      } catch (err) {
        showToast(err.message || 'Failed to submit request', 'error');
      }
    };
  }

  // Bedside Verification Form
  const verifyForm = document.getElementById('formNurseBedsideVerify');
  if (verifyForm) {
    verifyForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await verifyAndIssueBloodBag({
          requestId: document.getElementById('verifyRequestId')?.value,
          patientName: document.getElementById('verifyPatientName')?.value,
          patientIdNumber: document.getElementById('verifyPatientIdNumber')?.value,
          wardNumber: document.getElementById('verifyWardNumber')?.value,
          bloodType: document.getElementById('verifyBloodType')?.value,
          units: document.getElementById('verifyUnits')?.value,
          bloodBagBarcode: document.getElementById('verifyBagBarcode')?.value,
          secondVerifierName: document.getElementById('verifySecondStaffName')?.value,
          secondVerifierRole: document.getElementById('verifySecondStaffRole')?.value
        });

        showToast('✅ 2-Clinician Bedside Check Passed — Blood Bag Issued & Transfusion Started');
        if (typeof window.closeModal === 'function') window.closeModal('nurseBedsideVerifyModal');
        verifyForm.reset();
        loadNurseOverview();
      } catch (err) {
        showToast(err.message || 'Bedside verification failed', 'error');
      }
    };
  }

  // Vitals Monitor Form
  const vitalsForm = document.getElementById('formNurseVitals');
  if (vitalsForm) {
    vitalsForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const transId = document.getElementById('vitalsTransfusionId')?.value;
        const stage = document.getElementById('vitalsStage')?.value;

        await logTransfusionVitals(transId, stage, {
          temperature: document.getElementById('vitalsTemp')?.value,
          systolicBp: document.getElementById('vitalsSystolic')?.value,
          diastolicBp: document.getElementById('vitalsDiastolic')?.value,
          pulseRate: document.getElementById('vitalsPulse')?.value,
          respRate: document.getElementById('vitalsResp')?.value,
          notes: document.getElementById('vitalsNotes')?.value
        });

        showToast(`✅ Transfusion Vitals Logged (${stage})`);
        if (typeof window.closeModal === 'function') window.closeModal('nurseVitalsModal');
        vitalsForm.reset();
        loadNurseOverview();
      } catch (err) {
        showToast(err.message || 'Vitals check failed', 'error');
      }
    };
  }

  // Reaction Report Form
  const reactForm = document.getElementById('formNurseReaction');
  if (reactForm) {
    reactForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await stopTransfusionAndReportReaction({
          transfusionId: document.getElementById('reactTransfusionId')?.value,
          patientName: document.getElementById('reactPatientName')?.value,
          wardNumber: document.getElementById('reactWardNumber')?.value,
          bloodType: document.getElementById('reactBloodType')?.value,
          bloodBagBarcode: document.getElementById('reactBagBarcode')?.value,
          reactionType: document.getElementById('reactType')?.value,
          symptoms: document.getElementById('reactSymptoms')?.value,
          actionTaken: document.getElementById('reactAction')?.value
        });

        showToast('🚨 Transfusion Stopped & Emergency Hemovigilance Alert Sent');
        if (typeof window.closeModal === 'function') window.closeModal('nurseReactionModal');
        reactForm.reset();
        loadNurseOverview();
      } catch (err) {
        showToast(err.message || 'Reaction report failed', 'error');
      }
    };
  }
}

/**
 * bindNurseGlobalActions - Attaches window action helpers for Nurse UI
 */
function bindNurseGlobalActions() {
  window.openNurseBedsideModal = (reqId, patientName, wardNumber, bloodType) => {
    document.getElementById('verifyRequestId').value = reqId || '';
    document.getElementById('verifyPatientName').value = patientName || '';
    document.getElementById('verifyWardNumber').value = wardNumber || '';
    document.getElementById('verifyBloodType').value = bloodType || 'O+';
    if (typeof window.openModal === 'function') window.openModal('nurseBedsideVerifyModal');
  };

  window.openNurseVitalsModal = (transfusionId, patientName) => {
    document.getElementById('vitalsTransfusionId').value = transfusionId || '';
    document.getElementById('vitalsPatientNameLabel').textContent = patientName || 'Patient';
    if (typeof window.openModal === 'function') window.openModal('nurseVitalsModal');
  };

  window.openNurseReactionModal = (transId, patientName, wardNumber, bloodType, bagBarcode) => {
    document.getElementById('reactTransfusionId').value = transId || '';
    document.getElementById('reactPatientName').value = patientName || '';
    document.getElementById('reactWardNumber').value = wardNumber || '';
    document.getElementById('reactBloodType').value = bloodType || '';
    document.getElementById('reactBagBarcode').value = bagBarcode || '';
    if (typeof window.openModal === 'function') window.openModal('nurseReactionModal');
  };
}
