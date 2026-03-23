/**
 * Module Lifecycle Manager — thin facade over four focused sub-systems.
 *
 * Sub-systems:
 *   - ProcessPool:       spawn, kill, restart, hot-swap, shutdown ordering
 *   - IpcRouter:         message dispatching, kernel-to-module calls, RPC forwarding
 *   - HealthMonitor:     periodic ping/pong health checks
 *   - ServiceDirectory:  module activation, dependency resolution, lifecycle events
 *
 * This facade wires the sub-systems together via callbacks, preserving the exact
 * same public API so kernel.ts, signal-handlers.ts, and module-call-handler.ts
 * require no changes.
 */

import type { DiscoveredModule } from './module/loader.ts';
import type { KernelLogger } from './logs/logger.ts';
import type { MessageBus } from './messaging/bus.ts';
import { ModuleRegistry } from './module/registry.ts';
import type { KernelMessage, ModuleManifest } from '@pons/sdk';
import type { SecurityEnforcer } from './security/enforcer.ts';
import type { PermissionStore } from './security/permissions.ts';
import { DEFAULTS } from './lifecycle/types.ts';
import type { LifecycleContext, LifecycleLimits } from './lifecycle/types.ts';
import { IpcRouter } from './lifecycle/ipc-router.ts';
import { ProcessPool } from './lifecycle/process-pool.ts';
import { HealthMonitor } from './lifecycle/health-monitor.ts';
import { ServiceDirectory } from './lifecycle/service-directory.ts';

// ─── Lifecycle Manager (Facade) ───────────────────────────────

export class LifecycleManager {
  private readonly registry = new ModuleRegistry();
  private readonly ctx: LifecycleContext;

  private readonly ipcRouter: IpcRouter;
  private readonly processPool: ProcessPool;
  private readonly healthMonitor: HealthMonitor;
  private readonly serviceDirectory: ServiceDirectory;

  constructor(
    private readonly logger: KernelLogger,
    private readonly bus: MessageBus,
    private readonly initPayload: { config: unknown; workspacePath: string; projectRoot: string },
    private readonly onModuleCall: (moduleId: string, method: string, params: unknown) => Promise<unknown>,
    private readonly enforcer?: SecurityEnforcer,
    private readonly permissionStore?: PermissionStore,
  ) {
    const limits = loadLimits(initPayload);
    this.ctx = { registry: this.registry, logger, bus, enforcer, permissionStore, limits };

    // Wire sub-systems with cross-cutting callbacks

    this.ipcRouter = new IpcRouter(this.ctx, {
      onReady: (moduleId) => this.serviceDirectory.onReady(moduleId),
      onModuleCall: (moduleId, method, params) => this.onModuleCall(moduleId, method, params),
      kill: (moduleId, reason) => this.processPool.kill(moduleId, reason),
    });

    this.processPool = new ProcessPool(this.ctx, initPayload, {
      onModuleExitCleanup: (moduleId) => {
        this.ipcRouter.cleanupModuleCalls(moduleId);
        this.ipcRouter.cleanupModuleRpcs(moduleId);
      },
      clearModuleTimers: (moduleId) => {
        this.healthMonitor.clearAll(moduleId);
        this.serviceDirectory.clearPendingReady(moduleId);
        this.serviceDirectory.clearReadyTimeout(moduleId);
      },
      publishLifecycleEvent: (topic, payload) => this.serviceDirectory.publishLifecycleEvent(topic, payload),
      send: (moduleId, msg) => this.ipcRouter.send(moduleId, msg),
      handleMessage: (moduleId, msg) => this.ipcRouter.handleMessage(moduleId, msg),
      startReadyTimeout: (moduleId) => this.serviceDirectory.startReadyTimeout(moduleId),
      initModuleIpc: (moduleId) => this.ipcRouter.initModule(moduleId),
    });

    this.healthMonitor = new HealthMonitor(this.ctx, {
      ping: (moduleId) => this.ipcRouter.ping(moduleId),
      kill: (moduleId, reason) => this.processPool.kill(moduleId, reason),
    });

    this.serviceDirectory = new ServiceDirectory(this.ctx, {
      startHealthCheck: (moduleId) => this.healthMonitor.startHealthCheck(moduleId),
      scheduleRestartCountReset: (moduleId) => this.processPool.scheduleRestartCountReset(moduleId),
      send: (moduleId, msg) => this.ipcRouter.send(moduleId, msg),
      kill: (moduleId, reason) => this.processPool.kill(moduleId, reason),
      getSpawnTimestamp: (moduleId) => this.processPool.getSpawnTimestamp(moduleId),
    });
  }

