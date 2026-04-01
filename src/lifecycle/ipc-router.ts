/**
 * IpcRouter — the post office of the kernel.
 *
 * Every message that travels between the kernel and a module passes through here.
 * Inbound: the router receives raw validated messages from module stdout and decides
 * who handles them — ready announcements go to the ServiceDirectory, log lines go to
 * the logger, RPC responses wake up pending promises. Outbound: every `send()` call
 * writes a JSON line to the module's stdin.
 *
 * The router also owns the pending-call and pending-RPC maps. When a module (or the
 * kernel itself) issues a call and waits for a response, the router stores the promise
 * resolver here and matches it when the response arrives. Timeouts are enforced here
 * too — a module that never responds doesn't leak promises forever.
 *
 * Cleanup happens via the TypedEmitter: when a module exits, the `module:exit` event
 * triggers rejection of all its outstanding promises so callers get an error rather
 * than hanging indefinitely.
 */

import type { KernelMessage, ModuleMessage } from '@pons/sdk';
import { writeModuleLog, writeModuleLogGroup } from '../logs/logger.ts';
import type { LifecycleContext, PendingCall, PendingRpc } from './types.ts';
import type { TypedEmitter } from './typed-emitter.ts';

// ─── Callback Interfaces ──────────────────────────────────────

export interface IpcRouterCallbacks {
  /** Called when a module sends 'ready'. Facade routes to service-directory. */
  onReady(moduleId: string): void;
  /** Called when a module sends 'call'. Facade routes to external handler. */
  onModuleCall(moduleId: string, method: string, params: unknown): Promise<unknown>;
  /** Called when a module should be killed (security violation, etc.). */
  kill(moduleId: string, reason: string): void;
  /** Called when a module attempts an undeclared capability. Pause and ask the operator. */
  promptPermission: (request: { moduleId: string; type: 'topic' | 'service'; value: string }) => Promise<'grant-session' | 'grant-always' | 'deny'>;
}

// ─── IPC Router ───────────────────────────────────────────────

export class IpcRouter {
  private pendingCalls = new Map<string, Map<string, PendingCall>>();
  private pendingRpc = new Map<string, PendingRpc>();

  constructor(
    private readonly ctx: LifecycleContext,
    private readonly callbacks: IpcRouterCallbacks,
    events: TypedEmitter,
  ) {
    events.on("module:exit", (moduleId) => {
      this.cleanupModuleCalls(moduleId);
      this.cleanupModuleRpcs(moduleId);
    });
  }

  // ─── Message Dispatching ──────────────────────────────────────

