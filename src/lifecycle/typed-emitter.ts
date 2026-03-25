/**
 * TypedEmitter — a minimal typed event bus for internal lifecycle coordination.
 *
 * The lifecycle subsystems (ProcessPool, IpcRouter, HealthMonitor, ServiceDirectory)
 * need to react to each other's events without holding direct references to each other.
 * A full-blown EventEmitter from Node's standard library would work, but it carries
 * no type safety — any string is a valid event name, and handler signatures are unchecked.
 *
 * This class is intentionally small: it only knows about the events that actually exist
 * in the lifecycle layer. Adding a new event means adding it to LifecycleEvents first,
 * which makes the contract visible in one place and caught by the compiler everywhere else.
 *
 * It is not exported outside the lifecycle directory. If you find yourself wanting to
 * use it elsewhere, that's a sign the concern belongs in the lifecycle layer.
 */

export type LifecycleEvents = {
  /** Fired when a module process exits (expected or unexpected). */
  "module:exit": [moduleId: string];
  /** Fired when all timers for a module should be cleared. */
  "module:timers:clear": [moduleId: string];
};

export class TypedEmitter {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  on<K extends keyof LifecycleEvents>(
    event: K,
    handler: (...args: LifecycleEvents[K]) => void,
  ): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler as (...args: unknown[]) => void);
  }

  emit<K extends keyof LifecycleEvents>(event: K, ...args: LifecycleEvents[K]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}
