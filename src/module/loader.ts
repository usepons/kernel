/**
 * Module Loader — discovers modules from the filesystem.
 *
 * Scans a directory for subdirectories containing module.json manifests,
 * resolves entry points, and returns a list of discovered modules
 * ready to be spawned by the LifecycleManager.
 */
import { join, resolve } from '@std/path';
import type { ModuleManifest } from '@pons/sdk';
import { createLogger, type KernelLogger } from '../logs/logger.ts';
import { modulePermissionsSchema, computeManifestHash } from '../security/permissions.ts';
import type { PermissionStore } from '../security/permissions.ts';
import { existsSync } from '../utils/fs.ts';

const KERNEL_PROTOCOL_MAJOR = 1;
const KERNEL_PROTOCOL_MINOR = 0;

export interface DiscoveredModule {
  manifest: ModuleManifest;
  runnerPath: string;
  moduleDir: string;
}

export class ModuleLoader {

  logger: KernelLogger;

  constructor(private readonly modulesDir: string, private readonly permissionStore?: PermissionStore) {
    this.logger = createLogger()
  }

  discover(): DiscoveredModule[] {
    if (!existsSync(this.modulesDir)) {
      this.logger.debug({ modulesDir: this.modulesDir }, 'No modules directory found — nothing to discover');
      return [];
    }

    this.logger.debug({ modulesDir: this.modulesDir }, 'Scanning modules directory');
    const discovered: DiscoveredModule[] = [];

    for (const entry of Deno.readDirSync(this.modulesDir)) {
      const moduleDir = join(this.modulesDir, entry.name);
      const result = this.validateAndLoadModule(moduleDir, entry);
      if (result) {
        discovered.push(result);
      }
    }

    this.logger.debug({ count: discovered.length }, 'Modules discovered');
    return discovered;
  }

  private validateAndLoadModule(moduleDir: string, _entry: Deno.DirEntry): DiscoveredModule | null {
    // Guard: must be a directory
    try {
      if (!Deno.statSync(moduleDir).isDirectory) return null;
    } catch {
      this.logger.debug({ path: moduleDir }, 'Cannot stat entry — skipping');
      return null;
    }

    // Guard: must contain module.json
    const manifestPath = join(moduleDir, 'module.json');
    if (!existsSync(manifestPath)) {
      this.logger.debug({ path: moduleDir }, 'No module.json found — skipping directory');
      return null;
    }

    // Guard: module.json must be valid JSON
    let manifest: ModuleManifest;
    try {
      manifest = JSON.parse(Deno.readTextFileSync(manifestPath));
    } catch (err) {
      this.logger.warn({ path: manifestPath, error: String(err) }, 'Failed to parse module.json — skipping');
      return null;
    }

    // Guard: manifest must have id and name
    if (!manifest.id || typeof manifest.id !== 'string' ||
        !manifest.name || typeof manifest.name !== 'string') {
      this.logger.warn({ path: manifestPath }, 'Invalid manifest — missing id or name — skipping');
      return null;
    }

    // Guard: protocol version compatibility (spec §17)
    const minProto = manifest.minProtocolVersion || '1.0';
    const [reqMajorStr, reqMinorStr] = minProto.split('.');
    const reqMajor = parseInt(reqMajorStr, 10) || 0;
    const reqMinor = parseInt(reqMinorStr, 10) || 0;
    if (reqMajor !== KERNEL_PROTOCOL_MAJOR || reqMinor > KERNEL_PROTOCOL_MINOR) {
      this.logger.error({ module: manifest.id, required: minProto, kernel: `${KERNEL_PROTOCOL_MAJOR}.${KERNEL_PROTOCOL_MINOR}` },
        'Incompatible protocol version — skipping');
      return null;
    }

    // Normalize entry/entrypoint (spec uses "entry", codebase uses "entrypoint")
    if (manifest.entry && !manifest.entrypoint) {
      manifest.entrypoint = manifest.entry;
    }

    // Guard: permissions block must exist (security policy: deny by default)
    if (!manifest.permissions) {
      this.logger.warn({ module: manifest.id, path: manifestPath }, 'Module missing permissions block — skipping (security policy: deny by default)');
      return null;
    }

    // Guard: permissions block must be valid
    try {
      modulePermissionsSchema.parse(manifest.permissions);
    } catch (err) {
      this.logger.warn({ module: manifest.id, error: String(err) }, 'Module has invalid permissions block — skipping');
      return null;
    }

    // Guard: manifest tamper detection
    if (this.permissionStore) {
      const storedHash = this.permissionStore.getManifestHash(manifest.id);
      if (storedHash) {
        const currentHash = computeManifestHash(manifestPath);
        if (currentHash !== storedHash) {
          this.logger.error({ module: manifest.id }, `manifest hash mismatch for ${manifest.id} — re-install required`);
          return null;
        }
      }
    }

    // Resolve version from deno.json in the module directory
    const denoJsonPath = join(moduleDir, 'deno.json');
    if (existsSync(denoJsonPath)) {
      try {
        const denoJson = JSON.parse(Deno.readTextFileSync(denoJsonPath));
        if (denoJson.version) manifest.version = denoJson.version;
      } catch { /* ignore parse errors */ }
    }

    // Guard: entrypoint must resolve within the module directory (prevent path traversal)
    const entrypoint = manifest.entrypoint || 'runner.ts';
    let resolvedEntry: string;
    let realModuleDir: string;
    try {
      realModuleDir = Deno.realPathSync(moduleDir);
      resolvedEntry = Deno.realPathSync(resolve(moduleDir, entrypoint));
    } catch {
      realModuleDir = moduleDir;
      resolvedEntry = resolve(moduleDir, entrypoint);
    }
    if (!resolvedEntry.startsWith(realModuleDir + '/') && resolvedEntry !== realModuleDir) {
      this.logger.error({ module: manifest.id, entrypoint }, 'Entry point escapes module directory — skipping');
      return null;
    }

    // Guard: entrypoint file must exist (.js preferred, .ts fallback)
    const entryJs = resolvedEntry.replace(/\.ts$/, '.js');
    const entryTs = resolvedEntry;
    const runnerPath = existsSync(entryJs) ? entryJs : existsSync(entryTs) ? entryTs : null;

    if (!runnerPath) {
      this.logger.warn({ module: manifest.id, entrypoint }, 'Entry point not found — skipping');
      return null;
    }

    const result: DiscoveredModule & { unsandboxed?: boolean } = { manifest, runnerPath, moduleDir };
    if (manifest.runtime && manifest.runtime !== 'deno') {
      result.unsandboxed = true;
    }
    return result;
  }
}
