# VitalPulse Security Master Plan

**Owner:** Security Lead
**Version:** 1.0 — July 2026
**Scope:** Access control (RBAC/ABAC/IAM), security policies, module & stress testing, CI/CD, and pre-deployment security requirements for the VitalPulse blood coordination system (Cameroon).

This plan directly remediates the three critical findings in the Findings & Recommendations document, Section 3:

| Finding | Remediation in this plan |
|---|---|
| 3.1 Hardcoded admin code in public sign-up | Part 1.4 — Admin provisioning via server-only IAM flow; secret removed entirely |
| 3.2 Permission checks only on the frontend | Part 1 + Appendix A — Server-enforced RBAC/ABAC via Firebase custom claims + Firestore Security Rules |
| 3.3 Sensitive actions run on the client | Part 1.5 — All privileged mutations moved to Cloud Functions |

---

# PART 1 — ACCESS CONTROL ARCHITECTURE (RBAC + ABAC + IAM)

## 1.1 Design principle

VitalPulse handles Personal Health Information (blood type, donation history, disease-test results, transfusion reactions). The architecture therefore follows:

- **Zero trust on the client.** The frontend is treated as fully compromised. Nothing the browser sends is trusted; every decision is re-made on the server.
- **Least privilege.** Every role gets the minimum permission set required for its job.
- **Defense in depth.** Three enforcement layers: Firebase Auth (identity) → Custom Claims (role/attributes) → Firestore Security Rules + Cloud Functions (authorization + business logic).
- **Deny by default.** The root Firestore rule is `allow read, write: if false;` — every permission is an explicit exception.

## 1.2 RBAC — Role model

Six roles. Note this is finer-grained than the current three user types (Donor / Hospital / Admin) — splitting hospital and admin duties is required for separation of duties, which international frameworks (ISO 27001 A.5.3) mandate.

| Role | Description | Assigned by |
|---|---|---|
| `donor` | Registered blood donor | Self sign-up (default role) |
| `hospital_staff` | Ward/clinical staff at one hospital: creates requests, views own hospital stock | Hospital admin of that hospital |
| `lab_tech` | Laboratory staff: records disease-test results, sets unit status Cleared/Rejected | Hospital admin of that hospital |
| `hospital_admin` | Manages one hospital: staff accounts, inventory config, inter-hospital transfers | System admin |
| `system_admin` | National-level oversight: hospital verification, abuse review queue, aggregated safety data | Existing system admin only (server-side) |
| `nbtp_viewer` | Read-only national statistics role reserved for the National Blood Transfusion Program / CNTS partnership | System admin |

**Separation of duties enforced:**
- `hospital_staff` can create a blood request but **cannot** mark a unit as tested/cleared (only `lab_tech`).
- `lab_tech` **cannot** create blood requests or edit stock counts directly — unit status transitions only.
- `hospital_admin` cannot self-verify their own hospital — only `system_admin` grants the Verified Hospital badge.
- No role can write to audit logs; logs are written exclusively by Cloud Functions.

## 1.3 ABAC — Attribute model

RBAC answers "what can this role do." ABAC answers "on which data, under which conditions." Attributes are stored in Firebase custom claims (small, security-critical) and Firestore documents (contextual), and evaluated in Security Rules and Cloud Functions.

**Subject attributes (in custom claims — set only by Cloud Functions):**
- `role` — one of the six roles above
- `hospitalId` — the single hospital a hospital_staff / lab_tech / hospital_admin belongs to
- `region` — administrative region (for regional scoping of nbtp_viewer if needed)
- `suspended` — boolean kill-switch; overrides everything

**Resource attributes (on documents):**
- `bloodUnit.status` — `awaiting_test | cleared | rejected | transferred | transfused | expired`
- `bloodUnit.hospitalId` — owning hospital
- `request.verificationLabel` — `unverified | document_attached | hospital_confirmed`
- `request.category` — normal | `obstetric_emergency` (fast-track)
- `hospital.verified` — boolean (Verified Hospital badge)
- `donor.bloodTypeSource` — `self_reported | lab_verified`

**Environmental attributes:**
- Request time (used for escalation windows and for flagging off-hours admin actions)
- App Check token validity (request must originate from the genuine app)

