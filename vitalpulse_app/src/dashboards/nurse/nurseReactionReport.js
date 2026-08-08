import { doc, updateDoc, collection, addDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { submitHemovigilanceReport, logActivity } from '../../db.js';
import { getCurrentUser, getEffectiveHospitalName } from '../../auth.js';

/**
 * stopTransfusionAndReportReaction - Stop Transfusion & Emergency Reaction Protocol
 */
export async function stopTransfusionAndReportReaction(reactionData) {
  const {
    transfusionId,
    patientName,
    wardNumber,
    bloodType,
    bloodBagBarcode = '',
    reactionType = 'Febrile Non-Hemolytic', // Febrile, Allergic, Acute Hemolytic, Anaphylactic
    symptoms = '',
    actionTaken = 'Transfusion stopped immediately, IV saline maintained',
    attendingPhysicianNotified = true
  } = reactionData;

  if (!patientName || !reactionType) {
    throw new Error('Patient Name and Reaction Type are required.');
  }

  const currentUser = getCurrentUser();
  const hospitalName = getEffectiveHospitalName(currentUser);
  const now = new Date().toISOString();

  // 1. If transfusionId provided, update transfusion record status
  if (transfusionId) {
    const docRef = doc(db, 'patient_transfusions', transfusionId);
    await updateDoc(docRef, {
      status: 'Stopped - Reaction Reported',
      reactionType,
      stoppedAt: now,
      updatedAt: now
    }).catch(e => console.warn('Update transfusion record warning:', e));
  }

  // 2. Log Hemovigilance Report for Lab & Medical Director investigation
  await submitHemovigilanceReport({
    hospitalName,
    patientName: patientName.trim(),
    wardNumber: (wardNumber || 'General').trim(),
    bloodType: (bloodType || 'Unknown').trim(),
    bloodBagBarcode: bloodBagBarcode.trim(),
    reactionType,
    severity: reactionType.includes('Hemolytic') || reactionType.includes('Anaphylactic') ? 'Severe' : 'Moderate',
    symptoms: symptoms.trim(),
    actionTaken: actionTaken.trim(),
    reportedBy: currentUser?.email || 'Clinical Nurse'
  });

  await logActivity(
    '🚨 Emergency Stop Transfusion - Reaction Reported',
    `Transfusion stopped for ${patientName} (${reactionType}). Hemovigilance alert dispatched for lab investigation.`,
    'error'
  );

  return { success: true, reactionType, reportedAt: now };
}

/**
 * fetchNurseReactionLogs - Fetches adverse reaction logs for nurse care station
 */
export async function fetchNurseReactionLogs(hospitalName) {
  if (!hospitalName) return [];
  try {
    const q = query(
      collection(db, 'hemovigilance_reports'),
      where('hospitalName', '==', hospitalName)
    );
    const snapshot = await getDocs(q);
    const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    return list.sort((a, b) => new Date(b.createdAt || b.reportedAt || 0) - new Date(a.createdAt || a.reportedAt || 0));
  } catch (e) {
    console.warn('fetchNurseReactionLogs failed:', e);
    return [];
  }
}
