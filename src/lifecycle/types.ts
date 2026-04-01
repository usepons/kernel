/**
 * Shared types and constants for the lifecycle sub-system.
 */

import type { KernelLogger } from '../logs/logger.ts';
import type { MessageBus } from '../messaging/bus.ts';
import type { ModuleRegistry } from '../module/registry.ts';
import type { SecurityEnforcer } from '../security/enforcer.ts';
import type { PermissionStore } from '../security/permissions.ts';

// ─── Constants ─────────────────────────────────────────────────

/** Default values — overridable via config.yaml `lifecycle` section (spec S15). */
export const DEFAULTS = {
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

export const PROTOCOL_VERSION = '1.0';

// ─── Interfaces ────────────────────────────────────────────────

export interface LifecycleLimits {
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

export interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingRpc {
  callerModuleId: string;
  targetModuleId: string;
  timer: ReturnType<typeof setTimeout>;
  originalRpcId: string;
}

export interface PendingReady {
  manifest: import('@pons/sdk').ModuleManifest;
  timer: ReturnType<typeof setTimeout>;
}

/** Shared dependencies injected into each lifecycle sub-system. */
export interface LifecycleContext {
  registry: ModuleRegistry;
  logger: KernelLogger;
  bus: MessageBus;
  enforcer?: SecurityEnforcer;
  permissionStore?: PermissionStore;
  limits: LifecycleLimits;
}
