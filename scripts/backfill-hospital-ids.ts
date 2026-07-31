/**
 * backfill-hospital-ids.ts — ONE-OFF, MANUAL USE ONLY. Never deployed, never
 * called by the app or by functions/.
 *
 * Phase 2 (Firestore rules) scopes hospital-owned documents (`requests`,
 * `inventory`, `issuance_log`) by a `hospitalId` field that must equal the
 * owning hospital account's own uid (users/{hospitalUid}). New writes stamp
 * this correctly (see vitalpulse_app/src/db.js), but documents written
 * BEFORE that change only carry a free-text `hospital` name string. Until
 * backfilled, those old documents are invisible to their owning hospital's
 * own staff under the new rules (system_admin can still see everything).
 *
 * This script matches each old document's `hospital` name to a `users` doc
 * with role=='hospital' and the same `name`, and stamps `hospitalId` with
 * that account's uid. Names that don't match exactly one hospital account
 * (zero matches, or more than one — e.g. two hospitals sharing a display
 * name) are reported and left untouched rather than guessed at.
 *
 * Prerequisites:
 *   1. Download a Firebase service account key for the vitalpulse project
 *      (Project Settings -> Service accounts -> Generate new private key).
 *      Store it OUTSIDE this repo. Never commit it, never paste it into chat.
 *
 * Usage (run from the scripts/ directory):
 *   npm install
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json \
 *     npm run backfill-hospital-ids -- --yes
 *
 * Omit --yes to do a dry run (prints what would change, changes nothing).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HOSPITAL_OWNED_COLLECTIONS = ['requests', 'inventory', 'issuance_log'] as const;

function parseArgs(argv: string[]): { confirm: boolean } {
  return { confirm: argv.includes('--yes') };
}

async function main() {
  const { confirm } = parseArgs(process.argv.slice(2));

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a downloaded service ' +
        'account key before running this script — see the header comment for how to get one.',
    );
    process.exit(1);
  }

  initializeApp();
  const db = getFirestore();

  const hospitalUsersSnap = await db.collection('users').where('role', '==', 'hospital').get();
  const nameToUids = new Map<string, string[]>();
  for (const doc of hospitalUsersSnap.docs) {
    const name = (doc.data().name as string | undefined)?.trim();
    if (!name) continue;
    const list = nameToUids.get(name) ?? [];
    list.push(doc.id);
    nameToUids.set(name, list);
  }
  console.log(`Found ${hospitalUsersSnap.size} hospital account(s), ${nameToUids.size} distinct name(s).`);

  let toUpdate = 0;
  let alreadySet = 0;
  let noMatch = 0;
  let ambiguous = 0;
  const writes: { ref: FirebaseFirestore.DocumentReference; hospitalId: string; collection: string; name: string }[] = [];

  for (const collection of HOSPITAL_OWNED_COLLECTIONS) {
    const snap = await db.collection(collection).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.hospitalId) {
        alreadySet++;
        continue;
      }
      const hospitalName = (data.hospital as string | undefined)?.trim();
      if (!hospitalName) {
        console.warn(`[${collection}/${doc.id}] has no 'hospital' name field — skipping (likely admin-created, e.g. system-wide broadcast).`);
        continue;
      }
      const matches = nameToUids.get(hospitalName) ?? [];
      if (matches.length === 0) {
        console.warn(`[${collection}/${doc.id}] hospital name "${hospitalName}" matches no hospital account — skipping.`);
        noMatch++;
        continue;
      }
      if (matches.length > 1) {
        console.warn(`[${collection}/${doc.id}] hospital name "${hospitalName}" matches ${matches.length} accounts (${matches.join(', ')}) — ambiguous, skipping. Resolve manually.`);
        ambiguous++;
        continue;
      }
      writes.push({ ref: doc.ref, hospitalId: matches[0], collection, name: hospitalName });
      toUpdate++;
    }
  }

  console.log(`\nSummary: ${toUpdate} to update, ${alreadySet} already have hospitalId, ${noMatch} unmatched, ${ambiguous} ambiguous.`);

  if (!confirm) {
    console.log('\nDry run only (no --yes flag) — nothing was changed.');
    for (const w of writes.slice(0, 20)) {
      console.log(`  Would set ${w.collection}/${w.ref.id}.hospitalId = ${w.hospitalId} (matched "${w.name}")`);
    }
    if (writes.length > 20) console.log(`  ...and ${writes.length - 20} more.`);
    return;
  }

  const BATCH_SIZE = 400;
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + BATCH_SIZE)) {
      batch.update(w.ref, { hospitalId: w.hospitalId });
    }
    await batch.commit();
    console.log(`Committed ${Math.min(i + BATCH_SIZE, writes.length)}/${writes.length}`);
  }

  console.log(`\nDone. Backfilled hospitalId on ${toUpdate} document(s).`);
  if (noMatch > 0 || ambiguous > 0) {
    console.log(`${noMatch + ambiguous} document(s) still need manual resolution (see warnings above).`);
  }
}

main().catch((err) => {
  console.error('backfill-hospital-ids failed:', err);
  process.exit(1);
});
