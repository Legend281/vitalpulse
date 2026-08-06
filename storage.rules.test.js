/**
 * VitalPulse — Storage Security Rules test suite (Stream F2, donor UI/VitalPulse_Plan_Tracker.md).
 * Run: npm run test:rules (also spins up the Storage emulator now, see firebase.json)
 *
 * Covers storage.rules' one real path (kyc/{uid}/{fileName}) plus deny-by-default for
 * everything else, including hostile cases: a different donor probing another donor's file,
 * oversized/wrong-type uploads, and cross-account write attempts.
 *
 * SPARK PLAN MIGRATION (vitalpulse_app/docs/SPARK_PLAN_MIGRATION.md §7, Security Lead decision
 * 2026-08-05): the owning donor now uploads directly (previously Admin-SDK-only via
 * submitKYC/submitLivenessSelfie). Reads stay owner-or-admin; writes stay owner-only —
 * system_admin reviews, but never uploads on a donor's behalf.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { beforeAll, afterAll, describe, it } from 'vitest';
import { ref, uploadBytes, getBytes } from 'firebase/storage';

let env;

const claims = {
  donorA:   { role: 'donor' },
  donorB:   { role: 'donor' },
  sysAdmin: { role: 'system_admin' },
  hAdminH1: { role: 'hospital_admin', hospitalId: 'H1' },
};

const ctx = (uid) => env.authenticatedContext(uid, claims[uid]).storage();
const anon = () => env.unauthenticatedContext().storage();

const tinyFile = new Uint8Array([1, 2, 3]);
const jpegMeta = { contentType: 'image/jpeg' };
const oversizedFile = new Uint8Array(5 * 1024 * 1024 + 1); // one byte over the 5MB rule limit

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'vitalpulse-rules-test',
    storage: { rules: readFileSync('storage.rules', 'utf8') },
  });
});
afterAll(async () => env.cleanup());

describe('kyc/{uid}/{fileName} — identity documents', () => {
  it('the owning donor can write their own KYC document (jpeg, under 5MB)', async () =>
    assertSucceeds(uploadBytes(ref(ctx('donorA'), 'kyc/donorA/national_id_1.jpg'), tinyFile, jpegMeta)));

  it('HOSTILE: a write over the 5MB size limit is rejected', async () =>
    assertFails(uploadBytes(ref(ctx('donorA'), 'kyc/donorA/national_id_1.jpg'), oversizedFile, jpegMeta)));

  it('HOSTILE: a write with a disallowed content-type is rejected', async () =>
    assertFails(uploadBytes(ref(ctx('donorA'), 'kyc/donorA/national_id_1.jpg'), tinyFile, { contentType: 'application/zip' })));

  it('HOSTILE: no client can write without declaring a content-type at all', async () =>
    assertFails(uploadBytes(ref(ctx('donorA'), 'kyc/donorA/national_id_1.jpg'), tinyFile)));

  it('HOSTILE: system_admin cannot write a KYC document on a donor\'s behalf — owner only', async () =>
    assertFails(uploadBytes(ref(ctx('sysAdmin'), 'kyc/donorA/national_id_1.jpg'), tinyFile, jpegMeta)));

  it('HOSTILE: a donor cannot write into a DIFFERENT donor\'s kyc/ folder', async () =>
    assertFails(uploadBytes(ref(ctx('donorB'), 'kyc/donorA/national_id_1.jpg'), tinyFile, jpegMeta)));

  it('HOSTILE: unauthenticated cannot write a KYC document', async () =>
    assertFails(uploadBytes(ref(anon(), 'kyc/donorA/national_id_1.jpg'), tinyFile, jpegMeta)));

  it('the owning donor can read their own KYC document', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'kyc/donorA/national_id_1.jpg'), tinyFile);
    });
    await assertSucceeds(getBytes(ref(ctx('donorA'), 'kyc/donorA/national_id_1.jpg')));
  });

  it('system_admin can read a KYC document (review queue)', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'kyc/donorA/national_id_1.jpg'), tinyFile);
    });
    await assertSucceeds(getBytes(ref(ctx('sysAdmin'), 'kyc/donorA/national_id_1.jpg')));
  });

  it('HOSTILE: a different donor cannot read another donor\'s KYC document', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'kyc/donorA/national_id_1.jpg'), tinyFile);
    });
    await assertFails(getBytes(ref(ctx('donorB'), 'kyc/donorA/national_id_1.jpg')));
  });

  it('HOSTILE: hospital_admin cannot read a donor\'s KYC document (owner/system_admin only)', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'kyc/donorA/national_id_1.jpg'), tinyFile);
    });
    await assertFails(getBytes(ref(ctx('hAdminH1'), 'kyc/donorA/national_id_1.jpg')));
  });

  it('HOSTILE: unauthenticated cannot read a KYC document', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'kyc/donorA/national_id_1.jpg'), tinyFile);
    });
    await assertFails(getBytes(ref(anon(), 'kyc/donorA/national_id_1.jpg')));
  });
});

describe('deny by default — every other path', () => {
  it('HOSTILE: system_admin cannot read/write an arbitrary unrecognized path', async () => {
    await assertFails(uploadBytes(ref(ctx('sysAdmin'), 'random/path.txt'), tinyFile));
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'random/path.txt'), tinyFile);
    });
    await assertFails(getBytes(ref(ctx('sysAdmin'), 'random/path.txt')));
  });

  it('HOSTILE: the pre-existing hospital_licenses/ path is NOT covered by an allow rule (flagged in storage.rules\' own header, not silently widened here)', async () => {
    await assertFails(uploadBytes(ref(ctx('hAdminH1'), 'hospital_licenses/H1/license.pdf'), tinyFile));
  });
});
