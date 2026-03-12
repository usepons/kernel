// ─── Kernel built-in types ──────────────────────────────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LoggingConfig {
  level: LogLevel;
  levels: Record<string, LogLevel>;
}

export type KernelConfig = {
  logging: LoggingConfig;
} & Record<string, unknown>;

// ─── Diagnostic types ────────────────────────────────────────

export type DiagnosticIssueType = "missing" | "invalid" | "unknown" | "deprecated";

export interface DiagnosticIssue {
  path: string;
  type: DiagnosticIssueType;
  message: string;
  fixable: boolean;
  suggestedValue?: unknown;
}

export interface DiagnosticReport {
  issues: DiagnosticIssue[];
  valid: boolean;
}

export interface ValidationResult {
  success: boolean;
  error?: string;
  coerced?: unknown;
}
