/**
 * Module Loader — discovers modules from the filesystem.
 *
 * Scans a directory for subdirectories containing module.json manifests,
 * resolves entry points, and returns a list of discovered modules
 * ready to be spawned by the LifecycleManager.
 */

import { join } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import type { ModuleManifest } from 'jsr:@pons/sdk@^0.2';
import { createLogger, type KernelLogger } from '../logs/logger.ts';

export interface DiscoveredModule {
  manifest: ModuleManifest;
  runnerPath: string;
  moduleDir: string;
}

export class ModuleLoader {
  constructor(private readonly logger: KernelLogger) {
    this.logger = createLogger()
  }

  discover(modulesDir: string): DiscoveredModule[] {
    if (!existsSync(modulesDir)) {
      this.logger.warn({ modulesDir }, 'No modules directory found — nothing to discover');
      return [];
    }

    this.logger.info({ modulesDir }, 'Scanning modules directory');
    const discovered: DiscoveredModule[] = [];

    for (const entry of readdirSync(modulesDir)) {
      const moduleDir = join(modulesDir, entry);

      try {
        if (!statSync(moduleDir).isDirectory()) continue;
      } catch {
        this.logger.debug({ path: moduleDir }, 'Cannot stat entry — skipping');
        continue;
      }

      const manifestPath = join(moduleDir, 'module.json');
      if (!existsSync(manifestPath)) continue;

      let manifest: ModuleManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        this.logger.warn({ path: manifestPath, error: String(err) }, 'Failed to parse module.json — skipping');
        continue;
      }

      if (!manifest.id || typeof manifest.id !== 'string' ||
          !manifest.name || typeof manifest.name !== 'string') {
        this.logger.warn({ path: manifestPath }, 'Invalid manifest — missing id or name — skipping');
        continue;
      }

      // Resolve version from deno.json in the module directory
      const denoJsonPath = join(moduleDir, 'deno.json');
      if (existsSync(denoJsonPath)) {
        try {
          const denoJson = JSON.parse(readFileSync(denoJsonPath, 'utf-8'));
          if (denoJson.version) manifest.version = denoJson.version;
        } catch { /* ignore parse errors */ }
      }

      const entrypoint = manifest.entrypoint || 'runner.ts';
      const entryJs = join(moduleDir, entrypoint.replace(/\.ts$/, '.js'));
      const entryTs = join(moduleDir, entrypoint);
      const runnerPath = existsSync(entryJs) ? entryJs : existsSync(entryTs) ? entryTs : null;

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
