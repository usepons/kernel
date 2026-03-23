/** Config validation diagnostics and auto-fix capabilities. */

import { z } from "npm:zod@^3.24";
import type { ZodObject, ZodRawShape } from "npm:zod@^3.24";
import type {
  DiagnosticReport,
  DiagnosticIssue,
  ValidationResult,
} from "./types.ts";

interface ConfigAccess {
  readonly configData: Record<string, unknown>;
  readonly appSchema: ZodObject<ZodRawShape> | null;
  readonly schemaKeys: Set<string>;
  set(keyPath: string, value: unknown): ValidationResult;
  save(): void;
}

/**
 * Provides config validation diagnostics and auto-fix capabilities.
 * Operates against a ConfigAccess interface to read/write config state.
 */
export class ConfigDoctor {
  private config: ConfigAccess;

  constructor(config: ConfigAccess) {
    this.config = config;
  }

  /**
   * Diagnose config against all known schemas.
   */
  diagnose(): DiagnosticReport {
    const issues: DiagnosticIssue[] = [];

    if (!this.config.appSchema) {
      return { issues, valid: true };
    }

    const result = this.config.appSchema.safeParse(this.config.configData);
    if (result.success) {
      for (const key of Object.keys(this.config.configData)) {
        if (!this.config.schemaKeys.has(key)) {
          issues.push({
            path: key,
            type: "unknown",
            message: `Unknown config section "${key}" — no module claims this key`,
            fixable: true,
            suggestedValue: undefined,
          });
        }
      }
      return { issues, valid: issues.length === 0 };
    }

    let defaults: Record<string, unknown> = {};
    try {
      defaults = this.config.appSchema.parse({}) as Record<string, unknown>;
    } catch { /* no defaults available */ }

    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      let suggestedValue: unknown = undefined;
      let fixable = false;

      let def: unknown = defaults;
      for (const part of issue.path) {
        if (def == null || typeof def !== "object") {
          def = undefined;
          break;
        }
        def = (def as Record<string, unknown>)[String(part)];
      }
      if (def !== undefined) {
        suggestedValue = def;
        fixable = true;
      }

      const type = issue.code === "invalid_type" && issue.received === "undefined"
        ? "missing"
        : "invalid";

      issues.push({
        path: path || "(root)",
        type,
        message: issue.message,
        fixable,
        suggestedValue,
      });
    }

    return { issues, valid: false };
  }

  /**
   * Auto-fix fixable issues from a diagnostic report.
   */
  fix(report: DiagnosticReport): void {
    for (const issue of report.issues) {
      if (!issue.fixable) continue;

      if (issue.type === "unknown") {
        const parts = issue.path.split(".");
        let target: Record<string, unknown> = this.config.configData;
        let valid = true;
        for (let i = 0; i < parts.length - 1; i++) {
          if (target[parts[i]] == null || typeof target[parts[i]] !== "object") {
            valid = false;
            break;
          }
          target = target[parts[i]] as Record<string, unknown>;
        }
        if (!valid) continue;
        delete target[parts[parts.length - 1]];
      } else if (issue.suggestedValue !== undefined) {
        this.config.set(issue.path, issue.suggestedValue);
      }
    }
    this.config.save();
  }
}
