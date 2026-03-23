/**
 * Module Loader — discovers modules from the filesystem.
 *
 * Scans a directory for subdirectories containing module.json manifests,
 * resolves entry points, and returns a list of discovered modules
 * ready to be spawned by the LifecycleManager.
 */

import { join, resolve } from 'jsr:@std/path@^1';
import type { ModuleManifest } from '@pons/sdk';
import { createLogger, type KernelLogger } from '../logs/logger.ts';
import { modulePermissionsSchema, computeManifestHash } from '../security/permissions.ts';
import type { PermissionStore } from '../security/permissions.ts';

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
    try { Deno.statSync(this.modulesDir); } catch {
      this.logger.debug({ modulesDir: this.modulesDir }, 'No modules directory found — nothing to discover');
      return [];
    }

    this.logger.debug({ modulesDir: this.modulesDir }, 'Scanning modules directory');
    const discovered: DiscoveredModule[] = [];

    for (const entry of Deno.readDirSync(this.modulesDir)) {
      const moduleDir = join(this.modulesDir, entry.name);

      try {
        if (!Deno.statSync(moduleDir).isDirectory) continue;
      } catch {
        this.logger.debug({ path: moduleDir }, 'Cannot stat entry — skipping');
        continue;
      }

      const manifestPath = join(moduleDir, 'module.json');
      try { Deno.statSync(manifestPath); } catch {
        this.logger.debug({ path: moduleDir }, 'No module.json found — skipping directory');
        continue;
      }

      let manifest: ModuleManifest;
      try {
        manifest = JSON.parse(Deno.readTextFileSync(manifestPath));
      } catch (err) {
        this.logger.warn({ path: manifestPath, error: String(err) }, 'Failed to parse module.json — skipping');
        continue;
      }

      if (!manifest.id || typeof manifest.id !== 'string' ||
          !manifest.name || typeof manifest.name !== 'string') {
        this.logger.warn({ path: manifestPath }, 'Invalid manifest — missing id or name — skipping');
        continue;
      }

      // Protocol version compatibility check (spec §17)
      const KERNEL_PROTOCOL_MAJOR = 1;
      const KERNEL_PROTOCOL_MINOR = 0;
      const minProto = manifest.minProtocolVersion || '1.0';
      const [reqMajorStr, reqMinorStr] = minProto.split('.');
      const reqMajor = parseInt(reqMajorStr, 10) || 0;
      const reqMinor = parseInt(reqMinorStr, 10) || 0;
      if (reqMajor !== KERNEL_PROTOCOL_MAJOR || reqMinor > KERNEL_PROTOCOL_MINOR) {
        this.logger.error({ module: manifest.id, required: minProto, kernel: `${KERNEL_PROTOCOL_MAJOR}.${KERNEL_PROTOCOL_MINOR}` },
          'Incompatible protocol version — skipping');
        continue;
      }

      // Normalize entry/entrypoint (spec uses "entry", codebase uses "entrypoint")
      if (manifest.entry && !manifest.entrypoint) {
        manifest.entrypoint = manifest.entry;
      }

      // Security: validate permissions block
      if (!manifest.permissions) {
        this.logger.warn({ module: manifest.id, path: manifestPath }, 'Module missing permissions block — skipping (security policy: deny by default)');
        continue;
      }

      try {
        modulePermissionsSchema.parse(manifest.permissions);
      } catch (err) {
        this.logger.warn({ module: manifest.id, error: String(err) }, 'Module has invalid permissions block — skipping');
        continue;
      }

      // Security: manifest tamper detection
      if (this.permissionStore) {
        const storedHash = this.permissionStore.getManifestHash(manifest.id);
        if (storedHash) {
          const currentHash = computeManifestHash(manifestPath);
          if (currentHash !== storedHash) {
            this.logger.error({ module: manifest.id }, 'Module manifest has been modified since install — refusing to load (manifest-tampered)');
            continue;
          }
        }
      }

      // Resolve version from deno.json in the module directory
      const denoJsonPath = join(moduleDir, 'deno.json');
      try {
        Deno.statSync(denoJsonPath);
        try {
          const denoJson = JSON.parse(Deno.readTextFileSync(denoJsonPath));
          if (denoJson.version) manifest.version = denoJson.version;
        } catch { /* ignore parse errors */ }
      } catch { /* deno.json not present */ }

      const entrypoint = manifest.entrypoint || 'runner.ts';
      // Security: verify entrypoint resolves within the module directory (prevent path traversal)
      // Use realPathSync to normalize symlinks and case on case-insensitive filesystems
      let resolvedEntry: string;
      let realModuleDir: string;
      try {
        realModuleDir = Deno.realPathSync(moduleDir);
        resolvedEntry = Deno.realPathSync(resolve(moduleDir, entrypoint));
      } catch {
        // If realPath fails, fall back to resolve (file may not exist yet for .js check)
        realModuleDir = moduleDir;
        resolvedEntry = resolve(moduleDir, entrypoint);
      }
      if (!resolvedEntry.startsWith(realModuleDir + '/') && resolvedEntry !== realModuleDir) {
        this.logger.error({ module: manifest.id, entrypoint }, 'Entry point escapes module directory — skipping');
        continue;
      }
      const entryJs = resolvedEntry.replace(/\.ts$/, '.js');
      const entryTs = resolvedEntry;
      const entryJsExists = (() => { try { Deno.statSync(entryJs); return true; } catch { return false; } })();
      const entryTsExists = (() => { try { Deno.statSync(entryTs); return true; } catch { return false; } })();
      const runnerPath = entryJsExists ? entryJs : entryTsExists ? entryTs : null;

      if (!runnerPath) {
        this.logger.warn({ module: manifest.id, entrypoint }, 'Entry point not found — skipping');
        continue;
      }

      discovered.push({ manifest, runnerPath, moduleDir });
    }

    this.logger.debug({ count: discovered.length }, 'Modules discovered');
    return discovered;
  }
}
