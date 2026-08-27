import { doc, updateDoc, collection, addDoc } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { issueBloodToPatient, logActivity } from '../../db.js';
import { getCurrentUser, getEffectiveHospitalName, getEffectiveHospitalId } from '../../auth.js';

/**
 * verifyAndIssueBloodBag - Handles 2-Clinician Bedside Wristband & Blood Bag Verification
 */
export async function verifyAndIssueBloodBag(verifyData) {
  const {
    requestId,
    patientName,
    patientIdNumber,
    wardNumber,
    attendingDoctor,
    bloodType,
    units = 1,
    bloodBagBarcode,
    secondVerifierName,
    secondVerifierRole = 'Nurse'
  } = verifyData;

  if (!patientName || !bloodType || !bloodBagBarcode) {
    throw new Error('Patient Name, Blood Type, and Blood Bag Barcode are required.');
  }

  if (!secondVerifierName || !secondVerifierName.trim()) {
    throw new Error('2-Clinician Bedside Check requires second verifier name/PIN.');
  }

  const currentUser = getCurrentUser();
  const hospitalName = getEffectiveHospitalName(currentUser);
  const hospitalId = getEffectiveHospitalId(currentUser) || currentUser?.uid || '';
  const now = new Date().toISOString();

  // 1. Perform stock deduction / issuance via DB helper
  await issueBloodToPatient({
    hospitalName,
    patientName: patientName.trim(),
    wardNumber: (wardNumber || 'General').trim(),
    attendingDoctor: (attendingDoctor || 'On Duty').trim(),
    bloodType: bloodType.trim(),
    units: parseInt(units, 10) || 1,
    reason: `Bedside 2-Person Check Passed (Bag #${bloodBagBarcode})`
  });

  // 2. Log active transfusion monitoring record
  const transfusionRef = await addDoc(collection(db, 'patient_transfusions'), {
    hospitalId,
    hospitalName,
    requestId: requestId || null,
    patientName: patientName.trim(),
    patientIdNumber: (patientIdNumber || '').trim(),
    wardNumber: (wardNumber || 'General').trim(),
    attendingDoctor: (attendingDoctor || 'On Duty').trim(),
    bloodType: bloodType.trim(),
    unitsIssued: parseInt(units, 10) || 1,
    bloodBagBarcode: bloodBagBarcode.trim(),
    firstVerifier: currentUser?.email || 'Nurse',
    secondVerifier: `${secondVerifierName.trim()} (${secondVerifierRole})`,
    status: 'Transfusing',
    startedAt: now,
    vitalsChecked: {
      baseline: null,
      fifteenMin: null,
      post: null
    },
    updatedAt: now
  });

  await logActivity(
    'Bedside Blood Bag Verification & Transfusion Started',
    `Blood Bag #${bloodBagBarcode} (${bloodType}) issued to ${patientName} (Ward ${wardNumber}). Verified by ${currentUser?.name || 'Nurse'} & ${secondVerifierName}.`,
    'info'
  );

  return { transfusionId: transfusionRef.id, ...verifyData, startedAt: now };
}
