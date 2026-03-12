/**
 * Module Registry — tracks all known modules, their process handles,
 * and the service directory (which module provides which service).
 */

import type { ChildProcess } from 'node:child_process';
import type { ModuleManifest } from 'jsr:@pons/sdk@^0.2';

export type ModuleStatus = 'starting' | 'ready' | 'restarting' | 'stopped' | 'crashed';

export interface ModuleEntry {
  manifest: ModuleManifest;
  process: ChildProcess | null;
  status: ModuleStatus;
  pid: number | undefined;
  restartCount: number;
  startedAt: Date | null;
}

export class ModuleRegistry {
  private modules = new Map<string, ModuleEntry>();

  // ─── Service Directory ──────────────────────────────────────
  // service key → moduleId that provides it
  private serviceProviders = new Map<string, string>();

  // ─── Module Registration ────────────────────────────────────

  register(manifest: ModuleManifest): void {
    this.modules.set(manifest.id, {
      manifest,
      process: null,
      status: 'starting',
      pid: undefined,
      restartCount: 0,
      startedAt: null,
    });
  }

  setProcess(id: string, proc: ChildProcess): void {
    const entry = this.modules.get(id);
    if (!entry) return;
    entry.process = proc;
    entry.pid = proc.pid;
    entry.startedAt = new Date();
  }

  setStatus(id: string, status: ModuleStatus): void {
    const entry = this.modules.get(id);
    if (entry) entry.status = status;
  }

  incrementRestarts(id: string): number {
    const entry = this.modules.get(id);
    if (!entry) return 0;
    entry.restartCount++;
    entry.process = null;
    entry.pid = undefined;
    return entry.restartCount;
  }

  get(id: string): ModuleEntry | undefined {
    return this.modules.get(id);
  }

  all(): ModuleEntry[] {
    return [...this.modules.values()];
  }

  /** Serializable module info for API consumers */
  allPublic(): Array<{ id: string; status: ModuleStatus; provides: string[] }> {
    return [...this.modules.entries()].map(([id, entry]) => ({
      id,
      status: entry.status,
      provides: entry.manifest.provides ?? [],
    }));
  }

  ids(): string[] {
    return [...this.modules.keys()];
  }

  /** Collect all command declarations from module manifests */
  getCommands(): Array<{ name: string; description: string; moduleId: string; args?: unknown[]; category?: string }> {
    const commands: Array<{ name: string; description: string; moduleId: string; args?: unknown[]; category?: string }> = [];
    for (const [id, entry] of this.modules) {
      for (const cmd of entry.manifest.commands ?? []) {
        commands.push({ ...cmd, moduleId: id });
      }
    }
    return commands;
  }

  resetRestartCount(id: string): void {
    const entry = this.modules.get(id);
    if (entry) entry.restartCount = 0;
  }

  remove(id: string): void {
    this.modules.delete(id);
    this.removeServices(id);
  }

  // ─── Service Directory Methods ──────────────────────────────

  /** Register services provided by a module (from manifest.provides). Rejects duplicates. */
  registerServices(moduleId: string, services: string[]): string[] {
    const rejected: string[] = [];
    for (const service of services) {
      const existing = this.serviceProviders.get(service);
      if (existing && existing !== moduleId) {
        rejected.push(service);
        continue;
      }
      this.serviceProviders.set(service, moduleId);
    }
    return rejected;
  }

  /** Remove all services provided by a module */
  removeServices(moduleId: string): void {
    for (const [service, provider] of this.serviceProviders) {
      if (provider === moduleId) this.serviceProviders.delete(service);
    }
  }

  /** Resolve which module provides a service */
  resolveService(service: string): string | undefined {
    return this.serviceProviders.get(service);
  }

  /** List all registered services */
  listServices(): Array<{ service: string; moduleId: string }> {
    return [...this.serviceProviders.entries()].map(([service, moduleId]) => ({ service, moduleId }));
  }

  /**
   * Detect circular service dependencies.
   * Returns the cycle path if found, or null if no cycle.
   *
   * Example: A requires service from B, B requires service from A
   * → returns ['A', 'B', 'A']
   */
  detectCircularDeps(moduleId: string): string[] | null {
    const manifest = this.modules.get(moduleId)?.manifest;
    if (!manifest?.requires?.length) return null;

    const visited = new Set<string>();
    const path: string[] = [];

    const dfs = (currentId: string): string[] | null => {
      if (visited.has(currentId)) {
        const cycleStart = path.indexOf(currentId);
        if (cycleStart >= 0) return [...path.slice(cycleStart), currentId];
        return null;
      }

      visited.add(currentId);
      path.push(currentId);

      const entry = this.modules.get(currentId);
      const requires = entry?.manifest.requires ?? [];

      for (const service of requires) {
        const providerId = this.serviceProviders.get(service);
        if (!providerId) continue;
        const cycle = dfs(providerId);
        if (cycle) return cycle;
      }

      path.pop();
      return null;
    };

    return dfs(moduleId);
  }
}
