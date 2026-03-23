/**
 * Security Enforcer — runtime permission checks for RPC, topic, and config access.
 *
 * Centralized enforcer with pure check functions. All violations are structured
 * and logged at error level. No side effects beyond logging.
 */

import type { KernelLogger } from '../logs/logger.ts';
import type { SecurityViolation, SecurityViolationType, PermissionStore } from './permissions.ts';

/** IPC capabilities a module declares (services it may call, topics it may use). */
export interface ModuleCapabilities {
  services?: string[];
  topics?: string[];
}

// ─── SecurityEnforcer ──────────────────────────────────────────

export class SecurityEnforcer {
  private readonly moduleCapabilities = new Map<string, ModuleCapabilities>();

  constructor(
    private readonly store: PermissionStore,
    private readonly logger: KernelLogger,
  ) {}

  // ─── RPC Check ───────────────────────────────────────────────

  /**
   * Check if a module is permitted to call a target service via RPC.
   * Returns null if allowed, or a SecurityViolation if denied.
   */
  checkRpc(
    callerModuleId: string,
    targetService: string,
    callerCapabilities: ModuleCapabilities,
  ): SecurityViolation | null {
    const allowed = callerCapabilities.services?.includes(targetService) ?? false;
    if (allowed) return null;

    return {
      timestamp: new Date().toISOString(),
      moduleId: callerModuleId,
      type: 'rpc' as SecurityViolationType,
      resource: targetService,
      action: 'deny',
    };
  }

  // ─── Topic Check ─────────────────────────────────────────────

  /**
   * Check if a module is permitted to publish or subscribe to a topic.
   * Returns null if allowed, or a SecurityViolation if denied.
   */
  checkTopic(
    moduleId: string,
    topic: string,
    direction: 'publish' | 'subscribe',
    moduleCapabilities: ModuleCapabilities,
  ): SecurityViolation | null {
    const allowed = moduleCapabilities.topics?.includes(topic) ?? false;
    if (allowed) return null;

    return {
      timestamp: new Date().toISOString(),
      moduleId,
      type: 'topic' as SecurityViolationType,
      resource: `${direction}:${topic}`,
      action: 'deny',
    };
  }

  // ─── Config Check ────────────────────────────────────────────

  /**
   * Check if a module is permitted to access a config key path.
   * The top-level section of keyPath must match the module's declared configKey.
   * Rejects empty paths and path traversal patterns.
   * Returns null if allowed, or a SecurityViolation if denied.
   */
  checkConfig(
    moduleId: string,
    keyPath: string,
    moduleConfigKey: string | undefined,
  ): SecurityViolation | null {
    const deny = (): SecurityViolation => ({
      timestamp: new Date().toISOString(),
      moduleId,
      type: 'config' as SecurityViolationType,
      resource: keyPath,
      action: 'deny',
    });

    const UNSAFE_SEGMENTS = new Set(['..', '__proto__', 'constructor', 'prototype']);
    if (!keyPath || keyPath === '.' || keyPath === '..' || keyPath.split('.').some(s => UNSAFE_SEGMENTS.has(s))) {
      return deny();
    }

    const section = keyPath.split('.')[0];
    if (!section || section !== moduleConfigKey) {
      return deny();
    }

    return null;
  }

  // ─── Violation Logging ───────────────────────────────────────

  /**
   * Log a security violation at error level with structured data.
   */
  logViolation(violation: SecurityViolation): void {
    this.logger.error(
      {
        moduleId: violation.moduleId,
        action: violation.action,
        target: violation.resource,
      },
      'security.violation',
    );
  }

  // ─── Permission Lookup ───────────────────────────────────────

  /**
   * Look up the declared capabilities for a module from the PermissionStore.
   * Returns null if the module has no approved capabilities.
   */
  getModuleCapabilities(moduleId: string): ModuleCapabilities | null {
    return this.moduleCapabilities.get(moduleId) ?? null;
  }

  /**
   * Register the declared capabilities for a module.
   */
  setModuleCapabilities(moduleId: string, capabilities: ModuleCapabilities): void {
    this.moduleCapabilities.set(moduleId, capabilities);
  }

  /**
   * Remove capabilities for a module (on kill or crash).
   */
  removeModuleCapabilities(moduleId: string): void {
    this.moduleCapabilities.delete(moduleId);
  }
}
