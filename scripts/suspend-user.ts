/**
 * suspend-user.ts — ONE-OFF, MANUAL USE ONLY. Never deployed, never called
 * by the app. Local-script replacement for the (removed) suspendUser Cloud
 * Function — see vitalpulse_app/docs/SPARK_PLAN_MIGRATION.md §9.
 *
 * Flips the `suspended` kill-switch claim, revokes the target's refresh
 * tokens, and mirrors the state onto their users/{uid} doc (isSuspended /
 * isAvailable) the same way setUserSuspensionHandler did — the donor
 * dashboard reads isAvailable, so this keeps a suspended donor out of the
 * matching pool, not just off the login screen.
 *
 * See reactivate-user.ts for lifting a suspension.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json \
 *     npm run suspend-user -- --email=someone@example.com --reason="..." --yes
 *
 * Omit --yes to do a dry run.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function parseArgs(argv: string[]): { email?: string; reason?: string; confirm: boolean } {
  let email: string | undefined;
  let reason: string | undefined;
  let confirm = false;
  for (const arg of argv) {
    if (arg === '--yes') confirm = true;
    else if (arg.startsWith('--email=')) email = arg.slice('--email='.length).trim();
    else if (arg.startsWith('--reason=')) reason = arg.slice('--reason='.length).trim();
  }
  return { email, reason, confirm };
}

async function main() {
  const { email, reason, confirm } = parseArgs(process.argv.slice(2));

  if (!email) {
    console.error('Usage: npm run suspend-user -- --email=you@example.com [--reason="..."] --yes');
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
  // setCustomUserClaims REPLACES the claim set — preserve role/hospitalId, only add the kill-switch.
  const newClaims: Record<string, unknown> = {
    role: existingClaims.role ?? null,
    hospitalId: existingClaims.hospitalId ?? null,
    suspended: true,
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
    { isSuspended: true, isAvailable: false, statusChangedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await db.collection('auditLogs').add({
    actorUid: `suspend-user-script:${process.env.USERNAME || process.env.USER || 'unknown-operator'}`,
    action: 'suspendUser',
    targetUid: user.uid,
    details: { previousSuspended: existingClaims.suspended === true, reason: reason ?? null },
    timestamp: FieldValue.serverTimestamp(),
  });

  console.log(`\nDone. ${email} (${user.uid}) is now suspended.`);
  console.log('Their existing sessions were revoked — they must log out and back in (and will find themselves locked out).');
}

main().catch((err) => {
  console.error('suspend-user failed:', err);
  process.exit(1);
});