**Example ABAC rules (plain language):**
1. A `hospital_staff` user may read blood units **only where** `unit.hospitalId == token.hospitalId`.
2. A `lab_tech` may update a unit **only** the `status` field, **only** for their own hospital, and **only** along legal transitions (`awaiting_test → cleared` or `awaiting_test → rejected`).
3. A blood unit may be counted/read as available stock **only where** `status == 'cleared'` — untested blood is structurally invisible to the matching engine (this is the Section 2.2 safety fix enforced at the authorization layer, not just the UI).
4. A donor may read/update **only their own** profile document (`uid == resource.id`) and may never edit `bloodTypeSource`, `livesSaved`, or eligibility flags.
5. An anonymous (unauthenticated) public request may **only create** a document in `public_requests` with a strictly validated schema (phone number present, size limits), never read or update anything.
6. `system_admin` actions on the abuse-review queue are always logged with actor UID and timestamp by the Cloud Function performing them.

## 1.4 IAM — Identity lifecycle

**Identity provider:** Firebase Authentication.

| Concern | Requirement |
|---|---|
| Sign-in methods | Email/password + phone number (OTP). Phone auth is primary for donors given Cameroon usage patterns. |
| Password policy | Min 12 chars, breach-list screened (Firebase Identity Platform password policy), rate-limited attempts |
| MFA | **Mandatory** for `hospital_admin`, `system_admin`, `lab_tech`. TOTP or SMS second factor. Optional for donors. |
| Admin provisioning | The hardcoded sign-up secret is **deleted from the codebase and git history** (see 1.6). New privileged accounts are created only by a callable Cloud Function `grantRole()` that (a) verifies the caller is `system_admin` (or `hospital_admin` for staff/lab roles at their own hospital), (b) sets the custom claim server-side, (c) writes an audit event. There is no client path to any privileged role. |
| Session management | Firebase ID tokens (1h expiry). On role change or suspension: revoke refresh tokens (`revokeRefreshTokens`) so the change takes effect within minutes, not days. Rules additionally check the `suspended` claim. |
| Account recovery | Email/phone-verified reset only; privileged-role resets additionally reviewed by system_admin. |
| Offboarding | Single kill-switch: set `suspended: true` claim + revoke tokens. Quarterly access review of all privileged accounts (exportable list). |
| Service identities | Cloud Functions run with dedicated least-privilege service accounts; no default-editor service account in production. |

## 1.5 Privileged operations moved server-side (Cloud Functions)

Per finding 3.3, the following are **client-forbidden writes** — Firestore rules block direct writes, and only these Functions perform them:

| Operation | Function | Why server-side |
|---|---|---|
| Emergency donor alert fan-out | `dispatchEmergencyAlert` | Atomic, complete, and un-fakeable; enforces radius matching + escalation timers |
| Blood stock mutation | `updateInventory` | Transactional; enforces status lifecycle; prevents negative/fabricated stock |
| Audit log writes | internal `writeAudit` | Logs must be append-only and unforgeable |
| Role/claim changes | `grantRole` / `revokeRole` | Authorization decisions never made on the client |
| Escalation engine | scheduled `escalateStaleRequests` | Widens search radius + flags admin when an urgent request is unanswered (Section 14 recommendation) |
| Public request intake | `submitPublicRequest` | Validates schema, rate-limits per phone number, applies verification label, notifies target hospital if integrated |
| Inter-hospital transfer | `requestTransfer` / `approveTransfer` | Two-party approval, unit chain-of-custody preserved |

All Functions must: validate `context.auth` and claims first; validate input schema (e.g. with zod); run mutations in Firestore transactions; write an audit event; and be idempotent where retried.

## 1.6 Immediate remediation of the hardcoded admin secret

1. Remove the secret and the sign-up branch from the code.
2. **Treat the secret as leaked** (it shipped in client bundles): audit all existing admin accounts, disable any not explicitly known, rotate everything.
3. Purge the secret from git history (`git filter-repo`) and add secret scanning (gitleaks) to CI so this class of bug can never merge again (Part 4).
4. Bootstrap the first `system_admin` once via a one-off script run with owner credentials — never via app code.

## 1.7 Additional hardening layers

