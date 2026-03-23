/**
 * IPC Router — message dispatching, kernel-to-module calls, RPC forwarding.
 *
 * Owns: pendingCalls, pendingRpc state.
 * All send() calls go through this class (it writes to process stdin).
 */

import type { KernelMessage, ModuleMessage } from '@pons/sdk';
import { writeModuleLog, writeModuleLogGroup } from '../logs/logger.ts';
import type { LifecycleContext, PendingCall, PendingRpc } from './types.ts';

// ─── Callback Interfaces ──────────────────────────────────────

export interface IpcRouterCallbacks {
  /** Called when a module sends 'ready'. Facade routes to service-directory. */
  onReady(moduleId: string): void;
  /** Called when a module sends 'call'. Facade routes to external handler. */
  onModuleCall(moduleId: string, method: string, params: unknown): Promise<unknown>;
  /** Called when a module should be killed (security violation, etc.). */
  kill(moduleId: string, reason: string): void;
}

// ─── IPC Router ───────────────────────────────────────────────

export class IpcRouter {
  private pendingCalls = new Map<string, Map<string, PendingCall>>();
  private pendingRpc = new Map<string, PendingRpc>();

  constructor(
    private readonly ctx: LifecycleContext,
    private readonly callbacks: IpcRouterCallbacks,
  ) {}

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

  private onPublish(fromModuleId: string, topic: string, payload: unknown): void {
    if (this.ctx.enforcer) {
      const capabilities = this.ctx.enforcer.getModuleCapabilities(fromModuleId);
      if (!capabilities) {
        const violation = this.ctx.enforcer.createViolation(fromModuleId, 'topic', `publish:${topic}`);
        if (violation) {
          this.ctx.enforcer.logViolation(violation);
          if (violation.action === 'deny') {
            this.callbacks.kill(fromModuleId, 'security-violation');
            return;
          }
          // warn mode: log but continue
        }
      }
      const violation = capabilities ? this.ctx.enforcer.checkTopic(fromModuleId, topic, 'publish', capabilities) : null;
      if (violation) {
        // Fallback: auto-derive from manifest before enforcing
        const manifest = this.ctx.registry.get(fromModuleId)?.manifest;
        const manifestTopics = [...(manifest?.subscribes ?? []), ...(manifest?.publishes ?? [])];
        if (manifest && manifestTopics.includes(topic)) {
          this.ctx.logger.warn({ moduleId: fromModuleId, topic }, `Topic '${topic}' not in capabilities but found in manifest — auto-allowing. Add to capabilities block to silence this warning.`);
          const updatedTopics = [...new Set([...(capabilities?.topics ?? []), topic])];
          this.ctx.enforcer.setModuleCapabilities(fromModuleId, { ...capabilities, topics: updatedTopics });
        } else {
          this.ctx.enforcer.logViolation(violation);
          if (violation.action === 'deny') {
            this.callbacks.kill(fromModuleId, 'security-violation');
            return;
          }
          // warn mode: log but continue
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

  private onRpcRequest(callerModuleId: string, rpcId: string, service: string, method: string, params?: unknown): void {
    if (this.ctx.enforcer) {
      const capabilities = this.ctx.enforcer.getModuleCapabilities(callerModuleId);
      if (!capabilities) {
        const violation = this.ctx.enforcer.createViolation(callerModuleId, 'rpc', service);
        if (violation) {
          this.ctx.enforcer.logViolation(violation);
          if (violation.action === 'deny') {
            this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'forbidden' });
            this.callbacks.kill(callerModuleId, 'security-violation');
            return;
          }
          // warn mode: log but continue
        }
      }
      const violation = capabilities ? this.ctx.enforcer.checkRpc(callerModuleId, service, capabilities) : null;
      if (violation) {
        // Fallback: auto-derive from manifest before enforcing
        const manifest = this.ctx.registry.get(callerModuleId)?.manifest;
        const manifestServices = [...(manifest?.requires ?? []), ...(manifest?.optionalRequires ?? [])];
        if (manifest && manifestServices.includes(service)) {
          this.ctx.logger.warn({ moduleId: callerModuleId, service }, `Service '${service}' not in capabilities but found in manifest — auto-allowing. Add to capabilities block to silence this warning.`);
          const updatedServices = [...new Set([...(capabilities?.services ?? []), service])];
          this.ctx.enforcer.setModuleCapabilities(callerModuleId, { ...capabilities, services: updatedServices });
        } else {
          this.ctx.enforcer.logViolation(violation);
          if (violation.action === 'deny') {
            this.send(callerModuleId, { type: 'rpc_response', id: rpcId, error: 'forbidden' });
            this.callbacks.kill(callerModuleId, 'security-violation');
            return;
          }
          // warn mode: log but continue
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
