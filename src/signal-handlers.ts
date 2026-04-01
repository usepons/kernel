/** Signal handler factories for kernel hot-reload operations. */

import type { ConfigManager } from "./config/manager.ts";
import type { KernelLogger } from "./logs/logger.ts";
import type { LifecycleManager } from "./lifecycle.ts";
import type { PermissionStore } from "./security/permissions.ts";
import type { KernelConfig } from "./config/types.ts";

interface ConfigReloadDeps {
  configManager: ConfigManager;
  lifecycle: LifecycleManager;
  logger: KernelLogger;
  isShuttingDown: () => boolean;
  getConfig: () => KernelConfig | undefined;
  setConfig: (config: KernelConfig) => void;
}

interface PermissionReloadDeps {
  permissionStore: PermissionStore;
  lifecycle: LifecycleManager;
  logger: KernelLogger;
  isShuttingDown: () => boolean;
}

interface ModuleReloadDeps {
  permissionStore: PermissionStore;
  logger: KernelLogger;
  isShuttingDown: () => boolean;
  reloadModules: () => Promise<void>;
}

export function createConfigReloadHandler(deps: ConfigReloadDeps): () => void {
  const { configManager, lifecycle, logger, isShuttingDown, getConfig, setConfig } = deps;

  return function handleConfigReload(): void {
    if (isShuttingDown()) return;
    logger.info("Received SIGUSR1 — reloading config");
    try {
      const oldConfig = structuredClone(configManager.getAll());
      const newConfig = configManager.load();
      setConfig(newConfig);

      // Find changed top-level sections
      const changedSections: string[] = [];
      const allKeys = new Set([
        ...Object.keys(oldConfig),
        ...Object.keys(newConfig as Record<string, unknown>),
      ]);
      for (const key of allKeys) {
        if (
          JSON.stringify(oldConfig[key]) !==
            JSON.stringify((newConfig as Record<string, unknown>)[key])
        ) {
          changedSections.push(key);
        }
      }

      if (changedSections.length === 0) {
        logger.info("Config unchanged");
        return;
      }

      // Compute affected modules for the config.reload event
      const affectedModules = lifecycle.getRegistry().ids().filter((id) => {
        const e = lifecycle.getRegistry().get(id);
        return e?.status === 'ready' && e.manifest.configKey && changedSections.includes(e.manifest.configKey);
      });
      logger.info({ changedSections, affectedModules }, "config.reload");

      // Update lifecycle init payload config reference
      lifecycle.updateConfig(newConfig);

      // Notify affected modules
      for (const moduleId of lifecycle.getRegistry().ids()) {
        const entry = lifecycle.getRegistry().get(moduleId);
        if (!entry || entry.status !== "ready") continue;

        const manifest = entry.manifest;
        const moduleConfigKey = manifest.configKey;
        if (moduleConfigKey && changedSections.includes(moduleConfigKey)) {
          // Security: send only the module's own config section and relevant changed sections
          lifecycle.sendMessage(moduleId, {
            type: "config:update" as const,
            config: { [moduleConfigKey]: configManager.getSection(moduleConfigKey) },
            changedSections: changedSections.filter((s: string) => s === moduleConfigKey),
          });
          logger.debug(
            { module: moduleId, changedSections },
            "Sent config:update",
          );
        }
      }
    } catch (err) {
      logger.error({ error: String(err) }, "Failed to reload config");
    }
  };
}

export function createPermissionReloadHandler(deps: PermissionReloadDeps): () => void {
  const { permissionStore, lifecycle, logger, isShuttingDown } = deps;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return function handlePermissionReload(): void {
    if (isShuttingDown()) return;
    if (debounceTimer) return; // Already scheduled

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (isShuttingDown()) return;
      logger.info("Received SIGUSR2 — reloading permissions");
      try {
        // PONS-006: Snapshot effective permissions before reload
        const before = new Map<string, string>();
        for (const moduleId of lifecycle.getRegistry().ids()) {
          const entry = lifecycle.getRegistry().get(moduleId);
          if (!entry || entry.status === "stopped" || entry.status === "crashed") continue;
          const eff = permissionStore.getEffectivePermissions(moduleId);
          before.set(moduleId, JSON.stringify(eff));
        }

        permissionStore.reload();
        // Refresh enforcer capabilities so updated caps take effect immediately
        lifecycle.refreshCapabilities();

        // Compare and act on changes
        for (const moduleId of lifecycle.getRegistry().ids()) {
          const entry = lifecycle.getRegistry().get(moduleId);
          if (!entry || entry.status === "stopped" || entry.status === "crashed") continue;

          if (!permissionStore.isApproved(moduleId)) {
            logger.warn({ module: moduleId }, "Permissions fully revoked — killing module");
            lifecycle.kill(moduleId, "permissions-revoked");
          } else {
            const after = JSON.stringify(permissionStore.getEffectivePermissions(moduleId));
            if (before.get(moduleId) !== after) {
              logger.info({ module: moduleId }, "Permissions changed — restarting with updated flags");
              lifecycle.restartWithUpdatedPermissions(moduleId);
            }
          }
        }
      } catch (err) {
        logger.error({ error: String(err) }, "Failed to reload permissions");
      }
    }, 100);
  };
}

export function createModuleReloadHandler(deps: ModuleReloadDeps): () => void {
  const { permissionStore, logger, isShuttingDown, reloadModules } = deps;

  return function handleModuleReload(): void {
    if (isShuttingDown()) return;
    logger.info("Received SIGHUP — reloading permissions and re-discovering modules");
    permissionStore.reload();
    reloadModules().catch((err) => {
      logger.error({ error: String(err) }, "Failed to reload modules");
    });
  };
}
