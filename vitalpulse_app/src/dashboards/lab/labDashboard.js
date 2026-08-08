import { collection, getDocs, query } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { getCurrentUser, getEffectiveHospitalName } from '../../auth.js';
import { resolveLabTest } from '../../db.js';
import { showToast } from '../../main.js';

let isLabInitialized = false;
let activeLabFilter = 'pending';
let cachedBatches = { pending: [], cleared: [], rejected: [] };

/**
 * initLabDashboard - Main lifecycle initialization for Lab Tech Dashboard
 */
export function initLabDashboard() {
  if (isLabInitialized) return;
  isLabInitialized = true;

  bindLabModalForm();
  bindGlobalLabActions();
  bindLabTabFilters();
}

/**
 * fetchAllLabBatches - Retrieves all quarantine, cleared, and rejected batches for a hospital
 */
export async function fetchAllLabBatches(hospitalName) {
  if (!hospitalName) return { pending: [], cleared: [], rejected: [] };
  try {
    const q = query(collection(db, 'inventory'));
    const snapshot = await getDocs(q);

    const pending = [];
    const cleared = [];
    const rejected = [];

    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data();
      const matchHospital = data.hospital === hospitalName || data.hospitalName === hospitalName;
      if (!matchHospital) return;

      const bloodType = data.bloodType;
      const batches = Array.isArray(data.batches) ? data.batches : [];

      batches.forEach(b => {
        const item = { ...b, bloodType, hospital: hospitalName };
        const status = b.testStatus || 'Cleared';

        if (status === 'Waiting for Lab Test') {
          pending.push(item);
        } else if (status === 'Cleared') {
          cleared.push(item);
        } else if (status === 'Rejected, Not Safe') {
          rejected.push(item);
        }
      });
    });

    pending.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
    cleared.sort((a, b) => new Date(b.resolvedAt || b.addedAt || 0) - new Date(a.resolvedAt || a.addedAt || 0));
    rejected.sort((a, b) => new Date(b.resolvedAt || b.addedAt || 0) - new Date(a.resolvedAt || a.addedAt || 0));

    return { pending, cleared, rejected };
  } catch (err) {
    console.warn('fetchAllLabBatches failed:', err);
    return { pending: [], cleared: [], rejected: [] };
  }
}

export const fetchPendingLabTests = async (hospitalName) => {
  const result = await fetchAllLabBatches(hospitalName);
  return result.pending;
};

/**
 * loadLabOverview / loadLabPipeline - Renders Lab Tech KPIs and Quarantine Screening Queue
 */
export async function loadLabOverview() {
  const currentUser = getCurrentUser();
  const hospitalName = getEffectiveHospitalName(currentUser);

  try {
    const batches = await fetchAllLabBatches(hospitalName);
    cachedBatches = batches;

    const pendingUnits = batches.pending.reduce((sum, b) => sum + (b.units || 1), 0);
    const clearedUnits = batches.cleared.reduce((sum, b) => sum + (b.units || 1), 0);
    const rejectedUnits = batches.rejected.reduce((sum, b) => sum + (b.units || 1), 0);
    const totalResolved = clearedUnits + rejectedUnits;
    const passRate = totalResolved > 0 ? Math.round((clearedUnits / totalResolved) * 100) + '%' : '100%';

    // Update KPI Tiles in Hero and #view-lab
    const pendingEls = document.querySelectorAll('#labPendingCount');
    const clearedEls = document.querySelectorAll('#labClearedCount');
    const rejectedEls = document.querySelectorAll('#labRejectedCount');
    const totalEl = document.getElementById('labTotalBatchesCount');
    const passRateEl = document.getElementById('labPassRate');

    pendingEls.forEach(el => { el.textContent = batches.pending.length; });
    clearedEls.forEach(el => { el.textContent = clearedUnits; });
    rejectedEls.forEach(el => { el.textContent = rejectedUnits; });

    if (totalEl) totalEl.textContent = batches.pending.length + batches.cleared.length + batches.rejected.length;
    if (passRateEl) passRateEl.textContent = passRate;

    // Render Queues
    renderPendingLabTestsQueue(batches.pending);
    renderLabPipelineGrid(batches);
  } catch (e) {
    console.warn('loadLabOverview failed:', e);
  }
}

export const loadLabPipeline = loadLabOverview;

/**
 * renderPendingLabTestsQueue - Renders scannable quarantine list inside #labPendingTestsList
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

  container.innerHTML = pendingBatches.map(b => renderLabCardHTML(b, 'pending')).join('');
}

/**
 * renderLabPipelineGrid - Renders tabbed view inside #labPipelineGrid
 */
