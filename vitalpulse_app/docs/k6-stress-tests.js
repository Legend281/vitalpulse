/**
 * VitalPulse — k6 stress/load scenarios (S1–S6 from the Security Master Plan)
 * Run:  k6 run -e TARGET_URL=https://staging.vitalpulse.example k6-stress-tests.js
 * Pick one scenario: k6 run -e K6_SCENARIO=s2_public_surge ...
 * ONLY against staging with synthetic data. Never against production.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.TARGET_URL || 'http://localhost:5001';
const PICK = __ENV.K6_SCENARIO || 'all';

export const droppedAlerts = new Counter('dropped_alerts');
export const dispatchTime = new Trend('alert_dispatch_time', true);

const allScenarios = {
  // S1 — Mass-casualty spike: 50 urgent requests in 5 min, fan-out to donors
  s1_mass_casualty: {
    executor: 'ramping-arrival-rate',
    exec: 'createUrgentRequest',
    startRate: 1, timeUnit: '1s',
    stages: [ { target: 10, duration: '1m' }, { target: 10, duration: '4m' } ],
    preAllocatedVUs: 50, maxVUs: 200,
  },
  // S2 — Public page surge (news-driven): ramp to 500 RPS on public intake
  s2_public_surge: {
    executor: 'ramping-arrival-rate',
    exec: 'submitPublicRequest',
    startRate: 5, timeUnit: '1s',
    stages: [
      { target: 100, duration: '2m' },
      { target: 500, duration: '3m' },
      { target: 500, duration: '5m' },
      { target: 0,   duration: '1m' },
    ],
    preAllocatedVUs: 200, maxVUs: 1000,
  },
  // S3 — Donor response stampede: 500 donors accept the same request in 30s
  s3_accept_stampede: {
    executor: 'shared-iterations',
    exec: 'acceptSameRequest',
    vus: 500, iterations: 500, maxDuration: '30s',
  },
  // S4 — Escalation storm is triggered server-side; here we seed 200 stale
  // urgent requests, then ops verifies the scheduled function completes.
  s4_seed_stale_requests: {
    executor: 'shared-iterations',
    exec: 'createUrgentRequest',
    vus: 50, iterations: 200, maxDuration: '2m',
  },
  // S5 — Inventory consistency: 100 concurrent stock mutations, one hospital
  s5_inventory_contention: {
    executor: 'shared-iterations',
    exec: 'mutateInventory',
    vus: 100, iterations: 100, maxDuration: '1m',
  },
  // S6 — Degraded network: low-and-slow clients with induced latency profile
  s6_slow_network: {
    executor: 'constant-vus',
    exec: 'submitPublicRequest',
    vus: 30, duration: '5m',
    // pair with: k6 run --http-debug and network throttling via k6 cloud,
    // or run behind toxiproxy adding 2000ms latency / 1% loss.
  },
  // smoke — reduced S1 used as the CI gate
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
    http_req_failed: ['rate<0.001'],                 // <0.1% errors
    'http_req_duration{endpoint:createRequest}': ['p(95)<2000'],
    'http_req_duration{endpoint:publicRequest}': ['p(95)<3000'],
    dropped_alerts: ['count==0'],
  },
};

const HEADERS = { 'Content-Type': 'application/json' };
const bloodTypes = ['O-','O+','A-','A+','B-','B+','AB-','AB+'];
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];

// NOTE: obtain a synthetic-staff auth token in setup(); staging test accounts only.
export function setup() {
  const res = http.post(`${BASE}/test-support/token`, JSON.stringify({
    role: 'hospital_staff', hospitalId: 'H_STAGING_1',
  }), { headers: HEADERS });
  return { token: res.json('token') || '' };
}

export function createUrgentRequest(data) {
  const t0 = Date.now();
  const res = http.post(`${BASE}/api/requests`, JSON.stringify({
    hospitalId: 'H_STAGING_1',
    bloodType: rnd(bloodTypes),
    component: 'whole',
    urgency: 'critical',
    category: Math.random() < 0.3 ? 'obstetric_emergency' : 'normal',
  }), { headers: { ...HEADERS, Authorization: `Bearer ${data.token}` },
        tags: { endpoint: 'createRequest' } });

  const ok = check(res, {
    'request created': (r) => r.status === 200 || r.status === 201,
    'alert dispatched flag': (r) => r.json('alertDispatched') === true,
  });
  if (!ok) droppedAlerts.add(1);
  dispatchTime.add(Date.now() - t0);
  sleep(0.5);
}

export function submitPublicRequest() {
  const res = http.post(`${BASE}/api/public-requests`, JSON.stringify({
    patientName: `LoadTest Patient ${__VU}-${__ITER}`,
    hospitalName: 'District Hospital Staging',
    ward: 'Maternity',
    bloodType: rnd(bloodTypes),
    urgency: 'critical',
    submitterPhone: `+2376${String(70000000 + (__VU * 1000 + __ITER) % 9999999)}`,
    relationship: 'family',
  }), { headers: HEADERS, tags: { endpoint: 'publicRequest' } });

  check(res, {
    // 201 = accepted; 429 = rate limiter shedding (acceptable under surge,
    // the pass criterion is that legitimate low-rate clients still succeed)
    'accepted or rate-limited': (r) => r.status === 201 || r.status === 429,
    'never 5xx': (r) => r.status < 500,
  });
  sleep(1);
}

export function acceptSameRequest(data) {
  const res = http.post(`${BASE}/api/requests/R_STAMPEDE_TARGET/accept`,
    JSON.stringify({ donorId: `synthetic_donor_${__VU}` }),
    { headers: { ...HEADERS, Authorization: `Bearer ${data.token}` } });

  check(res, {
    // exactly-once semantics: precisely ONE 200 across all 500 iterations,
    // everyone else must get 409 Conflict. Verify the single-winner count
    // in the post-run assertion script.
    'won or conflict': (r) => r.status === 200 || r.status === 409,
    'no double-assignment errors': (r) => r.status !== 500,
  });
}

export function mutateInventory(data) {
  const res = http.post(`${BASE}/api/inventory/mutate`, JSON.stringify({
    hospitalId: 'H_STAGING_1', bloodType: 'O-', component: 'whole', delta: 1,
  }), { headers: { ...HEADERS, Authorization: `Bearer ${data.token}` } });
  check(res, { 'mutation ok': (r) => r.status === 200 });
  // POST-RUN: final count must equal exactly the number of 200s (no lost updates).
}
