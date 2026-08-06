/**
 * reactivate-user.ts — ONE-OFF, MANUAL USE ONLY. Never deployed, never
 * called by the app. Local-script replacement for the (removed)
 * reactivateUser Cloud Function — see
 * vitalpulse_app/docs/SPARK_PLAN_MIGRATION.md §9. Lifts a suspension set by
 * suspend-user.ts; role/hospitalId are left untouched.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json \
 *     npm run reactivate-user -- --email=someone@example.com --yes
 *
 * Omit --yes to do a dry run.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function parseArgs(argv: string[]): { email?: string; confirm: boolean } {
  let email: string | undefined;
  let confirm = false;
  for (const arg of argv) {
    if (arg === '--yes') confirm = true;
    else if (arg.startsWith('--email=')) email = arg.slice('--email='.length).trim();
  }
  return { email, confirm };
}

async function main() {
  const { email, confirm } = parseArgs(process.argv.slice(2));

  if (!email) {
    console.error('Usage: npm run reactivate-user -- --email=you@example.com --yes');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a downloaded service account key.');
    process.exit(1);
  }

  initializeApp();
  const auth = getAuth();
  const db = getFirestore();

  const user = await auth.getUserByEmail(email).catch(() => null);
  if (!user) {
    console.error(`No account found for ${email}.`);
    process.exit(1);
  }

  const existingClaims = (user.customClaims ?? {}) as { role?: string; hospitalId?: string; suspended?: boolean };
  const newClaims: Record<string, unknown> = {
    role: existingClaims.role ?? null,
    hospitalId: existingClaims.hospitalId ?? null,
    // suspended intentionally omitted — reactivation clears it.
  };

  console.log(`Target: ${email} (uid: ${user.uid})`);
  console.log(`Current custom claims: ${JSON.stringify(existingClaims)}`);

  if (!confirm) {
    console.log('\nDry run only (no --yes flag) — nothing was changed.');
    console.log(`Would set claims to: ${JSON.stringify(newClaims)}`);
    return;
  }

  await auth.setCustomUserClaims(user.uid, newClaims);
  await auth.revokeRefreshTokens(user.uid);
  await db.collection('users').doc(user.uid).set(
    { isSuspended: false, isAvailable: true, statusChangedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await db.collection('auditLogs').add({
    actorUid: `reactivate-user-script:${process.env.USERNAME || process.env.USER || 'unknown-operator'}`,
    action: 'reactivateUser',
    targetUid: user.uid,
    details: { previousSuspended: existingClaims.suspended === true },
    timestamp: FieldValue.serverTimestamp(),
  });

  console.log(`\nDone. ${email} (${user.uid}) is no longer suspended.`);
  console.log('Their existing sessions were revoked — they must log out and back in to pick up the new claim.');
}

main().catch((err) => {
  console.error('reactivate-user failed:', err);
  process.exit(1);
});
