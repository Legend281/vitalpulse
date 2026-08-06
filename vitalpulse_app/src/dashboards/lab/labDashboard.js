import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { getCurrentUser } from '../../auth.js';
import { resolveLabTest } from '../../db.js';
import { showToast } from '../../main.js';

let isLabInitialized = false;

/**
 * initLabDashboard - Main lifecycle initialization for Lab Tech Dashboard
 */
export function initLabDashboard() {
  if (isLabInitialized) return;
  isLabInitialized = true;

  bindLabModalForm();
  bindGlobalLabActions();
}

/**
 * fetchPendingLabTests - Retrieves all quarantine batches waiting for lab testing for a hospital
 */
export async function fetchPendingLabTests(hospitalName) {
  if (!hospitalName) return [];
  try {
    const q = query(collection(db, 'inventory'));
    const snapshot = await getDocs(q);
    const pendingBatches = [];

    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data();
      const matchHospital = data.hospital === hospitalName || data.hospitalName === hospitalName;
      if (!matchHospital) return;

      const bloodType = data.bloodType;
      const batches = Array.isArray(data.batches) ? data.batches : [];

      batches.forEach(b => {
        if (b.testStatus === 'Waiting for Lab Test') {
          pendingBatches.push({
            ...b,
            bloodType,
            hospital: hospitalName
          });
        }
      });
    });

    return pendingBatches.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  } catch (err) {
    console.warn('fetchPendingLabTests failed:', err);
    return [];
  }
}

/**
 * fetchLabClearedBatches - Fetches cleared & rejected statistics for KPIs
 */
export async function fetchLabStatistics(hospitalName) {
  if (!hospitalName) return { clearedCount: 0, rejectedCount: 0, totalBatches: 0 };
  try {
    const q = query(collection(db, 'inventory'));
    const snapshot = await getDocs(q);
    let clearedCount = 0;
    let rejectedCount = 0;
    let totalBatches = 0;

    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data();
      const matchHospital = data.hospital === hospitalName || data.hospitalName === hospitalName;
      if (!matchHospital) return;

      const batches = Array.isArray(data.batches) ? data.batches : [];
      batches.forEach(b => {
        totalBatches++;
        if (b.testStatus === 'Cleared') clearedCount += (b.units || 1);
        if (b.testStatus === 'Rejected, Not Safe') rejectedCount += (b.units || 1);
      });
    });

    return { clearedCount, rejectedCount, totalBatches };
  } catch (err) {
    console.warn('fetchLabStatistics failed:', err);
    return { clearedCount: 0, rejectedCount: 0, totalBatches: 0 };
  }
}

/**
 * loadLabOverview / loadLabPipeline - Renders Lab Tech KPIs and Quarantine Screening Queue
 */
export async function loadLabOverview() {
  const currentUser = getCurrentUser();
  const hospitalName = currentUser?.name || 'General Hospital';

  try {
    const pendingBatches = await fetchPendingLabTests(hospitalName);
    const stats = await fetchLabStatistics(hospitalName);

    // Update KPI Tiles
    const pendingEl = document.getElementById('labPendingCount');
    const clearedEl = document.getElementById('labClearedCount');
    const rejectedEl = document.getElementById('labRejectedCount');
    const totalEl = document.getElementById('labTotalBatchesCount');

    if (pendingEl) pendingEl.textContent = pendingBatches.length;
    if (clearedEl) clearedEl.textContent = stats.clearedCount;
    if (rejectedEl) rejectedEl.textContent = stats.rejectedCount;
    if (totalEl) totalEl.textContent = stats.totalBatches;

    // Render Queue
    renderPendingLabTestsQueue(pendingBatches);
  } catch (e) {
    console.warn('loadLabOverview failed:', e);
  }
}

export const loadLabPipeline = loadLabOverview;

/**
 * renderPendingLabTestsQueue - Renders scannable quarantine list of blood units needing TTI screening
 */