- **Firebase App Check** (Play Integrity / reCAPTCHA Enterprise) on Firestore, Functions, and Storage — blocks scripted abuse of the public request page.
- **Rate limiting:** per-phone and per-IP limits on `submitPublicRequest` and auth endpoints.
- **Cloud Armor / hosting-level protections** for the public page.
- **Field-level privacy:** disease-test results readable only by `lab_tech`/`hospital_admin` of the owning hospital; donors see their own results only through a dedicated, logged read path.
- **Encryption:** Firestore encrypts at rest by default; enforce HTTPS-only; no PHI in URLs, logs, or push-notification payloads (notification says "urgent O- request near you," never patient names).
- **Backups:** daily Firestore export to a locked GCS bucket, 35-day retention, restore-tested quarterly.

---

# PART 2 — SECURITY & GOVERNANCE POLICY SUITE

These are the written policies a health-data system needs to be credible to hospitals, the Ministry of Public Health, international partners (WHO, NGOs), and future certification audits. Each policy below is drafted ready to adapt; full texts are in the companion file `VitalPulse_Security_Policies.md`.

## 2.1 Regulatory & standards mapping (what "internationally accepted" means concretely)

| Framework | Relevance to VitalPulse | Target |
|---|---|---|
| **Cameroon Law No. 2010/012** (Cybersecurity & Cybercriminality) | National baseline: security of information systems, penalties for unauthorized access, obligations on operators | Mandatory |
| **Cameroon personal data protection law (2024)** + ANTIC oversight | Lawful basis, consent, and safeguards for processing personal data, especially health data | Mandatory |
| **African Union Malabo Convention** (Cybersecurity & Personal Data) | Continental data-protection principles; Cameroon alignment strengthens cross-border credibility | Align |
| **GDPR (EU)** | Gold standard reference; required if any EU-based NGO/partner processes data; drives our consent, minimization, and breach-notification design | Align by design |
| **ISO/IEC 27001** | International ISMS certification — the single most persuasive credential for institutional partners | Roadmap: certify within 18–24 months |
| **HIPAA (US)** | Not legally binding in Cameroon, but its Security Rule (access control, audit, integrity, transmission security) is our PHI engineering benchmark | Benchmark |
| **WHO guidance on blood safety & hemovigilance** | Domain-specific: traceability of every unit donor→patient, adverse-event reporting | Build in from day one |
| **OWASP ASVS / Top 10** | Application security verification baseline for testing (Part 3) | ASVS Level 2 |

## 2.2 The policy set (13 policies)

1. **Information Security Policy (master)** — objectives, scope, roles (you as Security Lead = policy owner), risk appetite, annual review cycle.
2. **Access Control Policy** — codifies Part 1: least privilege, RBAC/ABAC definitions, MFA requirements, provisioning/deprovisioning, quarterly access reviews.
3. **Data Protection & Privacy Policy** — lawful basis and consent for donors/patients; data minimization (the public request page collects only what Section 5.3 of the findings lists); purpose limitation; data subject rights (access, correction, deletion); special-category handling for health data; bilingual (EN/FR) privacy notices.
4. **Data Classification & Handling Policy** — four classes: Public / Internal / Confidential / **Restricted-PHI** (blood type, test results, transfusion reactions, patient identity). Handling rules per class: storage, transmission, display, export.
5. **Audit Logging & Monitoring Policy** — what is logged (all privileged actions, all PHI access, all auth events), append-only storage, 12-month minimum retention, weekly review of anomalies, alerting thresholds.
6. **Incident Response & Breach Notification Policy** — severity matrix (SEV1: PHI breach or system down during active emergency requests), response roles, containment→eradication→recovery→lessons-learned, notification clock (regulator and affected persons; 72h internal target aligned with GDPR practice), press/partner communication template.
7. **Vulnerability & Patch Management Policy** — dependency scanning cadence, severity SLAs (Critical: 48h, High: 7d, Medium: 30d), coordinated disclosure contact (security@) for outside researchers.
8. **Secure Development Policy (SDLC)** — code review mandatory for auth/rules changes (two reviewers), no secrets in code, security testing gates in CI (Part 4), threat modeling for every new feature touching PHI.
9. **Business Continuity & Disaster Recovery Policy** — RPO 24h (daily exports), RTO 4h; degraded-mode plan (matching engine outage must not block hospitals from phoning donors — export contact lists procedure); ties to offline-first roadmap.
10. **Acceptable Use Policy** — for hospital staff/admin users of the platform; account sharing prohibited (each staff member = own account, or audit trails are meaningless).
11. **Third-Party & Vendor Security Policy** — Firebase/Google Cloud DPA in place; assessment checklist for any future SMS gateway, transport partner, or NBTP data-sharing integration.
12. **Data Retention & Disposal Policy** — public requests: 12 months then anonymize; abuse-flagged records: 24 months; unit traceability records: long-term (blood-bank norms require years of traceability); donor account deletion honors erasure requests while preserving legally required transfusion traceability via pseudonymization.
13. **Anti-Abuse & Trust Policy** — governs the public request page: rate limits, phone-number reputation, admin review SLAs, honest labeling (Unverified / Document Attached / Hospital-Confirmed), appeal path for wrongly flagged requesters.

