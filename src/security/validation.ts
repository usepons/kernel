/** Zod-based validation for module permission declarations. */

import { z } from 'npm:zod@^3.24';
import type { ModulePermissions } from './types.ts';

// ─── Zod Schema ──────────────────────────────────────────────────

const stringArraySchema = z.array(z.string()).optional().default([]);

export const modulePermissionsSchema = z.object({
  net: stringArraySchema,
  read: stringArraySchema,
  write: stringArraySchema,
  env: z.array(z.string().refine(s => !s.includes('*'), { message: 'Glob patterns not allowed in env — use exact names' })).optional().default([]),
  run: stringArraySchema,
  sys: stringArraySchema,
}).strict();

/**
 * Validate a permissions block from module.json.
 * Returns the parsed permissions or throws on invalid input.
 */
export function validatePermissions(raw: unknown): ModulePermissions {
  return modulePermissionsSchema.parse(raw);
}
