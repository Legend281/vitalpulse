import { doc, getDoc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { logActivity } from '../../db.js';
import { getCurrentUser, getEffectiveHospitalId } from '../../auth.js';

/**
 * logTransfusionVitals - Logs vital sign checks (baseline, 15min, post) during active transfusion
 */
export async function logTransfusionVitals(transfusionId, stage = 'fifteenMin', vitalsData) {
  if (!transfusionId) throw new Error('Transfusion ID is required.');

  const { temperature, systolicBp, diastolicBp, pulseRate, respRate, notes = '' } = vitalsData;
  if (!temperature || !systolicBp || !pulseRate) {
    throw new Error('Temperature, Blood Pressure, and Pulse Rate are required.');
  }

  const now = new Date().toISOString();
  const currentUser = getCurrentUser();
  const docRef = doc(db, 'patient_transfusions', transfusionId);
  const snap = await getDoc(docRef);

  if (!snap.exists()) throw new Error('Transfusion record not found.');
  const data = snap.data();

  const existingVitals = data.vitalsChecked || {};
  existingVitals[stage] = {
    temperature: parseFloat(temperature),
    bp: `${systolicBp}/${diastolicBp}`,
    pulseRate: parseInt(pulseRate, 10),
    respRate: parseInt(respRate, 10) || 16,
    notes: notes.trim(),
    loggedBy: currentUser?.email || 'Nurse',
    loggedAt: now
  };

  const isCompleted = stage === 'post';
  await updateDoc(docRef, {
    vitalsChecked: existingVitals,
    status: isCompleted ? 'Completed' : 'Transfusing',
    updatedAt: now
  });

  await logActivity(
    `Transfusion Vital Check (${stage})`,
    `Vitals logged for ${data.patientName} (${stage} check: ${temperature}°C, BP ${systolicBp}/${diastolicBp}, Pulse ${pulseRate} bpm).`,
    'info'
  );

  return { success: true, stage, loggedAt: now };
}

/**
 * fetchActiveTransfusions - Fetches active transfusions for the nurse care station
 */
export async function fetchActiveTransfusions(hospitalName) {
  if (!hospitalName) return [];
  try {
    const currentUser = getCurrentUser();
    const effectiveHospitalId = getEffectiveHospitalId(currentUser);
    let q;
    if (effectiveHospitalId) {
      q = query(
        collection(db, 'patient_transfusions'),
        where('hospitalId', '==', effectiveHospitalId)
      );
    } else {
      q = query(
        collection(db, 'patient_transfusions'),
        where('hospitalName', '==', hospitalName)
      );
    }
    const snapshot = await getDocs(q);
    const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    return list.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  } catch (e) {
    console.warn('fetchActiveTransfusions failed:', e);
    return [];
  }
}