  async handleMessage(moduleId: string, msg: ModuleMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':        return this.callbacks.onReady(moduleId);
      case 'log':          return void writeModuleLog(this.ctx.logger, moduleId, msg.level, msg.msg, msg.data, msg.topic);
      case 'log-group':    return void writeModuleLogGroup(this.ctx.logger, moduleId, msg.level, msg.msg, msg.data, msg.items);
      case 'ack':          return; // fire-and-forget
      case 'nack':         return; // fire-and-forget
      case 'publish':      return this.onPublish(moduleId, msg.topic, msg.payload);
      case 'call':         return this.onCall(moduleId, msg.id, msg.method, msg.params);
      case 'call:response': return this.onCallResponse(moduleId, msg.id, msg.result, msg.error);
      case 'pong':         return this.onPong(moduleId);
      case 'rpc_request':  return this.onRpcRequest(moduleId, msg.id, msg.service, msg.method, msg.params);
      case 'rpc_response': return this.onRpcResponse(moduleId, msg.id, msg.result, msg.error);
    }
  }

  // ─── Publish (Pub/Sub) ────────────────────────────────────────

  private async onPublish(fromModuleId: string, topic: string, payload: unknown): Promise<void> {
    const entry = this.ctx.registry.get(fromModuleId);
    if (!entry || entry.status !== 'ready') {
      this.ctx.logger.warn({ moduleId: fromModuleId }, 'Rejected message from module not in ready state');
      return;
    }

    if (this.ctx.enforcer) {
      const capabilities = this.ctx.enforcer.getModuleCapabilities(fromModuleId);
      if (!capabilities) {
        const violation = this.ctx.enforcer.createViolation(fromModuleId, 'topic', `publish:${topic}`);
        if (violation) {
          this.ctx.enforcer.logViolation(violation);
          if (violation.action === 'deny') {
            const decision = await this.callbacks.promptPermission({
              moduleId: fromModuleId, type: 'topic', value: topic,
            });
            if (decision === 'deny') {
              this.ctx.logger.warn({ moduleId: fromModuleId, topic }, 'Topic publish denied by operator');
              return; // drop message, don't kill
            }
            // Granted — bootstrap capabilities for this module
            this.ctx.enforcer.setModuleCapabilities(fromModuleId, { topics: [topic], services: [] });
          }
          // warn mode: log but continue
        }
      }
      const violation = capabilities ? this.ctx.enforcer.checkTopic(fromModuleId, topic, 'publish', capabilities) : null;
      if (violation) {
        this.ctx.enforcer.logViolation(violation);
        if (violation.action === 'deny') {
          this.callbacks.kill(fromModuleId, 'security-violation');
          return;
        }
      }
    }

    const subscribers = this.ctx.bus.getSubscribers(topic, fromModuleId);
    for (const subscriberId of subscribers) {
      const entry = this.ctx.registry.get(subscriberId);
      if (!entry?.process?.connected || entry.status !== 'ready') continue;
      this.send(subscriberId, {
        type: 'deliver',
        id: crypto.randomUUID(),
        topic,
        payload,
      });
    }
  }

  // ─── Kernel-to-Module Call ────────────────────────────────────

  private async onCall(moduleId: string, callId: string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.callbacks.onModuleCall(moduleId, method, params);
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

  // ─── RPC Routing ──────────────────────────────────────────────

  private async onRpcRequest(callerModuleId: string, rpcId: string, service: string, method: string, params?: unknown): Promise<void> {
    const entry = this.ctx.registry.get(callerModuleId);
    if (!entry || entry.status !== 'ready') {
      this.ctx.logger.warn({ moduleId: callerModuleId }, 'Rejected RPC from module not in ready state');
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'Module not ready' });
      return;
    }

    if (this.ctx.enforcer) {
      const capabilities = this.ctx.enforcer.getModuleCapabilities(callerModuleId);
      if (!capabilities) {
        const violation = this.ctx.enforcer.createViolation(callerModuleId, 'rpc', service);
        if (violation) {
          this.ctx.enforcer.logViolation(violation);
          if (violation.action === 'deny') {
            const decision = await this.callbacks.promptPermission({
              moduleId: callerModuleId, type: 'service', value: service,
            });
            if (decision === 'deny') {
              this.ctx.logger.warn({ moduleId: callerModuleId, service }, 'RPC request denied by operator');
              this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'forbidden' });
              return; // drop request, don't kill
            }
            // Granted — bootstrap capabilities for this module
            this.ctx.enforcer.setModuleCapabilities(callerModuleId, { topics: [], services: [service] });
          }
          // warn mode: log but continue
        }
      }
      const violation = capabilities ? this.ctx.enforcer.checkRpc(callerModuleId, service, capabilities) : null;
      if (violation) {
        this.ctx.enforcer.logViolation(violation);
        if (violation.action === 'deny') {
          this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'forbidden' });
          this.callbacks.kill(callerModuleId, 'security-violation');
          return;
        }
      }
    }

    const targetModuleId = this.ctx.registry.resolveService(service);
    if (!targetModuleId) {
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'service_not_found' });
      return;
    }

    const targetEntry = this.ctx.registry.get(targetModuleId);
    if (!targetEntry?.process?.connected || targetEntry.status !== 'ready') {
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'module_not_ready' });
      return;
    }

    const timer = setTimeout(() => {
      this.pendingRpc.delete(rpcId);
      this.ctx.logger.warn({ callerId: callerModuleId, targetService: service, method, timeoutMs: this.ctx.limits.rpcTimeoutMs }, 'rpc.timeout');
      this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'timeout' });
    }, this.ctx.limits.rpcTimeoutMs);

    // Publish RPC event for monitoring
    const rpcEvent = { from: callerModuleId, service, method, id: rpcId, ts: Date.now() };
    for (const subscriberId of this.ctx.bus.getSubscribers('system:rpc')) {
      const subEntry = this.ctx.registry.get(subscriberId);
      if (subEntry?.process?.connected && subEntry.status === 'ready') {
        this.send(subscriberId, { type: 'deliver', id: crypto.randomUUID(), topic: 'system:rpc', payload: rpcEvent });
      }
    }

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
      this.ctx.logger.warn({ module: moduleId, expected: pending.targetModuleId, rpcId }, 'RPC response from unexpected module — ignoring');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRpc.delete(rpcId);
    this.send(pending.callerModuleId, { type: 'rpc_response', id: rpcId, result, error });
  }

  // ─── Public API ───────────────────────────────────────────────

  /** Initialize pending-calls map for a module (called on spawn). */
  initModule(moduleId: string): void {
    if (!this.pendingCalls.has(moduleId)) {
      this.pendingCalls.set(moduleId, new Map());
    }
  }

  /** Send a kernel message to a module via its process stdin. */
  send(moduleId: string, msg: KernelMessage): boolean {
    const entry = this.ctx.registry.get(moduleId);
    if (entry?.process?.connected) {
      try {
        entry.process.send(msg);
        return true;
      } catch {
        this.ctx.logger.warn({ moduleId, msgType: (msg as { type: string }).type }, 'IPC write failed — module may be dead');
        return false;
      }
    }
    return false;
  }

  /** Issue a call to a module and wait for a response. */
  call(moduleId: string, method: string, params?: unknown, timeoutMs = this.ctx.limits.rpcTimeoutMs): Promise<unknown> {
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

  /** Issue a ping to a module and wait for pong. */
  ping(moduleId: string): Promise<void> {
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
      }, this.ctx.limits.pingTimeoutMs);

      calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(moduleId, { type: 'ping' });
    });
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /** Reject all pending calls for a module (on exit/kill). */
  cleanupModuleCalls(moduleId: string): void {
    const calls = this.pendingCalls.get(moduleId);
    if (!calls) return;
    for (const [, pending] of calls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Module ${moduleId} disconnected`));
    }
    this.pendingCalls.delete(moduleId);
  }

  /** Clean up pending RPCs involving a module (on exit/kill). */
  cleanupModuleRpcs(moduleId: string): void {
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
}
