import { dirname, join, resolve } from "jsr:@std/path@^1";
import { getPonsHome } from "@pons/sdk";
import { ConfigManager } from "./config/manager.ts";
import { createLogger } from "./logs/logger.ts";
import type { KernelLogger } from "./logs/logger.ts";
import { MessageBus } from "./messaging/bus.ts";
import { LifecycleManager } from "./lifecycle.ts";
import { ModuleLoader } from "./module/loader.ts";
import type { DiscoveredModule } from "./module/loader.ts";
import type { KernelConfig, LogLevel } from "./config/types.ts";
import { PermissionStore } from "./security/permissions.ts";
import type { ModulePermissions } from "./security/permissions.ts";
import { SecurityEnforcer } from "./security/enforcer.ts";

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

  private modules: DiscoveredModule[] = [];

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
    this.lifecycle = new LifecycleManager(
      this.logger,
      this.bus,
      { config: this.configManager.getAll(), workspacePath: getPonsHome(), projectRoot: getPonsHome() },
      (moduleId, method, params) =>
        this.handleModuleCall(moduleId, method, params),
      this.enforcer,
      this.permissionStore,
    );
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
    const configSource = join(getPonsHome(), "config.yaml");
    this.printStartupBanner(configSource, [configSource]);

    // Message bus
    this.logger.info("Message bus ready");

    // Lifecycle manager
    this.lifecycle = new LifecycleManager(
      this.logger,
      this.bus,
      { config, workspacePath: getPonsHome(), projectRoot: getPonsHome() },
      (moduleId, method, params) =>
        this.handleModuleCall(moduleId, method, params),
      this.enforcer,
      this.permissionStore,
    );

    return this;
  }

  /**
   * Start phase — spawn discovered modules, register shutdown handlers.
   */
  async start(): Promise<this> {
    this.lifecycle.spawnAll(this.modules);

    Deno.addSignalListener("SIGINT", () => {
      this.shutdown().catch(console.error);
    });
    Deno.addSignalListener("SIGTERM", () => {
      this.shutdown().catch(console.error);
    });

    // Config hot-reload: CLI sends SIGUSR1 after writing config
    Deno.addSignalListener("SIGUSR1", () => {
      this.logger.info("Received SIGUSR1 — reloading config");
      try {
        const oldConfig = structuredClone(this.configManager.getAll());
        this._config = this.configManager.load();

        // Find changed top-level sections
        const changedSections: string[] = [];
        const allKeys = new Set([
          ...Object.keys(oldConfig),
          ...Object.keys(this._config as Record<string, unknown>),
        ]);
        for (const key of allKeys) {
          if (
            JSON.stringify(oldConfig[key]) !==
              JSON.stringify((this._config as Record<string, unknown>)[key])
          ) {
            changedSections.push(key);
          }
        }

        if (changedSections.length === 0) {
          this.logger.info("Config unchanged");
          return;
        }

        this.logger.info({ changedSections }, "Config sections changed");

        // Update lifecycle init payload config reference
        (this.lifecycle as unknown as { initPayload: { config: unknown } })
          .initPayload.config = this._config;

        // Notify affected modules
        for (const moduleId of this.lifecycle.getRegistry().ids()) {
          const entry = this.lifecycle.getRegistry().get(moduleId);
          if (!entry || entry.status !== "ready") continue;

          const manifest = entry.manifest;
          const moduleConfigKey = manifest.configKey;
          if (moduleConfigKey && changedSections.includes(moduleConfigKey)) {
            // Security: send only the module's own config section and relevant changed sections
            this.lifecycle["send"](moduleId, {
              type: "config:update" as const,
              config: { [moduleConfigKey]: this.configManager.getSection(moduleConfigKey) },
              changedSections: changedSections.filter((s: string) => s === moduleConfigKey),
            });
            this.logger.debug(
              { module: moduleId, changedSections },
              "Sent config:update",
            );
          }
        }
      } catch (err) {
        this.logger.error({ error: String(err) }, "Failed to reload config");
      }
    });

    // Permission hot-reload: CLI sends SIGUSR2 after granting/revoking permissions
    Deno.addSignalListener("SIGUSR2", () => {
      this.logger.info("Received SIGUSR2 — reloading permissions");
      try {
        // PONS-006: Snapshot effective permissions before reload
        const before = new Map<string, string>();
        for (const moduleId of this.lifecycle.getRegistry().ids()) {
          const entry = this.lifecycle.getRegistry().get(moduleId);
          if (!entry || entry.status === "stopped" || entry.status === "crashed") continue;
          const eff = this.permissionStore.getEffectivePermissions(moduleId);
          before.set(moduleId, JSON.stringify(eff));
        }

        this.permissionStore.reload();

        // Compare and act on changes
        for (const moduleId of this.lifecycle.getRegistry().ids()) {
          const entry = this.lifecycle.getRegistry().get(moduleId);
          if (!entry || entry.status === "stopped" || entry.status === "crashed") continue;

          if (!this.permissionStore.isApproved(moduleId)) {
            this.logger.warn({ module: moduleId }, "Permissions fully revoked — killing module");
            this.lifecycle.kill(moduleId, "permissions-revoked");
          } else {
            const after = JSON.stringify(this.permissionStore.getEffectivePermissions(moduleId));
            if (before.get(moduleId) !== after) {
              this.logger.info({ module: moduleId }, "Permissions changed — restarting with updated flags");
              this.lifecycle.restartWithUpdatedPermissions(moduleId);
            }
          }
        }
      } catch (err) {
        this.logger.error({ error: String(err) }, "Failed to reload permissions");
      }
    });

    // Module hot-reload: CLI sends SIGHUP after installing/uninstalling modules
    Deno.addSignalListener("SIGHUP", () => {
      this.logger.info("Received SIGHUP — reloading permissions and re-discovering modules");
      this.permissionStore.reload();
      this.reloadModules().catch((err) => {
        this.logger.error({ error: String(err) }, "Failed to reload modules");
      });
    });

    this.logger.info("Kernel running");

    // Write PID file for CLI process management
    const runtimeDir = join(getPonsHome(), ".runtime");
    Deno.mkdirSync(runtimeDir, { recursive: true });
    Deno.writeTextFileSync(join(runtimeDir, "kernel.pid"), String(Deno.pid));

    return this;
  }

  /**
   * Re-discover modules and spawn any newly installed ones.
   * Existing running modules are left untouched.
   */
  private async reloadModules(): Promise<void> {
    const freshModules = await this.moduleLoader.discover();
    const runningIds = new Set(this.lifecycle.getRegistry().ids());

    const newModules = freshModules.filter((m) => !runningIds.has(m.manifest.id));

    if (newModules.length === 0) {
      this.logger.info("No new modules found");
      return;
    }

    // Re-discover config schemas for new modules
    await this.configManager.discoverSchemas(
      freshModules.map((m) => ({ manifest: m.manifest, moduleDir: m.moduleDir })),
    );
    this._config = this.configManager.load();

    // Update lifecycle config reference
    (this.lifecycle as unknown as { initPayload: { config: unknown } })
      .initPayload.config = this._config;

    this.logger.info({ modules: newModules.map((m) => m.manifest.id) }, "Spawning new modules");
    await this.lifecycle.spawnAll(newModules);

    // Update internal module list
    this.modules = freshModules;
  }

  async shutdown(): Promise<void> {
    this.logger.info("─".repeat(60));
    this.logger.info("Kernel shutting down...");

    await this.lifecycle.stopAll();
    await this.bus.close();

    // Remove runtime files
    const runtimeDir = join(getPonsHome(), ".runtime");
    try { Deno.removeSync(join(runtimeDir, "kernel.pid")); } catch { /* may not exist */ }

    Deno.exit(0);
  }

  private async handleModuleCall(
    moduleId: string,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    // Security: get the calling module's manifest for config scoping
    const callerEntry = this.lifecycle.getRegistry().get(moduleId);
    const callerConfigKey = callerEntry?.manifest?.configKey;

    switch (method) {
      case "config.get": {
        const key = (params as { key: string }).key;
        // Security: enforce config scope — module can only read its own section
        const violation = this.enforcer.checkConfig(moduleId, key, callerConfigKey);
        if (violation) {
          this.enforcer.logViolation(violation);
          this.lifecycle.kill(moduleId, "security-violation");
          throw new Error(`Security violation: not permitted to read config key "${key}"`);
        }
        return this.configManager.get(key);
      }
      case "config.set": {
        const { key, value } = params as { key: string; value: unknown };
        // Security: enforce config scope — module can only write its own section
        const violation = this.enforcer.checkConfig(moduleId, key, callerConfigKey);
        if (violation) {
          this.enforcer.logViolation(violation);
          this.lifecycle.kill(moduleId, "security-violation");
          throw new Error(`Security violation: not permitted to write config key "${key}"`);
        }
        const result = this.configManager.set(key, value);
        if (result.success) {
          const affected = this.configManager.getAffectedModules([key]);
          const section = key.split(".")[0];
          for (const modId of affected) {
            if (modId === "__kernel__") continue;
            const entry = this.lifecycle.getRegistry().get(modId);
            if (entry?.process?.connected) {
              // Security: send only the affected module's own config section
              const modConfigKey = entry.manifest?.configKey;
              this.lifecycle["send"](modId, {
                type: "config:update" as const,
                config: modConfigKey ? { [modConfigKey]: this.configManager.getSection(modConfigKey) } : {},
                changedSections: [section],
              });
            }
          }
        }
        return result;
      }
      case "config.sections":
        // Security: filter to return only the calling module's own section metadata
        return this.configManager.listSections().filter(
          (s: { key: string }) => s.key === callerConfigKey,
        );
      // Intentionally ungated: topology knowledge ≠ data access (RPC enforcement prevents unauthorized calls)
      case "module.list":
        return this.lifecycle.getRegistry().allPublic();
      case "module.commands":
        return this.lifecycle.getRegistry().getCommands();
      case "service.discover":
        return this.lifecycle.getRegistry().listServices();
      case "service.resolve": {
        const service = (params as { service: string }).service;
        const resolved = this.lifecycle.getRegistry().resolveService(service);
        if (!resolved) throw new Error(`Service not found: ${service}`);
        return resolved;
      }
      case "permissions.request": {
        const { permissions, reason } = params as { permissions: Partial<ModulePermissions>; reason?: string };

        // Check if already granted
        const effective = this.permissionStore.getEffectivePermissions(moduleId);
        if (effective && isSubset(permissions, effective)) {
          return { granted: true };
        }

        // Check if denied
        if (this.permissionStore.isDenied(moduleId, permissions)) {
          return { granted: false, denied: true };
        }

        // Check for existing pending
        const existing = this.permissionStore.findExistingPending(moduleId, permissions);
        if (existing) {
          return { granted: false, pending: true, requestId: existing.id };
        }

        // Queue as pending
        const pending = this.permissionStore.addPendingRequest(moduleId, permissions, reason);

        // Send system notification (best-effort)
        this.sendSystemNotification(moduleId);

        this.logger.warn({ module: moduleId, requestId: pending.id }, 'Pending permission request');

        return { granted: false, pending: true, requestId: pending.id };
      }
      case "permissions.check": {
        const { permissions } = params as { permissions: Partial<ModulePermissions> };
        const effective = this.permissionStore.getEffectivePermissions(moduleId);

        if (!effective) return { granted: false, missing: permissions };

        const missing: Partial<ModulePermissions> = {};
        const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];
        let allGranted = true;

        for (const field of fields) {
          const requested = (permissions as Record<string, string[]>)[field];
          if (!requested) continue;
          const granted = (effective as Record<string, string[]>)[field] || [];
          const missingValues = requested.filter((v: string) => !granted.includes(v));
          if (missingValues.length > 0) {
            (missing as Record<string, string[]>)[field] = missingValues;
            allGranted = false;
          }
        }

        return { granted: allGranted, missing };
      }
      default:
        throw new Error(`Unknown kernel method: ${method}`);
    }
  }

  private sendSystemNotification(moduleId: string): void {
    try {
      if (Deno.build.os === 'darwin') {
        new Deno.Command('osascript', {
          args: ['-e', `display notification "Module ${moduleId} is waiting for permission approval" with title "Pons"`],
          stdout: 'null', stderr: 'null',
        }).outputSync();
      } else {
        new Deno.Command('notify-send', {
          args: ['Pons', `Module ${moduleId} is waiting for permission approval`],
          stdout: 'null', stderr: 'null',
        }).outputSync();
      }
    } catch { /* notification is best-effort */ }
  }

  private printStartupBanner(configSource: string, loadedFiles: string[]) {
    this.logger.info("─".repeat(60));
    this.logger.info(`Pons Kernel v${this.version}`);
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

function isSubset(requested: Partial<ModulePermissions>, granted: ModulePermissions): boolean {
  const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];
  for (const field of fields) {
    const reqValues = (requested as Record<string, string[]>)[field];
    if (!reqValues || reqValues.length === 0) continue;
    const grantedValues = (granted as Record<string, string[]>)[field] || [];
    if (!reqValues.every((v: string) => grantedValues.includes(v))) return false;
  }
  return true;
}
