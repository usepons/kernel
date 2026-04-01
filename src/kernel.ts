// The Kernel is the entry point and orchestrator for the entire Pons system. It owns
// nothing application-specific — its only job is to wire together the subsystems that
// manage module processes, route IPC messages, enforce security, and handle configuration.
// Boot and start are deliberately separate phases: boot discovers and validates the world
// (modules, config, permissions), while start brings it to life (spawns processes, listens
// for signals). This separation lets callers inspect the boot result before committing.

import { join, resolve } from "jsr:@std/path@^1";
import { getPonsHome } from "@pons/sdk";
import { ConfigManager } from "./config/manager.ts";
import { createLogger } from "./logs/logger.ts";
import type { KernelLogger } from "./logs/logger.ts";
import { MessageBus } from "./messaging/bus.ts";
import { LifecycleManager } from "./lifecycle.ts";
import type { DiscoveredModule } from "./module/loader.ts";
import type { KernelConfig, LogLevel } from "./config/types.ts";
import { PermissionStore } from "./security/permissions.ts";
import { SecurityEnforcer } from "./security/enforcer.ts";
import { PermissionPrompter } from './security/prompter.ts';
import { ModuleCallHandler } from "./module-call-handler.ts";
import {
  createConfigReloadHandler,
  createPermissionReloadHandler,
  createModuleReloadHandler,
} from "./signal-handlers.ts";
import { ControlServer } from "./control/server.ts";
import { KernelBootstrap, readVersion } from "./kernel-bootstrap.ts";
import { KernelRuntime } from "./kernel-runtime.ts";

export default class Kernel {
  readonly version: string;
  readonly logger: KernelLogger;
  readonly modulesDir: string;

  private _config?: KernelConfig;
  private configManager: ConfigManager;
  private bus: MessageBus;
  private lifecycle: LifecycleManager;
  private permissionStore: PermissionStore;
  private enforcer: SecurityEnforcer;
  private prompter!: PermissionPrompter;
  private moduleCallHandler!: ModuleCallHandler;
  private controlServer?: ControlServer;

  private modules: DiscoveredModule[] = [];
  private _bootTime = Date.now();

  private readonly bootstrap: KernelBootstrap;
  private readonly runtime: KernelRuntime;

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

    this.bootstrap = new KernelBootstrap(
      this.modulesDir,
      this.configManager,
      this.permissionStore,
      this.logger,
      this.logLevel,
    );

    // LifecycleManager depends on config (for health-check intervals, restart limits, etc.),
    // so it can't be created until boot() loads and validates config.yaml.
    this.lifecycle = null!;

    // Runtime holds references to mutable kernel state via closures. This indirection lets
    // signal handlers and the control server read the latest config/modules without the
    // kernel needing to push updates to them after every reload.
    this.runtime = new KernelRuntime({
      logger: this.logger,
      bus: this.bus,
      lifecycle: null!, // set in boot()
      moduleLoader: this.bootstrap.moduleLoader,
      configManager: this.configManager,
      getConfig: () => this._config,
      setConfig: (config) => { this._config = config; },
      getModules: () => this.modules,
      setModules: (modules) => { this.modules = modules; },
      bootTime: this._bootTime,
    });
  }

  /**
   * Boot phase — delegates to KernelBootstrap for discovery, config, and banner.
   */
  async boot(): Promise<this> {
    const { config, modules, enforcer } = await this.bootstrap.boot();

    this._config = config;
    this._bootTime = Date.now();
    this.modules = modules;
    this.enforcer = enforcer;

    // Created here — not in the constructor — because we need the loaded config
    this.lifecycle = new LifecycleManager(
      this.logger,
      this.bus,
      { config, workspacePath: getPonsHome(), projectRoot: getPonsHome() },
      (moduleId, method, params) => {
        if (!this.moduleCallHandler) {
          throw new Error('Kernel not fully initialized — module call received too early');
        }
        return this.moduleCallHandler.handle(moduleId, method, params);
      },
      this.enforcer,
      this.permissionStore,
      (request) => this.prompter.prompt(request),
    );

    // ModuleCallHandler and LifecycleManager have a circular dependency: lifecycle
    // routes module calls to the handler, and the handler queries lifecycle for module
    // state. We break the cycle by creating lifecycle first with a lambda that captures
    // `this.moduleCallHandler`, then creating the handler.
    this.moduleCallHandler = new ModuleCallHandler(
      this.configManager,
      this.enforcer,
      this.permissionStore,
      this.lifecycle,
      this.logger,
      this.bus,
      this._bootTime,
    );

    // Patch the runtime's lifecycle reference — ugly but honest: we can't pass it
    // at construction time because it doesn't exist yet. The alternative (a lazy getter)
    // would hide the temporal dependency instead of making it explicit here.
    (this.runtime as unknown as { deps: { lifecycle: LifecycleManager } }).deps.lifecycle = this.lifecycle;
    (this.runtime as unknown as { deps: { bootTime: number } }).deps.bootTime = this._bootTime;

    return this;
  }

  /**
   * Start phase — spawn discovered modules, register shutdown handlers.
   */
  async start(): Promise<this> {
    await this.lifecycle.spawnAll(this.modules);

    this.runtime.addSignalHandler("SIGINT", () => {
      this.runtime.shutdown().catch(console.error);
    });
    this.runtime.addSignalHandler("SIGTERM", () => {
      this.runtime.shutdown().catch(console.error);
    });

    this.runtime.addSignalHandler("SIGUSR1", createConfigReloadHandler({
      configManager: this.configManager,
      lifecycle: this.lifecycle,
      logger: this.logger,
      isShuttingDown: () => this.runtime.isShuttingDown,
      getConfig: () => this._config,
      setConfig: (config) => { this._config = config; },
    }));

    this.runtime.addSignalHandler("SIGUSR2", createPermissionReloadHandler({
      permissionStore: this.permissionStore,
      lifecycle: this.lifecycle,
      logger: this.logger,
      isShuttingDown: () => this.runtime.isShuttingDown,
    }));

    this.runtime.addSignalHandler("SIGHUP", createModuleReloadHandler({
      permissionStore: this.permissionStore,
      logger: this.logger,
      isShuttingDown: () => this.runtime.isShuttingDown,
      reloadModules: () => this.runtime.reloadModules(),
    }));

    this.logger.info("Kernel running");

    // The PID file is how `pons stop` and `pons status` find the running kernel.
    // Written after signal handlers are registered so the kernel can't be killed
    // before it's ready to handle shutdown gracefully.
    const runtimeDir = join(getPonsHome(), ".runtime");
    Deno.mkdirSync(runtimeDir, { recursive: true });
    Deno.writeTextFileSync(join(runtimeDir, "kernel.pid"), String(Deno.pid));

    // The control server exposes a Unix socket for CLI commands (status, module
    // list, etc.) without needing to go through signals or filesystem polling.
    this.controlServer = new ControlServer(getPonsHome(), this.lifecycle, this.logger);
    (this.runtime as unknown as { deps: { controlServer?: ControlServer } }).deps.controlServer = this.controlServer;
    await this.controlServer.start();

    // Emitted after PID file write so log consumers can correlate the boot event
    // with a reachable process
    this.logger.info({ version: this.version, moduleCount: this.modules.length, configPath: join(getPonsHome(), "config.yaml") }, 'kernel.boot');

    return this;
  }

  async shutdown(): Promise<void> {
    return this.runtime.shutdown();
  }
}
