/**
 * Kernel Runtime — signal handling, module reloading, and shutdown.
 *
 * Extracted from Kernel to separate runtime concerns from boot-time setup.
 */

import { join } from "jsr:@std/path@^1";
import { getPonsHome } from "@pons/sdk";
import type { KernelLogger } from "./logs/logger.ts";
import { closeLogger } from "./logs/logger.ts";
import type { MessageBus } from "./messaging/bus.ts";
import type { LifecycleManager } from "./lifecycle.ts";
import type { ModuleLoader } from "./module/loader.ts";
import type { DiscoveredModule } from "./module/loader.ts";
import type { ConfigManager } from "./config/manager.ts";
import type { KernelConfig } from "./config/types.ts";
import type { ControlServer } from "./control/server.ts";

export interface KernelRuntimeDeps {
  logger: KernelLogger;
  bus: MessageBus;
  lifecycle: LifecycleManager;
  moduleLoader: ModuleLoader;
  configManager: ConfigManager;
  controlServer?: ControlServer;
  getConfig: () => KernelConfig | undefined;
  setConfig: (config: KernelConfig) => void;
  getModules: () => DiscoveredModule[];
  setModules: (modules: DiscoveredModule[]) => void;
  bootTime: number;
}

export class KernelRuntime {
  private _signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];
  private _shuttingDown = false;

  constructor(private readonly deps: KernelRuntimeDeps) {}

  get isShuttingDown(): boolean {
    return this._shuttingDown;
  }

  // ─── Signal Handlers ─────────────────────────────────────────

  addSignalHandler(signal: Deno.Signal, handler: () => void): void {
    Deno.addSignalListener(signal, handler);
    this._signalHandlers.push({ signal, handler });
  }

  removeAllSignalHandlers(): void {
    for (const { signal, handler } of this._signalHandlers) {
      try { Deno.removeSignalListener(signal, handler); } catch { /* already removed */ }
    }
    this._signalHandlers = [];
  }

  // ─── Module Reload ───────────────────────────────────────────

  async reloadModules(): Promise<void> {
    const { lifecycle, moduleLoader, configManager, logger } = this.deps;

    const freshModules = await moduleLoader.discover();
    const freshIds = new Set(freshModules.map((m) => m.manifest.id));
    const runningIds = new Set(lifecycle.getRegistry().ids());

    // Kill modules whose directories have been removed
    for (const id of runningIds) {
      if (!freshIds.has(id)) {
        logger.info({ module: id }, "Module no longer on disk — stopping");
        await lifecycle.kill(id, "uninstalled");
      }
    }

    const newModules = freshModules.filter((m) => !runningIds.has(m.manifest.id));

    // Re-discover config schemas for new modules
    await configManager.discoverSchemas(
      freshModules.map((m) => ({ manifest: m.manifest, moduleDir: m.moduleDir })),
    );
    const config = configManager.load();
    this.deps.setConfig(config);

    // Update lifecycle config reference
    lifecycle.updateConfig(config);

    if (newModules.length > 0) {
      logger.info({ modules: newModules.map((m) => m.manifest.id) }, "Spawning new modules");
      await lifecycle.spawnAll(newModules);
    } else {
      logger.info("No new modules found");
    }

    // Update internal module list
    this.deps.setModules(freshModules);
  }

  // ─── Shutdown ────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    const { logger, lifecycle, bus } = this.deps;

    this.removeAllSignalHandlers();

    const uptime = Date.now() - this.deps.bootTime;
    logger.info("─".repeat(60));
    logger.info({ reason: 'signal', uptime }, 'kernel.shutdown');

    this.deps.controlServer?.stop();
    await lifecycle.stopAll();
    await bus.close();

    // Remove runtime files
    const runtimeDir = join(getPonsHome(), ".runtime");
    try { Deno.removeSync(join(runtimeDir, "kernel.pid")); } catch { /* may not exist */ }

    // Flush and close log file handle before exit
    closeLogger();

    Deno.exit(0);
  }
}
