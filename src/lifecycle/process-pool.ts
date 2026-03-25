// The ProcessPool is where modules become real OS processes. It handles the full
// lifecycle of a module's process: forking it with the right Deno permissions, feeding
// it IPC messages, watching for unexpected exits, and deciding whether to restart or
// give up. Restart logic uses exponential backoff with a stability heuristic — if a
// module stays alive for 60 seconds, we consider it healthy and reset the failure
// counter. This prevents transient errors (a flaky network call at startup) from
// permanently exhausting the restart budget.

import type { KernelMessage, ModuleManifest } from '@pons/sdk';
import type { DiscoveredModule } from '../module/loader.ts';
import { ProcessForker } from '../process/process-forker.ts';
import { validateModuleMessage } from '../ipc/validation.ts';
import type { LifecycleContext } from './types.ts';
import { PROTOCOL_VERSION } from './types.ts';
import type { TypedEmitter } from './typed-emitter.ts';

// ─── Callback Interfaces ──────────────────────────────────────

export interface ProcessPoolCallbacks {
  /** Publish a system lifecycle event to bus subscribers. */
  publishLifecycleEvent(topic: string, payload: Record<string, unknown>): void;
  /** Send a kernel message to a module (routed through ipc-router). */
  send(moduleId: string, msg: KernelMessage): boolean;
  /** Handle a validated module message (routed through ipc-router). */
  handleMessage(moduleId: string, msg: import('@pons/sdk').ModuleMessage): Promise<void>;
  /** Start a ready timeout for a newly spawned module. */
  startReadyTimeout(moduleId: string): void;
  /** Initialize IPC pending-calls map for a module. */
  initModuleIpc(moduleId: string): void;
}

// ─── Process Pool ─────────────────────────────────────────────

