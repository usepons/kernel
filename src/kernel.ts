import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getPonsHome } from "jsr:@pons/sdk@^0.2";
import { ConfigManager } from "./config/manager.ts";
import { createLogger } from "./logs/logger.ts";
import type { KernelLogger } from "./logs/logger.ts";
import { MessageBus } from "./messaging/bus.ts";
import { LifecycleManager } from "./lifecycle.ts";
import { ModuleLoader } from "./module/loader.ts";
import type { DiscoveredModule } from "./module/loader.ts";
import type { KernelConfig, LogLevel } from "./config/types.ts";

function readVersion(): string {
  const baseDir = join(dirname(new URL(import.meta.url).pathname), "..");
  // module.json is stamped with the version by the CLI after JSR download
  const manifestPath = join(baseDir, "module.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (manifest.version) return manifest.version;
  } catch { /* fall through */ }
  // Fallback: deno.json (available in local dev, stripped by JSR)
  try {
    const pkg = JSON.parse(readFileSync(join(baseDir, "deno.json"), "utf-8"));
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
    this.moduleLoader = new ModuleLoader(this.modulesDir);
    this.lifecycle = new LifecycleManager(
      this.logger,
      this.bus,
      { config: this.configManager.getAll(), workspacePath: getPonsHome(), projectRoot: getPonsHome() },
      (moduleId, method, params) =>
        this.handleModuleCall(moduleId, method, params),
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
    );

    return this;
  }

  /**
   * Start phase — spawn discovered modules, register shutdown handlers.
   */
  async start(): Promise<this> {
    this.lifecycle.spawnAll(this.modules);

    process.once("SIGINT", () => {
      this.shutdown().catch(console.error);
    });
    process.once("SIGTERM", () => {
      this.shutdown().catch(console.error);
    });

    // Config hot-reload: CLI sends SIGUSR1 after writing config
    process.on("SIGUSR1", () => {
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
            this.lifecycle["send"](moduleId, {
              type: "config:update" as const,
              config: this._config,
              changedSections,
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

    this.logger.info("Kernel running");

    // Write PID file for CLI process management
    const runtimeDir = join(getPonsHome(), ".runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "kernel.pid"), String(process.pid), "utf-8");

    return this;
  }

  async shutdown(): Promise<void> {
    this.logger.info("─".repeat(60));
    this.logger.info("Kernel shutting down...");
    await this.lifecycle.stopAll();
    await this.bus.close();

    // Remove PID file
    try {
      unlinkSync(join(getPonsHome(), ".runtime", "kernel.pid"));
    } catch { /* may not exist */ }

    Deno.exit(0);
  }

  private async handleModuleCall(
    _moduleId: string,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "config.get": {
        const key = (params as { key: string }).key;
        return this.configManager.get(key);
      }
      case "config.set": {
        const { key, value } = params as { key: string; value: unknown };
        const result = this.configManager.set(key, value);
        if (result.success) {
          const affected = this.configManager.getAffectedModules([key]);
          const section = key.split(".")[0];
          for (const modId of affected) {
            if (modId === "__kernel__") continue;
            const entry = this.lifecycle.getRegistry().get(modId);
            if (entry?.process?.connected) {
              this.lifecycle["send"](modId, {
                type: "config:update" as const,
                config: this.configManager.getAll(),
                changedSections: [section],
              });
            }
          }
        }
        return result;
      }
      case "config.sections":
        return this.configManager.listSections();
      case "module.list":
        return this.lifecycle.getRegistry().allPublic();
      case "module.commands":
        return this.lifecycle.getRegistry().getCommands();
      case "service.discover":
        return this.lifecycle.getRegistry().listServices();
      case "service.resolve": {
        const service = (params as { service: string }).service;
        const moduleId = this.lifecycle.getRegistry().resolveService(service);
        if (!moduleId) throw new Error(`Service not found: ${service}`);
        return moduleId;
      }
      default:
        throw new Error(`Unknown kernel method: ${method}`);
    }
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
