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
import type { KernelMessage, ModuleMessage, ModuleManifest } from '@pons/sdk';
import type { SecurityEnforcer, ModuleCapabilities } from './security/enforcer.ts';
import { translateToDenoFlags } from './security/permissions.ts';
import type { PermissionStore } from './security/permissions.ts';


const VALID_MODULE_TYPES = new Set([
  'ready', 'log', 'log-group', 'ack', 'nack',
  'publish', 'call', 'pong', 'call:response',
  'rpc_request', 'rpc_response',
]);

/** Validate incoming IPC data is a known ModuleMessage with required fields. */
export function validateModuleMessage(raw: unknown): { msg: ModuleMessage } | { msg: null; reason: string } {
  if (raw == null || typeof raw !== 'object') return { msg: null, reason: 'not an object' };
  const data = raw as Record<string, unknown>;
  if (typeof data.type !== 'string' || !VALID_MODULE_TYPES.has(data.type)) return { msg: null, reason: `unknown type: ${String(data.type)?.slice(0, 50)}` };

  // Validate required fields per message type
  const checkStr = (field: string): string | null => {
    const v = data[field];
    if (typeof v !== 'string') return `${field} is not a string`;
    if (v.length > MAX_IPC_STRING_LEN) return `${field} exceeds ${MAX_IPC_STRING_LEN} chars (${v.length})`;
    return null;
  };

  let err: string | null = null;
  switch (data.type) {
    case 'rpc_request':
      err = checkStr('id') ?? checkStr('service') ?? checkStr('method');
      break;
    case 'rpc_response':
      err = checkStr('id');
      break;
    case 'publish':
      err = checkStr('topic');
      break;
    case 'call':
      err = checkStr('id') ?? checkStr('method');
      break;
    case 'call:response':
      err = checkStr('id');
      break;
  }

  if (err) return { msg: null, reason: `${data.type}: ${err}` };
  return { msg: raw as ModuleMessage };
}

// ─── Constants ─────────────────────────────────────────────────

// Default values — overridable via config.yaml `lifecycle` section (spec §15)
const DEFAULTS = {
  MAX_RESTARTS: 5,
  RESTART_BASE_MS: 1_000,
  HEALTH_INTERVAL_MS: 30_000,
  PING_TIMEOUT_MS: 10_000,
  RPC_TIMEOUT_MS: 30_000,
  REQUIRES_TIMEOUT_MS: 30_000,
  SHUTDOWN_GRACE_MS: 5_000,
  HEALTH_MAX_FAILURES: 3,
  READY_TIMEOUT_MS: 30_000,
  MAX_RESTART_BACKOFF_MS: 60_000,
} as const;
const MAX_IPC_STRING_LEN = 256;
const PROTOCOL_VERSION = '1.0';

