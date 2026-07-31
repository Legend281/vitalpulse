import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebaseAdmin';

/**
 * Append-only audit event. Per Policy 5: log actor/action/target/timestamp
 * references only — never PHI values themselves. Writable only from Cloud
 * Functions (Admin SDK bypasses Firestore rules by design); clients have no
 * write path to `auditLogs` at all.
 */
export async function writeAudit(event: {
  actorUid: string;
  action: string;
  targetUid?: string;
  details?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  await db.collection('auditLogs').add({
    actorUid: event.actorUid,
    action: event.action,
    targetUid: event.targetUid ?? null,
    details: event.details ?? {},
    timestamp: FieldValue.serverTimestamp(),
  });
}
