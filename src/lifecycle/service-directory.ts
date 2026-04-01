/**
 * ServiceDirectory — the gatekeeper that decides when a module is truly alive.
 *
 * A module process existing and sending `ready` is necessary but not sufficient.
 * Before a module can receive messages or serve RPC calls, it must prove that its
 * dependencies are satisfied. The ServiceDirectory holds modules in a `pendingReady`
 * state until all their `requires` services have been registered by other modules.
 * Only then does it activate the module and send `deps_ready`.
 *
 * This is the mechanism that gives the kernel its startup ordering guarantee: you can
 * declare `requires: ["llm"]` in your manifest and know that `onDepsReady()` will only
 * fire after the LLM module is fully initialized — without any manual sleep() or polling.
 *
 * The ServiceDirectory also registers capabilities with the SecurityEnforcer, subscribes
 * modules to their declared bus topics, and emits lifecycle events (module:ready,
 * module:stopped, etc.) that the rest of the system can react to.
 */

import type { ModuleManifest } from '@pons/sdk';
import type { ModuleCapabilities } from '../security/enforcer.ts';
import type { LifecycleContext, PendingReady } from './types.ts';
import type { TypedEmitter } from './typed-emitter.ts';

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
    events: TypedEmitter,
  ) {
    events.on("module:timers:clear", (moduleId) => {
      this.clearPendingReady(moduleId);
      this.clearReadyTimeout(moduleId);
    });
  }

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
            this.ctx.enforcer.logViolation(violation);
            if (violation.action === 'deny') {
              this.callbacks.kill(moduleId, 'security-violation');
              return;
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

    // Notify module of any optional services that are already available
    const activatedEntry = this.ctx.registry.get(moduleId);
    const optional = ((activatedEntry?.manifest as unknown as { optionalRequires?: string[] })?.optionalRequires) ?? [];
    for (const svc of optional) {
      if (this.ctx.registry.resolveService(svc)) {
        this.callbacks.send(moduleId, { type: 'service_available', service: svc });
      }
    }
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
      this.callbacks.kill(moduleId, 'ready-timeout');
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
