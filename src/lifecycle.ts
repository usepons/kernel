/**
 * Module Lifecycle Manager — spawn, kill, restart, hot-swap, IPC routing.
 *
 * Each module runs as an isolated child process.
 * IPC protocol: kernel sends KernelMessage, module replies with ModuleMessage.
 *
 * Two communication patterns:
 *   1. Pub/Sub — immediate in-memory forwarding (fire-and-forget)
 *   2. RPC — direct IPC routing (non-persistent, exactly-once, timeout on failure)
 */

import { fork, spawn as spawnChild } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KernelLogger } from './logs/logger.ts';
import { writeModuleLog, writeModuleLogGroup } from './logs/logger.ts';
import type { MessageBus } from './messaging/bus.ts';
import { ModuleRegistry } from './module/registry.ts';
import type { KernelMessage, ModuleMessage, ModuleManifest } from 'jsr:@pons/sdk@^0.2';


const VALID_MODULE_TYPES = new Set([
  'ready', 'log', 'log-group', 'ack', 'nack',
  'publish', 'call', 'pong', 'call:response',
  'rpc_request', 'rpc_response',
]);

/** Lightweight validation that incoming IPC data is a known ModuleMessage. */
export function validateModuleMessage(raw: unknown): ModuleMessage | null {
  if (raw == null || typeof raw !== 'object') return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string' || !VALID_MODULE_TYPES.has(msg.type)) return null;
  return raw as ModuleMessage;
}

// ─── Constants ─────────────────────────────────────────────────

const MAX_RESTARTS = 5;
const RESTART_BASE_MS = 1_000;
const HEALTH_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 30_000;
const REQUIRES_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

