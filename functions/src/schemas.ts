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
