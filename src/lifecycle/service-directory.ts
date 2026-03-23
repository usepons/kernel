/**
 * Service Directory — module activation, dependency resolution, lifecycle events.
 *
 * Owns: pendingReady, readyTimers state.
 * Handles the 'ready' message flow: capability registration, topic subscription,
 * service registration, dependency checking, and activation.
 */

import type { ModuleManifest } from '@pons/sdk';
import type { ModuleCapabilities } from '../security/enforcer.ts';
import type { LifecycleContext, PendingReady } from './types.ts';

// ─── Callback Interfaces ──────────────────────────────────────

export interface ServiceDirectoryCallbacks {
  /** Start periodic health checks for an activated module. */
  startHealthCheck(moduleId: string): void;
  /** Schedule restart-count reset after stable period. */
  scheduleRestartCountReset(moduleId: string): void;
  /** Send a kernel message to a module. */
  send(moduleId: string, msg: import('@pons/sdk').KernelMessage): boolean;
  /** Kill a module (routed through process-pool). */
  kill(moduleId: string, reason: string): Promise<void>;
  /** Get spawn timestamp for startup timing. */
  getSpawnTimestamp(moduleId: string): number | undefined;
}

// ─── Service Directory ────────────────────────────────────────

export class ServiceDirectory {
  private pendingReady = new Map<string, PendingReady>();
  private readyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: LifecycleContext,
    private readonly callbacks: ServiceDirectoryCallbacks,
  ) {}

  // ─── Ready Handler ────────────────────────────────────────────

  /** Handle a module's 'ready' message: register capabilities, topics, services, and activate. */
  onReady(moduleId: string): void {
    this.clearReadyTimeout(moduleId);
    const spawnTime = this.callbacks.getSpawnTimestamp(moduleId);
    const startupMs = spawnTime ? Date.now() - spawnTime : undefined;
    this.ctx.logger.info({ moduleId, ...(startupMs !== undefined ? { startupMs } : {}) }, 'module.ready');

    const storedEntry = this.ctx.registry.get(moduleId);
    const manifest = storedEntry?.manifest;
    if (!manifest) {
      this.ctx.logger.error({ module: moduleId }, 'Module ready but no manifest in registry');
      return;
    }

    // Security: register module capabilities (PONS-004)
    const storedCaps = this.ctx.permissionStore?.getApprovedCapabilities(moduleId);
    const manifestCaps = (manifest as ModuleManifest & { capabilities?: ModuleCapabilities }).capabilities;
    const derivedCaps: ModuleCapabilities = {
      topics: manifest.subscribes ?? [],
      services: [...(manifest.requires ?? []), ...((manifest as ModuleManifest & { optionalRequires?: string[] }).optionalRequires ?? [])],
    };
    const hasStoredCaps = storedCaps && ((storedCaps.topics?.length ?? 0) > 0 || (storedCaps.services?.length ?? 0) > 0);
    const capabilities = (hasStoredCaps ? storedCaps : null) ?? manifestCaps ?? derivedCaps;
    if (this.ctx.enforcer) {
      this.ctx.enforcer.setModuleCapabilities(moduleId, capabilities);
    }

    // Merge subscribes + capabilities.topics for subscription (spec S8)
    const topics = [...new Set([...(manifest.subscribes ?? []), ...(manifest.capabilities?.topics ?? [])])];
    if (this.ctx.enforcer && topics.length > 0) {
      const caps = this.ctx.enforcer.getModuleCapabilities(moduleId);
      if (!caps) {
        const violation = this.ctx.enforcer.createViolation(moduleId, 'topic', `subscribe:${topics[0]}`);
        if (violation) {
          this.ctx.enforcer.logViolation(violation);
          if (violation.action === 'deny') {
            this.callbacks.kill(moduleId, 'security-violation');
            return;
          }
          // warn mode: log but continue
        }
      }
      if (caps) {
        for (const topic of topics) {
          const violation = this.ctx.enforcer.checkTopic(moduleId, topic, 'subscribe', caps);
          if (violation) {
            // Fallback: auto-derive from manifest before enforcing
            const manifestTopics = [...(manifest.subscribes ?? []), ...(manifest.publishes ?? [])];
            if (manifestTopics.includes(topic)) {
              this.ctx.logger.warn({ moduleId, topic }, `Topic '${topic}' not in capabilities but found in manifest — auto-allowing. Add to capabilities block to silence this warning.`);
              const updatedTopics = [...new Set([...(caps.topics ?? []), topic])];
              this.ctx.enforcer.setModuleCapabilities(moduleId, { ...caps, topics: updatedTopics });
            } else {
              this.ctx.enforcer.logViolation(violation);
              if (violation.action === 'deny') {
                this.callbacks.kill(moduleId, 'security-violation');
                return;
              }
              // warn mode: log but continue
            }
          }
        }
      }
    }
    this.ctx.bus.subscribe(moduleId, topics);

    // Register provided services
    const services = manifest.provides ?? [];
    if (services.length > 0) {
      const rejected = this.ctx.registry.registerServices(moduleId, services);
      if (rejected.length > 0) {
        this.ctx.logger.error({ module: moduleId, rejected }, 'Duplicate service registration — killing module');
        this.callbacks.kill(moduleId, 'duplicate-service');
        return;
      }
      if (services.length > 0) {
        this.ctx.logger.info({ module: moduleId, services }, 'Services registered');
      }
      this.notifyOptionalServices(services);
    }

    // Check for circular dependencies
    const cycle = this.ctx.registry.detectCircularDeps(moduleId);
    if (cycle) {
      this.ctx.logger.error(
        { moduleId, cycle: cycle.join(' -> ') },
        'Circular service dependency detected — killing all modules in cycle',
      );
      const uniqueModules = [...new Set(cycle)];
      for (const cycleModuleId of uniqueModules) {
        this.callbacks.kill(cycleModuleId, 'circular-dependency');
      }
      return;
    }

    // Check required services before activation
    const requires = manifest.requires ?? [];
    if (requires.every((s: string) => this.ctx.registry.resolveService(s))) {
      this.activateModule(moduleId);
    } else {
      const missing = requires.filter((s: string) => !this.ctx.registry.resolveService(s));
      const timer = setTimeout(() => {
        this.pendingReady.delete(moduleId);
        const stillMissing = requires.filter((s: string) => !this.ctx.registry.resolveService(s));
        this.ctx.logger.error({ module: moduleId, missing: stillMissing },
          `Required services not satisfied within ${this.ctx.limits.requiresTimeoutMs / 1000}s — killing`);
        this.callbacks.kill(moduleId, 'requires-timeout');
      }, this.ctx.limits.requiresTimeoutMs);
      this.ctx.registry.setStatus(moduleId, 'waiting');
      this.pendingReady.set(moduleId, { manifest, timer });
      this.ctx.logger.info({ module: moduleId, waiting: missing }, 'Waiting for required services');
    }
  }

  // ─── Activation ───────────────────────────────────────────────

  private activateModule(moduleId: string): void {
    this.ctx.registry.setStatus(moduleId, 'ready');
    this.callbacks.startHealthCheck(moduleId);
    this.callbacks.send(moduleId, { type: 'deps_ready' });
    const readyEntry = this.ctx.registry.get(moduleId);
    this.publishLifecycleEvent('system:module:ready', {
      moduleId,
      provides: readyEntry?.manifest.provides ?? [],
      version: readyEntry?.manifest.version ?? 'unknown',
    });
    this.checkPendingReady();
    this.callbacks.scheduleRestartCountReset(moduleId);
  }

  private notifyOptionalServices(newServices: string[]): void {
    for (const id of this.ctx.registry.ids()) {
      const entry = this.ctx.registry.get(id);
      if (!entry || entry.status !== 'ready') continue;
      const optional = entry.manifest.optionalRequires ?? [];
      for (const svc of newServices) {
        if (optional.includes(svc)) {
          this.callbacks.send(id, { type: 'service_available', service: svc });
        }
      }
    }
  }

  private checkPendingReady(): void {
    const ready: string[] = [];
    for (const [moduleId, { manifest, timer }] of this.pendingReady) {
      const requires = manifest.requires ?? [];
      if (requires.every((s: string) => this.ctx.registry.resolveService(s))) {
        clearTimeout(timer);
        this.pendingReady.delete(moduleId);
        ready.push(moduleId);
      }
    }
    for (const moduleId of ready) {
      this.ctx.logger.info({ module: moduleId }, 'All required services available — activating');
      this.activateModule(moduleId);
    }
  }

  // ─── Lifecycle Events ─────────────────────────────────────────

  /** Publish a system lifecycle event on the message bus (spec S6). */
  publishLifecycleEvent(topic: string, payload: Record<string, unknown>): void {
    const subscribers = this.ctx.bus.getSubscribers(topic);
    for (const subscriberId of subscribers) {
      const entry = this.ctx.registry.get(subscriberId);
      if (!entry?.process?.connected || entry.status !== 'ready') continue;
      if (this.ctx.enforcer) {
        const caps = this.ctx.enforcer.getModuleCapabilities(subscriberId);
        if (caps) {
          const capTopics = caps.topics ?? [];
          const hasTopic = capTopics.includes(topic) ||
            capTopics.some(t => t.endsWith(':*') && topic.startsWith(t.slice(0, -1)));
          if (!hasTopic) continue;
        }
      }
      this.callbacks.send(subscriberId, { type: 'deliver', id: crypto.randomUUID(), topic, payload });
    }
  }

  // ─── Capability Refresh ───────────────────────────────────────

  /**
   * Refresh enforcer capabilities for all running modules from the permission store.
   * Called after SIGUSR2 reloads permissions.yaml.
   */
  refreshCapabilities(): void {
    if (!this.ctx.enforcer) return;
    for (const moduleId of this.ctx.registry.ids()) {
      const entry = this.ctx.registry.get(moduleId);
      if (!entry || entry.status === 'stopped' || entry.status === 'crashed') continue;
      const manifest = entry.manifest;

      const storedCaps = this.ctx.permissionStore?.getApprovedCapabilities(moduleId);
      const manifestCaps = (manifest as ModuleManifest & { capabilities?: ModuleCapabilities }).capabilities;
      const derivedCaps = this.ctx.enforcer.deriveCapabilities(manifest);
      const hasStoredCaps = storedCaps && ((storedCaps.topics?.length ?? 0) > 0 || (storedCaps.services?.length ?? 0) > 0);
      const capabilities = (hasStoredCaps ? storedCaps : null) ?? manifestCaps ?? derivedCaps;
      this.ctx.enforcer.setModuleCapabilities(moduleId, capabilities);
    }
    this.ctx.logger.info('Enforcer capabilities refreshed for all running modules');
  }

  // ─── Ready Timeout ────────────────────────────────────────────

  /** Start a timer that kills the module if it doesn't send 'ready' in time. */
  startReadyTimeout(moduleId: string): void {
    this.clearReadyTimeout(moduleId);
    const timer = setTimeout(() => {
      this.readyTimers.delete(moduleId);
      const entry = this.ctx.registry.get(moduleId);
      if (!entry || entry.status !== 'starting') return;
      this.ctx.logger.error({ module: moduleId }, `Module did not send 'ready' within ${this.ctx.limits.readyTimeoutMs / 1000}s — treating as crash`);
      entry.process?.kill('SIGKILL');
    }, this.ctx.limits.readyTimeoutMs);
    this.readyTimers.set(moduleId, timer);
  }

  clearReadyTimeout(moduleId: string): void {
    const t = this.readyTimers.get(moduleId);
    if (t) { clearTimeout(t); this.readyTimers.delete(moduleId); }
  }

  clearPendingReady(moduleId: string): void {
    const pending = this.pendingReady.get(moduleId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingReady.delete(moduleId);
    }
  }
}