function renderLabPipelineGrid(batches = cachedBatches) {
  const gridEl = document.getElementById('labPipelineGrid');
  if (!gridEl) return;

  const currentList = batches[activeLabFilter] || [];
  if (currentList.length === 0) {
    const emptyCopy = {
      pending: 'No blood units currently awaiting TTI lab testing.',
      cleared: 'No cleared blood batches logged yet.',
      rejected: 'No rejected/quarantined batches on record.'
    };
    gridEl.innerHTML = `<div class="col-span-full text-center text-slate-400 py-12 font-medium">${emptyCopy[activeLabFilter]}</div>`;
    return;
  }

  gridEl.innerHTML = currentList.map(b => renderLabCardHTML(b, activeLabFilter)).join('');
}

/**
 * Helper to render individual lab batch cards
 */
function renderLabCardHTML(b, filterType) {
  const batchId = b.id || 'N/A';
  const bloodType = b.bloodType || 'O+';
  const units = b.units || 1;
  const component = b.componentType || 'Whole Blood';
  const dateStr = b.addedAt ? new Date(b.addedAt).toLocaleDateString() : 'Recent';

  if (filterType === 'pending') {
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
              ${units} unit(s) · <span class="text-indigo-600 font-bold">${component}</span> · Collected: ${dateStr}
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
  } else if (filterType === 'cleared') {
    return `
      <div class="bg-white rounded-2xl border border-emerald-200/80 border-l-4 border-l-emerald-500 p-5 shadow-xs hover:shadow-md transition-all">
        <div class="flex items-start justify-between gap-2 mb-2">
          <span class="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200/60 text-emerald-700 flex items-center justify-center font-black text-sm shrink-0 shadow-2xs">${bloodType}</span>
          <span class="text-[9px] font-black uppercase px-2.5 py-0.5 rounded-full text-emerald-700 bg-emerald-50 border border-emerald-200">Cleared & Issuable</span>
        </div>
        <p class="text-base font-extrabold text-slate-900">${units} unit(s) · ${component}</p>
        <p class="text-xs text-slate-500 font-medium mt-1">Batch ${batchId.slice(-8)} · Released ${b.resolvedAt ? new Date(b.resolvedAt).toLocaleDateString() : dateStr}</p>
        <p class="text-[11px] text-emerald-600 font-bold mt-2 flex items-center gap-1">
          <span class="material-symbols-outlined text-xs">verified</span>
          Viral Diagnostics Non-Reactive
        </p>
      </div>
    `;
  } else {
    return `
      <div class="bg-white rounded-2xl border border-rose-200/80 border-l-4 border-l-rose-500 p-5 shadow-xs hover:shadow-md transition-all">
        <div class="flex items-start justify-between gap-2 mb-2">
          <span class="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200/60 text-rose-700 flex items-center justify-center font-black text-sm shrink-0 shadow-2xs">${bloodType}</span>
          <span class="text-[9px] font-black uppercase px-2.5 py-0.5 rounded-full text-rose-700 bg-rose-50 border border-rose-200">Rejected & Quarantined</span>
        </div>
        <p class="text-base font-extrabold text-slate-900">${units} unit(s) · ${component}</p>
        <p class="text-xs font-bold text-rose-600 mt-1">${b.rejectionReason || 'Failed TTI viral screening'}</p>
        <p class="text-xs text-slate-400 font-medium mt-1">Flagged ${b.resolvedAt ? new Date(b.resolvedAt).toLocaleDateString() : dateStr}</p>
      </div>
    `;
  }
}

/**
 * bindLabTabFilters - Binds Pending / Cleared / Rejections tabs inside #view-lab
 */
function bindLabTabFilters() {
  const tabsContainer = document.getElementById('labFilterTabs');
  if (!tabsContainer) return;

  tabsContainer.querySelectorAll('.lab-tab-btn').forEach(btn => {
    btn.onclick = () => {
      tabsContainer.querySelectorAll('.lab-tab-btn').forEach(b => {
        b.classList.remove('active', 'bg-white', 'text-slate-900', 'shadow-xs');
        b.classList.add('text-slate-600');
      });
      btn.classList.add('active', 'bg-white', 'text-slate-900', 'shadow-xs');
      btn.classList.remove('text-slate-600');

      activeLabFilter = btn.dataset.filter || 'pending';
      renderLabPipelineGrid(cachedBatches);
    };
  });

  const refreshBtn = document.getElementById('btnRefreshLabPipeline');
  if (refreshBtn) {
    refreshBtn.onclick = () => loadLabOverview();
  }
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
