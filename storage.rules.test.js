/**
 * VitalPulse — Storage Security Rules test suite (Stream F2, donor UI/VitalPulse_Plan_Tracker.md).
 * Run: npm run test:rules (also spins up the Storage emulator now, see firebase.json)
 *
 * Covers storage.rules' one real path (kyc/{uid}/{fileName}) plus deny-by-default for
 * everything else, including hostile cases: the owning donor trying to read/write their own
 * KYC file directly, and a non-admin role probing another donor's file.
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

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'vitalpulse-rules-test',
    storage: { rules: readFileSync('storage.rules', 'utf8') },
  });
});
afterAll(async () => env.cleanup());

describe('kyc/{uid}/{fileName} — identity documents', () => {
  it('system_admin can read a KYC document (review queue)', async () => {
    // Written directly via the Admin SDK path (bypasses rules), same as submitKYC does in prod.
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'kyc/donorA/national_id_1.jpg'), tinyFile);
    });
    await assertSucceeds(getBytes(ref(ctx('sysAdmin'), 'kyc/donorA/national_id_1.jpg')));
  });

  it('HOSTILE: the owning donor cannot read their own KYC document directly', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'kyc/donorA/national_id_1.jpg'), tinyFile);
    });
    await assertFails(getBytes(ref(ctx('donorA'), 'kyc/donorA/national_id_1.jpg')));
  });

  it('HOSTILE: a different donor cannot read another donor\'s KYC document', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await uploadBytes(ref(c.storage(), 'kyc/donorA/national_id_1.jpg'), tinyFile);
    });
    await assertFails(getBytes(ref(ctx('donorB'), 'kyc/donorA/national_id_1.jpg')));
  });

  it('HOSTILE: hospital_admin cannot read a donor\'s KYC document (system_admin only)', async () => {
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

  it('HOSTILE: no client, including the owning donor, can write a KYC document directly (C3.6 — submitKYC/Admin SDK only)', async () => {
    await assertFails(uploadBytes(ref(ctx('donorA'), 'kyc/donorA/national_id_1.jpg'), tinyFile));
  });

  it('HOSTILE: no client, including system_admin, can write a KYC document directly', async () => {
    await assertFails(uploadBytes(ref(ctx('sysAdmin'), 'kyc/donorA/national_id_1.jpg'), tinyFile));
  });

  it('HOSTILE: a donor cannot write into a DIFFERENT donor\'s kyc/ folder', async () => {
    await assertFails(uploadBytes(ref(ctx('donorB'), 'kyc/donorA/national_id_1.jpg'), tinyFile));
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
