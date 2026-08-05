/**
 * revoke-role.ts — ONE-OFF, MANUAL USE ONLY. Never deployed, never called by
 * the app. Local-script replacement for the (removed) revokeRole Cloud
 * Function — see vitalpulse_app/docs/SPARK_PLAN_MIGRATION.md §9.
 *
 * Strips a user's role/hospitalId claims (demotes them back to an
 * unprivileged account). Pass --suspend to also flip the `suspended`
 * kill-switch claim in the same operation — same behavior as
 * revokeRoleHandler's `suspend` flag.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json \
 *     npm run revoke-role -- --email=former-staff@hospital.cm [--suspend] --yes
 *
 * Omit --yes to do a dry run.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function parseArgs(argv: string[]): { email?: string; suspend: boolean; confirm: boolean } {
  let email: string | undefined;
  let suspend = false;
  let confirm = false;
  for (const arg of argv) {
    if (arg === '--yes') confirm = true;
    else if (arg === '--suspend') suspend = true;
    else if (arg.startsWith('--email=')) email = arg.slice('--email='.length).trim();
  }
  return { email, suspend, confirm };
}

async function main() {
  const { email, suspend, confirm } = parseArgs(process.argv.slice(2));

  if (!email) {
    console.error('Usage: npm run revoke-role -- --email=you@example.com [--suspend] --yes');
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
  const newClaims: Record<string, unknown> = {};
  if (suspend || existingClaims.suspended === true) {
    newClaims.suspended = true;
  }

  console.log(`Target: ${email} (uid: ${user.uid})`);
  console.log(`Current custom claims: ${JSON.stringify(existingClaims)}`);
  console.log(`New custom claims (role/hospitalId stripped): ${JSON.stringify(newClaims)}`);

  if (!confirm) {
    console.log('\nDry run only (no --yes flag) — nothing was changed.');
    return;
  }

  await auth.setCustomUserClaims(user.uid, newClaims);
  await auth.revokeRefreshTokens(user.uid);
  await db.collection('auditLogs').add({
    actorUid: `revoke-role-script:${process.env.USERNAME || process.env.USER || 'unknown-operator'}`,
    action: 'revokeRole',
    targetUid: user.uid,
    details: { previousRole: existingClaims.role ?? null, suspended: newClaims.suspended === true },
    timestamp: FieldValue.serverTimestamp(),
  });

  console.log(`\nDone. ${email} (${user.uid}) has been demoted to an unprivileged account.`);
  console.log('Their existing sessions were revoked — they must log out and back in for it to take effect.');
}

main().catch((err) => {
  console.error('revoke-role failed:', err);
  process.exit(1);
});
