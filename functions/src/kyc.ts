import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { auth, db } from './firebaseAdmin';
import { writeAudit } from './audit';
import { type CallerClaims } from './roles';
import { submitKycSchema, reviewDonorKycSchema, submitLivenessSelfieSchema, KYC_MIME_TYPES } from './schemas';

/**
 * Donor KYC onboarding — Auth & Onboarding workstream (donor UI/VitalPulse_Plan_Tracker.md
 * Streams A/B). `donors/{uid}` is a NEW, KYC-only collection approved 2026-08-01 (Stream
 * A4) — it holds ONLY kycStatus/kycDocType/kycDocRef/kycSubmittedAt(+kycRejectionReason,
 * see below); it does not replace or duplicate anything on users/{uid} (blood type,
 * points/tier, badges, notification prefs all stay exactly where they are today).
 *
 * DEVIATION FROM THE TRACKER, FLAGGED NOT SILENT: the tracker's B4 describes
 * `onDonorSignUp` as an "Auth onCreate trigger." Implemented instead as a callable the
 * client invokes right after `createUserWithEmailAndPassword` succeeds, for two concrete
 * reasons found while building this:
 *   1. `registerUser()` (vitalpulse_app/src/auth.js) creates the Auth user BEFORE writing
 *      role into Firestore, and that same signup path is shared by donor AND hospital
 *      registration. A real Auth onCreate trigger fires with no reliable way to know which
 *      role the client is about to register as — it can't safely default to 'donor'.
 *   2. v2's non-racy alternative (`beforeUserCreated`, a blocking function) requires the
 *      Firebase project to be upgraded to Identity Platform, which A3's audit flagged as
 *      unconfirmed/unknown-console-state — making the function's very ability to fire a
 *      silent unknown, not something worth building on for a zero-trust boundary.
 * A callable, explicitly invoked only from the donor branch of registerUser(), is
 * idempotent (guarded below), fully unit-testable with this codebase's existing
 * request-mock pattern, and doesn't depend on an unconfirmed project upgrade.
 *
 * Also: this function closes a real, pre-existing gap, not just a KYC nicety — confirmed
 * via firestore.rules.test.js's `noRole: {}` fixture ("the real state of every account
 * today"): nothing in this codebase currently grants the `donor` custom claim at signup.
 * Once Phase 2's deny-by-default rules are actually deployed, every newly self-registered
 * donor would be locked out of every hasRole()-gated read/write until a system_admin
 * manually ran grantRole — this function is what should have bootstrapped that claim
 * regardless of whether KYC existed.
 */
