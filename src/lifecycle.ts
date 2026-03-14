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

import { dirname, join } from 'jsr:@std/path@^1';
import type { DiscoveredModule } from './module/loader.ts';
import type { KernelLogger } from './logs/logger.ts';
import { writeModuleLog, writeModuleLogGroup } from './logs/logger.ts';
import type { MessageBus } from './messaging/bus.ts';
import { ModuleRegistry } from './module/registry.ts';
import type { ChildProcessLike } from './module/registry.ts';
import type { KernelMessage, ModuleMessage, ModuleManifest } from 'jsr:@pons/sdk@^0.2';
import type { SecurityEnforcer } from './security/enforcer.ts';
import { translateToDenoFlags } from './security/permissions.ts';
import type { ModulePermissions, PermissionStore } from './security/permissions.ts';


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

// ─── Deno Child Process Wrapper ────────────────────────────────
//
// Wraps Deno.ChildProcess to provide a Node-like interface used by
// the lifecycle manager: connected, send(), on('message'|'exit'), kill(), pid.
// IPC is implemented as newline-delimited JSON over stdin/stdout.

type MessageHandler = (msg: unknown) => void;
type ExitHandler = (code: number | null, signal: string | null) => void;
type DataHandler = (data: Uint8Array) => void;

class DenoChildProcessWrapper implements ChildProcessLike {
  readonly pid: number;
  connected: boolean = true;

  private messageHandlers: MessageHandler[] = [];
  private exitHandlers: ExitHandler[] = [];
  private stdoutHandlers: DataHandler[] = [];
  private stderrHandlers: DataHandler[] = [];

  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  private readonly _proc: Deno.ChildProcess;
  private readonly _stdin: WritableStreamDefaultWriter<Uint8Array>;

  constructor(proc: Deno.ChildProcess) {
    this._proc = proc;
    this.pid = proc.pid;
    this._stdin = proc.stdin.getWriter();

    // Read stdout lines as JSON IPC messages
    this._readLines(proc.stdout, (line) => {
      // Try to parse as IPC JSON first
      try {
        const msg = JSON.parse(line);
        for (const h of this.messageHandlers) h(msg);
      } catch {
        // Not JSON — treat as plain stdout data
        const data = this.encoder.encode(line + '\n');
        for (const h of this.stdoutHandlers) h(data);
      }
    });

    // Read stderr as plain data
    this._readLines(proc.stderr, (line) => {
      const data = this.encoder.encode(line + '\n');
      for (const h of this.stderrHandlers) h(data);
    });

    // Watch for exit
    proc.status.then((status) => {
      this.connected = false;
      const code = status.success ? 0 : (status.code ?? 1);
      const signal = status.signal ?? null;
      for (const h of this.exitHandlers) h(code, signal);
    });
  }

  private async _readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += this.decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      }
      if (buffer.trim()) onLine(buffer.trim());
    } catch {
      // Stream closed
    } finally {
      reader.releaseLock();
    }
  }

  on(event: 'message', handler: MessageHandler): void;
  on(event: 'exit', handler: ExitHandler): void;
  on(event: string, handler: MessageHandler | ExitHandler): void {
    if (event === 'message') this.messageHandlers.push(handler as MessageHandler);
    else if (event === 'exit') this.exitHandlers.push(handler as ExitHandler);
  }

  once(event: 'exit', handler: ExitHandler): void {
    const wrapper: ExitHandler = (code, signal) => {
      this.exitHandlers = this.exitHandlers.filter((h) => h !== wrapper);
      handler(code, signal);
    };
    this.exitHandlers.push(wrapper);
  }

  get stdout() {
    return {
      on: (event: string, handler: DataHandler) => {
        if (event === 'data') this.stdoutHandlers.push(handler);
      },
    };
  }

  get stderr() {
    return {
      on: (event: string, handler: DataHandler) => {
        if (event === 'data') this.stderrHandlers.push(handler);
      },
    };
  }

  send(msg: unknown): void {
    if (!this.connected) return;
    const line = JSON.stringify(msg) + '\n';
    const bytes = this.encoder.encode(line);
    // Fire-and-forget write — errors mean the process is gone
    this._stdin.write(bytes).catch(() => {
      this.connected = false;
    });
  }

  kill(signal: string = 'SIGTERM'): void {
    try {
      this._proc.kill(signal as Deno.Signal);
    } catch {
      // Process already exited
    }
    this.connected = false;
  }
}

