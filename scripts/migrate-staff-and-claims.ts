/**
 * migrate-staff-and-claims.ts — ONE-OFF, MANUAL USE ONLY. Never deployed, never
 * called by the app or by functions/.
 *
 * This closes the two gaps that between them keep steps 4-6 of the donation
 * journey (Blood Drawn -> Lab Cleared -> Life Saved) dead in production, and
 * finishes the 2026-08-08 staff-credential security remediation.
 *
 * WHAT IT DOES
 *
 * 1. CLAIMS BACKFILL (the reason inventory/lab/issuance return permission-denied)
 *    Every privileged Cloud Function gates on custom claims:
 *      requireCaller() -> hasAnyRole(caller, [...])  needs `role`/`roles`
 *      resolveTargetHospital()                       needs `hospitalId`
 *    Claims are only ever set by grantRole / createStaffAccount. grantRole has
 *    never been run against this project and nothing in the app calls it, so NO
 *    live account carries either claim — meaning addInventoryStock,
 *    resolveLabTest and issueBloodToPatient fail for everyone, even once the
 *    functions are deployed and CORS is fixed. This grants:
 *      users.role == 'hospital' -> role/roles 'hospital_admin', hospitalId = own uid
 *      hospitals/{hid}/staff/*  -> that staff member's roles, hospitalId = hid
 *    Donors are left alone: rolesList() in firestore.rules already defaults a
 *    claimless account to ['donor'], so they are unaffected either way, and
 *    writing claims for every donor would be a large, pointless token churn.
 *
 * 2. STAFF RECORD MIGRATION (the security half)
 *    - stamps `hospitalName` on every staff doc and staff users doc, so
 *      hospital-scoped queries by a sub-account stop returning the empty set
 *    - populates `staff_index/{email}` (routing only, no credential material)
 *    - DELETES the `staff_accounts` collection, which was world-readable and
 *      contained every staff member's PIN hash
 *
 * Existing PIN hashes are deliberately NOT rewritten here — they are legacy
 * unsalted SHA-256 and staffPin.ts's verifyPin() accepts them once and upgrades
 * them to salted scrypt on that staff member's next successful login. Rewriting
 * them here is impossible anyway: the script cannot know the plaintext PIN.
 *
 * IMPORTANT — after running this, tell every staff member to log in once so
 * their PIN is re-hashed with scrypt. Until they do, their stored hash is still
 * the weak legacy form (though no longer publicly readable).
 *
 * Prerequisites:
 *   1. Download a Firebase service account key (Project Settings -> Service
 *      accounts -> Generate new private key). Store it OUTSIDE this repo.
 *
 * Usage (run from the scripts/ directory):
 *   npm install
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json \
 *     npm run migrate-staff-and-claims -- --yes
 *
 * Omit --yes for a dry run (prints every change, writes nothing).
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const VALID_STAFF_ROLES = ['reception', 'nurse', 'hospital_staff', 'lab_tech', 'hospital_admin'];

interface PlannedClaim {
  uid: string;
  label: string;
  claims: Record<string, unknown>;
}

function parseArgs(argv: string[]): { confirm: boolean } {
  return { confirm: argv.includes('--yes') };
}

async function main() {
  const { confirm } = parseArgs(process.argv.slice(2));

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a downloaded service ' +
        'account key before running this script — see the header comment.',
    );
    process.exit(1);
  }

  initializeApp();
  const db = getFirestore();
  const auth = getAuth();

  const plannedClaims: PlannedClaim[] = [];
  const docWrites: { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>; label: string }[] = [];
  const deletes: { ref: FirebaseFirestore.DocumentReference; label: string }[] = [];

  // ---------- 1. Hospital accounts ----------
  const hospitalsSnap = await db.collection('users').where('role', '==', 'hospital').get();
  const hospitalNameById = new Map<string, string>();
  let hospitalsAlreadyClaimed = 0;

  for (const doc of hospitalsSnap.docs) {
    const name = (doc.data().name as string | undefined)?.trim() || null;
    if (name) hospitalNameById.set(doc.id, name);

    let existing: Record<string, unknown>;
    try {
      existing = ((await auth.getUser(doc.id)).customClaims ?? {}) as Record<string, unknown>;
    } catch {
      console.warn(`[hospital ${doc.id}] has a users doc but no Auth user — skipping claims.`);
      continue;
    }

    const hasRole = Array.isArray(existing.roles) ? (existing.roles as string[]).length > 0 : !!existing.role;
    if (hasRole && existing.hospitalId === doc.id) {
      hospitalsAlreadyClaimed++;
      continue;
    }

    plannedClaims.push({
      uid: doc.id,
      label: `hospital "${name ?? doc.id}"`,
      // Preserve anything already there (e.g. a `suspended` kill-switch) rather
      // than clobbering it — setCustomUserClaims replaces the whole object.
      claims: { ...existing, roles: ['hospital_admin'], role: 'hospital_admin', hospitalId: doc.id },
    });
  }

  // ---------- 2. Staff sub-accounts ----------
  const staffSnap = await db.collectionGroup('staff').get();
  let staffAlreadyClaimed = 0;
  let staffSkipped = 0;

  for (const doc of staffSnap.docs) {
    const data = doc.data();
    // hospitals/{hospitalId}/staff/{staffUid}
    const hospitalId = (data.hospitalId as string | undefined) || doc.ref.parent.parent?.id;
    if (!hospitalId) {
      console.warn(`[staff ${doc.id}] cannot determine hospitalId — skipping.`);
      staffSkipped++;
      continue;
    }

    const roles = (Array.isArray(data.roles) ? data.roles : [data.role])
      .filter((r: unknown): r is string => typeof r === 'string' && VALID_STAFF_ROLES.includes(r));
    if (roles.length === 0) {
      console.warn(`[staff ${doc.id}] has no valid roles (${JSON.stringify(data.roles ?? data.role)}) — skipping.`);
      staffSkipped++;
      continue;
    }

    const email = (data.email as string | undefined)?.trim().toLowerCase();
    const hospitalName = hospitalNameById.get(hospitalId) ?? null;

    // Resolve the real Auth uid. Records created by the old client-side fallback
    // have a synthetic `staff_xxxx` uid that no Auth user matches.
    let staffUid = (data.uid as string | undefined) || doc.id;
    let authOk = true;
    try {
      await auth.getUser(staffUid);
    } catch {
      authOk = false;
      if (email) {
        try {
          staffUid = (await auth.getUserByEmail(email)).uid;
          authOk = true;
        } catch {
          console.warn(`[staff ${doc.id}] (${email ?? 'no email'}) has no Auth user — will be created on first login; claims deferred.`);
        }
      }
    }

    const staffDocUpdate: Record<string, unknown> = {};
    if (hospitalName && data.hospitalName !== hospitalName) staffDocUpdate.hospitalName = hospitalName;
    if (data.hospitalId !== hospitalId) staffDocUpdate.hospitalId = hospitalId;
    if (staffUid !== data.uid) staffDocUpdate.uid = staffUid;
    if (Object.keys(staffDocUpdate).length > 0) {
      docWrites.push({ ref: doc.ref, data: staffDocUpdate, label: `staff doc ${hospitalId}/${doc.id}` });
    }

    if (email) {
      docWrites.push({
        ref: db.collection('staff_index').doc(email),
        data: { email, hospitalId, staffUid, updatedAt: new Date().toISOString() },
        label: `staff_index/${email}`,
      });
    }

    if (!authOk) {
      staffSkipped++;
      continue;
    }

    docWrites.push({
      ref: db.collection('users').doc(staffUid),
      data: {
        uid: staffUid,
        email: email ?? null,
        name: data.name ?? null,
        roles,
        role: roles[0],
        hospitalId,
        hospitalName,
        userType: 'hospital_staff',
        isStaffAccount: true,
        active: data.active !== false,
      },
      label: `users/${staffUid} (staff ${data.name ?? email})`,
    });

    let existing: Record<string, unknown> = {};
    try {
      existing = ((await auth.getUser(staffUid)).customClaims ?? {}) as Record<string, unknown>;
    } catch { /* handled above */ }

    const claimsMatch =
      Array.isArray(existing.roles) &&
      (existing.roles as string[]).join(',') === roles.join(',') &&
      existing.hospitalId === hospitalId;
    if (claimsMatch) {
      staffAlreadyClaimed++;
      continue;
    }

    plannedClaims.push({
      uid: staffUid,
      label: `staff "${data.name ?? email ?? staffUid}" @ ${hospitalName ?? hospitalId}`,
      claims: { ...existing, roles, role: roles[0], hospitalId, staffUid },
    });
  }

  // ---------- 3. Purge the leaked staff_accounts collection ----------
  const legacySnap = await db.collection('staff_accounts').get();
  for (const doc of legacySnap.docs) {
    deletes.push({ ref: doc.ref, label: `staff_accounts/${doc.id}` });
  }

  console.log('\n================ MIGRATION PLAN ================');
  console.log(`Hospital accounts:      ${hospitalsSnap.size} found, ${hospitalsAlreadyClaimed} already claimed`);
  console.log(`Staff accounts:         ${staffSnap.size} found, ${staffAlreadyClaimed} already claimed, ${staffSkipped} skipped`);
  console.log(`Custom claims to set:   ${plannedClaims.length}`);
  console.log(`Firestore docs to write:${docWrites.length}`);
  console.log(`staff_accounts to purge:${deletes.length}  <-- these leaked PIN hashes publicly`);
  console.log('===============================================\n');

  if (!confirm) {
    for (const c of plannedClaims.slice(0, 30)) {
      console.log(`  Would set claims on ${c.uid} — ${c.label}: ${JSON.stringify(c.claims)}`);
    }
    if (plannedClaims.length > 30) console.log(`  ...and ${plannedClaims.length - 30} more claim writes.`);
    for (const w of docWrites.slice(0, 20)) console.log(`  Would write ${w.label}`);
    if (docWrites.length > 20) console.log(`  ...and ${docWrites.length - 20} more doc writes.`);
    for (const d of deletes.slice(0, 20)) console.log(`  Would DELETE ${d.label}`);
    if (deletes.length > 20) console.log(`  ...and ${deletes.length - 20} more deletes.`);
    console.log('\nDry run only (no --yes flag) — nothing was changed.');
    return;
  }

  // Claims first: a doc write without matching claims still leaves the account
  // denied, whereas claims without the doc write at least restores access.
  let claimsDone = 0;
  for (const c of plannedClaims) {
    try {
      await auth.setCustomUserClaims(c.uid, c.claims);
      // Force the next token refresh to pick the new claims up rather than
      // waiting out the current ID token's ~1h natural expiry.
      await auth.revokeRefreshTokens(c.uid);
      claimsDone++;
    } catch (err) {
      console.error(`Failed to set claims on ${c.uid} (${c.label}):`, err);
    }
  }
  console.log(`Set custom claims on ${claimsDone}/${plannedClaims.length} account(s).`);

  const BATCH_SIZE = 400;
  for (let i = 0; i < docWrites.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const w of docWrites.slice(i, i + BATCH_SIZE)) batch.set(w.ref, w.data, { merge: true });
    await batch.commit();
    console.log(`Doc writes committed ${Math.min(i + BATCH_SIZE, docWrites.length)}/${docWrites.length}`);
  }

  for (let i = 0; i < deletes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const d of deletes.slice(i, i + BATCH_SIZE)) batch.delete(d.ref);
    await batch.commit();
    console.log(`Deletes committed ${Math.min(i + BATCH_SIZE, deletes.length)}/${deletes.length}`);
  }

  console.log('\nDone.');
  console.log('NEXT: every signed-in hospital/staff user must sign out and back in for the');
  console.log('new claims to appear in their ID token (refresh tokens were revoked above).');
  console.log('Staff PIN hashes upgrade from legacy SHA-256 to scrypt on first successful login.');
}

main().catch((err) => {
  console.error('migrate-staff-and-claims failed:', err);
  process.exit(1);
});
