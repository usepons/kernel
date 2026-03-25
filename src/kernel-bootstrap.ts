/**
 * Kernel Bootstrap — config loading, schema discovery, module discovery,
 * security setup, and startup banner.
 *
 * Extracted from Kernel to separate boot-time concerns from runtime.
 */

import { dirname, join } from "jsr:@std/path@^1";
import { getPonsHome } from "@pons/sdk";
import { ConfigManager } from "./config/manager.ts";
import type { KernelLogger } from "./logs/logger.ts";
import { ModuleLoader } from "./module/loader.ts";
import type { DiscoveredModule } from "./module/loader.ts";
import type { KernelConfig, LogLevel } from "./config/types.ts";
import { PermissionStore } from "./security/permissions.ts";
import { SecurityEnforcer } from "./security/enforcer.ts";
import { renderBanner } from "./banner.ts";

/** Read kernel version from module.json or deno.json. */
export function readVersion(): string {
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

export interface BootResult {
  config: KernelConfig;
  modules: DiscoveredModule[];
  enforcer: SecurityEnforcer;
}

export class KernelBootstrap {
  readonly moduleLoader: ModuleLoader;

  constructor(
    private readonly modulesDir: string,
    private readonly configManager: ConfigManager,
    private readonly permissionStore: PermissionStore,
    private readonly logger: KernelLogger,
    private readonly logLevel?: string,
  ) {
    this.moduleLoader = new ModuleLoader(modulesDir, permissionStore);
  }

  /** Run the full boot sequence: discover, load config, create enforcer, print banner. */
  async boot(): Promise<BootResult> {
    // Discover modules first (need manifests for schema discovery)
    const modules = await this.moduleLoader.discover();

    // Discover schemas from modules
    await this.configManager.discoverSchemas(
      modules.map((m) => ({
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

    // Recreate enforcer with configured enforcement mode
    const enforcer = new SecurityEnforcer(
      this.permissionStore,
      this.logger,
      config.security?.enforcementMode,
    );

    const configSource = join(getPonsHome(), "config.yaml");
    this.printStartupBanner(configSource, [configSource]);

    this.logger.info("Message bus ready");

    return { config, modules, enforcer };
  }

  private printStartupBanner(configSource: string, loadedFiles: string[]) {
    for (const line of renderBanner("PONS")) {
      this.logger.info(`\x1b[36m${line}\x1b[0m`);
    }
    this.logger.info(`\x1b[36mKernel v${readVersion()}\x1b[0m`);
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
