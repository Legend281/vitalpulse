import { collection, addDoc, getDocs, query, where, orderBy, doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { createEmergencyRequest, logActivity, fetchHospitalRequests } from '../../db.js';
import { getCurrentUser, getEffectiveHospitalName } from '../../auth.js';

/**
 * createNursePatientRequest - Handles Track A (Emergency Uncrossmatched) and Track B (Standard Crossmatched) patient requests
 */
export async function createNursePatientRequest(reqData) {
  const {
    patientName,
    patientIdNumber = '',
    wardNumber,
    attendingDoctor,
    bloodTypeNeeded,
    unitsNeeded,
    emergencyTrack = 'Track B', // Track A: Emergency Uncrossmatched Release, Track B: Standard Crossmatched
    clinicalDiagnosis = '',
    emergencyWaiverSigned = false
  } = reqData;

  if (!patientName || !wardNumber || !bloodTypeNeeded) {
    throw new Error('Patient Name, Ward/Room #, and Blood Type are required.');
  }

  const currentUser = getCurrentUser();
  const hospitalName = getEffectiveHospitalName(currentUser);
  const now = new Date().toISOString();
  const isTrackA = emergencyTrack === 'Track A';

  if (isTrackA && !emergencyWaiverSigned) {
    throw new Error('Track A Emergency Release requires physician emergency waiver check.');
  }

  // 1. Log clinical request doc
  const docRef = await addDoc(collection(db, 'requests'), {
    hospital: hospitalName,
    hospitalName,
    patientName: patientName.trim(),
    patientIdNumber: patientIdNumber.trim(),
    wardNumber: wardNumber.trim(),
    attendingDoctor: (attendingDoctor || 'On Duty Physician').trim(),
    bloodType: bloodTypeNeeded.trim(),
    unitsNeeded: parseInt(unitsNeeded, 10) || 1,
    emergencyTrack,
    isTrackA,
    clinicalDiagnosis: clinicalDiagnosis.trim(),
    emergencyWaiverSigned,
    status: isTrackA ? 'Emergency Dispatch' : 'Pending Crossmatch',
    urgency: isTrackA ? 'Emergency' : 'Routine',
    createdByNurse: currentUser?.email || 'Clinical Nurse',
    createdAt: now,
    updatedAt: now
  });

  // 2. If Track A emergency, also trigger system-wide emergency broadcast
  if (isTrackA) {
    await createEmergencyRequest({
      hospitalName,
      bloodType: bloodTypeNeeded,
      unitsNeeded: parseInt(unitsNeeded, 10) || 1,
      reason: `Emergency Uncrossmatched Release for ${patientName} (Ward ${wardNumber}) - ${clinicalDiagnosis || 'Maternal/Accident Hemorrhage'}`,
      urgency: 'Immediate'
    }).catch(err => console.warn('Track A Emergency broadcast trigger warning:', err));
  }

  await logActivity(
    isTrackA ? 'Track A Emergency Release Triggered' : 'Clinical Patient Blood Request',
    `Nurse logged ${emergencyTrack} request for ${patientName} (${bloodTypeNeeded}, ${unitsNeeded} unit(s), Ward ${wardNumber}).`,
    isTrackA ? 'error' : 'info'
  );

  return { id: docRef.id, ...reqData, createdAt: now };
}

/**
 * fetchNurseActiveRequests - Fetches active clinical patient requests for the nurse's hospital
 */
export async function fetchNurseActiveRequests(hospitalName) {
  if (!hospitalName) return [];
  try {
    const requests = await fetchHospitalRequests(hospitalName);
    return requests || [];
  } catch (e) {
    console.warn('fetchNurseActiveRequests query failed:', e);
    return [];
  }
}
