import { collection, addDoc, getDocs, query, where, orderBy, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { fetchInventory, logActivity } from '../../db.js';
import { getCurrentUser, getEffectiveHospitalName } from '../../auth.js';

/**
 * fetchReceptionStockSummary - Read-only query for front-desk staff to answer patient family questions.
 * Does NOT allow stock editing or issuance.
 */
export async function fetchReceptionStockSummary(hospitalName) {
  if (!hospitalName) return {};
  const inventory = await fetchInventory(hospitalName);
  
  const summary = {};
  const allTypes = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

  allTypes.forEach(type => {
    const item = inventory[type] || {};
    summary[type] = {
      bloodType: type,
      unitsAvailable: item.unitsAvailable || 0,
      unitsPendingTest: item.unitsPendingTest || 0,
      expiringSoon: item.expiringSoon || 0,
      isLowStock: (item.unitsAvailable || 0) <= (item.minimumThreshold || 3),
      status: (item.unitsAvailable || 0) === 0 ? 'Out of Stock' : (item.unitsAvailable || 0) <= 3 ? 'Low Stock' : 'Available'
    };
  });

  return summary;
}

/**
 * savePatientRequisitionHold - Logs a front-desk patient ward blood requisition hold request.
 */
export async function savePatientRequisitionHold(reqData) {
  const {
    patientName,
    wardNumber,
    attendingDoctor,
    bloodTypeNeeded,
    unitsNeeded,
    requisitionSlipNumber = '',
    notes = ''
  } = reqData;

  if (!patientName || !wardNumber || !bloodTypeNeeded) {
    throw new Error('Patient Name, Ward Number, and Blood Type are required for requisition hold.');
  }

  const currentUser = getCurrentUser();
  const hospitalName = getEffectiveHospitalName(currentUser);
  const now = new Date().toISOString();

  const docRef = await addDoc(collection(db, 'patient_requisitions'), {
    hospitalName,
    patientName: patientName.trim(),
    wardNumber: wardNumber.trim(),
    attendingDoctor: (attendingDoctor || 'On Duty').trim(),
    bloodTypeNeeded: bloodTypeNeeded.trim(),
    unitsNeeded: parseInt(unitsNeeded, 10) || 1,
    requisitionSlipNumber: requisitionSlipNumber.trim(),
    notes: notes.trim(),
    status: 'Pending Crossmatch',
    loggedBy: currentUser?.email || 'Receptionist',
    createdAt: now,
    updatedAt: now
  });

  await logActivity(
    'Patient Ward Blood Requisition',
    `Requisition #${requisitionSlipNumber || docRef.id.slice(0, 6)} logged at reception for ${patientName} (Ward ${wardNumber}, ${bloodTypeNeeded}, ${unitsNeeded} unit(s)).`,
    'info'
  );

  return { id: docRef.id, ...reqData, createdAt: now };
}

/**
 * fetchPatientRequisitions - Fetches active front-desk patient requisitions
 */
export async function fetchPatientRequisitions(hospitalName) {
  if (!hospitalName) return [];
  try {
    const q = query(
      collection(db, 'patient_requisitions'),
      where('hospitalName', '==', hospitalName)
    );
    const snapshot = await getDocs(q);
    const reqs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    return reqs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  } catch (e) {
    console.warn('fetchPatientRequisitions query failed:', e);
    return [];
  }
}

/**
 * deletePatientRequisition - Removes or fulfills a front-desk patient requisition
 */
export async function deletePatientRequisition(reqId) {
  if (!reqId) return;
  await deleteDoc(doc(db, 'patient_requisitions', reqId));
}
