/**
 * Security Permission Model — types, validation, Deno flag translation, and persistence.
 *
 * Defines the permission schema that modules must declare in their module.json,
 * translates declared permissions into Deno CLI flags, and manages user-approved
 * permissions in ~/.pons/permissions.yaml.
 */

import { dirname, join } from 'jsr:@std/path@^1';
import { encodeHex } from 'jsr:@std/encoding@^1/hex';
import { crypto as stdCrypto } from 'jsr:@std/crypto@^1';
import { z } from 'npm:zod@^3.24';
import { parse as parseYaml, stringify as stringifyYaml } from 'npm:yaml@^2.7.1';
import { getPonsHome } from '@pons/sdk';

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
  action: 'deny' | 'kill';
}

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

// ─── Binary Resolution ──────────────────────────────────────────

/**
 * Check whether a binary exists on the host by attempting to resolve it.
 * Returns true if the binary is found in PATH, false otherwise.
 */
function binaryExists(name: string): boolean {
  try {
    const cmd = Deno.build.os === 'windows' ? 'where' : 'which';
    const result = new Deno.Command(cmd, {
      args: [name],
      stdout: 'null',
      stderr: 'null',
    }).outputSync();
    return result.success;
  } catch {
    return false;
  }
}

// ─── Deno Flag Translation ──────────────────────────────────────

/**
 * Convert declared permissions into Deno CLI permission flags.
 * Never produces --allow-all.
 *
 * Relative paths in read/write permissions are resolved against moduleDir
 * (the directory containing the module's runner). This lets modules declare
 * "." to mean "my own directory" and have it translate to an absolute path.
 *
 * Run permissions are resolved lazily: binaries not found on the host
 * are silently omitted from --allow-run. This lets modules declare all
 * binaries they *may* call without requiring every one to be installed.
 */
export function translateToDenoFlags(permissions: ModulePermissions, moduleDir?: string): string[] {
  const flags: string[] = [];

  const home = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '';
  const expandTilde = (p: string): string => p.startsWith('~/') ? join(home, p.slice(2)) : p;
  const resolvePaths = (paths: string[]): string[] =>
    paths.map(p => {
      const expanded = expandTilde(p);
      return expanded.startsWith('/') ? expanded : (moduleDir ? join(moduleDir, expanded) : expanded);
    });

  // net
  if (permissions.net && permissions.net.length > 0) {
    flags.push(`--allow-net=${permissions.net.join(',')}`);
  } else {
    flags.push('--deny-net');
  }

  // read
  if (permissions.read && permissions.read.length > 0) {
    flags.push(`--allow-read=${resolvePaths(permissions.read).join(',')}`);
  } else {
    flags.push('--deny-read');
  }

  // write
  if (permissions.write && permissions.write.length > 0) {
    flags.push(`--allow-write=${resolvePaths(permissions.write).join(',')}`);
  } else {
    flags.push('--deny-write');
  }

  // env — exact names only, no globs
  if (permissions.env && permissions.env.length > 0) {
    flags.push(`--allow-env=${permissions.env.join(',')}`);
  } else {
    flags.push('--deny-env');
  }

  // run — only include binaries found in PATH
  if (permissions.run && permissions.run.length > 0) {
    const DANGEROUS_BINARIES = new Set(['sh', 'bash', 'zsh', 'fish', 'csh', 'dash', 'cmd', 'powershell', 'pwsh', 'python', 'python3', 'node', 'ruby', 'perl']);
    const available = permissions.run.filter(binaryExists);
    const dangerous = available.filter(b => DANGEROUS_BINARIES.has(b));
    if (dangerous.length > 0) {
      console.warn(`[security] Module requests shell interpreters: ${dangerous.join(', ')} — these can bypass Deno sandbox restrictions`);
    }
    if (available.length > 0) {
      flags.push(`--allow-run=${available.join(',')}`);
    } else {
      flags.push('--deny-run');
    }
  } else {
    flags.push('--deny-run');
  }

  // sys — specific keys
  if (permissions.sys && permissions.sys.length > 0) {
    flags.push(`--allow-sys=${permissions.sys.join(',')}`);
  } else {
    flags.push('--deny-sys');
  }

  return flags;
}

// ─── Manifest Hash ──────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a module.json file for tamper detection.
 */
