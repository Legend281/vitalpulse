/**
 * grant-role.ts — ONE-OFF, MANUAL USE ONLY. Never deployed, never called by
 * the app. Local-script replacement for the (removed) grantRole Cloud
 * Function — see vitalpulse_app/docs/SPARK_PLAN_MIGRATION.md §9: role
 * grants stay on custom claims, set by whoever holds the service account
 * key (you), rather than moving to a client-writable Firestore field.
 *
 * Unlike the old Cloud Function, this has no "caller" to check permissions
 * against — whoever runs this script already holds full Admin SDK access
 * via the service account key, so authorization is "do you have the key,"
 * same as bootstrap-admin.ts. What IS still enforced: the same data-
 * integrity rules grantRoleHandler had (hospitalId required for hospital-
 * scoped roles, forbidden otherwise; a suspension is never silently lifted
 * by granting a role).
 *
 * Prerequisites: same as bootstrap-admin.ts (service account key via
 * GOOGLE_APPLICATION_CREDENTIALS, target must already have an account).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json \
 *     npm run grant-role -- --email=staff@hospital.cm --role=hospital_staff --hospitalId=<hospitalUid> --yes
 *
 * Omit --yes to do a dry run (prints what would happen, changes nothing).
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const ROLES = ['donor', 'hospital_staff', 'lab_tech', 'hospital_admin', 'system_admin', 'nbtp_viewer'] as const;
type Role = (typeof ROLES)[number];
const HOSPITAL_SCOPED_ROLES: readonly Role[] = ['hospital_staff', 'lab_tech', 'hospital_admin'];

function parseArgs(argv: string[]): { email?: string; role?: string; hospitalId?: string; confirm: boolean } {
  let email: string | undefined;
  let role: string | undefined;
  let hospitalId: string | undefined;
  let confirm = false;
  for (const arg of argv) {
    if (arg === '--yes') confirm = true;
    else if (arg.startsWith('--email=')) email = arg.slice('--email='.length).trim();
    else if (arg.startsWith('--role=')) role = arg.slice('--role='.length).trim();
    else if (arg.startsWith('--hospitalId=')) hospitalId = arg.slice('--hospitalId='.length).trim();
  }
  return { email, role, hospitalId, confirm };
}

async function main() {
  const { email, role, hospitalId, confirm } = parseArgs(process.argv.slice(2));

  if (!email || !role) {
    console.error(
      'Usage: npm run grant-role -- --email=you@example.com --role=hospital_staff [--hospitalId=<uid>] --yes',
    );
    process.exit(1);
  }
  if (!ROLES.includes(role as Role)) {
    console.error(`Invalid role "${role}". Must be one of: ${ROLES.join(', ')}`);
    process.exit(1);
  }
  const targetRole = role as Role;
  const isHospitalScoped = HOSPITAL_SCOPED_ROLES.includes(targetRole);
  if (isHospitalScoped && !hospitalId) {
    console.error(`--hospitalId is required when granting role "${targetRole}".`);
    process.exit(1);
  }
  if (!isHospitalScoped && hospitalId) {
    console.error(`--hospitalId must not be set when granting role "${targetRole}".`);
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
    console.error(`No account found for ${email}. They must sign up in the app first.`);
    process.exit(1);
  }

  const existingClaims = (user.customClaims ?? {}) as { role?: Role; roles?: Role[]; hospitalId?: string; suspended?: boolean };
  const existingRoles = existingClaims.roles && existingClaims.roles.length > 0
    ? existingClaims.roles
    : existingClaims.role
      ? [existingClaims.role]
      : [];
  const updatedRoles = Array.from(new Set([...existingRoles, targetRole]));
  const newClaims: Record<string, unknown> = { role: targetRole, roles: updatedRoles };
  if (isHospitalScoped) newClaims.hospitalId = hospitalId;
  if (existingClaims.suspended === true) {
    // A role grant never lifts a suspension — that's revoke-role.ts/reactivate-user.ts's job.
    newClaims.suspended = true;
  }

  console.log(`Target: ${email} (uid: ${user.uid})`);
  console.log(`Current custom claims: ${JSON.stringify(existingClaims)}`);
  console.log(`New custom claims: ${JSON.stringify(newClaims)}`);

  if (!confirm) {
    console.log('\nDry run only (no --yes flag) — nothing was changed.');
    return;
  }

  await auth.setCustomUserClaims(user.uid, newClaims);
  const userDocUpdate: Record<string, unknown> = { role: targetRole, updatedAt: FieldValue.serverTimestamp() };
  if (isHospitalScoped && hospitalId) userDocUpdate.hospitalId = hospitalId;
  await db.collection('users').doc(user.uid).set(userDocUpdate, { merge: true });
  await auth.revokeRefreshTokens(user.uid);
  await db.collection('auditLogs').add({
    actorUid: `grant-role-script:${process.env.USERNAME || process.env.USER || 'unknown-operator'}`,
    action: 'grantRole',
    targetUid: user.uid,
    details: { role: targetRole, hospitalId: hospitalId ?? null },
    timestamp: FieldValue.serverTimestamp(),
  });

  console.log(`\nDone. ${email} (${user.uid}) now has role "${targetRole}".`);
  console.log('Their existing sessions were revoked — they must log out and back in for it to take effect.');
}

main().catch((err) => {
  console.error('grant-role failed:', err);
  process.exit(1);
});