---

# PART 3 — TESTING STRATEGY (MODULE, SECURITY, STRESS)

## 3.1 Module (unit) testing — each module tested individually

| Module | What to test | Tooling |
|---|---|---|
| Firestore Security Rules | Every allow/deny path per role — the single most important test suite in the system | `@firebase/rules-unit-testing` + Firebase Emulator Suite |
| Cloud Functions | Input validation, authz checks, transactional integrity, idempotency | Jest/Vitest + `firebase-functions-test` + emulator |
| Matching engine | Radius matching correctness, blood-type compatibility matrix (incl. inverted plasma rules), only `cleared` units counted | Pure-function unit tests with fixture data |
| Escalation engine | Timer thresholds, radius widening steps, admin flagging, obstetric fast-track priority | Emulated scheduled runs with fake clock |
| Public request intake | Schema validation, rate limiting, label assignment, hospital notification | Emulator integration tests |
| Auth/IAM flows | Role grant/revoke, claim propagation, token revocation on suspension, MFA enrollment | Emulator + Admin SDK tests |
| Frontend | Role-based UI rendering (defense in depth only — never the security boundary) | Vitest + Testing Library |

**Coverage gates:** 90%+ on Security Rules paths and Cloud Functions authz branches; 80%+ overall. A rules change with untested paths fails CI.

**Rules test matrix (illustrative — full suite in Appendix A companion file):** for each collection × each role × each action (get/list/create/update/delete), assert the expected allow/deny, including hostile cases: donor reading another donor, staff reading another hospital's stock, staff self-escalating role, client writing to audit logs, unauthenticated writes anywhere except `public_requests`, lab_tech making an illegal status jump (`rejected → cleared`).

## 3.2 Security testing

- **SAST:** Semgrep (+ ESLint security plugins) on every PR.
- **Dependency scanning:** `npm audit` + Dependabot/Renovate; severity SLAs per Policy 7.
- **Secret scanning:** gitleaks in CI + GitHub push protection.
- **DAST:** OWASP ZAP baseline scan against the staging URL in the pipeline.
- **Abuse-case testing:** scripted attempts against staging — mass fake public requests, IDOR attempts on request/unit IDs, token replay after suspension, App Check bypass attempts.
- **Manual penetration test:** before public launch and annually; scope includes the public request page, auth, and Firestore rules; findings tracked to closure per SLA.
- **OWASP ASVS L2 checklist** review signed off by you before go-live.

## 3.3 Stress & load testing

Tooling: **k6** (primary) against a dedicated staging Firebase project, plus Firebase Emulator for cheap early iterations.

**Realistic scenarios (derived from the findings document):**

| Scenario | Model | Pass criteria |
|---|---|---|
| S1 — Mass-casualty spike | 50 simultaneous urgent requests in one city in 5 min; alert fan-out to 2,000 matched donors | p95 request-creation < 2s; 100% of alerts dispatched < 60s; zero dropped |
| S2 — Public page surge (news-driven) | Ramp 0→500 RPS on `submitPublicRequest` for 10 min (mirrors the March 2026 Yaoundé near-zero-stock news moment) | Legitimate requests succeed; rate limiter sheds abuse without collapsing; p95 < 3s |
| S3 — Donor response stampede | 500 donors accept/decline the same request within 30s | Exactly-once accept semantics hold; no double-assignment; stock counters consistent |
| S4 — Escalation storm | 200 unanswered urgent requests hit escalation simultaneously | Scheduled function completes within its window; no missed escalations |
| S5 — Inventory consistency | 100 concurrent stock mutations on one hospital via transfers + transfusions | Zero lost updates; final count exact (transactions hold) |
| S6 — Degraded network | Clients on simulated 2G/high-latency links (k6 network profiles) | Graceful timeouts; retries idempotent; no duplicate requests created |
| Soak | 24h at expected steady load | No memory/quota creep; error rate < 0.1% |

