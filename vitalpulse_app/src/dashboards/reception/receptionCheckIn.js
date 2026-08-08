import { doc, getDoc, updateDoc, collection, addDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { logActivity, findRequestByCheckInToken, checkInDonor } from '../../db.js';
import { getCurrentUser, getEffectiveHospitalName } from '../../auth.js';

/**
 * verifyAndCheckInToken - Handles donor passcode (VP-XXXX) search and front-desk check-in.
 */
export async function verifyAndCheckInToken(tokenInput, hospitalName = '') {
  const code = (tokenInput || '').trim().toUpperCase();
  if (!code) {
    throw new Error('Please enter a valid donor check-in passcode (e.g. VP-9482)');
  }

  if (!hospitalName) {
    throw new Error('Your account is not linked to a hospital yet, so donors cannot be checked in here.');
  }

  // 1. Resolve the pass code across requests / public_requests / donation_requests,
  //    scoped to this hospital. This used to call findRequestByCheckInToken(code)
  //    with the collection argument omitted, so it threw on `collection(db,
  //    undefined)` — the front-desk check-in box never worked at all.
  const matched = await findRequestByCheckInToken(code, hospitalName);
  if (!matched) {
    throw new Error(`No active donor check-in record found for passcode "${code}" at your hospital. Check the code or register the donor as a walk-in.`);
  }

  const requestId = matched.id;
  const donorId = matched.matchedDonor || matched.donorId || null;
  const donorName = matched.donorName || 'Donor';

  // Re-scan of a code whose journey already moved past the front desk. We do
  // NOT re-write 'Checked In' — that would let the same donation be recorded
  // twice (duplicate inventory batch). Instead we pull the current stage up so
  // the desk can continue the SAME process from where it stopped: a drawn unit
  // goes to the Lab Testing Queue, a cleared one to Nurse issuance.
  const STAGES = [
    { statuses: ['Donation Complete', 'completed'], stage: 4, label: 'Blood Drawn · At Lab', view: 'lab', hint: 'Blood was already collected. Continue from the Lab Testing Queue — clear the unit so it becomes available stock.' },
    { statuses: ['Lab Cleared', 'Lab Rejected'], stage: 5, label: 'Lab Cleared · Ready to Issue', view: 'nurse-issued', hint: 'The unit was already cleared by the lab. Continue from the Nurse bedside view and issue it to the patient to finish the journey.' },
    { statuses: ['Issued', 'Resolved', 'Completed'], stage: 6, label: 'Journey Complete', view: null, hint: 'This donation has reached its final step (unit issued to a patient). There is nothing left to do — the pass code is spent by design.' },
  ];
  const stage = STAGES.find(s => s.statuses.includes(matched.status));
  if (stage) {
    return {
      success: false,
      already: true,
      stage: stage.stage,
      stageLabel: stage.label,
      nextView: stage.view,
      nextHint: stage.hint,
      requestId,
      donorId,
      donorName,
      code,
      bloodType: matched.bloodType || matched.type || 'Unknown',
      hospital: matched.hospital || matched.hospitalName || hospitalName
    };
  }

  // 2. Advance the journey. The second argument is the source collection the
  //    code was found in — previously a donorId was passed here, which
  //    checkInDonor silently ignored.
  await checkInDonor(requestId, matched.sourceCollection);

  await logActivity(
    'Front-Desk Donor Arrival',
    `Donor ${donorName} (Passcode: ${code}) checked in at reception at ${hospitalName || 'hospital desk'}. Sent to lobby waiting area.`,
    'info'
  );

  return {
    success: true,
    requestId,
    donorId,
    donorName,
    code,
    bloodType: matched.bloodType || 'Unknown',
    checkedInAt: new Date().toISOString()
  };
}

/**
 * callNextDonor - Notifies waiting room and updates donor status to "Calling to Screening Room"
 */
export async function callNextDonor(requestId, donorName, roomNumber = 'Screening Room 1') {
  if (!requestId) {
    throw new Error('Invalid donor request ID');
  }

  const now = new Date().toISOString();
  await updateDoc(doc(db, 'requests', requestId), {
    receptionStatus: 'Calling',
    calledToRoom: roomNumber,
    calledAt: now,
    updatedAt: now
  }).catch(() => {
    // Fallback for donation_requests collection
    return updateDoc(doc(db, 'donation_requests', requestId), {
      receptionStatus: 'Calling',
      calledToRoom: roomNumber,
      calledAt: now,
      updatedAt: now
    });
  });

  await logActivity(
    'Donor Called to Screening',
    `Receptionist called ${donorName} to ${roomNumber}.`,
    'info'
  );

  return { success: true, roomNumber, calledAt: now };
}

/**
 * saveDonorEtaNote - Logs a phone call note when a donor calls reception about arrival ETA
 */
export async function saveDonorEtaNote(requestId, donorName, noteText) {
  const cleanNote = (noteText || '').trim();
  if (!cleanNote) throw new Error('Please enter a note');

  const now = new Date().toISOString();
  const currentUser = getCurrentUser();

  await addDoc(collection(db, 'reception_notes'), {
    requestId: requestId || null,
    donorName: donorName || 'Donor',
    hospitalName: getEffectiveHospitalName(currentUser),
    note: cleanNote,
    createdBy: currentUser?.email || 'Receptionist',
    createdAt: now
  });

  await logActivity(
    'Reception Donor ETA Note',
    `Phone note for ${donorName}: "${cleanNote}"`,
    'info'
  );

  return { success: true, note: cleanNote, createdAt: now };
}
