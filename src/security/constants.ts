/** Shared permission field names used throughout the kernel security system. */

import type { ModulePermissions } from './permissions.ts';

export const PERMISSION_FIELDS: readonly (keyof ModulePermissions)[] = [
  'net', 'read', 'write', 'env', 'run', 'sys',
] as const;

/** Environment variables allowed for all modules without explicit declaration. */
export const COMMON_ENV_ALLOWLIST = [
  'DEBUG',
  'HOME',
  'USERPROFILE',
  'PONS_HOME',
  'NODE_ENV',
  'LANG',
  'TERM',
  'TZ',
] as const;
