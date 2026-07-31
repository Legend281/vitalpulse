/**
 * VitalPulse — k6 stress/load scenarios (Master Plan Part 3.3, S1–S6 + soak).
 *
 * REWRITTEN 2026-07-25 (Part 3.3 review) against the REAL app architecture, not the
 * Master Plan's aspirational REST backend. The real app has no custom REST API — the
 * browser talks to Firestore directly via the client SDK (PHASE0_AUDIT.md §1). This
 * script exercises the same real traffic pattern by hitting Firestore's own REST API
 * directly, against the REAL collections/schema (PHASE0_AUDIT.md §7: `requests`,
 * `inventory`) — not the fictional `/api/*` endpoints or `public_requests`/`bloodUnits`
 * schema the original draft (vitalpulse_app/docs/k6-stress-tests.js) assumed.
 *
 * WHAT'S ACTUALLY RUNNABLE TODAY vs BLOCKED — see VitalPulse_Plan_Tracker.md Part 3.3
 * for the full accounting:
 *   - S1 (mass-casualty spike), S3 (accept stampede), S5 (inventory contention):
 *     scripted below, ready to run once a staging Firebase project + synthetic test
 *     accounts exist (neither does yet — single project `vitalpulse-fa458`, no
 *     hosting/staging secrets — see Part 4 notes). S3/S5's actual SAFETY invariants
 *     are already verified locally, right now, with no staging infra at all, in
 *     `concurrency.rules.test.js` (run via `npm run test:rules`) — that's the
 *     trustworthy correctness result. This script measures throughput/latency under
 *     load instead, a materially different (and currently unrunnable) question.
 *   - S2 (public page surge): N/A, removed — no public/anonymous request feature
 *     exists in the app at all (PHASE0_AUDIT.md §6). Re-add once submitPublicRequest
 *     ships, adapted to whatever its real shape turns out to be.
 *   - S4 (escalation storm): N/A, removed — no escalation engine/scheduled function
 *     exists yet (Part 1.5, Phase 3 work).
 *   - S6 (degraded network), soak: need a real deployed target to mean anything —
 *     network-throttling or 24h-steady-load against the local emulator doesn't tell
 *     you anything about real Firebase infrastructure behavior. Left as documented
 *     scaffolding, not a runnable scenario, until staging exists.
 *   - Firebase quota headroom + billing/quota alerts: Firebase console only — needs
 *     the Security Lead, not a script.
 *
 * Prerequisites to actually run S1/S3/S5 for real (against staging, once it exists):
 *   1. A staging Firebase project with firestore.rules deployed (synthetic data only,
 *      never real PHI — Master Plan Part 4's non-negotiable rule).
 *   2. Synthetic test accounts with real custom claims (hospital_staff/donor via
 *      grantRole — see scripts/bootstrap-admin.ts for the credential pattern).
 *   3. k6 run -e TARGET=https://firestore.googleapis.com -e PROJECT=vitalpulse-staging \
 *          -e ID_TOKEN=<token from signing in a synthetic account> k6-stress-tests.js
 *      (or -e TARGET=http://localhost:8080 against the local Firestore emulator for a
 *      dry run of the script's mechanics only — emulator throughput isn't
 *      representative of production Firebase, so that only proves "the script works,"
 *      not "S1 passed")
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const TARGET = __ENV.TARGET || 'http://localhost:8080'; // Firestore REST base — see header
const PROJECT = __ENV.PROJECT || 'vitalpulse-fa458';
const ID_TOKEN = __ENV.ID_TOKEN || ''; // must belong to a synthetic hospital_staff test account
const PICK = __ENV.K6_SCENARIO || 'all';

export const droppedWrites = new Counter('dropped_writes');
export const writeTime = new Trend('firestore_write_time', true);

const DOCS_BASE = `${TARGET}/v1/projects/${PROJECT}/databases/(default)/documents`;

const allScenarios = {
  // S1 — Mass-casualty spike: 50 urgent requests in 5 min (real schema: `requests`)
  s1_mass_casualty: {
    executor: 'ramping-arrival-rate',
    exec: 'createUrgentRequest',
    startRate: 1, timeUnit: '1s',
    stages: [{ target: 10, duration: '1m' }, { target: 10, duration: '4m' }],
    preAllocatedVUs: 50, maxVUs: 200,
  },
  // S3 — Donor response stampede: throughput/latency under many concurrent accept
  // attempts on the same request. The exactly-once SAFETY guarantee itself is already
  // proven in concurrency.rules.test.js — this measures load characteristics only,
  // against a target that needs to exist first.
  s3_accept_stampede: {
    executor: 'shared-iterations',
    exec: 'acceptSameRequest',
    vus: 500, iterations: 500, maxDuration: '30s',
  },
  // S5 — Inventory consistency: throughput under concurrent stock mutations. The
  // lost-update BUG this is meant to catch is already proven in
  // concurrency.rules.test.js (PHASE0_AUDIT.md §5) — not something staging load
  // testing would newly discover, but worth reconfirming under real infra latency
  // once updateInventory (Phase 3) exists and (hopefully) fixes it.
  s5_inventory_contention: {
    executor: 'shared-iterations',
    exec: 'mutateInventory',
    vus: 100, iterations: 100, maxDuration: '1m',
  },
  // smoke — reduced S1, intended as the CI gate once staging exists (see ci-cd.yml's
  // gated-off smoke-load-test job)
  smoke: {
    executor: 'constant-arrival-rate',
    exec: 'createUrgentRequest',
    rate: 2, timeUnit: '1s', duration: '1m',
    preAllocatedVUs: 10, maxVUs: 20,
  },
};

export const options = {
  scenarios: PICK === 'all' ? allScenarios : { [PICK]: allScenarios[PICK] },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    'http_req_duration{endpoint:createRequest}': ['p(95)<2000'],
    dropped_writes: ['count==0'],
  },
};

const bloodTypes = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Firestore's REST API wants typed field values, not plain JSON — see
// https://firebase.google.com/docs/firestore/reference/rest/v1/Value
function toFirestoreValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  throw new Error(`toFirestoreValue: unsupported type for ${JSON.stringify(v)}`);
}
function toFirestoreFields(obj) {
  const fields = {};
  for (const key of Object.keys(obj)) fields[key] = toFirestoreValue(obj[key]);
  return { fields };
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${ID_TOKEN}` };
}

export function createUrgentRequest() {
  const t0 = Date.now();
  const res = http.post(`${DOCS_BASE}/requests`, JSON.stringify(toFirestoreFields({
    hospital: 'Hospital One',
    hospitalId: 'H_STAGING_1', // must match the synthetic test account's own uid/hospitalId claim
    bloodType: rnd(bloodTypes),
    status: 'Open',
    isEmergency: true,
    requestedAt: new Date().toISOString(),
  })), { headers: authHeaders(), tags: { endpoint: 'createRequest' } });

  const ok = check(res, { 'request created': (r) => r.status === 200 });
  if (!ok) droppedWrites.add(1);
  writeTime.add(Date.now() - t0);
  sleep(0.5);
}

export function acceptSameRequest() {
  // PATCHes a single shared target doc (create it once beforehand, e.g. via
  // firebase firestore:write or the console, as requests/R_STAMPEDE_TARGET with
  // status: Open) — real contention happens at the Firestore layer regardless of
  // which HTTP verb/tooling issues the request.
  const url = `${DOCS_BASE}/requests/R_STAMPEDE_TARGET`
    + '?updateMask.fieldPaths=status&updateMask.fieldPaths=matchedDonor&updateMask.fieldPaths=matchedAt';
  const res = http.request('PATCH', url, JSON.stringify(toFirestoreFields({
    status: 'Donor Assigned',
    matchedDonor: `synthetic_donor_${__VU}`,
    matchedAt: new Date().toISOString(),
  })), { headers: authHeaders() });

  check(res, {
    'won (200) or rules-denied (403, someone already won)': (r) => r.status === 200 || r.status === 403,
    'never a server error': (r) => r.status < 500,
  });
}

export function mutateInventory() {
  const url = `${DOCS_BASE}/inventory/H_STAGING_1_O-?updateMask.fieldPaths=unitsAvailable`;
  const res = http.request('PATCH', url, JSON.stringify(toFirestoreFields({
    unitsAvailable: 19, // pre-seed the doc at 20 units; each VU deducts 1
  })), { headers: authHeaders() });
  check(res, { 'mutation accepted': (r) => r.status === 200 });
  // POST-RUN (manual): compare final unitsAvailable to the expected fully-serialized
  // total — see concurrency.rules.test.js for the already-proven lost-update bug this
  // would reconfirm under real network/infra conditions, not newly discover it.
}

export function setup() {
  if (!ID_TOKEN) {
    throw new Error(
      'ID_TOKEN env var is required — mint one by signing in a synthetic staging test '
      + 'account (never a real user) via the Identity Toolkit REST API, or via the Auth '
      + 'emulator for a local dry run. See the header comment for full prerequisites.'
    );
  }
}