export async function bootstrapDonorAccountHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call onDonorSignUp.');
  }
  const uid = request.auth.uid;

  const targetUser = await auth.getUser(uid).catch(() => {
    throw new HttpsError('not-found', 'Caller does not exist in Firebase Auth.');
  });
  const existingClaims = (targetUser.customClaims ?? {}) as CallerClaims;

  // BUG FOUND AND FIXED 2026-08-07 (Security Lead report: a donor who reached the KYC
  // screen, then logged out and back in, got full unrestricted dashboard access instead of
  // being routed back into KYC): the OLD order here set the `role` claim FIRST, then created
  // donors/{uid} SECOND. If the claim write succeeded but the Firestore create() failed for
  // any reason (a transient error, or — very plausibly in this exact case — the local dev
  // Functions emulator not running, since firebase.js auto-points Functions calls at it on
  // localhost), the account was left in an unrecoverable half-bootstrapped state: `role:
  // 'donor'` claim set (so every role-gated rule treats them as a normal donor), but no
  // donors/{uid} doc at all. Retrying this same call would immediately hit the
  // `existingClaims.role` guard below and refuse to run again — so the doc could never be
  // created after that point. And a MISSING donors/{uid} doc is exactly what
  // firestore.rules' isKycEligible()/isDonorVerified() treat as "grandfathered, exempt from
  // KYC" (a deliberate design for accounts that predate this feature) — so a donor whose
  // bootstrap merely had a transient hiccup ended up PERMANENTLY treated as pre-verified,
  // bypassing identity verification entirely. Fail-open, not fail-closed — the opposite of
  // this project's stated rules.
  //
  // FIX: create the Firestore doc FIRST. The guard below now keys off the DOC's existence,
  // not the claim's — so if the doc create() step previously failed, a retry can still get
  // all the way through (claims can be safely re-set; they're idempotent). If claim-setting
  // then fails on this attempt, the donor is left with a real donors/{uid} doc but no role
  // claim — role-gated rules deny them everywhere, a visibly broken (fails CLOSED) state
  // that surfaces as permission errors rather than a silent, wide-open bypass.
  const donorRef = db.collection('donors').doc(uid);
  const existingDonorDoc = await donorRef.get();
  if (existingDonorDoc.exists) {
    throw new HttpsError('failed-precondition', 'A donors/{uid} record already exists for this account.');
  }
  // A hospital/admin account (already claimed a non-donor role by grantRole) can never
  // bootstrap into donor — but a donor claim from a PRIOR partial attempt at this same
  // handler must not block the retry that's the whole point of this fix.
  if (existingClaims.role && existingClaims.role !== 'donor') {
    throw new HttpsError(
      'failed-precondition',
      'This account already has a non-donor role assigned; onDonorSignUp is for first-time donor signup only.',
    );
  }

  // kycStatus starts 'not_submitted', not 'pending' — donor UI/KYC_fix.md (2026-08-07)
  // introduces this as a real state distinct from "submitted, awaiting review." The claim
  // still says 'pending' here deliberately: no OTHER rule in this file reads a 'not_submitted'
  // claim value, and B7's isKycEligible()/every existing consumer of the kycStatus claim only
  // ever distinguishes 'verified' from "anything else" — donors/{uid}'s Firestore field (not
  // the claim) is now KYC_fix.md's actual source of truth for the donor-facing state machine.
  await donorRef.create({
    kycStatus: 'not_submitted',
    kycDocType: null,
    kycIdImageBase64: null,
    kycIdBackImageBase64: null,
    kycSelfieImageBase64: null,
    kycSubmittedAt: null,
    kycRejectionReason: null,
    kycReviewedBy: null,
    kycReviewedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });

  await auth.setCustomUserClaims(uid, { role: 'donor', kycStatus: 'pending' });
  await auth.revokeRefreshTokens(uid);

  await writeAudit({
    actorUid: uid,
    action: 'onDonorSignUp',
    targetUid: uid,
    details: { kycStatus: 'not_submitted' },
  });

  return { success: true, kycStatus: 'not_submitted' };
}

export const onDonorSignUp = onCall({ cors: true }, bootstrapDonorAccountHandler);

const EXTENSION_BY_MIME_TYPE: Record<(typeof KYC_MIME_TYPES)[number], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

/**
 * submitKYC — uploads the donor's identity document server-side and records the
 * submission. C3.6: "never direct client Storage write" — the client sends base64 bytes
 * over the callable, not a Storage SDK write, so `kyc/{uid}/` never needs a client-facing
 * write rule (storage.rules locks it to Cloud-Function/admin access only, see B3).
 */
