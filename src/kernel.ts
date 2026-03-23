import { dirname, join, resolve } from "jsr:@std/path@^1";
import { getPonsHome } from "@pons/sdk";
import { ConfigManager } from "./config/manager.ts";
import { createLogger, closeLogger } from "./logs/logger.ts";
import type { KernelLogger } from "./logs/logger.ts";
import { MessageBus } from "./messaging/bus.ts";
import { LifecycleManager } from "./lifecycle.ts";
import { ModuleLoader } from "./module/loader.ts";
import type { DiscoveredModule } from "./module/loader.ts";
import type { KernelConfig, LogLevel } from "./config/types.ts";
import { PermissionStore } from "./security/permissions.ts";
import { SecurityEnforcer } from "./security/enforcer.ts";
import { ModuleCallHandler } from "./module-call-handler.ts";
import {
  createConfigReloadHandler,
  createPermissionReloadHandler,
  createModuleReloadHandler,
} from "./signal-handlers.ts";
import { renderBanner } from "./banner.ts";

function readVersion(): string {
  const baseDir = join(dirname(new URL(import.meta.url).pathname), "..");
  // module.json is stamped with the version by the CLI after JSR download
  const manifestPath = join(baseDir, "module.json");
  try {
    const manifest = JSON.parse(Deno.readTextFileSync(manifestPath));
    if (manifest.version) return manifest.version;
  } catch { /* fall through */ }
  // Fallback: deno.json (available in local dev, stripped by JSR)
  try {
    const pkg = JSON.parse(Deno.readTextFileSync(join(baseDir, "deno.json")));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export default class Kernel {
  readonly version: string;
  readonly logger: KernelLogger;
  readonly modulesDir: string;

  private _config?: KernelConfig;
  private configManager: ConfigManager;
  private moduleLoader: ModuleLoader;
  private bus: MessageBus;
  private lifecycle: LifecycleManager;
  private permissionStore: PermissionStore;
  private enforcer: SecurityEnforcer;
  private moduleCallHandler!: ModuleCallHandler;

  private modules: DiscoveredModule[] = [];
  /** Guards against concurrent/duplicate shutdown calls. */
  private _shuttingDown = false;
  private _bootTime = Date.now();
  /** Stored signal handler references for cleanup on shutdown. */
  private _signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];

  constructor(
    private readonly logLevel?: string,
    configPath: string = join(getPonsHome(), "config.yaml"),
  ) {
    this.version = readVersion();
    this.modulesDir = resolve(getPonsHome(), "modules");
    const logDir = join(getPonsHome(), ".runtime", "logs");
    this.logger = createLogger({
      level: (this.logLevel || "info") as LogLevel,
      levels: {},
      logDir,
    });

    this.configManager = new ConfigManager(configPath);
    this.bus = new MessageBus();
    this.permissionStore = new PermissionStore();
    this.enforcer = new SecurityEnforcer(this.permissionStore, this.logger);
    this.moduleLoader = new ModuleLoader(this.modulesDir, this.permissionStore);
    // LifecycleManager is created in boot() after config is loaded — not here.
    this.lifecycle = null!;
  }

  /**
   * Boot phase — load config, connect bus, discover modules, mount lifecycle.
   */
  async boot(): Promise<this> {
    // Discover modules first (need manifests for schema discovery)
    this.modules = await this.moduleLoader.discover();

    // Discover schemas from modules
    await this.configManager.discoverSchemas(
      this.modules.map((m) => ({
        manifest: m.manifest,
        moduleDir: m.moduleDir,
      })),
    );

    // Load and validate config
    const config = this.configManager.load();

    if (this.logLevel) {
      if (!config.logging) {
        (config as Record<string, unknown>).logging = {
          level: this.logLevel,
          levels: {},
        };
      } else config.logging.level = this.logLevel as LogLevel;
    }

    this._config = config;
    this._bootTime = Date.now();

    // Recreate enforcer with configured enforcement mode (enforcer has no state yet)
    this.enforcer = new SecurityEnforcer(
      this.permissionStore,
      this.logger,
      config.security?.enforcementMode,
    );

    const configSource = join(getPonsHome(), "config.yaml");
    this.printStartupBanner(configSource, [configSource]);

    // Message bus
    this.logger.info("Message bus ready");

    // Lifecycle manager — single creation point (never in constructor)
    this.lifecycle = new LifecycleManager(
      this.logger,
      this.bus,
      { config, workspacePath: getPonsHome(), projectRoot: getPonsHome() },
      (moduleId, method, params) =>
        this.moduleCallHandler.handle(moduleId, method, params),
      this.enforcer,
      this.permissionStore,
    );

    // Module call handler — created after lifecycle so it can reference it
    this.moduleCallHandler = new ModuleCallHandler(
      this.configManager,
      this.enforcer,
      this.permissionStore,
      this.lifecycle,
      this.logger,
    );

    return this;
  }

  /**
   * Start phase — spawn discovered modules, register shutdown handlers.
   */
  private addSignalHandler(signal: Deno.Signal, handler: () => void): void {
    Deno.addSignalListener(signal, handler);
    this._signalHandlers.push({ signal, handler });
  }

  private removeAllSignalHandlers(): void {
    for (const { signal, handler } of this._signalHandlers) {
      try { Deno.removeSignalListener(signal, handler); } catch { /* already removed */ }
    }
    this._signalHandlers = [];
  }

  async start(): Promise<this> {
    this.lifecycle.spawnAll(this.modules);

    this.addSignalHandler("SIGINT", () => {
      this.shutdown().catch(console.error);
    });
    this.addSignalHandler("SIGTERM", () => {
      this.shutdown().catch(console.error);
    });

    this.addSignalHandler("SIGUSR1", createConfigReloadHandler({
      configManager: this.configManager,
      lifecycle: this.lifecycle,
      logger: this.logger,
      isShuttingDown: () => this._shuttingDown,
      getConfig: () => this._config,
      setConfig: (config) => { this._config = config; },
    }));

    this.addSignalHandler("SIGUSR2", createPermissionReloadHandler({
      permissionStore: this.permissionStore,
      lifecycle: this.lifecycle,
      logger: this.logger,
      isShuttingDown: () => this._shuttingDown,
    }));

    this.addSignalHandler("SIGHUP", createModuleReloadHandler({
      permissionStore: this.permissionStore,
      logger: this.logger,
      isShuttingDown: () => this._shuttingDown,
      reloadModules: () => this.reloadModules(),
    }));

    this.logger.info("Kernel running");

    // Write PID file for CLI process management
    const runtimeDir = join(getPonsHome(), ".runtime");
    Deno.mkdirSync(runtimeDir, { recursive: true });
    Deno.writeTextFileSync(join(runtimeDir, "kernel.pid"), String(Deno.pid));

    // Structured boot event — emitted after PID file write (spec §18, §2 Phase 4 step 16)
    this.logger.info({ version: this.version, moduleCount: this.modules.length, configPath: join(getPonsHome(), "config.yaml") }, 'kernel.boot');

    return this;
  }

  /**
   * Re-discover modules and spawn any newly installed ones.
   * Existing running modules are left untouched.
   */
  private async reloadModules(): Promise<void> {
    const freshModules = await this.moduleLoader.discover();
    const freshIds = new Set(freshModules.map((m) => m.manifest.id));
    const runningIds = new Set(this.lifecycle.getRegistry().ids());

    // Kill modules whose directories have been removed
    for (const id of runningIds) {
      if (!freshIds.has(id)) {
        this.logger.info({ module: id }, "Module no longer on disk — stopping");
        await this.lifecycle.kill(id, "uninstalled");
      }
    }

    const newModules = freshModules.filter((m) => !runningIds.has(m.manifest.id));

    // Re-discover config schemas for new modules
    await this.configManager.discoverSchemas(
      freshModules.map((m) => ({ manifest: m.manifest, moduleDir: m.moduleDir })),
    );
    this._config = this.configManager.load();

    // Update lifecycle config reference
    this.lifecycle.updateConfig(this._config);

    if (newModules.length > 0) {
      this.logger.info({ modules: newModules.map((m) => m.manifest.id) }, "Spawning new modules");
      await this.lifecycle.spawnAll(newModules);
    } else {
      this.logger.info("No new modules found");
    }

    // Update internal module list
    this.modules = freshModules;
  }

  async shutdown(): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    this.removeAllSignalHandlers();

    const uptime = Date.now() - this._bootTime;
    this.logger.info("─".repeat(60));
    this.logger.info({ reason: 'signal', uptime }, 'kernel.shutdown');

    await this.lifecycle.stopAll();
    await this.bus.close();

    // Remove runtime files
    const runtimeDir = join(getPonsHome(), ".runtime");
    try { Deno.removeSync(join(runtimeDir, "kernel.pid")); } catch { /* may not exist */ }

    // Flush and close log file handle before exit
    closeLogger();

    Deno.exit(0);
  }

  private printStartupBanner(configSource: string, loadedFiles: string[]) {
    for (const line of renderBanner("PONS")) {
      this.logger.info(`\x1b[36m${line}\x1b[0m`);
    }
    this.logger.info(`\x1b[36mKernel v${this.version}\x1b[0m`);
    this.logger.info({
      _groupItems: [
        { msg: `Config      ${configSource}` },
        ...(loadedFiles.length > 1
          ? loadedFiles.slice(1).map((f) => ({ msg: `  merged     ${f}` }))
          : []),
        { msg: `Log level   ${this.logLevel || "info"}` },
        { msg: `Home        ${getPonsHome()}` },
        { msg: `Modules     ${this.modulesDir}` },
      ],
    }, "Configuration");
  }
}
