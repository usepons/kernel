/**
 * Module Loader — discovers modules from the filesystem.
 *
 * Scans a directory for subdirectories containing module.json manifests,
 * resolves entry points, and returns a list of discovered modules
 * ready to be spawned by the LifecycleManager.
 */

import { join, resolve } from 'jsr:@std/path@^1';
import type { ModuleManifest } from 'jsr:@pons/sdk@^0.2';
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

    this.logger.info({ modulesDir: this.modulesDir }, 'Scanning modules directory');
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
      try { Deno.statSync(manifestPath); } catch { continue; }

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
      const resolvedEntry = resolve(moduleDir, entrypoint);
      if (!resolvedEntry.startsWith(moduleDir + '/') && resolvedEntry !== moduleDir) {
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

    this.logger.info({ count: discovered.length }, 'Modules discovered');
    return discovered;
  }
}