export async function submitKycHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call submitKYC.');
  }
  const uid = request.auth.uid;
  const callerClaims = (request.auth.token ?? {}) as CallerClaims;
  if (callerClaims.suspended) {
    throw new HttpsError('permission-denied', 'Caller account is suspended.');
  }
  if (callerClaims.role !== 'donor') {
    throw new HttpsError('permission-denied', 'Only donor accounts can submit KYC documents.');
  }

  const parsed = submitKycSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid submitKYC payload.', parsed.error.flatten());
  }
  const { docType, fileBase64, mimeType, fileBackBase64, mimeTypeBack } = parsed.data;

  const donorRef = db.collection('donors').doc(uid);
  const donorSnap = await donorRef.get();
  if (!donorSnap.exists) {
    throw new HttpsError('failed-precondition', 'Call onDonorSignUp before submitting KYC documents.');
  }
  const currentStatus = donorSnap.data()?.kycStatus;
  if (currentStatus === 'verified') {
    throw new HttpsError('failed-precondition', 'This account is already KYC-verified; no resubmission needed.');
  }

  // zod bounds the encoded string length as a cheap first gate; the decoded byte length is
  // the real 5MB limit (C3.5) and must be re-checked — a permissive string bound alone
  // would let a crafted/non-standard base64 payload smuggle more raw bytes through.
  const MAX_KYC_FILE_BYTES = 5 * 1024 * 1024;
  const decodeAndValidate = (b64: string, label: string): Buffer => {
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      throw new HttpsError('invalid-argument', `${label} is not valid base64.`);
    }
    if (buf.length === 0 || buf.length > MAX_KYC_FILE_BYTES) {
      throw new HttpsError('invalid-argument', `${label} must be between 1 byte and 5MB.`);
    }
    return buf;
  };

  const buffer = decodeAndValidate(fileBase64, 'fileBase64');
  const ext = EXTENSION_BY_MIME_TYPE[mimeType];
  const kycDocRef = `kyc/${uid}/${docType}_${Date.now()}.${ext}`;

  await getStorage().bucket().file(kycDocRef).save(buffer, {
    contentType: mimeType,
    // Never publicly readable — storage.rules (B3) additionally locks this path to
    // system_admin/Cloud-Function access only; this is defense in depth, not the boundary.
    resumable: false,
  });

  // National ID needs both faces on file — the schema already requires both fields together
  // for this docType, so fileBackBase64/mimeTypeBack are guaranteed present here whenever
  // docType === 'national_id'.
  let kycDocBackRef: string | null = null;
  if (docType === 'national_id' && fileBackBase64 && mimeTypeBack) {
    const backBuffer = decodeAndValidate(fileBackBase64, 'fileBackBase64');
    const backExt = EXTENSION_BY_MIME_TYPE[mimeTypeBack];
    kycDocBackRef = `kyc/${uid}/${docType}_back_${Date.now()}.${backExt}`;
    await getStorage().bucket().file(kycDocBackRef).save(backBuffer, {
      contentType: mimeTypeBack,
      resumable: false,
    });
  }

  await donorRef.update({
    kycStatus: 'pending',
    kycDocType: docType,
    kycDocRef,
    kycDocBackRef,
    kycSubmittedAt: FieldValue.serverTimestamp(),
    kycRejectionReason: null,
  });

  // If the claim had drifted to 'rejected' from a prior review, a resubmission puts the
  // donor back in the review queue — mirror that on the claim too so client/rules gating
  // (B7) reflects "awaiting review" rather than a stale "rejected".
  if (callerClaims.kycStatus !== 'pending') {
    await auth.setCustomUserClaims(uid, { role: 'donor', kycStatus: 'pending' });
    await auth.revokeRefreshTokens(uid);
  }

  // Lightweight admin review worklist — B5's "notifies adminQueue/kyc_{uid}".
  await db.collection('adminQueue').doc(`kyc_${uid}`).set({
    type: 'kyc_review',
    donorUid: uid,
    docType,
    kycDocRef,
    kycDocBackRef,
    status: 'pending',
    submittedAt: FieldValue.serverTimestamp(),
  });

  await writeAudit({
    actorUid: uid,
    action: 'submitKYC',
    targetUid: uid,
    details: { docType, mimeType, hasBack: Boolean(kycDocBackRef) },
  });

  return { success: true, kycDocRef, kycDocBackRef };
}

export const submitKYC = onCall({ cors: true }, submitKycHandler);

