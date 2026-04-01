/** Handles kernel API calls from modules (config, services, permissions). */

import type { ConfigManager } from "./config/manager.ts";
import type { KernelLogger } from "./logs/logger.ts";
import type { LifecycleManager } from "./lifecycle.ts";
import type { ModulePermissions } from "./security/permissions.ts";
import { isSubset } from "./security/permissions.ts";
import type { PermissionStore } from "./security/permissions.ts";
import type { SecurityEnforcer } from "./security/enforcer.ts";
import { PERMISSION_FIELDS } from "./security/constants.ts";
import type { MessageBus } from "./messaging/bus.ts";

export class ModuleCallHandler {
  private readonly _bootTime: number;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly enforcer: SecurityEnforcer,
    private readonly permissionStore: PermissionStore,
    private readonly lifecycle: LifecycleManager,
    private readonly logger: KernelLogger,
    private readonly bus?: MessageBus,
    bootTime?: number,
  ) {
    this._bootTime = bootTime ?? Date.now();
  }

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
      case "monitor.snapshot":
        return {
          modules: this.lifecycle.getRegistry().allPublic(),
          services: this.lifecycle.getRegistry().listServices(),
          pending: this.permissionStore.getPendingRequests(),
          uptime: Date.now() - this._bootTime,
        };
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

    // Protected sections — only kernel can modify these
    const PROTECTED_SECTIONS = new Set(['security', 'kernel']);
    const section = key.split('.')[0];
    if (PROTECTED_SECTIONS.has(section)) {
      this.lifecycle.kill(moduleId, 'security-violation');
      throw new Error(`Security violation: section "${section}" is protected and cannot be modified by modules`);
    }

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

    // Notify UI via gateway (best-effort)
    this.notifyUiPermissionRequest(moduleId, pending.id, permissions, reason);

    this.logger.warn({ module: moduleId, requestId: pending.id }, 'Pending permission request');

    // Publish on the bus so any operator module (telegram, web, etc.) can show UI
    this.publishPermissionRequest(moduleId, pending.id, permissions, reason);

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

  private publishPermissionRequest(
    moduleId: string,
    requestId: string,
    permissions: unknown,
    reason?: string,
  ): void {
    if (!this.bus) return;
    const topic = 'kernel.permissions.pending';
    const subscribers = this.bus.getSubscribers(topic);
    if (subscribers.length === 0) return;

    for (const subscriberId of subscribers) {
      const entry = this.lifecycle.getRegistry().get(subscriberId);
      if (!entry?.process?.connected || entry.status !== 'ready') continue;
      this.lifecycle.sendMessage(subscriberId, {
        type: 'deliver' as const,
        id: crypto.randomUUID(),
        topic,
        payload: { moduleId, requestId, permissions, reason },
      });
    }
  }

  /** Push a permission request event to the gateway so the web UI can show it. */
  private notifyUiPermissionRequest(
    moduleId: string,
    requestId: string,
    permissions: Partial<ModulePermissions>,
    reason?: string,
  ): void {
    try {
      const gatewayEntry = this.lifecycle.getRegistry().get('gateway');
      if (!gatewayEntry?.process?.connected) return;
      this.lifecycle.sendMessage('gateway', {
        type: 'deliver',
        id: crypto.randomUUID(),
        topic: 'outbound:ws',
        payload: {
          type: 'permission:request',
          moduleId,
          requestId,
          permissions,
          reason,
        },
      });
    } catch { /* best-effort */ }
  }
}

const notificationCooldowns = new Map<string, number>();
const NOTIFICATION_COOLDOWN_MS = 60_000;

export function sendSystemNotification(moduleId: string): void {
  const now = Date.now();
  const last = notificationCooldowns.get(moduleId) ?? 0;
  if (now - last < NOTIFICATION_COOLDOWN_MS) return;
  notificationCooldowns.set(moduleId, now);
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
