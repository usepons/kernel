/**
 * Health Monitor — periodic ping/pong health checks for running modules.
 *
 * Owns: healthTimers, healthFailures state.
 */

import type { LifecycleContext } from './types.ts';

// ─── Callback Interfaces ──────────────────────────────────────

export interface HealthMonitorCallbacks {
  /** Issue a ping to a module and wait for pong. */
  ping(moduleId: string): Promise<void>;
  /** Kill a module that has failed too many health checks. */
  kill(moduleId: string, reason: string): Promise<void>;
}

// ─── Health Monitor ───────────────────────────────────────────

export class HealthMonitor {
  private healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private healthFailures = new Map<string, number>();

  constructor(
    private readonly ctx: LifecycleContext,
    private readonly callbacks: HealthMonitorCallbacks,
  ) {}

  startHealthCheck(moduleId: string): void {
    this.clearHealthTimer(moduleId);
    this.healthFailures.set(moduleId, 0);
    const timer = setInterval(async () => {
      try {
        await this.callbacks.ping(moduleId);
        this.healthFailures.set(moduleId, 0);
      } catch {
        const failures = (this.healthFailures.get(moduleId) ?? 0) + 1;
        this.healthFailures.set(moduleId, failures);
        if (failures >= this.ctx.limits.healthMaxFailures) {
          this.ctx.logger.warn({ module: moduleId, failures }, 'Health check failed — killing module');
          this.callbacks.kill(moduleId, 'health-check-failed').catch(() => {});
        } else {
          this.ctx.logger.debug({ module: moduleId, failures, max: this.ctx.limits.healthMaxFailures }, 'Health check failed — retrying');
        }
      }
    }, this.ctx.limits.healthIntervalMs);

    this.healthTimers.set(moduleId, timer);
  }

  clearHealthTimer(moduleId: string): void {
    const t = this.healthTimers.get(moduleId);
    if (t) { clearInterval(t); this.healthTimers.delete(moduleId); }
  }

  /** Clear all health state for a module (timer + failure count). */
  clearAll(moduleId: string): void {
    this.clearHealthTimer(moduleId);
    this.healthFailures.delete(moduleId);
  }
}
