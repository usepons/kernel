/**
 * Security Enforcer — runtime permission checks for RPC, topic, and config access.
 *
 * Centralized enforcer with pure check functions. All violations are structured
 * and logged at error level. No side effects beyond logging.
 */

import type { KernelLogger } from '../logs/logger.ts';
import type { ModulePermissions, SecurityViolation, SecurityViolationType, PermissionStore } from './permissions.ts';

// ─── SecurityEnforcer ──────────────────────────────────────────

export class SecurityEnforcer {
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
    callerPermissions: ModulePermissions,
  ): SecurityViolation | null {
    const allowed = callerPermissions.services?.includes(targetService) ?? false;
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
    modulePermissions: ModulePermissions,
  ): SecurityViolation | null {
    const allowed = modulePermissions.topics?.includes(topic) ?? false;
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

    if (!keyPath || keyPath === '.' || keyPath === '..' || keyPath.includes('..')) {
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
        timestamp: violation.timestamp,
        moduleId: violation.moduleId,
        violationType: violation.type,
        resource: violation.resource,
        action: violation.action,
      },
      'Security violation',
    );
  }

  // ─── Permission Lookup ───────────────────────────────────────

  /**
   * Look up the approved permissions for a module from the PermissionStore.
   * Returns null if the module has no approved permissions.
   */
  getModulePermissions(moduleId: string): ModulePermissions | null {
    const granted = this.store.getApproved(moduleId);
    return granted?.permissions ?? null;
  }
}