export class ProcessPool {
  private readonly processForker: ProcessForker;
  // Last stderr output per module — kept so we can include it in crash diagnostics
  private stderrBuffers = new Map<string, string>();
  private spawnTimestamps = new Map<string, number>();
  // Per-module promise chain that serializes kill/restart operations. Without this,
  // a health-check kill racing with a signal-triggered restart could double-spawn.
  private restartLocks = new Map<string, Promise<void>>();
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private restartResetTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: LifecycleContext,
    private readonly initPayload: { config: unknown; workspacePath: string; projectRoot: string },
    private readonly callbacks: ProcessPoolCallbacks,
    private readonly events: TypedEmitter,
  ) {
    this.processForker = new ProcessForker(ctx.logger, ctx.permissionStore, initPayload.projectRoot);
  }

  // ─── Spawn ────────────────────────────────────────────────────

  async spawnAll(modules: DiscoveredModule[]): Promise<void> {
    const sorted = [...modules].sort(
      (a, b) => (a.manifest.priority ?? 100) - (b.manifest.priority ?? 100),
    );
    for (const { manifest, runnerPath } of sorted) {
      try {
        await this.spawn(runnerPath, manifest);
        this.ctx.logger.debug({ module: manifest.id }, 'Module spawned');
      } catch (err) {
        this.ctx.logger.error({ module: manifest.id, error: String(err) }, 'Failed to spawn module');
      }
    }
  }

  async spawn(runnerPath: string, manifest: ModuleManifest, env?: Record<string, string>): Promise<void> {
    if (this.ctx.permissionStore && !this.ctx.permissionStore.isApproved(manifest.id)) {
      this.ctx.logger.warn({ module: manifest.id }, 'Module not approved — refusing to spawn (run `pons modules install` to approve permissions)');
      return;
    }

    if (!this.ctx.registry.get(manifest.id)) {
      this.ctx.registry.register(manifest, runnerPath);
    } else {
      const entry = this.ctx.registry.get(manifest.id)!;
      entry.runnerPath = runnerPath;
    }
    this.callbacks.initModuleIpc(manifest.id);

    const proc = this.processForker.fork(runnerPath, manifest, env);

    proc.stdout?.on('data', (d: Uint8Array) => {
      this.ctx.logger.warn({ module: manifest.id, source: 'stdout' }, new TextDecoder().decode(d).trim());
    });
    proc.stderr?.on('data', (d: Uint8Array) => {
      const text = new TextDecoder().decode(d).trim();
      if (text) {
        this.stderrBuffers.set(manifest.id, text);
        this.ctx.logger.warn({ module: manifest.id, source: 'stderr' }, text);
      }
    });

    proc.on('message', (raw) => {
      const currentEntry = this.ctx.registry.get(manifest.id);
      if (!currentEntry || currentEntry.status === 'stopped' || currentEntry.status === 'crashed') return;

      const validated = validateModuleMessage(raw);
      if (!validated.msg) {
        this.ctx.logger.warn({ module: manifest.id, reason: validated.reason }, 'Invalid IPC message — ignoring');
        return;
      }
      this.callbacks.handleMessage(manifest.id, validated.msg).catch((err) => {
        this.ctx.logger.error({ module: manifest.id, error: String(err) }, 'Error handling module message');
      });
    });

    proc.on('exit', (code, signal) => {
      this.onExit(manifest.id, runnerPath, manifest, env, code, signal);
    });

    this.ctx.registry.setProcess(manifest.id, proc);
    this.spawnTimestamps.set(manifest.id, Date.now());
    this.ctx.logger.info({ moduleId: manifest.id, pid: proc.pid, runtime: (manifest as ModuleManifest & { runtime?: string }).runtime ?? 'deno' }, 'module.spawn');

    // First-time spawn: send install message before init
    if (this.ctx.permissionStore && !this.ctx.permissionStore.getFirstSpawnAt(manifest.id)) {
      this.callbacks.send(manifest.id, { type: 'install' });
      this.ctx.permissionStore.setFirstSpawnAt(manifest.id);
    }

    // Security: scope config to module's own section only
    const moduleConfigKey = manifest.configKey;
    const scopedConfig = moduleConfigKey && typeof this.initPayload.config === 'object' && this.initPayload.config !== null
      ? { [moduleConfigKey]: (this.initPayload.config as Record<string, unknown>)[moduleConfigKey] }
      : {};
    this.callbacks.send(manifest.id, {
      type: 'init',
      protocolVersion: PROTOCOL_VERSION,
      config: scopedConfig,
      workspacePath: this.initPayload.workspacePath,
      projectRoot: this.initPayload.projectRoot,
    } as KernelMessage);

    this.callbacks.startReadyTimeout(manifest.id);
  }

  // ─── Kill / Hot-swap ──────────────────────────────────────────

  async kill(moduleId: string, reason = 'requested', tier = 0): Promise<void> {
    await this.withModuleLock(moduleId, () => this.killInner(moduleId, reason, tier));
  }

  private async killInner(moduleId: string, reason: string, tier = 0): Promise<void> {
    const entry = this.ctx.registry.get(moduleId);
    if (!entry) return;

    this.callbacks.publishLifecycleEvent('system:module:stopping', { moduleId, tier });
    this.ctx.registry.setStatus(moduleId, 'killed');
    this.clearTimers(moduleId);
    this.events.emit('module:timers:clear', moduleId);

    if (entry.process?.connected) {
      this.callbacks.send(moduleId, { type: 'shutdown' });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.ctx.limits.shutdownGraceMs);
        entry.process?.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (entry.process?.connected) {
        entry.process.kill('SIGKILL');
      }
    }

    this.events.emit('module:exit', moduleId);
    this.ctx.bus.unsubscribe(moduleId);
    this.ctx.enforcer?.removeModuleCapabilities(moduleId);
    this.ctx.registry.setStatus(moduleId, 'stopped');
    this.callbacks.publishLifecycleEvent('system:module:stopped', { moduleId, reason });
    this.ctx.logger.info({ moduleId, reason }, 'module.killed');
  }

  async hotSwap(moduleId: string, newRunnerPath: string, newManifest: ModuleManifest, env?: Record<string, string>): Promise<void> {
    if (this.ctx.permissionStore && newManifest.permissions) {
      const approved = this.ctx.permissionStore.getApproved(newManifest.id);
      if (!approved) {
        this.ctx.logger.error({ module: newManifest.id }, 'Hot-swap blocked — new manifest has no approved permissions');
        return;
      }
      const newPerms = newManifest.permissions as unknown as Record<string, string[]>;
      const approvedPerms = approved.permissions as unknown as Record<string, string[]>;
      for (const [key, values] of Object.entries(newPerms)) {
        const approvedValues = approvedPerms[key] ?? [];
        const unapproved = (values ?? []).filter((v: string) => !approvedValues.includes(v));
        if (unapproved.length > 0) {
          this.ctx.logger.error({ module: newManifest.id, permission: key, unapproved }, 'Hot-swap blocked — new manifest requests unapproved permissions');
          return;
        }
      }
    }

    this.ctx.logger.info({ module: moduleId }, 'Hot-swap: draining old process');
    await this.kill(moduleId, 'hot-swap');
    this.ctx.registry.remove(moduleId);

    this.ctx.logger.info({ module: newManifest.id }, 'Hot-swap: spawning new process');
    await this.spawn(newRunnerPath, newManifest, env);
  }

  async restartWithUpdatedPermissions(moduleId: string): Promise<void> {
    await this.withModuleLock(moduleId, async () => {
      const entry = this.ctx.registry.get(moduleId);
      if (!entry) return;

      this.ctx.logger.info({ module: moduleId }, 'Restarting module with updated permissions');

      const runnerPath = entry.runnerPath;
      const { manifest } = entry;

      if (!runnerPath) {
        this.ctx.logger.error({ module: moduleId }, 'Cannot restart — no runnerPath stored');
        return;
      }

      await this.killInner(moduleId, 'permission-update');
      await this.spawn(runnerPath, manifest);
    });
  }

  // ─── Exit Handler ─────────────────────────────────────────────

  private onExit(
    moduleId: string,
    runnerPath: string,
    manifest: ModuleManifest,
    env: Record<string, string> | undefined,
    code: number | null,
    signal: string | null,
  ): void {
    const entry = this.ctx.registry.get(moduleId);
    if (!entry || entry.status === 'stopped' || entry.status === 'killed') return;

    this.clearTimers(moduleId);
    this.events.emit('module:timers:clear', moduleId);
    this.events.emit('module:exit', moduleId);

    const restarts = this.ctx.registry.incrementRestarts(moduleId);
    const lastStderr = this.stderrBuffers.get(moduleId);
    this.stderrBuffers.delete(moduleId);

    const spawnTime = this.spawnTimestamps.get(moduleId);
    this.spawnTimestamps.delete(moduleId);
    const aliveMs = spawnTime ? Date.now() - spawnTime : null;
    const instant = aliveMs !== null && aliveMs < 1000;

    let detail = '';
    if (lastStderr) {
      detail = lastStderr;
    } else if (instant) {
      detail = `exited after ${aliveMs}ms with no output — check the module entry point (runner) and its dependencies`;
    }

    const crashFields = { moduleId, exitCode: code, signal, restartCount: restarts, ...(aliveMs !== null ? { aliveMs } : {}), ...(lastStderr ? { stderr: lastStderr } : {}) };
    const crashMsg = detail ? `Module exited unexpectedly — ${detail}` : 'Module exited unexpectedly';
    if (instant) {
      this.ctx.logger.warn(crashFields, crashMsg);
    } else {
      this.ctx.logger.error(crashFields, crashMsg);
    }

    if (restarts >= this.ctx.limits.maxRestarts) {
      this.ctx.registry.setStatus(moduleId, 'crashed');
      this.ctx.bus.unsubscribe(moduleId);
      this.ctx.enforcer?.removeModuleCapabilities(moduleId);
      this.restartLocks.delete(moduleId);
      this.callbacks.publishLifecycleEvent('system:module:crashed', { moduleId, restartCount: restarts });
      this.ctx.logger.error({ moduleId }, 'Module crashed — max restarts reached');
      return;
    }

    const delay = Math.min(this.ctx.limits.restartBaseMs * Math.pow(2, restarts - 1), this.ctx.limits.maxRestartBackoffMs);
    this.ctx.registry.setStatus(moduleId, 'restarting');

    const restartTimer = setTimeout(() => {
      this.restartTimers.delete(moduleId);
      const current = this.ctx.registry.get(moduleId);
      if (!current || current.status === 'stopped' || current.status === 'crashed') return;
      this.withModuleLock(moduleId, async () => {
        const inner = this.ctx.registry.get(moduleId);
        if (!inner || inner.status === 'stopped' || inner.status === 'crashed') return;
        await this.spawn(runnerPath, manifest, env);
      }).catch((err) => {
        this.ctx.logger.error({ module: moduleId, error: String(err) }, 'Module restart failed');
      });
    }, delay);
    this.restartTimers.set(moduleId, restartTimer);
  }

  // ─── Ordered Shutdown ─────────────────────────────────────────

  async stopAll(): Promise<void> {
    const tiers = this.computeShutdownTiers();
    for (let i = 0; i < tiers.length; i++) {
      await Promise.all(tiers[i].map(id => this.kill(id, 'shutdown', i)));
    }
  }

  /** Compute shutdown tiers via reverse topological sort (leaves first). */
  private computeShutdownTiers(): string[][] {
    const ids = this.ctx.registry.ids();
    if (ids.length === 0) return [];

    const dependsOn = new Map<string, Set<string>>();
    for (const id of ids) {
      dependsOn.set(id, new Set());
    }
    for (const id of ids) {
      const entry = this.ctx.registry.get(id);
      const requires = entry?.manifest.requires ?? [];
      for (const service of requires) {
        const provider = this.ctx.registry.resolveService(service);
        if (provider && provider !== id && dependsOn.has(provider)) {
          dependsOn.get(id)!.add(provider);
        }
      }
    }

    const tiers: string[][] = [];
    const remaining = new Set(ids);
    while (remaining.size > 0) {
      const tier: string[] = [];
      for (const id of remaining) {
        let isDependency = false;
        for (const otherId of remaining) {
          if (otherId !== id && dependsOn.get(otherId)!.has(id)) {
            isDependency = true;
            break;
          }
        }
        if (!isDependency) tier.push(id);
      }
      if (tier.length === 0) {
        tiers.push([...remaining]);
        break;
      }
      tiers.push(tier);
      for (const id of tier) remaining.delete(id);
    }
    return tiers;
  }

  // ─── Restart Count Reset ──────────────────────────────────────

  /** Reset restart counter if module stays alive for 60+ seconds (spec S8). */
  scheduleRestartCountReset(moduleId: string): void {
    const existing = this.restartResetTimers.get(moduleId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.restartResetTimers.delete(moduleId);
      const entry = this.ctx.registry.get(moduleId);
      if (entry && entry.status === 'ready' && entry.restartCount > 0) {
        this.ctx.registry.resetRestartCount(moduleId);
        this.ctx.logger.debug({ module: moduleId }, 'Restart counter reset — module stable for 60s');
      }
    }, 60_000);
    this.restartResetTimers.set(moduleId, timer);
  }

  /** Get spawn timestamp for a module (used by service-directory for startup timing). */
  getSpawnTimestamp(moduleId: string): number | undefined {
    return this.spawnTimestamps.get(moduleId);
  }

  // ─── Locking ──────────────────────────────────────────────────

  private async withModuleLock(moduleId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.restartLocks.get(moduleId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.restartLocks.set(moduleId, next);
    try {
      await next;
    } finally {
      if (this.restartLocks.get(moduleId) === next) {
        this.restartLocks.delete(moduleId);
      }
    }
  }

  // ─── Timer Management ─────────────────────────────────────────

  private clearTimers(moduleId: string): void {
    const restartTimer = this.restartTimers.get(moduleId);
    if (restartTimer) { clearTimeout(restartTimer); this.restartTimers.delete(moduleId); }
    const resetTimer = this.restartResetTimers.get(moduleId);
    if (resetTimer) { clearTimeout(resetTimer); this.restartResetTimers.delete(moduleId); }
  }
}
