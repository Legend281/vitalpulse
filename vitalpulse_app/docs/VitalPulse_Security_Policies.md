# VitalPulse Security & Governance Policy Suite

**Document owner:** Security Lead • **Version 1.1 — reviewed against the real implementation 24 Jul 2026, pending Security Lead sign-off • Review cycle: annual or after any SEV1/SEV2 incident**
**Applies to:** All VitalPulse systems, environments (dev/staging/prod), personnel, and any third party with access to VitalPulse data.

> Adapt bracketed items [like this] to your team's names/contacts. Each policy is intentionally short enough to be read and followed; detail lives in runbooks.

---

## Review & Adoption Status (2026-07-24)

This pass checked the drafted suite against `PHASE0_AUDIT.md` and the actual Phase 1/2 implementation rather than approving it as a paper exercise. A policy stating a requirement that the code doesn't meet yet is normal and expected (that gap is tracked in the Part 1 access-control checklist); the issue this review looked for is narrower — policy text that describes something as *already true or already existing* when it isn't.

- **Confirmed factually accurate today:** Policy 2 §§2/5 (server-side enforcement via Firestore Rules, separation of duties — live since Phase 2); Policy 5 §3 (audit logs are append-only with no client write path — true since Phase 2 locked both `auditLogs` and `activity_logs`).
- **Reframed as forward-looking, not current-state** (the features they describe don't exist in the app yet, per `PHASE0_AUDIT.md` §6 / Phase 2 completion notes — adopting the policy now avoids a gap at launch, but it isn't describing today's app): Policy 3 §3's public-request-page field list, the blood-unit-traceability row in Policy 12's retention table, and all of Policy 13 (governs the public request page). Wording adjusted below; re-check against the real shape once each feature ships.
- **Gap this review surfaced that wasn't previously tracked:** Policy 4 requires Restricted-PHI exports to go only through an "approved, logged admin function." Today's admin dashboard CSV export (donor directory, `issuance_log`) is a plain client-side download with no Cloud Function and no audit entry (`PHASE0_AUDIT.md` §5). No Cloud Function in the Part 1.5 checklist currently covers this — added as a new line item there. Likewise, Policy 8 §1's "2 reviewers on rules/auth/authz changes" isn't a live GitHub branch-protection setting yet — added to the Part 4 checklist so it isn't dropped before CI/CD stands up.
- **Placeholders left bracketed on purpose — these need you, not an engineering guess:** `[security@vitalpulse]` / `[privacy@vitalpulse]` contact addresses (Policies 3, 6, 7, 10); `[ANTIC / ministry contact]` (Policy 6); the Incident Commander deputy and Communications owner names (Policy 6); and the approval signatures at the end of this document. The French half of Policy 3's bilingual consent notice also hasn't been drafted — only English exists so far.

---

## POLICY 1 — Information Security Policy (Master)

**Purpose.** VitalPulse coordinates life-critical blood donation in Cameroon and processes restricted health data. Security failures here are patient-safety failures. This policy establishes the Information Security Management System (ISMS).

**Objectives.**
1. Protect confidentiality, integrity, and availability of all VitalPulse data, with health data (PHI) as the highest class.
2. Comply with Cameroon Law No. 2010/012 on Cybersecurity and Cybercriminality, Cameroon's personal data protection law, and align with the AU Malabo Convention, GDPR principles, ISO/IEC 27001, and WHO blood-safety/hemovigilance guidance.
3. Ensure the platform remains available and correct during emergencies — availability is a safety property for this system.

**Governance.** The Security Lead owns this ISMS, chairs a quarterly security review, maintains the risk register, and reports risks to the team. Every team member is responsible for security within their work; the Secure Development Policy (Policy 8) binds all contributors.

**Risk appetite.** Zero tolerance for: unverified blood counted as available stock, client-side-only authorization, PHI in logs/URLs/notifications, or unreviewed changes to authorization code. Low tolerance elsewhere; risks accepted only in writing by the Security Lead with expiry dates.

**Enforcement.** Violations trigger access suspension pending review. This policy is a condition of system access for staff, hospital users, and vendors.

---

## POLICY 2 — Access Control Policy

1. **Least privilege & deny by default.** All access denied unless explicitly granted. Roles: donor, hospital_staff, lab_tech, hospital_admin, system_admin, nbtp_viewer (definitions in the Security Master Plan, Part 1).
2. **Server-side enforcement only.** Authorization is enforced by Firestore Security Rules and Cloud Functions. Frontend checks are usability features, never security controls.
3. **Provisioning.** Privileged roles are granted only via the server-side `grantRole` function by an authorized grantor (system_admin globally; hospital_admin for staff/lab roles at their own hospital). No self-service elevation path may exist in any codebase. The historical sign-up admin code is permanently banned.
4. **Authentication.** MFA is mandatory for lab_tech, hospital_admin, system_admin, nbtp_viewer. Passwords: minimum 12 characters, breach-screened, rate-limited.
5. **Separation of duties.** Request creation (hospital_staff) and test clearance (lab_tech) must be different capabilities; hospital verification is external to the hospital (system_admin only); audit logs are writable by system processes only.
6. **Reviews.** Quarterly access review of all privileged accounts; results recorded. Dormant privileged accounts (90 days) suspended automatically.
7. **Termination.** On role change/exit: claims updated, refresh tokens revoked within 1 hour.
8. **No shared accounts.** Each human = one identity. Shared credentials void the audit trail and are prohibited.

---

## POLICY 3 — Data Protection & Privacy Policy

1. **Lawful basis & consent.** Donors consent at registration to processing of identity, contact, blood type, and donation history for the purpose of blood-donation coordination. Public requesters consent to processing of the submitted details for fulfilling the request and abuse prevention. Consent notices are provided in **English and French**, in plain language.
2. **Special-category data.** Blood type, screening answers, disease-test results, and transfusion reactions are Restricted-PHI (Policy 4) with the tightest access controls.
3. **Minimization.** Collect only fields defined in the product specification. *(Forward-looking: once the public request page ships — it does not exist in the app today, PHASE0_AUDIT.md §6 — it must collect exactly: patient name, hospital + ward, blood type, urgency, submitter phone, optional proof photo, optional device location. No additional fields without a privacy review.)*
4. **Purpose limitation.** Data is used only for coordination, safety monitoring (hemovigilance), and abuse prevention. No sale or advertising use, ever. Aggregated, de-identified statistics may be shared with the National Blood Transfusion Program under a signed agreement (Policy 11).
5. **Data subject rights.** Any person may request access, correction, or deletion via [privacy@vitalpulse]. Fulfillment ≤ 30 days. Deletion is honored via anonymization where blood-unit traceability must be preserved (Policy 12).
6. **Transparency to donors.** Verification labels shown to donors (Unverified / Document Attached / Hospital-Confirmed) must always be truthful; the platform must never imply verification it did not perform.
7. **Children.** Donor registration requires being of eligible donation age; underage registrations are removed on detection.
8. **Cross-border.** Data is hosted on Google Cloud under a Data Processing Agreement; any change of processor or region requires a documented transfer assessment.

---

## POLICY 4 — Data Classification & Handling Policy

| Class | Examples | Handling |
|---|---|---|
| Public | Educational content, verified-hospital list, aggregate national statistics | Freely publishable |
| Internal | Non-sensitive configs, feature docs | Team access, not published |
| Confidential | Donor contact info, request metadata, audit logs | Role-scoped access; encrypted transit; no export without approval |
| **Restricted-PHI** | Blood type, screening answers, lab test results, transfusion/donor reaction logs, patient identity in requests | Minimum-necessary role access; every read/write audited; never in URLs, client logs, error messages, analytics, or push-notification payloads; exports only via approved, logged admin function |

Screenshots or data extracts of Confidential/Restricted data may not be shared in chats, tickets, or demos; use synthetic data. Production data never enters dev/staging.

---

## POLICY 5 — Audit Logging & Monitoring Policy

1. **Logged events:** all authentication events (success/failure/MFA), all role grants/revocations, all Restricted-PHI reads and writes, all privileged actions (alert dispatch, inventory mutation, transfer approval, request-review decisions, escalations), all admin queue decisions.
2. **Log content:** actor UID, role, action, target resource, timestamp, request origin. **Never** log PHI values themselves — log references (unit ID, request ID).
3. **Integrity:** logs are written exclusively by Cloud Functions to an append-only store; no client or console write path; retention **≥ 12 months** (unit-traceability events retained per Policy 12).
4. **Monitoring & alerting:** real-time alerts for: repeated auth failures, role-grant events, suspended-token usage attempts, abnormal read volumes of PHI, escalation-engine failures, quota approach. Weekly log review by the Security Lead; findings recorded.
5. **Clock discipline:** all services use synchronized UTC timestamps (audit and escalation correctness depend on it).

---

## POLICY 6 — Incident Response & Breach Notification Policy

**Severity matrix.**
- **SEV1:** confirmed PHI breach; platform down or alert dispatch failing while urgent requests are active; audit-log tampering.
- **SEV2:** vulnerability exploitable for PHI access; privileged account compromise (contained); sustained abuse defeating rate limits.
- **SEV3:** non-PHI bug with security relevance; failed control found in review.

**Response steps (all severities):** Detect → Triage (assign severity, open incident record) → Contain (suspend accounts/keys, disable endpoint, rules hotfix) → Eradicate → Recover → **Post-incident review within 5 working days** with tracked corrective actions.

**Roles:** Incident Commander = Security Lead (deputy: [name]). Communications owner = [name]. Every incident gets a timeline log from first detection.

**Notification clock:** internal escalation immediately; for personal-data breaches, notify the competent Cameroonian authority [ANTIC / ministry contact] and affected persons **within 72 hours** of confirmation, with plain-language EN/FR notices describing what happened, what data, and what to do. Hospital partners on affected data are notified in the same window.

**Special rule for this system:** if alert dispatch or escalation is down, the degraded-mode runbook (Policy 9) is activated *in parallel with* technical response — patient-facing continuity is never queued behind forensics.

---

## POLICY 7 — Vulnerability & Patch Management Policy

1. Automated dependency scanning on every PR and nightly (npm audit + Renovate/Dependabot).
2. **Remediation SLAs:** Critical: 48 hours. High: 7 days. Medium: 30 days. Low: next planning cycle. SLA clock starts at detection.
3. SAST (Semgrep) and secret scanning (gitleaks) run on every PR; new high findings block merge.
4. DAST (OWASP ZAP) runs on every staging deploy; manual penetration test before launch and annually thereafter.
5. **Coordinated disclosure:** [security@vitalpulse] published; good-faith researchers acknowledged, fixes per SLA, no legal threats for good-faith reports.
6. Firebase/GCP platform advisories reviewed weekly by the Security Lead.

---

## POLICY 8 — Secure Development Policy (SDLC)

1. All changes via pull request; `main` is protected. **Changes to `firestore.rules`, authentication code, or any Cloud Function performing authorization require two approving reviews**, one of them the Security Lead.
2. No secrets in source code, config files, or git history — enforced by CI secret scanning and push protection. Secrets live in GitHub Environments / Secret Manager.
3. Every feature touching Restricted-PHI receives a lightweight threat model (data flow, trust boundaries, abuse cases) before implementation.
4. Test gates (unit, rules, coverage) are blocking; disabling a failing security test to merge is prohibited.
5. Dev/staging use synthetic data only. Feature branches never receive production credentials.
6. Third-party packages: prefer well-maintained libraries; new dependencies reviewed for maintenance status and known CVEs.

---

## POLICY 9 — Business Continuity & Disaster Recovery Policy

1. **Objectives:** RPO ≤ 24h (daily automated Firestore exports to a locked bucket, 35-day retention). RTO ≤ 4h for core request/matching capability.
2. **Restore drills:** quarterly restore test into an isolated project; results recorded.
3. **Degraded mode (patient-safety continuity):** if matching/alerting is unavailable, hospitals must still be able to obtain matched-donor contact lists through the documented emergency export procedure executed by system_admin; the outage banner instructs hospitals to phone donors directly. This runbook is printed/offline-accessible.
4. **Single points of failure:** at least two people can deploy, rotate keys, and execute the DR runbook — never only one.
5. Ties to product roadmap: offline-first client behavior (findings §10.2) is a continuity control and is tracked here as well as in product planning.

---

## POLICY 10 — Acceptable Use Policy (hospital & admin users)

Users must: keep credentials personal and secret; use VitalPulse data only for patient care and blood coordination; report suspected incidents to [security@] immediately; not attempt to access other hospitals' data; not export or photograph Restricted-PHI outside approved functions; not create requests known to be false. Violations lead to suspension and, where relevant, referral to the hospital's management and authorities under Law No. 2010/012.

---

## POLICY 11 — Third-Party & Vendor Security Policy

1. Current processors: Google (Firebase/GCP) under DPA — reviewed annually.
2. Any new vendor touching VitalPulse data (SMS gateway, transport/logistics partner, analytics) must pass the vendor checklist before integration: data accessed & minimized, security posture (certifications, breach history), DPA signed, retention/deletion terms, exit plan.
3. **Data sharing with the National Blood Transfusion Program / CNTS:** aggregated or pseudonymized safety statistics only, under a signed data-sharing agreement specifying purpose, fields, cadence, and security requirements. Raw PHI is never shared without explicit legal basis and Security Lead sign-off.
4. Open-source components are "vendors" for risk purposes and are covered by Policy 7 scanning.

---

## POLICY 12 — Data Retention & Disposal Policy

| Data | Retention | Then |
|---|---|---|
| Public/unauthenticated requests | 12 months | Anonymize (keep aggregate stats) |
| Abuse-flagged requests & phone reputation | 24 months | Delete |
| Blood-unit traceability chain (donated→tested→cleared→transfused) & hemovigilance records — *reserved: no per-unit lifecycle exists yet, inventory today is an aggregate count per hospital+blood type (PHASE0_AUDIT.md §6); apply this row once a `bloodUnits` model ships* | **≥ 10 years** (blood-bank traceability norm; align with ministry guidance when partnership formalizes) | Archive, pseudonymized |
| Donor accounts | Life of account | On deletion request: erase identity fields; pseudonymize unit-traceability links |
| Audit logs | ≥ 12 months (privileged/PHI events: 24 months) | Delete |
| Backups | 35 days rolling | Auto-expire |

Disposal = cryptographic deletion / verified removal including backups at expiry. An annual retention audit confirms schedules execute.

---

## POLICY 13 — Anti-Abuse & Trust Policy (public request page)

> *The public request page does not exist in the app yet (PHASE0_AUDIT.md §6). This policy is adopted ahead of the build so there's no governance gap at launch — it does not describe current behavior.*

1. **Never block, always label.** Requests are shown to donors immediately with honest labels (Unverified / Document Attached / Hospital-Confirmed). VitalPulse never fabricates or implies verification.
2. **Rate limits:** per phone number and per device/IP on submission; thresholds tuned from staging stress tests and reviewed monthly.
3. **Review SLA:** every public request enters the admin review queue; review within [24h]; confirmed-fake submitters are blocked by phone reputation, and repeat abuse reported where appropriate.
4. **Appeals:** a wrongly blocked requester may appeal via [contact]; resolution ≤ 72h.
5. **Abuse metrics** (fake-rate, time-to-review, block accuracy) are reviewed monthly and reported in the quarterly security review — trust of donors is a measurable asset, not a slogan.

---

*End of policy suite. Approval record: [Security Lead signature/date] [Team lead signature/date]*
