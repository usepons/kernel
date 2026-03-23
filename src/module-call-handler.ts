/** Handles kernel API calls from modules (config, services, permissions). */

import type { ConfigManager } from "./config/manager.ts";
import type { KernelLogger } from "./logs/logger.ts";
import type { LifecycleManager } from "./lifecycle.ts";
import type { ModulePermissions } from "./security/permissions.ts";
import { isSubset } from "./security/permissions.ts";
import type { PermissionStore } from "./security/permissions.ts";
import type { SecurityEnforcer } from "./security/enforcer.ts";
import { PERMISSION_FIELDS } from "./security/constants.ts";

export class ModuleCallHandler {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly enforcer: SecurityEnforcer,
    private readonly permissionStore: PermissionStore,
    private readonly lifecycle: LifecycleManager,
    private readonly logger: KernelLogger,
  ) {}

  async handle(moduleId: string, method: string, params: unknown): Promise<unknown> {
    // Security: get the calling module's manifest for config scoping
    const callerEntry = this.lifecycle.getRegistry().get(moduleId);
    const callerConfigKey = callerEntry?.manifest?.configKey;

    switch (method) {
      case "config.get":
        return this.handleConfigGet(moduleId, params, callerConfigKey);
      case "config.set":
        return this.handleConfigSet(moduleId, params, callerConfigKey);
      case "config.sections":
        return this.handleConfigSections(callerConfigKey);
      case "module.list":
        return this.lifecycle.getRegistry().allPublic();
      case "module.commands":
        return this.lifecycle.getRegistry().getCommands();
      case "service.discover":
        return this.lifecycle.getRegistry().listServices();
      case "service.resolve":
        return this.handleServiceResolve(params);
      case "permissions.request":
        return this.handlePermissionsRequest(moduleId, params);
      case "permissions.check":
        return this.handlePermissionsCheck(moduleId, params);
      case "permissions.pending":
        return this.handlePermissionsPending();
      case "permissions.grant":
        return this.handlePermissionsGrant(moduleId, params);
      case "permissions.deny":
        return this.handlePermissionsDeny(moduleId, params);
      default:
        throw new Error(`Unknown kernel method: ${method}`);
    }
  }

  private handleConfigGet(
    moduleId: string,
    params: unknown,
    callerConfigKey: string | undefined,
  ): unknown {
    const key = (params as { key: string }).key;
    // Security: enforce config scope -- module can only read its own section
    const violation = this.enforcer.checkConfig(moduleId, key, callerConfigKey);
    if (violation) {
      this.enforcer.logViolation(violation);
      if (violation.action === 'deny') {
        this.lifecycle.kill(moduleId, "security-violation");
        throw new Error(`Security violation: not permitted to read config key "${key}"`);
      }
      // warn mode: log but allow access
    }
    return this.configManager.get(key);
  }

  private handleConfigSet(
    moduleId: string,
    params: unknown,
    callerConfigKey: string | undefined,
  ): unknown {
    const { key, value } = params as { key: string; value: unknown };
    // Security: enforce config scope -- module can only write its own section
    const violation = this.enforcer.checkConfig(moduleId, key, callerConfigKey);
    if (violation) {
      this.enforcer.logViolation(violation);
      if (violation.action === 'deny') {
        this.lifecycle.kill(moduleId, "security-violation");
        throw new Error(`Security violation: not permitted to write config key "${key}"`);
      }
      // warn mode: log but allow access
    }
    const result = this.configManager.set(key, value);
    if (result.success) {
      const affected = this.configManager.getAffectedModules([key]);
      const section = key.split(".")[0];
      for (const modId of affected) {
        if (modId === "__kernel__") continue;
        const entry = this.lifecycle.getRegistry().get(modId);
        if (entry?.process?.connected) {
          // Security: send only the affected module's own config section
          const modConfigKey = entry.manifest?.configKey;
          this.lifecycle.sendMessage(modId, {
            type: "config:update" as const,
            config: modConfigKey ? { [modConfigKey]: this.configManager.getSection(modConfigKey) } : {},
            changedSections: [section],
          });
        }
      }
    }
    return result;
  }

  private handleConfigSections(callerConfigKey: string | undefined): unknown {
    // Security: filter to return only the calling module's own section metadata
    return this.configManager.listSections().filter(
      (s: { key: string }) => s.key === callerConfigKey,
    );
  }

  private handleServiceResolve(params: unknown): unknown {
    const service = (params as { service: string }).service;
    const resolved = this.lifecycle.getRegistry().resolveService(service);
    if (!resolved) throw new Error(`Service not found: ${service}`);
    return resolved;
  }

  private handlePermissionsRequest(moduleId: string, params: unknown): unknown {
    const { permissions, reason } = params as { permissions: Partial<ModulePermissions>; reason?: string };

    // Check if already granted
    const effective = this.permissionStore.getEffectivePermissions(moduleId);
    if (effective && isSubset(permissions, effective)) {
      return { granted: true };
    }

    // Check if denied
    if (this.permissionStore.isDenied(moduleId, permissions)) {
      return { granted: false, denied: true };
    }

    // Check for existing pending
    const existing = this.permissionStore.findExistingPending(moduleId, permissions);
    if (existing) {
      return { granted: false, pending: true, requestId: existing.id };
    }

    // Guard: module may have been removed from permissions store during SIGUSR2 race
    if (!this.permissionStore.isApproved(moduleId)) {
      return { granted: false, denied: true };
    }

    // Queue as pending
    const pending = this.permissionStore.addPendingRequest(moduleId, permissions, reason);

    // Send system notification (best-effort)
    sendSystemNotification(moduleId);

    this.logger.warn({ module: moduleId, requestId: pending.id }, 'Pending permission request');

    return { granted: false, pending: true, requestId: pending.id };
  }

  private handlePermissionsCheck(moduleId: string, params: unknown): unknown {
    const { permissions } = params as { permissions: Partial<ModulePermissions> };
    const effective = this.permissionStore.getEffectivePermissions(moduleId);

    if (!effective) return { granted: false, missing: permissions };

    const missing: Partial<ModulePermissions> = {};
    let allGranted = true;

    for (const field of PERMISSION_FIELDS) {
      const requested = (permissions as Record<string, string[]>)[field];
      if (!requested) continue;
      const granted = (effective as Record<string, string[]>)[field] || [];
      const missingValues = requested.filter((v: string) => !granted.includes(v));
      if (missingValues.length > 0) {
        (missing as Record<string, string[]>)[field] = missingValues;
        allGranted = false;
      }
    }

    return { granted: allGranted, missing };
  }

  private handlePermissionsPending(): Record<string, unknown[]> {
    return this.permissionStore.getPendingRequests();
  }

  /** Only operator modules (e.g. the gateway) may grant or deny permissions. */
  private static readonly OPERATOR_MODULES = new Set(['gateway']);

  private assertOperator(callerId: string): void {
    if (!ModuleCallHandler.OPERATOR_MODULES.has(callerId)) {
      this.logger.error({ moduleId: callerId }, 'Unauthorized permissions.grant/deny attempt');
      throw new Error('Only operator modules may grant or deny permissions');
    }
  }

  private handlePermissionsGrant(callerId: string, params: unknown): { success: boolean } {
    this.assertOperator(callerId);
    const { moduleId, requestId } = params as { moduleId: string; requestId: string };
    if (!moduleId || !requestId) throw new Error('moduleId and requestId are required');
    const resolved = this.permissionStore.resolvePending(moduleId, requestId, 'grant');
    if (!resolved) throw new Error(`Pending request not found: ${requestId}`);
    // Trigger permission reload — the kernel's SIGUSR2 handler will restart the module
    try { Deno.kill(Deno.pid, 'SIGUSR2'); } catch { /* best-effort */ }
    this.logger.info({ operator: callerId, target: moduleId, requestId }, 'permission.granted');
    return { success: true };
  }

  private handlePermissionsDeny(callerId: string, params: unknown): { success: boolean } {
    this.assertOperator(callerId);
    const { moduleId, requestId } = params as { moduleId: string; requestId: string };
    if (!moduleId || !requestId) throw new Error('moduleId and requestId are required');
    const resolved = this.permissionStore.resolvePending(moduleId, requestId, 'deny');
    if (!resolved) throw new Error(`Pending request not found: ${requestId}`);
    this.logger.info({ operator: callerId, target: moduleId, requestId }, 'permission.denied');
    return { success: true };
  }
}

export function sendSystemNotification(moduleId: string): void {
  try {
    // Sanitize moduleId -- strip anything that could escape shell/AppleScript strings
    const safeId = moduleId.replace(/[^a-zA-Z0-9_\-\.]/g, '');
    // Fire-and-forget -- never block the event loop for a best-effort notification
    if (Deno.build.os === 'darwin') {
      new Deno.Command('osascript', {
        args: ['-e', `display notification "Module ${safeId} is waiting for permission approval" with title "Pons"`],
        stdout: 'null', stderr: 'null',
      }).spawn();
    } else {
      new Deno.Command('notify-send', {
        args: ['Pons', `Module ${safeId} is waiting for permission approval`],
        stdout: 'null', stderr: 'null',
      }).spawn();
    }
  } catch { /* notification is best-effort */ }
}
