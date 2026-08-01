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