export function computeManifestHash(manifestPath: string): string {
  const content = Deno.readTextFileSync(manifestPath);
  const data = new TextEncoder().encode(content);
  const hash = stdCrypto.subtle.digestSync("SHA-256", data);
  return encodeHex(new Uint8Array(hash));
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

// ─── Permission Store ───────────────────────────────────────────

/**
 * Persistent store for user-approved module permissions.
 * Backed by ~/.pons/permissions.yaml.
 *
 * Supports base permissions (from manifest approval), dynamic permissions
 * (requested at runtime), pending requests (queued for user approval),
 * and denied requests (to prevent re-prompting).
 */
export class PermissionStore {
  private data: Record<string, ModulePermissionEntry> = {};
  private serviceProviders: Record<string, string> = {};
  private readonly filePath: string;

  constructor(ponsHome?: string) {
    const home = ponsHome || getPonsHome();
    this.filePath = join(home, 'permissions.yaml');
    this.load();
  }

  private load(): void {
    try { Deno.statSync(this.filePath); } catch {
      this.data = {};
      this.serviceProviders = {};
      return;
    }

    try {
      const raw = Deno.readTextFileSync(this.filePath);
      // deno-lint-ignore no-explicit-any
      const parsed = parseYaml(raw) as { modules?: Record<string, any>; serviceProviders?: Record<string, string> } | null;
      const rawModules = parsed?.modules ?? {};
      this.serviceProviders = parsed?.serviceProviders ?? {};

      // Migrate: handle both old format and new format
      this.data = {};
      for (const [moduleId, entry] of Object.entries(rawModules)) {
        if (entry && 'base' in entry) {
          // New format — use as-is
          this.data[moduleId] = entry as ModulePermissionEntry;
        } else if (entry && 'permissions' in entry) {
          // Old format — migrate { permissions, manifestHash, grantedAt }
          this.data[moduleId] = {
            base: entry.permissions as ModulePermissions,
            baseManifestHash: entry.manifestHash as string,
            baseGrantedAt: entry.grantedAt as string,
            dynamic: [],
            pending: [],
            denied: [],
          };
        }
      }
    } catch {
      this.data = {};
      this.serviceProviders = {};
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    try { Deno.statSync(dir); } catch { Deno.mkdirSync(dir, { recursive: true }); }
    const content = stringifyYaml({
      modules: this.data,
      serviceProviders: this.serviceProviders,
    });
    const tmpPath = this.filePath + '.tmp';
    Deno.writeTextFileSync(tmpPath, content, { mode: 0o600 });
    Deno.renameSync(tmpPath, this.filePath);
  }

  /**
   * Reload from disk. Used when permissions.yaml is modified externally
   * (e.g., by CLI permission revoke while kernel is running).
   */
  reload(): void {
    this.load();
  }

  /**
   * Backward-compatible accessor. Returns a GrantedPermission-shaped object
   * so existing code (enforcer, lifecycle, cli) continues to work.
   */
  getApproved(moduleId: string): GrantedPermission | undefined {
    const entry = this.data[moduleId];
    if (!entry) return undefined;
    return {
      permissions: entry.base,
      manifestHash: entry.baseManifestHash,
      grantedAt: entry.baseGrantedAt,
    };
  }

  isApproved(moduleId: string): boolean {
    return moduleId in this.data;
  }

  approve(moduleId: string, permissions: ModulePermissions, manifestHash: string): void {
    this.data[moduleId] = {
      base: permissions,
      baseManifestHash: manifestHash,
      baseGrantedAt: new Date().toISOString(),
      dynamic: [],
      pending: [],
      denied: [],
    };
    this.save();
  }

  /** PONS-004: Store IPC capabilities at approval time so they are kernel-controlled. */
  approveCapabilities(moduleId: string, capabilities: StoredCapabilities): void {
    if (!this.data[moduleId]) return;
    this.data[moduleId].capabilities = capabilities;
    this.save();
  }

  /** PONS-004: Retrieve kernel-stored capabilities (not self-asserted from manifest). */
  getApprovedCapabilities(moduleId: string): StoredCapabilities | null {
    const entry = this.data[moduleId];
    if (!entry) return null;
    return entry.capabilities ?? null;
  }

  revoke(moduleId: string, permissionType?: string, value?: string): boolean {
    if (!this.data[moduleId]) return false;

    if (!permissionType) {
      // Revoke all permissions for this module
      delete this.data[moduleId];
      // Also remove service provider entries for this module
      for (const [svc, provider] of Object.entries(this.serviceProviders)) {
        if (provider === moduleId) delete this.serviceProviders[svc];
      }
    } else {
      const entry = this.data[moduleId];
      const key = permissionType as keyof ModulePermissions;

      // Remove from base permissions
      if (key in entry.base && Array.isArray(entry.base[key])) {
        if (value) {
          entry.base[key] = entry.base[key]!.filter((v: string) => v !== value);
        } else {
          entry.base[key] = [];
        }
      }

      // Remove from dynamic permissions
      for (const dyn of entry.dynamic) {
        if (key in dyn.permissions && Array.isArray(dyn.permissions[key])) {
          if (value) {
            dyn.permissions[key] = dyn.permissions[key]!.filter((v: string) => v !== value);
          } else {
            dyn.permissions[key] = [];
          }
        }
      }
    }

    this.save();
    return true;
  }

  getManifestHash(moduleId: string): string | null {
    return this.data[moduleId]?.baseManifestHash ?? null;
  }

  // ─── Effective Permissions ──────────────────────────────────────

  /**
   * Compute the effective permissions for a module by merging base
   * permissions with all approved dynamic permissions.
   */
  getEffectivePermissions(moduleId: string): ModulePermissions | null {
    const entry = this.data[moduleId];
    if (!entry) return null;

    const effective: ModulePermissions = {};
    const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];

    for (const field of fields) {
      const baseValues = entry.base[field] || [];
      const dynamicValues = entry.dynamic.flatMap(d => d.permissions[field] || []);
      const merged = [...new Set([...baseValues, ...dynamicValues])];
      if (merged.length > 0) effective[field] = merged;
    }

    return effective;
  }

  // ─── Dynamic Permissions ────────────────────────────────────────

  /**
   * Add an approved dynamic permission to a module.
   */
  addDynamicPermission(moduleId: string, permissions: Partial<ModulePermissions>, reason?: string): void {
    const entry = this.data[moduleId];
    if (!entry) return;

    entry.dynamic.push({
      permissions,
      reason,
      grantedAt: new Date().toISOString(),
    });
    this.save();
  }

  // ─── Pending Requests ──────────────────────────────────────────

  /**
   * Add a pending permission request for user approval.
   * Returns the created PendingRequest with a generated UUID.
   */
  addPendingRequest(moduleId: string, permissions: Partial<ModulePermissions>, reason?: string): PendingRequest {
    const entry = this.data[moduleId];
    if (!entry) throw new Error(`Module ${moduleId} is not approved`);

    const request: PendingRequest = {
      id: crypto.randomUUID(),
      permissions,
      reason,
      requestedAt: new Date().toISOString(),
    };
    entry.pending.push(request);
    this.save();
    return request;
  }

  /**
   * Get pending requests. If moduleId is provided, returns only that module's
   * pending requests. Otherwise returns all pending across all modules.
   */
  getPendingRequests(moduleId?: string): Record<string, PendingRequest[]> {
    if (moduleId) {
      const entry = this.data[moduleId];
      if (!entry) return {};
      return { [moduleId]: entry.pending };
    }

    const result: Record<string, PendingRequest[]> = {};
    for (const [id, entry] of Object.entries(this.data)) {
      if (entry.pending.length > 0) {
        result[id] = entry.pending;
      }
    }
    return result;
  }

  /**
   * Resolve a pending request by granting or denying it.
   * Returns true if the request was found and resolved.
   */
  resolvePending(moduleId: string, requestId: string, decision: 'grant' | 'deny'): boolean {
    const entry = this.data[moduleId];
    if (!entry) return false;

    const idx = entry.pending.findIndex(p => p.id === requestId);
    if (idx === -1) return false;

    const request = entry.pending[idx];
    entry.pending.splice(idx, 1);

    if (decision === 'grant') {
      this.addDynamicPermission(moduleId, request.permissions, request.reason);
      this.removeDenied(moduleId, request.permissions);
    } else {
      entry.denied.push({
        permissions: request.permissions,
        reason: request.reason,
        deniedAt: new Date().toISOString(),
      });
      this.save();
    }

    return true;
  }

  // ─── Denied Requests ───────────────────────────────────────────

  /**
   * Check if any value in the requested permissions has been previously denied.
   * Uses per-value matching: returns true if ANY requested value appears in
   * ANY denied entry's corresponding field.
   */
  isDenied(moduleId: string, permissions: Partial<ModulePermissions>): boolean {
    const entry = this.data[moduleId];
    if (!entry || entry.denied.length === 0) return false;

    const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];
    for (const denied of entry.denied) {
      for (const field of fields) {
        const deniedValues = denied.permissions[field];
        const requestedValues = permissions[field];
        if (deniedValues && requestedValues) {
          for (const val of requestedValues) {
            if (deniedValues.includes(val)) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Remove denied entries that match the given permissions.
   * For each denied entry, removes values that match. If a denied entry
   * becomes empty (no values in any field), it is removed entirely.
   */
  removeDenied(moduleId: string, permissions: Partial<ModulePermissions>): void {
    const entry = this.data[moduleId];
    if (!entry) return;

    const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];

    entry.denied = entry.denied.filter(denied => {
      for (const field of fields) {
        const toRemove = permissions[field];
        if (toRemove && denied.permissions[field]) {
          denied.permissions[field] = denied.permissions[field]!.filter(
            (v: string) => !toRemove.includes(v)
          );
        }
      }
      // Keep the denied entry only if it still has at least one value
      return fields.some(f => denied.permissions[f] && denied.permissions[f]!.length > 0);
    });

    this.save();
  }

  /**
   * Find an existing pending request that already covers all requested permissions.
   * Returns the matching PendingRequest, or null if none found.
   */
  findExistingPending(moduleId: string, permissions: Partial<ModulePermissions>): PendingRequest | null {
    const entry = this.data[moduleId];
    if (!entry) return null;

    const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];

    for (const pending of entry.pending) {
      let allCovered = true;
      for (const field of fields) {
        const requestedValues = permissions[field];
        if (!requestedValues || requestedValues.length === 0) continue;
        const pendingValues = pending.permissions[field];
        if (!pendingValues) { allCovered = false; break; }
        for (const val of requestedValues) {
          if (!pendingValues.includes(val)) { allCovered = false; break; }
        }
        if (!allCovered) break;
      }
      if (allCovered) return pending;
    }
    return null;
  }

  // ─── First Spawn Tracking ──────────────────────────────────────

  /**
   * Record the first spawn timestamp for a module (used for onInstall hook).
   */
  setFirstSpawnAt(moduleId: string): void {
    const entry = this.data[moduleId];
    if (!entry) return;
    entry.firstSpawnAt = new Date().toISOString();
    this.save();
  }

  /**
   * Get the first spawn timestamp for a module, or null if not yet spawned.
   */
  getFirstSpawnAt(moduleId: string): string | null {
    return this.data[moduleId]?.firstSpawnAt ?? null;
  }

  // ─── Service Providers ─────────────────────────────────────────

  /** Get the module that is approved to provide a service. */
  getServiceProvider(service: string): string | null {
    return this.serviceProviders[service] ?? null;
  }

  /** Alias for getServiceProvider. */
  resolveServiceProvider(service: string): string | null {
    return this.getServiceProvider(service);
  }

  /** Register a module as the approved provider of a service. Returns false if already claimed. */
  registerServiceProvider(service: string, moduleId: string): boolean {
    const existing = this.serviceProviders[service];
    if (existing && existing !== moduleId) return false;
    this.serviceProviders[service] = moduleId;
    this.save();
    return true;
  }

  // ─── Backward-Compatible Accessors ─────────────────────────────

  /** List all approved modules and their permissions (backward-compatible). */
  listAll(): Record<string, GrantedPermission> {
    const result: Record<string, GrantedPermission> = {};
    for (const [moduleId, entry] of Object.entries(this.data)) {
      result[moduleId] = {
        permissions: entry.base,
        manifestHash: entry.baseManifestHash,
        grantedAt: entry.baseGrantedAt,
      };
    }
    return result;
  }

  /** Get all module IDs that have approved permissions. */
  approvedModuleIds(): string[] {
    return Object.keys(this.data);
  }
}