function renderPendingLabTestsQueue(pendingBatches = []) {
  const container = document.getElementById('labPendingTestsList');
  if (!container) return;

  if (pendingBatches.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 text-slate-400">
        <span class="material-symbols-outlined text-4xl text-emerald-400 mb-2" style="font-variation-settings:'FILL' 1">check_circle</span>
        <p class="text-sm font-extrabold text-slate-800">Quarantine Lab Queue Clear!</p>
        <p class="text-xs text-slate-400 mt-1">All collected blood units have completed viral marker screening</p>
      </div>
    `;
    return;
  }

  container.innerHTML = pendingBatches.map(b => {
    const batchId = b.id || 'N/A';
    const bloodType = b.bloodType || 'O+';
    const units = b.units || 1;
    const component = b.componentType || 'Whole Blood';
    const collectedAt = b.addedAt ? new Date(b.addedAt).toLocaleDateString() : 'Recent';

    return `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200/80 shadow-xs hover:border-indigo-300 transition-all">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-600 to-purple-600 text-white font-black text-base flex items-center justify-center shadow-md shadow-indigo-200 shrink-0">
            ${bloodType}
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="font-mono font-bold text-xs bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-md border border-slate-200">${batchId}</span>
              <span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">
                Waiting for Lab Test
              </span>
            </div>
            <p class="text-xs font-semibold text-slate-600 mt-1">
              ${units} unit(s) · <span class="text-indigo-600 font-bold">${component}</span> · Collected: ${collectedAt}
            </p>
            <p class="text-[11px] text-slate-400 font-medium mt-0.5 flex items-center gap-1">
              <span class="material-symbols-outlined text-xs text-amber-500">warning</span>
              Quarantined — Cannot be issued until HIV, Hep B/C, Syphilis non-reactive
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button onclick="window.openLabTestModal('${bloodType}', '${batchId}', '${component}', ${units})" class="px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1.5">
            <span class="material-symbols-outlined text-sm">science</span>
            Run TTI Screening
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * bindLabModalForm - Connects viral screening modal form submit handler
 */
function bindLabModalForm() {
  const form = document.getElementById('formLabTest');
  if (!form) return;

  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const currentUser = getCurrentUser();
      const hospitalName = currentUser?.name || 'General Hospital';

      const bloodType = document.getElementById('labTestBloodType')?.value;
      const batchId = document.getElementById('labTestBatchId')?.value;
      const hivResult = document.getElementById('labTestHiv')?.value;
      const hepBResult = document.getElementById('labTestHepB')?.value;
      const hepCResult = document.getElementById('labTestHepC')?.value;
      const syphilisResult = document.getElementById('labTestSyphilis')?.value;
      const notes = document.getElementById('labTestNotes')?.value || '';

      const isAllNegative = hivResult === 'Negative' && hepBResult === 'Negative' && hepCResult === 'Negative' && syphilisResult === 'Negative';
      const result = isAllNegative ? 'Cleared' : 'Rejected, Not Safe';

      const rejectionReason = isAllNegative ? null : `Reactive for: ${[
        hivResult === 'Positive' ? 'HIV 1/2' : null,
        hepBResult === 'Positive' ? 'Hepatitis B (HBsAg)' : null,
        hepCResult === 'Positive' ? 'Hepatitis C (HCV)' : null,
        syphilisResult === 'Positive' ? 'Syphilis (VDRL)' : null,
      ].filter(Boolean).join(', ')}. Notes: ${notes}`;

      await resolveLabTest(hospitalName, bloodType, batchId, result, rejectionReason, {
        labTechName: currentUser?.name || currentUser?.email || 'Lab Technician',
        screeningResults: { hiv: hivResult, hepB: hepBResult, hepC: hepCResult, syphilis: syphilisResult }
      });

      if (isAllNegative) {
        showToast('✅ Blood Unit Cleared! Added to available inventory stock.');
      } else {
        showToast('🚨 Unit REJECTED & Quarantined for Biohazard Disposal.', 'error');
      }

      if (typeof window.closeModal === 'function') window.closeModal('labTestModal');
      form.reset();
      loadLabOverview();
    } catch (err) {
      showToast(err.message || 'Failed to submit lab test result', 'error');
    }
  };
}

/**
 * bindGlobalLabActions - Attaches window action helpers for Lab UI
 */
function bindGlobalLabActions() {
  window.openLabTestModal = (bloodType, batchId, componentType, units) => {
    const bloodTypeEl = document.getElementById('labTestBloodType');
    const batchIdEl = document.getElementById('labTestBatchId');
    const labelEl = document.getElementById('labTestBatchLabel');

    if (bloodTypeEl) bloodTypeEl.value = bloodType || 'O+';
    if (batchIdEl) batchIdEl.value = batchId || '';
    if (labelEl) labelEl.textContent = `Testing Batch ID: ${batchId || 'N/A'} (${units || 1} unit(s) of ${bloodType || 'blood'})`;

    if (typeof window.openModal === 'function') window.openModal('labTestModal');
  };
}