// ─── Internal Types ────────────────────────────────────────────

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRpc {
  callerModuleId: string;
  targetModuleId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingReady {
  manifest: ModuleManifest;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Lifecycle Manager ─────────────────────────────────────────

export class LifecycleManager {
  private registry = new ModuleRegistry();
  private pendingCalls = new Map<string, Map<string, PendingCall>>();
  private pendingRpc = new Map<string, PendingRpc>();
  private healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private pendingReady = new Map<string, PendingReady>();

  private readonly denoConfigPath: string | null;

  constructor(
    private readonly logger: KernelLogger,
    private readonly bus: MessageBus,
    private readonly initPayload: { config: unknown; workspacePath: string; projectRoot: string },
    private readonly onModuleCall: (moduleId: string, method: string, params: unknown) => Promise<unknown>,
  ) {
    this.denoConfigPath = this.findDenoConfig();
  }

  // ─── Spawn ────────────────────────────────────────────────────

  async spawnAll(modules: DiscoveredModule[]): Promise<void> {
      for (const { manifest, runnerPath } of modules) {
      try {
        await this.spawn(runnerPath, manifest);
        this.logger.debug({ module: manifest.id }, 'Module spawned');
      } catch (err) {
        this.logger.error({ module: manifest.id, error: String(err) }, 'Failed to spawn module');
      }
    }
  }

  async spawn(runnerPath: string, manifest: ModuleManifest, env?: Record<string, string>): Promise<void> {
    // Only register fresh if not already in the registry (avoids resetting restartCount on respawn)
    if (!this.registry.get(manifest.id)) {
      this.registry.register(manifest);
    }
    if (!this.pendingCalls.has(manifest.id)) {
      this.pendingCalls.set(manifest.id, new Map());
    }

    const proc = this.forkProcess(runnerPath, manifest, env);

    proc.stdout?.on('data', (d: Buffer) => {
      this.logger.debug({ module: manifest.id, source: 'stdout' }, d.toString().trim());
    });
    proc.stderr?.on('data', (d: Buffer) => {
      this.logger.warn({ module: manifest.id, source: 'stderr' }, d.toString().trim());
    });

    proc.on('message', (raw) => {
      const msg = validateModuleMessage(raw);
      if (!msg) {
        this.logger.warn({ module: manifest.id }, 'Invalid IPC message — ignoring');
        return;
      }
      this.handleMessage(manifest.id, msg).catch((err) => {
        this.logger.error({ module: manifest.id, error: String(err) }, 'Error handling module message');
      });
    });

    proc.on('exit', (code, signal) => {
      this.onExit(manifest.id, runnerPath, manifest, env, code, signal);
    });

    this.registry.setProcess(manifest.id, proc);
    this.logger.debug({ module: manifest.id, pid: proc.pid }, 'Module process spawned');

    this.send(manifest.id, { type: 'init', ...this.initPayload });
  }

  // ─── Kill / Hot-swap ──────────────────────────────────────────

  async kill(moduleId: string, reason = 'requested'): Promise<void> {
    const entry = this.registry.get(moduleId);
    if (!entry) return;

    this.registry.setStatus(moduleId, 'stopped');
    this.clearTimers(moduleId);
    this.clearPendingReady(moduleId);

    if (entry.process?.connected) {
      this.send(moduleId, { type: 'shutdown' });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        entry.process?.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (entry.process.connected) {
        entry.process.kill('SIGKILL');
      }
    }

    this.cleanupModuleCalls(moduleId);
    this.cleanupModuleRpcs(moduleId);
    this.bus.unsubscribe(moduleId);
    this.logger.info({ module: moduleId, reason }, 'Module stopped');
  }

  async hotSwap(moduleId: string, newRunnerPath: string, newManifest: ModuleManifest, env?: Record<string, string>): Promise<void> {
    this.logger.info({ module: moduleId }, 'Hot-swap: draining old process');
    await this.kill(moduleId, 'hot-swap');
    this.registry.remove(moduleId);

    this.logger.info({ module: newManifest.id }, 'Hot-swap: spawning new process');
    await this.spawn(newRunnerPath, newManifest, env);
  }

  // ─── Message Routing ─────────────────────────────────────────

  private async handleMessage(moduleId: string, msg: ModuleMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':        return this.onReady(moduleId);
      case 'log':          return void writeModuleLog(this.logger, moduleId, msg.level, msg.msg, msg.data, msg.topic);
      case 'log-group':    return void writeModuleLogGroup(this.logger, moduleId, msg.level, msg.msg, msg.data, msg.items);
      case 'ack':          return; // fire-and-forget — no tracking needed
      case 'nack':         return; // fire-and-forget — no tracking needed
      case 'publish':      return this.onPublish(moduleId, msg.topic, msg.payload);
      case 'call':         return this.onCall(moduleId, msg.id, msg.method, msg.params);
      case 'call:response': return this.onCallResponse(moduleId, msg.id, msg.result, msg.error);
      case 'pong':         return this.onPong(moduleId);
      case 'rpc_request':  return this.onRpcRequest(moduleId, msg.id, msg.service, msg.method, msg.params);
      case 'rpc_response': return this.onRpcResponse(moduleId, msg.id, msg.result, msg.error);
    }
  }

  // ─── Message Handlers ────────────────────────────────────────

  private onReady(moduleId: string): void {
    this.logger.info({ module: moduleId }, 'Module ready');

    const storedEntry = this.registry.get(moduleId);
    const manifest = storedEntry?.manifest;
    if (!manifest) {
      this.logger.error({ module: moduleId }, 'Module ready but no manifest in registry');
      return;
    }

    // Subscribe to bus topics
    const topics = manifest.subscribes ?? [];
    this.bus.subscribe(moduleId, topics);

    // Register provided services
    const services = manifest.provides ?? [];
    if (services.length > 0) {
      const rejected = this.registry.registerServices(moduleId, services);
      if (rejected.length > 0) {
        this.logger.warn({ module: moduleId, rejected }, 'Service registration rejected — already provided by another module');
      }
      const registered = services.filter((s: string) => !rejected.includes(s));
      if (registered.length > 0) {
        this.logger.info({ module: moduleId, services: registered }, 'Services registered');
      }
      this.notifyOptionalServices(services);
    }

    // Check for circular dependencies
    const cycle = this.registry.detectCircularDeps(moduleId);
    if (cycle) {
      this.logger.error(
        { module: moduleId, cycle: cycle.join(' → ') },
        'Circular service dependency detected — killing module',
      );
      this.kill(moduleId, 'circular-dependency');
      return;
    }

    // Check required services before activation
    const requires = manifest.requires ?? [];
    if (requires.every((s: string) => this.registry.resolveService(s))) {
      this.activateModule(moduleId);
    } else {
      const missing = requires.filter((s: string) => !this.registry.resolveService(s));
      const timer = setTimeout(() => {
        this.pendingReady.delete(moduleId);
        const stillMissing = requires.filter((s: string) => !this.registry.resolveService(s));
        this.logger.error({ module: moduleId, missing: stillMissing },
          `Required services not satisfied within ${REQUIRES_TIMEOUT_MS / 1000}s — killing`);
        this.kill(moduleId, 'requires-timeout');
      }, REQUIRES_TIMEOUT_MS);
      this.pendingReady.set(moduleId, { manifest, timer });
      this.logger.info({ module: moduleId, waiting: missing }, 'Waiting for required services');
    }
  }

  private onPublish(fromModuleId: string, topic: string, payload: unknown): void {
    const subscribers = this.bus.getSubscribers(topic, fromModuleId);
    for (const subscriberId of subscribers) {
      const entry = this.registry.get(subscriberId);
      if (!entry?.process?.connected) continue;
      this.send(subscriberId, {
        type: 'deliver',
        id: randomUUID(),
        topic,
        payload,
      });
    }
  }

  private async onCall(moduleId: string, callId: string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onModuleCall(moduleId, method, params);
      this.send(moduleId, { type: 'call:response', id: callId, result });
    } catch (err) {
      this.send(moduleId, { type: 'call:response', id: callId, error: String(err) });
    }
  }

  private onCallResponse(moduleId: string, callId: string, result: unknown, error?: string): void {
    const calls = this.pendingCalls.get(moduleId);
    const pending = calls?.get(callId);
    if (!pending) return;

    clearTimeout(pending.timer);
    calls!.delete(callId);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result);
  }

  private onPong(moduleId: string): void {
    const calls = this.pendingCalls.get(moduleId);
    if (!calls) return;

    for (const [id, pending] of calls) {
      if (id.startsWith('ping:')) {
        clearTimeout(pending.timer);
        calls.delete(id);
        pending.resolve(undefined);
      }
    }
  }

  private onRpcRequest(callerModuleId: string, rpcId: string, service: string, method: string, params?: unknown): void {
    const targetModuleId = this.registry.resolveService(service);
    if (!targetModuleId) {
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: `Service not found: ${service}` });
      return;
    }

    const targetEntry = this.registry.get(targetModuleId);
    if (!targetEntry?.process?.connected) {
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: `Service ${service} unavailable (module ${targetModuleId} not connected)` });
      return;
    }

    const timer = setTimeout(() => {
      this.pendingRpc.delete(rpcId);
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: `RPC ${service}.${method} timed out` });
    }, RPC_TIMEOUT_MS);

    this.pendingRpc.set(rpcId, { callerModuleId, targetModuleId, timer });
    this.send(targetModuleId, {
      type: 'rpc_request', id: rpcId, from: callerModuleId,
      service, method, params,
    });
  }

  private onRpcResponse(moduleId: string, rpcId: string, result?: unknown, error?: string): void {
    const pending = this.pendingRpc.get(rpcId);
    if (!pending) return;

    if (pending.targetModuleId !== moduleId) {
      this.logger.warn({ module: moduleId, expected: pending.targetModuleId, rpcId }, 'RPC response from unexpected module — ignoring');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRpc.delete(rpcId);
    this.send(pending.callerModuleId, { type: 'rpc_response', id: rpcId, result, error });
  }

  // ─── Module Activation ───────────────────────────────────────

  private activateModule(moduleId: string): void {
    this.registry.setStatus(moduleId, 'ready');
    this.startHealthCheck(moduleId);
    this.send(moduleId, { type: 'deps_ready' });
    this.checkPendingReady();
  }

  private notifyOptionalServices(newServices: string[]): void {
    for (const id of this.registry.ids()) {
      const entry = this.registry.get(id);
      if (!entry || entry.status !== 'ready') continue;
      const optional = entry.manifest.optionalRequires ?? [];
      for (const svc of newServices) {
        if (optional.includes(svc)) {
          this.send(id, { type: 'service_available', service: svc });
        }
      }
    }
  }

  private checkPendingReady(): void {
    const ready: string[] = [];
    for (const [moduleId, { manifest, timer }] of this.pendingReady) {
      const requires = manifest.requires ?? [];
      if (requires.every((s: string) => this.registry.resolveService(s))) {
        clearTimeout(timer);
        this.pendingReady.delete(moduleId);
        ready.push(moduleId);
      }
    }
    for (const moduleId of ready) {
      this.logger.info({ module: moduleId }, 'All required services available — activating');
      this.activateModule(moduleId);
    }
  }

  // ─── Health Check ────────────────────────────────────────────

  private startHealthCheck(moduleId: string): void {
    this.clearHealthTimer(moduleId);
    const timer = setInterval(async () => {
      try {
        await this.ping(moduleId);
      } catch {
        this.logger.warn({ module: moduleId }, 'Health check failed — killing module');
        const entry = this.registry.get(moduleId);
        entry?.process?.kill('SIGKILL');
      }
    }, HEALTH_INTERVAL_MS);

    this.healthTimers.set(moduleId, timer);
  }

  private async ping(moduleId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = `ping:${randomUUID()}`;
      const timer = setTimeout(() => {
        this.pendingCalls.get(moduleId)?.delete(id);
        reject(new Error('Ping timeout'));
      }, PING_TIMEOUT_MS);

      this.pendingCalls.get(moduleId)?.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(moduleId, { type: 'ping' });
    });
  }

  // ─── Kernel → Module Call ────────────────────────────────────

  call(moduleId: string, method: string, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pendingCalls.get(moduleId)?.delete(id);
        reject(new Error(`Call ${method} timed out`));
      }, timeoutMs);

      this.pendingCalls.get(moduleId)?.set(id, { resolve, reject, timer });
      this.send(moduleId, { type: 'call', id, method, params });
    });
  }

  // ─── Exit Handler ────────────────────────────────────────────

  private onExit(
    moduleId: string,
    runnerPath: string,
    manifest: ModuleManifest,
    env: Record<string, string> | undefined,
    code: number | null,
    signal: string | null,
  ): void {
    const entry = this.registry.get(moduleId);
    if (!entry || entry.status === 'stopped') return;

    this.clearTimers(moduleId);
    this.cleanupModuleCalls(moduleId);
    this.cleanupModuleRpcs(moduleId);

    const restarts = this.registry.incrementRestarts(moduleId);
    this.logger.warn({ module: moduleId, code, signal, restarts }, 'Module exited unexpectedly');

    if (restarts > MAX_RESTARTS) {
      this.registry.setStatus(moduleId, 'crashed');
      this.logger.error({ module: moduleId }, 'Module crashed — max restarts reached');
      return;
    }

    const delay = Math.min(RESTART_BASE_MS * Math.pow(2, restarts - 1), 60_000);
    this.registry.setStatus(moduleId, 'restarting');

    setTimeout(() => {
      this.spawn(runnerPath, manifest, env).catch((err) => {
        this.logger.error({ module: moduleId, error: String(err) }, 'Module restart failed');
      });
    }, delay);
  }

  // ─── Cleanup ─────────────────────────────────────────────────

  private cleanupModuleCalls(moduleId: string): void {
    const calls = this.pendingCalls.get(moduleId);
    if (!calls) return;
    for (const [, pending] of calls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Module ${moduleId} disconnected`));
    }
    calls.clear();
  }

  private cleanupModuleRpcs(moduleId: string): void {
    for (const [id, pending] of this.pendingRpc) {
      if (pending.targetModuleId === moduleId) {
        clearTimeout(pending.timer);
        this.pendingRpc.delete(id);
        this.send(pending.callerModuleId, {
          type: 'rpc_response', id,
          error: `Module ${moduleId} stopped while processing RPC`,
        });
      }
      if (pending.callerModuleId === moduleId) {
        clearTimeout(pending.timer);
        this.pendingRpc.delete(id);
      }
    }
  }

  private clearPendingReady(moduleId: string): void {
    const pending = this.pendingReady.get(moduleId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingReady.delete(moduleId);
    }
  }

  // ─── IPC Send ────────────────────────────────────────────────

  private send(moduleId: string, msg: KernelMessage): boolean {
    const entry = this.registry.get(moduleId);
    if (entry?.process?.connected) {
      try {
        entry.process.send(msg);
        return true;
      } catch {
        // EPIPE — process disconnected between the connected check and send
        return false;
      }
    }
    return false;
  }

  // ─── Timer Management ────────────────────────────────────────

  private clearTimers(moduleId: string): void {
    this.clearHealthTimer(moduleId);
  }

  private clearHealthTimer(moduleId: string): void {
    const t = this.healthTimers.get(moduleId);
    if (t) { clearInterval(t); this.healthTimers.delete(moduleId); }
  }

  // ─── Process Forking ─────────────────────────────────────────

  private forkProcess(runnerPath: string, manifest: ModuleManifest, env?: Record<string, string>) {
    const isDeno = typeof (globalThis as Record<string, unknown>).Deno !== 'undefined';
    const childEnv = { ...process.env, NODE_PATH: process.env["NODE_PATH"] || "", ...env };
    const stdio: ['pipe', 'pipe', 'pipe', 'ipc'] = ['pipe', 'pipe', 'pipe', 'ipc'];

    if (isDeno) {
      const denoPerms = manifest.runtimePermissions ?? ['--allow-all'];
      // Prefer the module's own deno.json (needed for nodeModulesDir, import maps, etc.)
      const moduleDenoConfig = join(dirname(runnerPath), 'deno.json');
      const configPath = existsSync(moduleDenoConfig) ? moduleDenoConfig : this.denoConfigPath;
      const denoArgs = configPath ? [`--config=${configPath}`] : [];
      return spawnChild(process.execPath, ['run', ...denoPerms, '--unstable-sloppy-imports', ...denoArgs, runnerPath], {
        stdio, env: childEnv,
      });
    }

    return fork(runnerPath, [], { stdio, env: childEnv });
  }

  private findDenoConfig(): string | null {
    const fromProject = join(this.initPayload.projectRoot, 'deno.json');
    if (existsSync(fromProject)) return fromProject;

    let dir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, 'deno.json');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    return null;
  }

  // ─── Introspection ───────────────────────────────────────────

  getRegistry(): ModuleRegistry {
    return this.registry;
  }

  async stopAll(): Promise<void> {
    const ids = this.registry.ids();
    for (const id of ids) {
      await this.kill(id, 'shutdown');
    }
  }
}
