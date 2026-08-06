import { doc, getDoc, updateDoc, collection, addDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { logActivity, findRequestByCheckInToken, checkInDonor } from '../../db.js';
import { getCurrentUser } from '../../auth.js';

/**
 * verifyAndCheckInToken - Handles donor passcode (VP-XXXX) search and front-desk check-in.
 */
export async function verifyAndCheckInToken(tokenInput, hospitalName = '') {
  const code = (tokenInput || '').trim().toUpperCase();
  if (!code) {
    throw new Error('Please enter a valid donor check-in passcode (e.g. VP-9482)');
  }

  // 1. Search for matching donation request or donor check-in token
  const matched = await findRequestByCheckInToken(code);
  if (!matched) {
    throw new Error(`No active donor check-in record found for passcode "${code}". Check code or register as walk-in.`);
  }

  const requestId = matched.requestId || matched.id;
  const donorId = matched.donorId;
  const donorName = matched.donorName || matched.name || 'Donor';

  // 2. Perform check-in state update
  await checkInDonor(requestId, donorId);

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
    hospitalName: currentUser?.name || 'Hospital Reception',
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