  // ─── Public API (delegates to sub-systems) ────────────────────

  async spawnAll(modules: DiscoveredModule[]): Promise<void> {
    return this.processPool.spawnAll(modules);
  }

  async spawn(runnerPath: string, manifest: ModuleManifest, env?: Record<string, string>): Promise<void> {
    return this.processPool.spawn(runnerPath, manifest, env);
  }

  async kill(moduleId: string, reason = 'requested', tier = 0): Promise<void> {
    return this.processPool.kill(moduleId, reason, tier);
  }

  async hotSwap(moduleId: string, newRunnerPath: string, newManifest: ModuleManifest, env?: Record<string, string>): Promise<void> {
    return this.processPool.hotSwap(moduleId, newRunnerPath, newManifest, env);
  }

  async restartWithUpdatedPermissions(moduleId: string): Promise<void> {
    return this.processPool.restartWithUpdatedPermissions(moduleId);
  }

  /** Update the config reference used for new module spawns. */
  updateConfig(config: unknown): void {
    (this.initPayload as { config: unknown }).config = config;
    this.ctx.limits = loadLimits(this.initPayload);
  }

  /** Send a kernel message to a module (public wrapper for config:update, etc.). */
  sendMessage(moduleId: string, msg: KernelMessage): boolean {
    return this.ipcRouter.send(moduleId, msg);
  }

  /** Issue a call to a module and wait for a response. */
  call(moduleId: string, method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    return this.ipcRouter.call(moduleId, method, params, timeoutMs);
  }

  /**
   * Refresh enforcer capabilities for all running modules from the permission store.
   * Called after SIGUSR2 reloads permissions.yaml.
   */
  refreshCapabilities(): void {
    return this.serviceDirectory.refreshCapabilities();
  }

  async stopAll(): Promise<void> {
    return this.processPool.stopAll();
  }

  getRegistry(): ModuleRegistry {
    return this.registry;
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function loadLimits(initPayload: { config: unknown }): LifecycleLimits {
  const cfg = (initPayload.config as Record<string, unknown>)?.lifecycle as Record<string, unknown> | undefined;
  return {
    maxRestarts: (cfg?.maxRestarts as number) ?? DEFAULTS.MAX_RESTARTS,
    restartBaseMs: DEFAULTS.RESTART_BASE_MS,
    healthIntervalMs: (cfg?.healthIntervalMs as number) ?? DEFAULTS.HEALTH_INTERVAL_MS,
    pingTimeoutMs: (cfg?.pingTimeoutMs as number) ?? DEFAULTS.PING_TIMEOUT_MS,
    rpcTimeoutMs: (cfg?.rpcTimeoutMs as number) ?? DEFAULTS.RPC_TIMEOUT_MS,
    requiresTimeoutMs: (cfg?.requiresTimeoutMs as number) ?? DEFAULTS.REQUIRES_TIMEOUT_MS,
    shutdownGraceMs: (cfg?.shutdownGraceMs as number) ?? DEFAULTS.SHUTDOWN_GRACE_MS,
    healthMaxFailures: (cfg?.healthMaxFailures as number) ?? DEFAULTS.HEALTH_MAX_FAILURES,
    readyTimeoutMs: (cfg?.readyTimeoutMs as number) ?? DEFAULTS.READY_TIMEOUT_MS,
    maxRestartBackoffMs: (cfg?.maxRestartBackoffMs as number) ?? DEFAULTS.MAX_RESTART_BACKOFF_MS,
  };
}