interface LifecycleLimits {
  maxRestarts: number;
  restartBaseMs: number;
  healthIntervalMs: number;
  pingTimeoutMs: number;
  rpcTimeoutMs: number;
  requiresTimeoutMs: number;
  shutdownGraceMs: number;
  healthMaxFailures: number;
  readyTimeoutMs: number;
  maxRestartBackoffMs: number;
}

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

  /** Serialized write queue — ensures ordering and backpressure on stdin writes. */
  private _writeChain: Promise<void> = Promise.resolve();
  private _writeQueueDepth = 0;
  private static readonly MAX_WRITE_QUEUE = 512;

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
    }).catch(() => {
      // OS-level error reading process status (e.g. waitpid failure)
      this.connected = false;
      for (const h of this.exitHandlers) h(null, null);
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
    // Drop messages if queue is saturated — prevent unbounded memory growth
    if (this._writeQueueDepth >= DenoChildProcessWrapper.MAX_WRITE_QUEUE) {
      this.connected = false;
      return;
    }
    const line = JSON.stringify(msg) + '\n';
    const bytes = this.encoder.encode(line);
    this._writeQueueDepth++;
    // Queue writes to preserve ordering and apply backpressure.
    // No retry — a partial write + retry would duplicate/garble IPC messages.
    this._writeChain = this._writeChain.then(async () => {
      this._writeQueueDepth--;
      if (!this.connected) return;
      try {
        await this._stdin.write(bytes);
      } catch {
        this.connected = false;
      }
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
  /** Per-module lock to serialize kill/spawn and prevent restart races. */
  private restartLocks = new Map<string, Promise<void>>();
  /** Consecutive health-check failures per module. */
  private healthFailures = new Map<string, number>();
  /** Pending restart delay timers — cancellable on kill(). */
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Ready timeout timers — kill module if it doesn't send 'ready' in time. */
  private readyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly denoConfigPath: string | null;
  /** Runtime-configurable limits (read from config.lifecycle, falls back to DEFAULTS). */
  private limits: LifecycleLimits;

  constructor(
    private readonly logger: KernelLogger,
    private readonly bus: MessageBus,
    private readonly initPayload: { config: unknown; workspacePath: string; projectRoot: string },
    private readonly onModuleCall: (moduleId: string, method: string, params: unknown) => Promise<unknown>,
    private readonly enforcer?: SecurityEnforcer,
    private readonly permissionStore?: PermissionStore,
  ) {
    this.denoConfigPath = this.findDenoConfig();
    this.limits = this.loadLimits();
  }

  private loadLimits(): LifecycleLimits {
    const cfg = (this.initPayload.config as Record<string, unknown>)?.lifecycle as Record<string, unknown> | undefined;
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

  /** Acquire a per-module lock to serialize kill/spawn operations. */
  private async withModuleLock(moduleId: string, fn: () => Promise<void>): Promise<void> {
    // Chain on previous lock; absorb prior errors (don't re-invoke fn as rejection handler)
    const prev = this.restartLocks.get(moduleId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.restartLocks.set(moduleId, next);
    try {
      await next;
    } finally {
      // Clean up stale lock if this was the last operation
      if (this.restartLocks.get(moduleId) === next) {
        this.restartLocks.delete(moduleId);
      }
    }
  }

  // ─── Spawn ────────────────────────────────────────────────────

  async spawnAll(modules: DiscoveredModule[]): Promise<void> {
    // Sort by manifest priority (lower = earlier, default 100)
    const sorted = [...modules].sort(
      (a, b) => (a.manifest.priority ?? 100) - (b.manifest.priority ?? 100),
    );
      for (const { manifest, runnerPath } of sorted) {
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
      this.registry.register(manifest, runnerPath);
    } else {
      // Update runnerPath in case it changed (e.g. hot-swap)
      const entry = this.registry.get(manifest.id)!;
      entry.runnerPath = runnerPath;
    }
    if (!this.pendingCalls.has(manifest.id)) {
      this.pendingCalls.set(manifest.id, new Map());
    }

    const proc = this.forkProcess(runnerPath, manifest, env);

    proc.stdout?.on('data', (d: Uint8Array) => {
      this.logger.warn({ module: manifest.id, source: 'stdout' }, new TextDecoder().decode(d).trim());
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
      // Discard messages from modules that are stopped or crashed (spec §14)
      const currentEntry = this.registry.get(manifest.id);
      if (!currentEntry || currentEntry.status === 'stopped' || currentEntry.status === 'crashed') return;

      const validated = validateModuleMessage(raw);
      if (!validated.msg) {
        this.logger.warn({ module: manifest.id, reason: validated.reason }, 'Invalid IPC message — ignoring');
        return;
      }
      this.handleMessage(manifest.id, validated.msg).catch((err) => {
        this.logger.error({ module: manifest.id, error: String(err) }, 'Error handling module message');
      });
    });

    proc.on('exit', (code, signal) => {
      this.onExit(manifest.id, runnerPath, manifest, env, code, signal);
    });

    this.registry.setProcess(manifest.id, proc);
    this.spawnTimestamps.set(manifest.id, Date.now());
    this.logger.info({ moduleId: manifest.id, pid: proc.pid, runtime: manifest.runtime ?? 'deno' }, 'module.spawn');

    // First-time spawn: send install message before init so module can request permissions
    if (this.permissionStore && !this.permissionStore.getFirstSpawnAt(manifest.id)) {
      this.send(manifest.id, { type: 'install' });
      this.permissionStore.setFirstSpawnAt(manifest.id);
    }

    // Security: scope config to module's own section only (never send full config)
    const moduleConfigKey = manifest.configKey;
    const scopedConfig = moduleConfigKey && typeof this.initPayload.config === 'object' && this.initPayload.config !== null
      ? { [moduleConfigKey]: (this.initPayload.config as Record<string, unknown>)[moduleConfigKey] }
      : {};
    this.send(manifest.id, {
      type: 'init',
      protocolVersion: PROTOCOL_VERSION,
      config: scopedConfig,
      workspacePath: this.initPayload.workspacePath,
      projectRoot: this.initPayload.projectRoot,
    });

    // Start ready timeout — if module doesn't send 'ready' within 30s, kill it
    this.startReadyTimeout(manifest.id);
  }

  // ─── Kill / Hot-swap ──────────────────────────────────────────

  async kill(moduleId: string, reason = 'requested'): Promise<void> {
    await this.withModuleLock(moduleId, () => this.killInner(moduleId, reason));
  }

  private async killInner(moduleId: string, reason: string): Promise<void> {
    const entry = this.registry.get(moduleId);
    if (!entry) return;

    this.publishLifecycleEvent('system:module:stopping', { moduleId, reason });
    this.registry.setStatus(moduleId, 'stopped');
    this.clearTimers(moduleId);
    this.clearPendingReady(moduleId);

    if (entry.process?.connected) {
      this.send(moduleId, { type: 'shutdown' });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.limits.shutdownGraceMs);
        entry.process?.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (entry.process?.connected) {
        entry.process.kill('SIGKILL');
      }
    }

    this.cleanupModuleCalls(moduleId);
    this.cleanupModuleRpcs(moduleId);
    this.bus.unsubscribe(moduleId);
    this.enforcer?.removeModuleCapabilities(moduleId);
    this.publishLifecycleEvent('system:module:stopped', { moduleId, reason });
    this.logger.info({ moduleId, reason }, 'module.killed');
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

  async restartWithUpdatedPermissions(moduleId: string): Promise<void> {
    await this.withModuleLock(moduleId, async () => {
      const entry = this.registry.get(moduleId);
      if (!entry) return;

      this.logger.info({ module: moduleId }, 'Restarting module with updated permissions');

      const runnerPath = entry.runnerPath;
      const { manifest } = entry;

      if (!runnerPath) {
        this.logger.error({ module: moduleId }, 'Cannot restart — no runnerPath stored');
        return;
      }

      // Kill and re-spawn atomically under the lock
      await this.killInner(moduleId, 'permission-update');
      await this.spawn(runnerPath, manifest);
    });
  }

  /** Update the config reference used for new module spawns. */
  updateConfig(config: unknown): void {
    (this.initPayload as { config: unknown }).config = config;
    this.limits = this.loadLimits();
  }

  /** Send a kernel message to a module (public wrapper for config:update, etc.). */
  sendMessage(moduleId: string, msg: KernelMessage): boolean {
    return this.send(moduleId, msg);
  }

  /** Publish a system lifecycle event on the message bus (spec §6). */
  private publishLifecycleEvent(topic: string, payload: Record<string, unknown>): void {
    const subscribers = this.bus.getSubscribers(topic);
    for (const subscriberId of subscribers) {
      const entry = this.registry.get(subscriberId);
      if (!entry?.process?.connected || entry.status !== 'ready') continue;
      this.send(subscriberId, { type: 'deliver', id: crypto.randomUUID(), topic, payload });
    }
  }

  /**
   * Refresh enforcer capabilities for all running modules from the permission store.
   * Called after SIGUSR2 reloads permissions.yaml so capability changes take effect
   * without requiring a full module restart.
   */
  refreshCapabilities(): void {
    if (!this.enforcer) return;
    for (const moduleId of this.registry.ids()) {
      const entry = this.registry.get(moduleId);
      if (!entry || entry.status === 'stopped' || entry.status === 'crashed') continue;
      const manifest = entry.manifest;

      const storedCaps = this.permissionStore?.getApprovedCapabilities(moduleId);
      const manifestCaps = (manifest as ModuleManifest & { capabilities?: ModuleCapabilities }).capabilities;
      const derivedCaps: ModuleCapabilities = {
        topics: manifest.subscribes ?? [],
        services: [...(manifest.requires ?? []), ...((manifest as ModuleManifest & { optionalRequires?: string[] }).optionalRequires ?? [])],
      };
      const hasStoredCaps = storedCaps && ((storedCaps.topics?.length ?? 0) > 0 || (storedCaps.services?.length ?? 0) > 0);
      const capabilities = (hasStoredCaps ? storedCaps : null) ?? manifestCaps ?? derivedCaps;
      this.enforcer.setModuleCapabilities(moduleId, capabilities);
    }
    this.logger.info('Enforcer capabilities refreshed for all running modules');
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
    this.clearReadyTimeout(moduleId);
    const spawnTime = this.spawnTimestamps.get(moduleId);
    const startupMs = spawnTime ? Date.now() - spawnTime : undefined;
    this.logger.info({ moduleId, ...(startupMs !== undefined ? { startupMs } : {}) }, 'module.ready');

    const storedEntry = this.registry.get(moduleId);
    const manifest = storedEntry?.manifest;
    if (!manifest) {
      this.logger.error({ module: moduleId }, 'Module ready but no manifest in registry');
      return;
    }

    // Security: register module capabilities and validate topic subscriptions (fail-closed)
    // PONS-004: Load capabilities from the permission store (user-approved at install time),
    // not from the module's self-asserted manifest. Fallback to manifest for backward compat.
    const storedCaps = this.permissionStore?.getApprovedCapabilities(moduleId);
    const manifestCaps = (manifest as ModuleManifest & { capabilities?: ModuleCapabilities }).capabilities;
    // Backward compat: derive capabilities from manifest fields when no explicit capabilities block
    const derivedCaps: ModuleCapabilities = {
      topics: manifest.subscribes ?? [],
      services: [...(manifest.requires ?? []), ...((manifest as ModuleManifest & { optionalRequires?: string[] }).optionalRequires ?? [])],
    };
    // Treat empty storedCaps (no topics/services) as unset so derivedCaps is used
    const hasStoredCaps = storedCaps && ((storedCaps.topics?.length ?? 0) > 0 || (storedCaps.services?.length ?? 0) > 0);
    const capabilities = (hasStoredCaps ? storedCaps : null) ?? manifestCaps ?? derivedCaps;
    if (this.enforcer) {
      this.enforcer.setModuleCapabilities(moduleId, capabilities);
    }

    // Merge subscribes + capabilities.topics for subscription (spec §8 uses capabilities.topics)
    const topics = [...new Set([...(manifest.subscribes ?? []), ...(manifest.capabilities?.topics ?? [])])];
    if (this.enforcer && topics.length > 0) {
      const caps = this.enforcer.getModuleCapabilities(moduleId);
      if (!caps) {
        this.enforcer.logViolation({ timestamp: new Date().toISOString(), moduleId, type: 'topic', resource: `subscribe:${topics[0]}`, action: 'deny' });
        this.kill(moduleId, 'security-violation');
        return;
      }
      for (const topic of topics) {
        const violation = this.enforcer.checkTopic(moduleId, topic, 'subscribe', caps);
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
        this.logger.error({ module: moduleId, rejected }, 'Duplicate service registration — killing module');
        this.kill(moduleId, 'duplicate-service');
        return;
      }
      if (services.length > 0) {
        this.logger.info({ module: moduleId, services }, 'Services registered');
      }
      this.notifyOptionalServices(services);
    }

    // Check for circular dependencies
    const cycle = this.registry.detectCircularDeps(moduleId);
    if (cycle) {
      this.logger.error(
        { moduleId, cycle: cycle.join(' → ') },
        'Circular service dependency detected — killing all modules in cycle',
      );
      // Kill ALL modules in the cycle, not just the triggering one (spec §14)
      const uniqueModules = [...new Set(cycle)];
      for (const cycleModuleId of uniqueModules) {
        this.kill(cycleModuleId, 'circular-dependency');
      }
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
          `Required services not satisfied within ${this.limits.requiresTimeoutMs / 1000}s — killing`);
        this.kill(moduleId, 'requires-timeout');
      }, this.limits.requiresTimeoutMs);
      this.registry.setStatus(moduleId, 'waiting');
      this.pendingReady.set(moduleId, { manifest, timer });
      this.logger.info({ module: moduleId, waiting: missing }, 'Waiting for required services');
    }
  }

  private onPublish(fromModuleId: string, topic: string, payload: unknown): void {
    // Security: check publish capability (fail-closed: deny if capabilities not found)
    if (this.enforcer) {
      const capabilities = this.enforcer.getModuleCapabilities(fromModuleId);
      if (!capabilities) {
        this.enforcer.logViolation({ timestamp: new Date().toISOString(), moduleId: fromModuleId, type: 'topic', resource: `publish:${topic}`, action: 'deny' });
        this.kill(fromModuleId, 'security-violation');
        return;
      }
      const violation = this.enforcer.checkTopic(fromModuleId, topic, 'publish', capabilities);
      if (violation) {
        this.enforcer.logViolation(violation);
        this.kill(fromModuleId, 'security-violation');
        return;
      }
    }

    const subscribers = this.bus.getSubscribers(topic, fromModuleId);
    for (const subscriberId of subscribers) {
      const entry = this.registry.get(subscriberId);
      if (!entry?.process?.connected || entry.status !== 'ready') continue;
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
    // Security: check RPC capability (fail-closed: deny if capabilities not found)
    if (this.enforcer) {
      const capabilities = this.enforcer.getModuleCapabilities(callerModuleId);
      if (!capabilities) {
        this.enforcer.logViolation({ timestamp: new Date().toISOString(), moduleId: callerModuleId, type: 'rpc', resource: service, action: 'deny' });
        this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'forbidden' });
        this.kill(callerModuleId, 'security-violation');
        return;
      }
      const violation = this.enforcer.checkRpc(callerModuleId, service, capabilities);
      if (violation) {
        this.enforcer.logViolation(violation);
        this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'forbidden' });
        this.kill(callerModuleId, 'security-violation');
        return;
      }
    }

    const targetModuleId = this.registry.resolveService(service);
    if (!targetModuleId) {
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'service_not_found' });
      return;
    }

    const targetEntry = this.registry.get(targetModuleId);
    if (!targetEntry?.process?.connected || targetEntry.status !== 'ready') {
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'module_not_ready' });
      return;
    }

    const timer = setTimeout(() => {
      this.pendingRpc.delete(rpcId);
      this.logger.warn({ callerId: callerModuleId, targetService: service, method, timeoutMs: this.limits.rpcTimeoutMs }, 'rpc.timeout');
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'timeout' });
    }, this.limits.rpcTimeoutMs);

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
    this.publishLifecycleEvent('system:module:ready', { moduleId });
    this.checkPendingReady();
    // Reset restart counter if module stays alive for 60+ seconds (spec §8)
    this.scheduleRestartCountReset(moduleId);
  }

  private restartResetTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleRestartCountReset(moduleId: string): void {
    const existing = this.restartResetTimers.get(moduleId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.restartResetTimers.delete(moduleId);
      const entry = this.registry.get(moduleId);
      if (entry && entry.status === 'ready' && entry.restartCount > 0) {
        this.registry.resetRestartCount(moduleId);
        this.logger.debug({ module: moduleId }, 'Restart counter reset — module stable for 60s');
      }
    }, 60_000);
    this.restartResetTimers.set(moduleId, timer);
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
    this.healthFailures.set(moduleId, 0);
    const timer = setInterval(async () => {
      try {
        await this.ping(moduleId);
        this.healthFailures.set(moduleId, 0);
      } catch {
        const failures = (this.healthFailures.get(moduleId) ?? 0) + 1;
        this.healthFailures.set(moduleId, failures);
        if (failures >= this.limits.healthMaxFailures) {
          this.logger.warn({ module: moduleId, failures }, 'Health check failed — killing module');
          // Route through kill() for proper cleanup (bus.unsubscribe, pending calls, etc.)
          this.kill(moduleId, 'health-check-failed').catch(() => {});
        } else {
          this.logger.debug({ module: moduleId, failures, max: this.limits.healthMaxFailures }, 'Health check failed — retrying');
        }
      }
    }, this.limits.healthIntervalMs);

    this.healthTimers.set(moduleId, timer);
  }

  private async ping(moduleId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const calls = this.pendingCalls.get(moduleId);
      if (!calls) {
        reject(new Error(`Module ${moduleId} not available`));
        return;
      }
      const id = `ping:${crypto.randomUUID()}`;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error('Ping timeout'));
      }, this.limits.pingTimeoutMs);

      calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(moduleId, { type: 'ping' });
    });
  }

  // ─── Kernel → Module Call ────────────────────────────────────

  call(moduleId: string, method: string, params?: unknown, timeoutMs = this.limits.rpcTimeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const calls = this.pendingCalls.get(moduleId);
      if (!calls) {
        reject(new Error(`Module ${moduleId} not available`));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error(`Call ${method} timed out`));
      }, timeoutMs);

      calls.set(id, { resolve, reject, timer });
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

    const crashFields = { moduleId, exitCode: code, signal, restartCount: restarts, ...(aliveMs !== null ? { aliveMs } : {}), ...(lastStderr ? { stderr: lastStderr } : {}) };
    const crashMsg = detail ? `Module exited unexpectedly — ${detail}` : 'Module exited unexpectedly';
    // Spec: instant exits (<1s) logged as warning; normal crashes as error
    if (instant) {
      this.logger.warn(crashFields, crashMsg);
    } else {
      this.logger.error(crashFields, crashMsg);
    }

    if (restarts >= this.limits.maxRestarts) {
      this.registry.setStatus(moduleId, 'crashed');
      // Full cleanup for permanently crashed modules
      this.bus.unsubscribe(moduleId);
      this.enforcer?.removeModuleCapabilities(moduleId);
      this.restartLocks.delete(moduleId);
      this.publishLifecycleEvent('system:module:crashed', { moduleId, restartCount: restarts });
      this.logger.error({ moduleId }, 'Module crashed — max restarts reached');
      return;
    }

    const delay = Math.min(this.limits.restartBaseMs * Math.pow(2, restarts - 1), this.limits.maxRestartBackoffMs);
    this.registry.setStatus(moduleId, 'restarting');

    const restartTimer = setTimeout(() => {
      this.restartTimers.delete(moduleId);
      // Re-check status: module may have been intentionally killed during backoff
      const current = this.registry.get(moduleId);
      if (!current || current.status === 'stopped' || current.status === 'crashed') return;
      this.withModuleLock(moduleId, async () => {
        // Double-check inside lock — kill() may have run between timer fire and lock acquisition
        const inner = this.registry.get(moduleId);
        if (!inner || inner.status === 'stopped' || inner.status === 'crashed') return;
        await this.spawn(runnerPath, manifest, env);
      }).catch((err) => {
        this.logger.error({ module: moduleId, error: String(err) }, 'Module restart failed');
      });
    }, delay);
    this.restartTimers.set(moduleId, restartTimer);
  }

  // ─── Cleanup ─────────────────────────────────────────────────

  private cleanupModuleCalls(moduleId: string): void {
    const calls = this.pendingCalls.get(moduleId);
    if (!calls) return;
    for (const [, pending] of calls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Module ${moduleId} disconnected`));
    }
    // Remove the entire Map entry to avoid leaking empty Maps for crashed modules
    this.pendingCalls.delete(moduleId);
  }

  private cleanupModuleRpcs(moduleId: string): void {
    // Snapshot entries before iterating — send() and delete() can mutate the Map
    const entries = [...this.pendingRpc.entries()];
    for (const [id, pending] of entries) {
      if (pending.targetModuleId === moduleId) {
        clearTimeout(pending.timer);
        this.pendingRpc.delete(id);
        this.send(pending.callerModuleId, {
          type: 'rpc_response', id,
          error: `Module ${moduleId} stopped while processing RPC`,
        });
      } else if (pending.callerModuleId === moduleId) {
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

  /** Start a timer that kills the module if it doesn't send 'ready' within READY_TIMEOUT_MS. */
  private startReadyTimeout(moduleId: string): void {
    this.clearReadyTimeout(moduleId);
    const timer = setTimeout(() => {
      this.readyTimers.delete(moduleId);
      const entry = this.registry.get(moduleId);
      if (!entry || entry.status !== 'starting') return;
      this.logger.error({ module: moduleId }, `Module did not send 'ready' within ${this.limits.readyTimeoutMs / 1000}s — treating as crash`);
      // Kill the process directly so onExit fires and triggers restart/backoff logic
      entry.process?.kill('SIGKILL');
    }, this.limits.readyTimeoutMs);
    this.readyTimers.set(moduleId, timer);
  }

  private clearReadyTimeout(moduleId: string): void {
    const t = this.readyTimers.get(moduleId);
    if (t) { clearTimeout(t); this.readyTimers.delete(moduleId); }
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
        this.logger.warn({ moduleId, msgType: (msg as { type: string }).type }, 'IPC write failed — module may be dead');
        return false;
      }
    }
    return false;
  }

  // ─── Timer Management ────────────────────────────────────────

  private clearTimers(moduleId: string): void {
    this.clearHealthTimer(moduleId);
    this.clearReadyTimeout(moduleId);
    this.healthFailures.delete(moduleId);
    const restartTimer = this.restartTimers.get(moduleId);
    if (restartTimer) { clearTimeout(restartTimer); this.restartTimers.delete(moduleId); }
    const resetTimer = this.restartResetTimers.get(moduleId);
    if (resetTimer) { clearTimeout(resetTimer); this.restartResetTimers.delete(moduleId); }
  }

  private clearHealthTimer(moduleId: string): void {
    const t = this.healthTimers.get(moduleId);
    if (t) { clearInterval(t); this.healthTimers.delete(moduleId); }
  }

  // ─── Process Forking ─────────────────────────────────────────

  private forkProcess(runnerPath: string, manifest: ModuleManifest, env?: Record<string, string>): DenoChildProcessWrapper {
    // PONS-003: Build a minimal allowlisted environment instead of leaking the full parent env.
    // Only pass system essentials + variables declared in the module's env permissions.
    const SYSTEM_ENV_KEYS = ['PATH', 'HOME', 'TERM', 'LANG', 'SHELL', 'USER', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DENO_DIR'];
    const effectivePerms = this.permissionStore?.getEffectivePermissions(manifest.id);
    const allowedEnvKeys = new Set([
      ...SYSTEM_ENV_KEYS,
      ...(effectivePerms?.env ?? []),
    ]);
    const childEnv: Record<string, string> = {};
    for (const key of allowedEnvKeys) {
      const val = Deno.env.get(key);
      if (val !== undefined) childEnv[key] = val;
    }
    // Overlay any caller-provided env (used for module-specific settings like IPC ports)
    if (env) Object.assign(childEnv, env);

    const runtime = manifest.runtime ?? 'deno';
    const { executable, args: runtimeArgs } = this.buildRuntimeCommand(runtime, runnerPath, manifest);

    const cmd = new Deno.Command(executable, {
      args: runtimeArgs,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
      env: childEnv,
    });

    const proc = cmd.spawn();
    return new DenoChildProcessWrapper(proc);
  }

  /** Build the spawn command based on the module's declared runtime (spec §21). */
  private buildRuntimeCommand(runtime: string, runnerPath: string, manifest: ModuleManifest): { executable: string; args: string[] } {
    const moduleDir = dirname(runnerPath);

    switch (runtime) {
      case 'deno': {
        // Security: translate manifest permissions to Deno flags (never --allow-all)
        const effective = this.permissionStore?.getEffectivePermissions(manifest.id);
        const denoPerms = effective
          ? translateToDenoFlags(effective, moduleDir)
          : ['--deny-all'];
        const moduleDenoConfig = join(moduleDir, 'deno.json');
        const configPath = existsSync(moduleDenoConfig) ? moduleDenoConfig : this.denoConfigPath;
        const denoArgs = configPath ? [`--config=${configPath}`] : [];
        return {
          executable: Deno.execPath(),
          args: ['run', ...denoPerms, '--unstable-sloppy-imports', ...denoArgs, runnerPath],
        };
      }
      case 'node':
        return { executable: 'node', args: [runnerPath] };
      case 'bun':
        return { executable: 'bun', args: ['run', runnerPath] };
      case 'python':
        return { executable: 'python', args: [runnerPath] };
      case 'php':
        return { executable: 'php', args: [runnerPath] };
      case 'go':
      case 'rust':
      case 'binary':
        // Pre-compiled binary — execute directly
        return { executable: runnerPath, args: [] };
      default:
        this.logger.warn({ module: manifest.id, runtime }, `Unknown runtime "${runtime}" — falling back to deno`);
        return this.buildRuntimeCommand('deno', runnerPath, manifest);
    }
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
    // Ordered shutdown: compute dependency tiers, kill leaves first (spec §7)
    const tiers = this.computeShutdownTiers();
    for (const tier of tiers) {
      // Parallel shutdown within each tier
      await Promise.all(tier.map(id => this.kill(id, 'shutdown')));
    }
  }

  /** Compute shutdown tiers via reverse topological sort (leaves first). */
  private computeShutdownTiers(): string[][] {
    const ids = this.registry.ids();
    if (ids.length === 0) return [];

    // Build dependsOn map: moduleId → set of modules it depends on (via requires → service providers)
    const dependsOn = new Map<string, Set<string>>();
    for (const id of ids) {
      dependsOn.set(id, new Set());
    }
    for (const id of ids) {
      const entry = this.registry.get(id);
      const requires = entry?.manifest.requires ?? [];
      for (const service of requires) {
        const provider = this.registry.resolveService(service);
        if (provider && provider !== id && dependsOn.has(provider)) {
          dependsOn.get(id)!.add(provider);
        }
      }
    }

    // Kahn's algorithm — reverse topological order (modules with no dependents first = leaves)
    const tiers: string[][] = [];
    const remaining = new Set(ids);
    while (remaining.size > 0) {
      // Find modules that no remaining module depends on (leaves in the dependency graph)
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
      // Safety: if no leaves found (cycle), break and kill all remaining
      if (tier.length === 0) {
        tiers.push([...remaining]);
        break;
      }
      tiers.push(tier);
      for (const id of tier) remaining.delete(id);
    }
    return tiers;
  }
}