Also verify **Firebase quota headroom** (Firestore writes/sec per document, FCM throughput) and set billing/quota alerts — hitting a quota mid-emergency is a patient-safety incident, not just an outage.

---

# PART 4 — CI/CD PIPELINE WITH SECURITY GATES

Pipeline (GitHub Actions reference implementation in companion file `ci-cd-pipeline.yml`):

```
PR opened
 ├─ Lint + typecheck
 ├─ Secret scan (gitleaks)            [BLOCKING]
 ├─ SAST (Semgrep)                    [BLOCKING on high]
 ├─ Dependency audit                  [BLOCKING on critical/high]
 ├─ Unit tests + coverage gates       [BLOCKING]
 ├─ Firestore Rules tests (emulator)  [BLOCKING]
 └─ Build
merge to main
 ├─ All of the above re-run
 ├─ Deploy to STAGING (rules → functions → hosting, in that order)
 ├─ Integration tests vs staging
 ├─ OWASP ZAP baseline scan           [BLOCKING on high]
 └─ Smoke k6 load test (S1 reduced)
release tag + manual approval (protected environment)
 ├─ Deploy to PRODUCTION
 ├─ Post-deploy smoke tests
 └─ Automatic rollback on failed smoke
```

**Non-negotiable pipeline rules:**
- Branch protection on `main`: PR + 1 review required; **2 reviews for changes to `firestore.rules`, auth code, or Cloud Functions authz** (per SDLC policy).
- Deploy credentials via Workload Identity Federation or a least-privilege deployer service account stored in GitHub Environments — never personal tokens, never in repo.
- Separate Firebase projects: `vitalpulse-dev` / `vitalpulse-staging` / `vitalpulse-prod`. No shared data; staging uses synthetic data only (never real PHI).
- Rules deploy **before** functions/hosting so a new feature never runs against stale permissions.
- Every production deploy is tagged, changelogged, and reversible (`firebase hosting:rollback` + keep N-1 functions deployable).

# PART 5 — PRE-DEPLOYMENT GO-LIVE CHECKLIST

**Security (owner: you)**
- [ ] Hardcoded admin secret removed from code AND git history; all admin accounts audited and rotated
- [ ] Firestore rules deny-by-default verified; full rules test suite green
- [ ] All privileged writes only via Cloud Functions; direct-write attempts denied in staging tests
- [ ] MFA enforced for all privileged roles; token revocation on suspension verified
- [ ] App Check enforced on Firestore, Functions, Storage
- [ ] Rate limiting live on public request intake + auth endpoints
- [ ] Audit logging live, append-only, alerting configured
- [ ] Pen test complete; all critical/high findings closed
- [ ] ZAP + ASVS L2 checklist signed off

**Compliance & policy**
- [ ] All 13 policies approved and version-controlled; privileged users acknowledged AUP
- [ ] Bilingual (EN/FR) privacy notice + consent flows live
- [ ] Data-processing records + Firebase/Google DPA on file
- [ ] Incident response plan tested with one tabletop exercise (recommended scenario: leaked staging credentials + fake public requests during a real shortage)
- [ ] Breach notification contacts confirmed (ANTIC / ministry / partners)

**Reliability**
- [ ] All k6 scenarios S1–S6 + soak passed on staging
- [ ] Backups running; one restore drill completed
- [ ] Quota + billing alerts configured; error monitoring (Crashlytics / Cloud Monitoring) with on-call alerting
- [ ] Rollback rehearsed once end-to-end

**Operational**
- [ ] Domain + TLS, security headers (CSP, HSTS) on hosting
- [ ] security@ disclosure contact published
- [ ] Runbooks written: alert fan-out failure, escalation-engine failure, Firestore outage degraded mode

---

*Companion files: `VitalPulse_Security_Policies.md` (full policy texts), `firestore.rules` (reference implementation), `firestore.rules.test.js` (rules test suite starter), `ci-cd-pipeline.yml` (GitHub Actions), `k6-stress-tests.js` (load scenarios).*