/**
 * submitLivenessSelfie — a second, separate piece of KYC evidence: a live camera capture of
 * the donor's face, distinct from the identity document uploaded via submitKYC. Requested
 * directly by the Security Lead (2026-08-02): admin approval should be based on evidence
 * that was actually captured live, not a gallery photo — so the client only ever reaches
 * this callable via getUserMedia() + <canvas>, never a file picker (enforced client-side in
 * donor-dashboard.js; mimeType is pinned to image/jpeg here as a second, server-side check
 * that a PDF/PNG identity-document upload can't be repurposed as the liveness step).
 *
 * Mirrors submitKycHandler's shape (same auth/role/suspension checks, same Storage-write-via-
 * Admin-SDK-only pattern, same adminQueue worklist doc) rather than being folded into
 * submitKYC itself — the identity document and the liveness selfie are captured in two
 * distinct UI steps and can be retaken/resubmitted independently.
 */
export async function submitLivenessSelfieHandler(request: CallableRequest) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call submitLivenessSelfie.');
  }
  const uid = request.auth.uid;
  const callerClaims = (request.auth.token ?? {}) as CallerClaims;
  if (callerClaims.suspended) {
    throw new HttpsError('permission-denied', 'Caller account is suspended.');
  }
  if (callerClaims.role !== 'donor') {
    throw new HttpsError('permission-denied', 'Only donor accounts can submit a liveness selfie.');
  }

  const parsed = submitLivenessSelfieSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid submitLivenessSelfie payload.', parsed.error.flatten());
  }
  const { fileBase64, mimeType } = parsed.data;

  const donorRef = db.collection('donors').doc(uid);
  const donorSnap = await donorRef.get();
  if (!donorSnap.exists) {
    throw new HttpsError('failed-precondition', 'Call onDonorSignUp before submitting a liveness selfie.');
  }
  const currentStatus = donorSnap.data()?.kycStatus;
  if (currentStatus === 'verified') {
    throw new HttpsError('failed-precondition', 'This account is already KYC-verified; no resubmission needed.');
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(fileBase64, 'base64');
  } catch {
    throw new HttpsError('invalid-argument', 'fileBase64 is not valid base64.');
  }
  const MAX_SELFIE_FILE_BYTES = 5 * 1024 * 1024;
  if (buffer.length === 0 || buffer.length > MAX_SELFIE_FILE_BYTES) {
    throw new HttpsError('invalid-argument', 'Selfie must be between 1 byte and 5MB.');
  }

  const livenessSelfieRef = `kyc/${uid}/liveness_${Date.now()}.jpg`;

  await getStorage().bucket().file(livenessSelfieRef).save(buffer, {
    contentType: mimeType,
    // Never publicly readable — storage.rules already locks the whole kyc/{uid}/ prefix to
    // system_admin/Cloud-Function access only; this new file just reuses that same path.
    resumable: false,
  });

  await donorRef.update({
    livenessSelfieRef,
    livenessSubmittedAt: FieldValue.serverTimestamp(),
  });

  // Keep the admin worklist doc in sync so the review queue can show "both pieces of
  // evidence submitted" without a second per-row Firestore read.
  await db.collection('adminQueue').doc(`kyc_${uid}`).set(
    { livenessSelfieRef, livenessSubmittedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  await writeAudit({
    actorUid: uid,
    action: 'submitLivenessSelfie',
    targetUid: uid,
    details: { mimeType },
  });

  return { success: true, livenessSelfieRef };
}

export const submitLivenessSelfie = onCall({ cors: true }, submitLivenessSelfieHandler);

/**
 * verifyDonor / rejectDonorKyc — system_admin-only review decision. One shared handler
 * exporting two names, mirroring suspendUser/reactivateUser's pattern in this codebase.
 *
 * ADDITION BEYOND B6, FLAGGED: the tracker's Stream B only lists `verifyDonor`, but
 * Stream D7 ("Rejected state... Resubmit Documents button") has no way to ever reach a
 * rejected state without a symmetric reject action, and only a Cloud Function may set
 * kycStatus (Policy 2 §2 — zero trust on the client). Building the reject counterpart now,
 * on the same handler, rather than leaving D7 permanently unreachable.
 */
export async function reviewDonorKycHandler(request: CallableRequest, decision: 'verified' | 'rejected') {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to review donor KYC.');
  }
  const callerClaims = (request.auth.token ?? {}) as CallerClaims;
  if (callerClaims.suspended) {
    throw new HttpsError('permission-denied', 'Caller account is suspended.');
  }
  if (callerClaims.role !== 'system_admin') {
    throw new HttpsError('permission-denied', 'Only system_admin may review donor KYC submissions.');
  }

  const parsed = reviewDonorKycSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'Invalid payload.', parsed.error.flatten());
  }
  const { targetUid, reason } = parsed.data;

  const donorRef = db.collection('donors').doc(targetUid);
  const donorSnap = await donorRef.get();
  if (!donorSnap.exists) {
    throw new HttpsError('not-found', 'No donors/{uid} record exists for this account.');
  }
  if (donorSnap.data()?.kycStatus === decision) {
    throw new HttpsError('failed-precondition', `Donor KYC is already ${decision}.`);
  }

  const targetUser = await auth.getUser(targetUid).catch(() => {
    throw new HttpsError('not-found', 'Target user does not exist in Firebase Auth.');
  });
  const existingClaims = (targetUser.customClaims ?? {}) as CallerClaims;
  if (existingClaims.role !== 'donor') {
    throw new HttpsError('failed-precondition', 'Target account is not a donor.');
  }

  // A rejection needs no evidence check (an admin can reject an incomplete or suspicious
  // submission at any point), but 'verified' must not be reachable without both pieces of
  // evidence actually on file — server-side, not just a UI flow that happens to collect
  // them in order. Requested directly by the Security Lead (2026-08-02) alongside the new
  // liveness step: approval must be based on evidence that was actually submitted.
  if (decision === 'verified') {
    const donorData = donorSnap.data();
    if (!donorData?.kycDocRef) {
      throw new HttpsError('failed-precondition', 'Cannot verify: no identity document has been submitted for this donor.');
    }
    if (!donorData?.livenessSelfieRef) {
      throw new HttpsError('failed-precondition', 'Cannot verify: no liveness selfie has been submitted for this donor.');
    }
  }

  await auth.setCustomUserClaims(targetUid, {
    role: 'donor',
    hospitalId: existingClaims.hospitalId,
    suspended: existingClaims.suspended === true,
    kycStatus: decision,
  });
  await auth.revokeRefreshTokens(targetUid);

  await donorRef.update({
    kycStatus: decision,
    kycRejectionReason: decision === 'rejected' ? (reason ?? null) : null,
  });

  await db.collection('adminQueue').doc(`kyc_${targetUid}`).set(
    { status: decision, reviewedAt: FieldValue.serverTimestamp(), reviewedBy: request.auth.uid },
    { merge: true },
  );

  // B6: "triggers welcome notification" on verification; a rejection gets the equivalent
  // "here's why, please resubmit" notice so D7's banner has real content to show.
  await db.collection('donor_notifications').add({
    donorId: targetUid,
    title: decision === 'verified' ? 'Your account is verified!' : 'Verification unsuccessful',
    message:
      decision === 'verified'
        ? 'Your identity has been verified. You now have full access to VitalPulse.'
        : `Your verification was unsuccessful${reason ? `: ${reason}` : ''}. Please resubmit your documents.`,
    type: decision === 'verified' ? 'success' : 'warning',
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  await writeAudit({
    actorUid: request.auth.uid,
    action: decision === 'verified' ? 'verifyDonor' : 'rejectDonorKyc',
    targetUid,
    details: { decision, reason: reason ?? null },
  });

  return { success: true, kycStatus: decision };
}

export const verifyDonor = onCall({ cors: true }, (request: CallableRequest) => reviewDonorKycHandler(request, 'verified'));
export const rejectDonorKyc = onCall({ cors: true }, (request: CallableRequest) => reviewDonorKycHandler(request, 'rejected'));