// ─── existsSync helper ──────────────────────────────────────────

function existsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Lifecycle Manager ─────────────────────────────────────────

export class LifecycleManager {
  private registry = new ModuleRegistry();
  private pendingCalls = new Map<string, Map<string, PendingCall>>();
  private pendingRpc = new Map<string, PendingRpc>();
  private healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private pendingReady = new Map<string, PendingReady>();
  private stderrBuffers = new Map<string, string>();
  private spawnTimestamps = new Map<string, number>();

  private readonly denoConfigPath: string | null;

  constructor(
    private readonly logger: KernelLogger,
    private readonly bus: MessageBus,
    private readonly initPayload: { config: unknown; workspacePath: string; projectRoot: string },
    private readonly onModuleCall: (moduleId: string, method: string, params: unknown) => Promise<unknown>,
    private readonly enforcer?: SecurityEnforcer,
    private readonly permissionStore?: PermissionStore,
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
    // Security: verify module permissions are approved before spawning
    if (this.permissionStore && !this.permissionStore.isApproved(manifest.id)) {
      this.logger.warn({ module: manifest.id }, 'Module not approved — refusing to spawn (run `pons modules install` to approve permissions)');
      return;
    }

    // Only register fresh if not already in the registry (avoids resetting restartCount on respawn)
    if (!this.registry.get(manifest.id)) {
      this.registry.register(manifest);
    }
    if (!this.pendingCalls.has(manifest.id)) {
      this.pendingCalls.set(manifest.id, new Map());
    }

    const proc = this.forkProcess(runnerPath, manifest, env);

    proc.stdout?.on('data', (d: Uint8Array) => {
      this.logger.debug({ module: manifest.id, source: 'stdout' }, new TextDecoder().decode(d).trim());
    });
    proc.stderr?.on('data', (d: Uint8Array) => {
      const text = new TextDecoder().decode(d).trim();
      if (text) {
        // Keep last stderr output for exit diagnostics
        this.stderrBuffers.set(manifest.id, text);
        this.logger.warn({ module: manifest.id, source: 'stderr' }, text);
      }
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
    this.spawnTimestamps.set(manifest.id, Date.now());
    this.logger.debug({ module: manifest.id, pid: proc.pid }, 'Module process spawned');

    // Security: scope config to module's own section only (never send full config)
    const moduleConfigKey = manifest.configKey;
    const scopedConfig = moduleConfigKey && typeof this.initPayload.config === 'object' && this.initPayload.config !== null
      ? { [moduleConfigKey]: (this.initPayload.config as Record<string, unknown>)[moduleConfigKey] }
      : {};
    this.send(manifest.id, {
      type: 'init',
      config: scopedConfig,
      workspacePath: this.initPayload.workspacePath,
      projectRoot: this.initPayload.projectRoot,
    });
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
    // Security: validate new manifest permissions against existing approval before swapping
    if (this.permissionStore && newManifest.permissions) {
      const approved = this.permissionStore.getApproved(newManifest.id);
      if (!approved) {
        this.logger.error({ module: newManifest.id }, 'Hot-swap blocked — new manifest has no approved permissions');
        return;
      }
      // Check if new manifest requests permissions not in the approved set
      const newPerms = newManifest.permissions as unknown as Record<string, string[]>;
      const approvedPerms = approved.permissions as unknown as Record<string, string[]>;
      for (const [key, values] of Object.entries(newPerms)) {
        const approvedValues = approvedPerms[key] ?? [];
        const unapproved = (values ?? []).filter((v: string) => !approvedValues.includes(v));
        if (unapproved.length > 0) {
          this.logger.error({ module: newManifest.id, permission: key, unapproved }, 'Hot-swap blocked — new manifest requests unapproved permissions');
          return;
        }
      }
    }

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

    // Security: validate topic subscriptions before registering (fail-closed)
    const topics = manifest.subscribes ?? [];
    if (this.enforcer && topics.length > 0) {
      const permissions = this.enforcer.getModulePermissions(moduleId);
      if (!permissions) {
        this.enforcer.logViolation({ timestamp: new Date().toISOString(), moduleId, type: 'topic', resource: `subscribe:${topics[0]}`, action: 'deny' });
        this.kill(moduleId, 'security-violation');
        return;
      }
      for (const topic of topics) {
        const violation = this.enforcer.checkTopic(moduleId, topic, 'subscribe', permissions);
        if (violation) {
          this.enforcer.logViolation(violation);
          this.kill(moduleId, 'security-violation');
          return;
        }
      }
    }
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
    // Security: check publish permission (fail-closed: deny if permissions not found)
    if (this.enforcer) {
      const permissions = this.enforcer.getModulePermissions(fromModuleId);
      if (!permissions) {
        this.enforcer.logViolation({ timestamp: new Date().toISOString(), moduleId: fromModuleId, type: 'topic', resource: `publish:${topic}`, action: 'deny' });
        this.kill(fromModuleId, 'security-violation');
        return;
      }
      const violation = this.enforcer.checkTopic(fromModuleId, topic, 'publish', permissions);
      if (violation) {
        this.enforcer.logViolation(violation);
        this.kill(fromModuleId, 'security-violation');
        return;
      }
    }

    const subscribers = this.bus.getSubscribers(topic, fromModuleId);
    for (const subscriberId of subscribers) {
      const entry = this.registry.get(subscriberId);
      if (!entry?.process?.connected) continue;
      this.send(subscriberId, {
        type: 'deliver',
        id: crypto.randomUUID(),
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
    // Security: check RPC permission (fail-closed: deny if permissions not found)
    if (this.enforcer) {
      const permissions = this.enforcer.getModulePermissions(callerModuleId);
      if (!permissions) {
        this.enforcer.logViolation({ timestamp: new Date().toISOString(), moduleId: callerModuleId, type: 'rpc', resource: service, action: 'deny' });
        this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: `Security violation: no approved permissions` });
        this.kill(callerModuleId, 'security-violation');
        return;
      }
      const violation = this.enforcer.checkRpc(callerModuleId, service, permissions);
      if (violation) {
        this.enforcer.logViolation(violation);
        this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: `Security violation: not permitted to call service "${service}"` });
        this.kill(callerModuleId, 'security-violation');
        return;
      }
    }

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
      const id = `ping:${crypto.randomUUID()}`;
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
      const id = crypto.randomUUID();
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

    this.logger.warn(
      { module: moduleId, code, signal, restarts, ...(aliveMs !== null ? { aliveMs } : {}), ...(lastStderr ? { lastStderr } : {}) },
      detail ? `Module exited unexpectedly — ${detail}` : 'Module exited unexpectedly',
    );

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

  private forkProcess(runnerPath: string, manifest: ModuleManifest, env?: Record<string, string>): DenoChildProcessWrapper {
    const childEnv = { ...Deno.env.toObject(), ...env };

    // Security: translate manifest permissions to Deno flags (never --allow-all)
    const moduleDir = dirname(runnerPath);
    const denoPerms = manifest.permissions
      ? translateToDenoFlags(manifest.permissions as ModulePermissions, moduleDir)
      : ['--deny-all'];
    // Prefer the module's own deno.json (needed for nodeModulesDir, import maps, etc.)
    const moduleDenoConfig = join(dirname(runnerPath), 'deno.json');
    const configPath = existsSync(moduleDenoConfig) ? moduleDenoConfig : this.denoConfigPath;
    const denoArgs = configPath ? [`--config=${configPath}`] : [];

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ['run', ...denoPerms, '--unstable-sloppy-imports', ...denoArgs, runnerPath],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
      env: childEnv,
    });

    const proc = cmd.spawn();
    return new DenoChildProcessWrapper(proc);
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
