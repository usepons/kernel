/** Security permission types for the kernel module system. */

// ─── Permission Types ────────────────────────────────────────────

export interface ModulePermissions {
  net?: string[];
  read?: string[];
  write?: string[];
  env?: string[];
  run?: string[];
  sys?: string[];
}

export interface GrantedPermission {
  permissions: ModulePermissions;
  manifestHash: string;
  grantedAt: string;
}

export type SecurityViolationType = 'rpc' | 'topic' | 'config';

export interface SecurityViolation {
  timestamp: string;
  moduleId: string;
  type: SecurityViolationType;
  resource: string;
  action: 'deny' | 'kill' | 'warn';
}

// ─── Extended Permission Types ──────────────────────────────────

/** IPC capabilities stored at approval time. */
export interface StoredCapabilities {
  services?: string[];
  topics?: string[];
}

export interface ModulePermissionEntry {
  base: ModulePermissions;
  baseManifestHash: string;
  baseGrantedAt: string;
  firstSpawnAt?: string;
  // PONS-004: Capabilities stored in the permission store, not self-asserted by modules
  capabilities?: StoredCapabilities;
  dynamic: ApprovedDynamicPermission[];
  pending: PendingRequest[];
  denied: DeniedRequest[];
}

export interface ApprovedDynamicPermission {
  permissions: Partial<ModulePermissions>;
  reason?: string;
  grantedAt: string;
}

export interface PendingRequest {
  id: string;
  permissions: Partial<ModulePermissions>;
  reason?: string;
  requestedAt: string;
}

export interface DeniedRequest {
  permissions: Partial<ModulePermissions>;
  reason?: string;
  deniedAt: string;
}
