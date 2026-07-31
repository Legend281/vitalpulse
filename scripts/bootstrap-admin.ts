/**
 * bootstrap-admin.ts — ONE-OFF, MANUAL USE ONLY. Never deployed, never
 * called by the app or by functions/. This is the only place in the entire
 * codebase where a system_admin role is ever set without an existing
 * system_admin calling grantRole() — it exists solely to break that
 * chicken-and-egg problem for the very first admin account.
 *
 * Prerequisites:
 *   1. The target person must already have a normal VitalPulse account
 *      (sign up as a donor through the app first, note their email).
 *   2. Download a Firebase service account key for the vitalpulse project
 *      from the Firebase console (Project Settings -> Service accounts ->
 *      Generate new private key). Store it OUTSIDE this repo. Never commit
 *      it, never paste it into chat, never leave it on a shared machine.
 *
 * Usage (run from the scripts/ directory, by the project owner, from a
 * trusted machine):
 *   npm install
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json \
 *     npm run bootstrap-admin -- --email=you@example.com --yes
 *
 * Omit --yes to do a dry run (prints what would happen, changes nothing).
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
    console.error('Usage: npm run bootstrap-admin -- --email=you@example.com --yes');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      'GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a downloaded service ' +
        'account key before running this script — see the header comment for how to get one.',
    );
    process.exit(1);
  }

  initializeApp();
  const auth = getAuth();
  const db = getFirestore();

  const user = await auth.getUserByEmail(email).catch(() => null);
  if (!user) {
    console.error(
      `No account found for ${email}. Ask them to sign up in the app first (as a donor — ` +
        `role doesn't matter, it will be overwritten), then re-run this script.`,
    );
    process.exit(1);
  }

  const alreadyAdmin = (user.customClaims as { role?: string } | undefined)?.role === 'system_admin';
  console.log(`Target: ${email} (uid: ${user.uid})`);
  console.log(`Current custom claims: ${JSON.stringify(user.customClaims ?? {})}`);
  if (alreadyAdmin) {
    console.log('This account is already system_admin. Re-running will re-set the claim and revoke their tokens.');
  }

  if (!confirm) {
    console.log('\nDry run only (no --yes flag) — nothing was changed.');
    console.log(`Would set custom claims on ${user.uid} to: { "role": "system_admin" }`);
    return;
  }

  await auth.setCustomUserClaims(user.uid, { role: 'system_admin' });
  await auth.revokeRefreshTokens(user.uid);
  await db.collection('auditLogs').add({
    actorUid: `bootstrap-script:${process.env.USERNAME || process.env.USER || 'unknown-operator'}`,
    action: 'bootstrapSystemAdmin',
    targetUid: user.uid,
    details: { email, note: 'Manual one-off bootstrap, run outside of grantRole().' },
    timestamp: FieldValue.serverTimestamp(),
  });

  console.log(`\nDone. ${email} (${user.uid}) is now system_admin.`);
  console.log('Their existing sessions were revoked — they must log out and back in for the new role to take effect.');
  console.log('From here on, ALL further role grants must go through grantRole() called by this (or another) system_admin.');
}

main().catch((err) => {
  console.error('bootstrap-admin failed:', err);
  process.exit(1);
});
