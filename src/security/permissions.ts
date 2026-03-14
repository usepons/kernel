/**
 * Security Permission Model — types, validation, Deno flag translation, and persistence.
 *
 * Defines the permission schema that modules must declare in their module.json,
 * translates declared permissions into Deno CLI flags, and manages user-approved
 * permissions in ~/.pons/permissions.yaml.
 */

import { dirname, join } from 'jsr:@std/path';
import { encodeHex } from 'jsr:@std/encoding/hex';
import { z } from 'npm:zod@^3.24';
import { parse as parseYaml, stringify as stringifyYaml } from 'npm:yaml@^2.7.1';
import { getPonsHome } from 'jsr:@pons/sdk@^0.2';

// ─── Permission Types ────────────────────────────────────────────

export interface ModulePermissions {
  net?: string[];
  read?: string[];
  write?: string[];
  env?: string[];
  run?: string[];
  services?: string[];
  topics?: string[];
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
  env: stringArraySchema,
  run: stringArraySchema,
  services: stringArraySchema,
  topics: stringArraySchema,
}).strict();

/**
 * Validate a permissions block from module.json.
 * Returns the parsed permissions or throws on invalid input.
 */
export function validatePermissions(raw: unknown): ModulePermissions {
  return modulePermissionsSchema.parse(raw);
}

// ─── Deno Flag Translation ──────────────────────────────────────

/**
 * Convert declared permissions into Deno CLI permission flags.
 * Never produces --allow-all.
 */
export function translateToDenoFlags(permissions: ModulePermissions): string[] {
  const flags: string[] = [];

  if (permissions.net && permissions.net.length > 0) {
    flags.push(`--allow-net=${permissions.net.join(',')}`);
  } else {
    flags.push('--deny-net');
  }

  if (permissions.read && permissions.read.length > 0) {
    flags.push(`--allow-read=${permissions.read.join(',')}`);
  } else {
    flags.push('--deny-read');
  }

  if (permissions.write && permissions.write.length > 0) {
    flags.push(`--allow-write=${permissions.write.join(',')}`);
  } else {
    flags.push('--deny-write');
  }

  if (permissions.env && permissions.env.length > 0) {
    flags.push(`--allow-env=${permissions.env.join(',')}`);
  } else {
    flags.push('--deny-env');
  }

  if (permissions.run && permissions.run.length > 0) {
    flags.push(`--allow-run=${permissions.run.join(',')}`);
  } else {
    flags.push('--deny-run');
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
  // Use @std/crypto's synchronous digestSync
  const hash = crypto.subtle as unknown as { digestSync?: (algo: string, data: Uint8Array) => ArrayBuffer };
  if (hash.digestSync) {
    return encodeHex(new Uint8Array(hash.digestSync("SHA-256", data)));
  }
  // Fallback: use Deno's built-in synchronous crypto (available via @std/crypto)
  // Run sync hash via synchronous XOR-based stub is not viable; throw to force fix
  throw new Error("computeManifestHash: digestSync not available — upgrade to @std/crypto");
}

// ─── Permission Store ───────────────────────────────────────────

/**
 * Persistent store for user-approved module permissions.
 * Backed by ~/.pons/permissions.yaml.
 */
export class PermissionStore {
  private data: Record<string, GrantedPermission> = {};
  private serviceProviders: Record<string, string> = {};
  private readonly filePath: string;

  constructor(ponsHome?: string) {
    const home = ponsHome || getPonsHome();
    this.filePath = join(home, 'permissions.yaml');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.data = {};
      this.serviceProviders = {};
      return;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = parseYaml(raw) as { modules?: Record<string, GrantedPermission>; serviceProviders?: Record<string, string> } | null;
      this.data = parsed?.modules ?? {};
      this.serviceProviders = parsed?.serviceProviders ?? {};
    } catch {
      this.data = {};
      this.serviceProviders = {};
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const content = stringifyYaml({
      modules: this.data,
      serviceProviders: this.serviceProviders,
    });
    writeFileSync(this.filePath, content, 'utf-8');
  }

  /**
   * Reload from disk. Used when permissions.yaml is modified externally
   * (e.g., by CLI permission revoke while kernel is running).
   */
  reload(): void {
    this.load();
  }

  getApproved(moduleId: string): GrantedPermission | undefined {
    return this.data[moduleId];
  }

  isApproved(moduleId: string): boolean {
    return moduleId in this.data;
  }

  approve(moduleId: string, permissions: ModulePermissions, manifestHash: string): void {
    this.data[moduleId] = {
      permissions,
      manifestHash,
      grantedAt: new Date().toISOString(),
    };
    this.save();
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
      const perms = this.data[moduleId].permissions;
      const key = permissionType as keyof ModulePermissions;
      if (!(key in perms) || !Array.isArray(perms[key])) return false;

      if (value) {
        // Revoke specific value from a permission type
        perms[key] = perms[key]!.filter((v: string) => v !== value);
      } else {
        // Revoke entire permission type
        perms[key] = [];
      }
    }

    this.save();
    return true;
  }

  getManifestHash(moduleId: string): string | null {
    return this.data[moduleId]?.manifestHash ?? null;
  }

  /** Get the module that is approved to provide a service. */
  getServiceProvider(service: string): string | null {
    return this.serviceProviders[service] ?? null;
  }

  /** Register a module as the approved provider of a service. Returns false if already claimed. */
  registerServiceProvider(service: string, moduleId: string): boolean {
    const existing = this.serviceProviders[service];
    if (existing && existing !== moduleId) return false;
    this.serviceProviders[service] = moduleId;
    this.save();
    return true;
  }

  /** List all approved modules and their permissions. */
  listAll(): Record<string, GrantedPermission> {
    return { ...this.data };
  }

  /** Get all module IDs that have approved permissions. */
  approvedModuleIds(): string[] {
    return Object.keys(this.data);
  }
}
