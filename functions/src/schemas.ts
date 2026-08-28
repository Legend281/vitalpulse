import { z } from 'zod';
import { ROLES } from './roles';

// Firebase UIDs and our hospitalId scoping values are never legitimately
// whitespace-padded or whitespace-only; reject rather than silently trim so
// a caller's mistake fails loudly instead of producing a subtly-wrong ID.
const idString = z.string().min(1).regex(/^\S+$/, 'must not contain whitespace');

export const grantRoleSchema = z
  .object({
    targetUid: idString,
    role: z.enum(ROLES),
    hospitalId: idString.optional(),
  })
  .strict();

export type GrantRoleInput = z.infer<typeof grantRoleSchema>;

export const revokeRoleSchema = z
  .object({
    targetUid: idString,
    suspend: z.boolean().optional().default(false),
  })
  .strict();

export type RevokeRoleInput = z.infer<typeof revokeRoleSchema>;

export const suspendUserSchema = z
  .object({
    targetUid: idString,
    suspend: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type SuspendUserInput = z.infer<typeof suspendUserSchema>;

export const hospitalStatusSchema = z
  .object({
    hospitalId: idString,
    active: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type HospitalStatusInput = z.infer<typeof hospitalStatusSchema>;

// SHA-256 hex digests are exactly 64 lowercase hex chars (see auth.js hashNationalId).
export const cniHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-char hex SHA-256 digest');

export const checkDuplicateCniSchema = z
  .object({
    cniHash: cniHashSchema,
  })
  .strict();

export type CheckDuplicateCniInput = z.infer<typeof checkDuplicateCniSchema>;

// Inventory — Phase 3 / Master Plan 1.5 "updateInventory". Real schema has no
// separate bloodUnits collection; each (hospital, bloodType) doc holds a
// `batches[]` array with its own lab-test lifecycle (see db.js's
// computeInventoryAggregates). hospitalId/hospitalName are both optional here:
// hospital-scoped callers (hospital_staff/hospital_admin/lab_tech) are always
// resolved from their own claim server-side and any client-supplied value is
// ignored; only system_admin's admin-proxy flows (including proxying for a
// shadow/unregistered hospital, which has no Firebase UID) actually use them.
export const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'] as const;

const bloodTypeSchema = z.enum(BLOOD_TYPES);
const positiveIntUnits = z.number().int().positive().max(10000);

const targetHospitalFields = {
  hospitalId: idString.optional(),
  hospitalName: z.string().trim().min(1).max(200).optional(),
};

export const addInventoryStockSchema = z
  .object({
    ...targetHospitalFields,
    bloodType: bloodTypeSchema,
    units: positiveIntUnits,
    componentType: z.string().trim().min(1).max(60).optional(),
    expiresAt: z.string().trim().min(1).optional(),
    testStatus: z.enum(['Waiting for Lab Test', 'Cleared']).optional(),
    sourceDonationId: idString.optional(),
  })
  .strict();

export type AddInventoryStockInput = z.infer<typeof addInventoryStockSchema>;

export const deductInventoryStockSchema = z
  .object({
    ...targetHospitalFields,
    bloodType: bloodTypeSchema,
    units: positiveIntUnits,
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export type DeductInventoryStockInput = z.infer<typeof deductInventoryStockSchema>;

export const resolveLabTestSchema = z
  .object({
    ...targetHospitalFields,
    bloodType: bloodTypeSchema,
    batchId: idString,
    result: z.enum(['Cleared', 'Rejected, Not Safe']),
    rejectionReason: z.string().trim().max(500).optional(),
    labTechName: z.string().trim().max(120).optional(),
    screeningResults: z.record(z.string(), z.unknown()).optional(),
    componentType: z.string().trim().min(1).max(60).optional(),
    expiryDate: z.string().trim().min(1).optional(),
  })
  .strict();

export type ResolveLabTestInput = z.infer<typeof resolveLabTestSchema>;

export const setInventoryThresholdSchema = z
  .object({
    ...targetHospitalFields,
    bloodType: bloodTypeSchema,
    threshold: z.number().int().min(0).max(10000),
  })
  .strict();

export type SetInventoryThresholdInput = z.infer<typeof setInventoryThresholdSchema>;

// issueBloodToPatient — Phase 3 / Master Plan 1.5, deferred from the original
// updateInventory pass. crossmatchConfirmed/crossmatchResult are z.literal,
// not just z.boolean()/z.enum(): the client's old "CRITICAL MEDICAL SAFETY
// GATE" check (db.js) was a plain JS `if` a hostile client could skip
// entirely by calling the SDK directly. Making the gate a schema literal
// means any payload that isn't exactly { crossmatchConfirmed: true,
// crossmatchResult: 'Compatible' } is rejected by zod before the handler
// runs — the gate can no longer be bypassed by calling the function with a
// different payload shape.
export const issueBloodToPatientSchema = z
  .object({
    ...targetHospitalFields,
    bloodType: bloodTypeSchema,
    units: positiveIntUnits,
    patientName: z.string().trim().min(1).max(200),
    patientId: z.string().trim().max(100).optional(),
    patientBloodType: bloodTypeSchema.optional(),
    ward: z.string().trim().max(120).optional(),
    requestingDoctor: z.string().trim().max(120).optional(),
    requestingPhysicianName: z.string().trim().min(2).max(150),
    diagnosis: z.string().trim().max(500).optional(),
    crossmatchConfirmed: z.literal(true),
    crossmatchResult: z.literal('Compatible'),
    crossmatchTechnician: z.string().trim().max(120).optional(),
  })
  .strict();

export type IssueBloodToPatientInput = z.infer<typeof issueBloodToPatientSchema>;

export const staffRoleEnum = z.enum(['reception', 'nurse', 'hospital_staff', 'lab_tech', 'hospital_admin']);

export const createStaffAccountSchema = z
  .object({
    ...targetHospitalFields,
    name: z.string().trim().min(2).max(150),
    email: z.string().trim().email(),
    roles: z.array(staffRoleEnum).min(1),
    pin: z.string().trim().regex(/^\d{4}$/, 'PIN must be exactly 4 digits').optional(),
  })
  .strict();

export type CreateStaffAccountInput = z.infer<typeof createStaffAccountSchema>;

export const verifyStaffPinSchema = z
  .object({
    ...targetHospitalFields,
    staffUid: z.string().trim().min(1),
    pin: z.string().trim().regex(/^\d{4}$/, 'PIN must be exactly 4 digits'),
  })
  .strict();

export type VerifyStaffPinInput = z.infer<typeof verifyStaffPinSchema>;

// Staff sign-in (email + PIN -> custom token). Callable while unauthenticated by
// design; see authenticateStaffDirectLoginHandler for the compensating controls.
export const staffDirectLoginSchema = z
  .object({
    email: z.string().trim().email(),
    pin: z.string().trim().regex(/^\d{4}$/, 'PIN must be exactly 4 digits'),
  })
  .strict();

export type StaffDirectLoginInput = z.infer<typeof staffDirectLoginSchema>;

// KYC / donor onboarding — Auth & Onboarding workstream (donor UI/VitalPulse_Plan_Tracker.md
// Stream B). donors/{uid} is a NEW, KYC-only collection approved 2026-08-01 (Stream A4) —
// it does not replace or duplicate anything on users/{uid}.
export const KYC_DOC_TYPES = ['national_id', 'drivers_licence', 'passport', 'other'] as const;
export const kycDocTypeSchema = z.enum(KYC_DOC_TYPES);

// C3.5: "Accepted: JPG, PNG, PDF. Max 5MB." Base64 inflates size by ~4/3, so bound the
// encoded string generously above the 5MB raw limit; submitKYC re-checks the decoded byte
// length exactly (a generous string bound alone would let a crafted payload sneak past).
const MAX_KYC_FILE_BYTES = 5 * 1024 * 1024;
const MAX_KYC_BASE64_LENGTH = Math.ceil((MAX_KYC_FILE_BYTES * 4) / 3) + 1024;

export const KYC_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

// National ID is the only doc type with two faces worth verifying (a passport/driver's
// licence is a single page) — fileBack* is optional at the object level so the other doc
// types are unaffected, then required together via superRefine specifically for national_id.
export const submitKycSchema = z
  .object({
    docType: kycDocTypeSchema,
    fileBase64: z.string().min(1).max(MAX_KYC_BASE64_LENGTH),
    fileName: z.string().trim().min(1).max(200),
    mimeType: z.enum(KYC_MIME_TYPES),
    fileBackBase64: z.string().min(1).max(MAX_KYC_BASE64_LENGTH).optional(),
    fileNameBack: z.string().trim().min(1).max(200).optional(),
    mimeTypeBack: z.enum(KYC_MIME_TYPES).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.docType === 'national_id' && (!data.fileBackBase64 || !data.fileNameBack || !data.mimeTypeBack)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'National ID verification requires both a front and back image.',
        path: ['fileBackBase64'],
      });
    }
  });

export type SubmitKycInput = z.infer<typeof submitKycSchema>;

export const reviewDonorKycSchema = z
  .object({
    targetUid: idString,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type ReviewDonorKycInput = z.infer<typeof reviewDonorKycSchema>;

// Liveness selfie — a second, separate piece of KYC evidence alongside the identity
// document. Always camera-captured client-side (getUserMedia + canvas, never a file picker
// — a gallery-sourced image proves nothing about liveness), so mimeType is pinned to
// image/jpeg rather than reusing KYC_MIME_TYPES' broader PDF/PNG allowance.
export const submitLivenessSelfieSchema = z
  .object({
    fileBase64: z.string().min(1).max(MAX_KYC_BASE64_LENGTH),
    mimeType: z.literal('image/jpeg'),
  })
  .strict();

export type SubmitLivenessSelfieInput = z.infer<typeof submitLivenessSelfieSchema>;

// B8 breach screening — k-anonymity prefix ONLY. See functions/src/checkPasswordBreach.ts's
// header comment for why: the password/hash never leaves the client, by design.
export const checkPasswordBreachSchema = z
  .object({
    prefix: z.string().regex(/^[0-9A-Fa-f]{5}$/, 'prefix must be exactly 5 hex characters'),
  })
  .strict();

export type CheckPasswordBreachInput = z.infer<typeof checkPasswordBreachSchema>;

// Stream C1 (Sign In) — resolves a "phone or email" identifier to the real email
// signInWithEmailAndPassword needs. Unauthenticated, so kept deliberately tiny.
export const resolveSignInIdentifierSchema = z
  .object({
    identifier: z.string().trim().min(1).max(320),
  })
  .strict();

export type ResolveSignInIdentifierInput = z.infer<typeof resolveSignInIdentifierSchema>;

// Custom password-reset pipeline (replaces Firebase Auth's built-in sendPasswordResetEmail —
// see functions/src/passwordReset.ts's header comment for why: a real, enforced 30-minute
// expiry and a custom sender identity, neither of which the built-in oobCode flow supports).
export const requestPasswordResetSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
  })
  .strict();

export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

const resetTokenField = z.string().regex(/^[0-9a-f]{64}$/, 'token must be a 64-character hex string');

// Read-only pre-check so reset-password.html can tell a dead link apart from a live one
// BEFORE the donor fills out a new password (matches the UX the old Firebase
// verifyPasswordResetCode + confirmPasswordReset two-step already had) — shares its
// validation logic with confirmPasswordResetSchema below via passwordReset.ts's
// validateResetToken(), not duplicated here.
export const checkPasswordResetTokenSchema = z
  .object({
    uid: idString,
    token: resetTokenField,
  })
  .strict();

export type CheckPasswordResetTokenInput = z.infer<typeof checkPasswordResetTokenSchema>;

export const confirmPasswordResetSchema = z
  .object({
    uid: idString,
    token: resetTokenField,
    newPassword: z.string().min(8).max(128),
  })
  .strict();

export type ConfirmPasswordResetInput = z.infer<typeof confirmPasswordResetSchema>;

export const adminEmailAlertSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    name: z.string().trim().max(200).optional().nullable(),
    bloodType: z.string().trim().max(50).optional().nullable(),
    city: z.string().trim().max(100).optional().nullable(),
    phone: z.string().trim().max(50).optional().nullable(),
    email: z.string().trim().max(150).optional().nullable(),
    urgency: z.string().trim().max(50).optional().nullable(),
    details: z.string().trim().max(2000).optional().nullable(),
    actionUrl: z.string().trim().url().optional().nullable(),
    eventType: z.string().trim().max(100).optional().nullable(),
    toEmail: z.string().trim().email().optional().nullable(),
    customApiKey: z.string().trim().max(200).optional().nullable()
  })
  .strict();

export type AdminEmailAlertInput = z.infer<typeof adminEmailAlertSchema>;
