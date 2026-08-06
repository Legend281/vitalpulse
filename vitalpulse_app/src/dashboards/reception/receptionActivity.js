import { collection, query, where, getDocs, orderBy, limit } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { fetchRecentLogs } from '../../db.js';
import { getCurrentUser } from '../../auth.js';

/**
 * renderReceptionActivityStream - Displays filtered front-desk reception events
 */
export async function renderReceptionActivityStream() {
  const container = document.getElementById('receptionActivityStream');
  if (!container) return;

  try {
    const currentUser = getCurrentUser();
    const hospitalName = currentUser?.name || 'General Hospital';

    // 1. Fetch system logs
    const allLogs = await fetchRecentLogs(30);

    // 2. Filter for reception-relevant actions
    const RECEPTION_ACTIONS = [
      'Front-Desk Donor Arrival',
      'Donor Called to Screening',
      'Reception Donor ETA Note',
      'Patient Ward Blood Requisition',
      'Donor Intake Verified',
      'Donor Checked In'
    ];

    const filteredLogs = allLogs.filter(log => {
      const action = log.action || log.title || '';
      return RECEPTION_ACTIONS.some(act => action.toLowerCase().includes(act.toLowerCase()));
    });

    if (filteredLogs.length === 0) {
      container.innerHTML = `
        <div class="text-center py-10 text-slate-400">
          <span class="material-symbols-outlined text-3xl text-slate-300">history</span>
          <p class="text-xs font-semibold mt-2">No front-desk activity recorded yet</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filteredLogs.map(log => {
      const timeStr = log.timestamp?.toDate ? log.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now';
      const actionTitle = log.action || 'Front-Desk Action';
      const details = log.details || log.description || '';

      return `
        <div class="flex items-start gap-3 bg-slate-50/80 p-3.5 rounded-2xl border border-slate-100">
          <div class="w-8 h-8 rounded-xl bg-sky-100 text-sky-700 flex items-center justify-center shrink-0 border border-sky-200 mt-0.5">
            <span class="material-symbols-outlined text-sm">how_to_reg</span>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between">
              <span class="font-extrabold text-xs text-slate-900">${actionTitle}</span>
              <span class="text-[10px] font-bold text-slate-400">${timeStr}</span>
            </div>
            <p class="text-xs text-slate-600 font-medium mt-0.5 leading-relaxed">${details}</p>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.warn('renderReceptionActivityStream failed:', e);
  }
}
