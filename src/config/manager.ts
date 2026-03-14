/**
 * ConfigManager — discovers module schemas, builds unified AppConfig,
 * validates config.yaml, provides CRUD, doctor diagnostics.
 */

import { join, toFileUrl } from "jsr:@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "npm:yaml@^2.7.1";
import { z } from "npm:zod@^3.24";
import type { ZodObject, ZodRawShape } from "npm:zod@^3.24";
import { getPonsHome } from "jsr:@pons/sdk@^0.2";
import type { ModuleManifest } from "jsr:@pons/sdk@^0.2";
import type { ConfigSchemaDefinition } from "jsr:@pons/sdk@^0.2/config";
import type {
  KernelConfig,
  DiagnosticReport,
  DiagnosticIssue,
  ValidationResult,
} from "./types.ts";

// Kernel built-in schema (defined here to avoid JSR slow-type export issues in types.ts)
const kernelBuiltinSchema = z.object({
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    levels: z.record(z.enum(["trace", "debug", "info", "warn", "error", "fatal"])).default({}),
  }).default({}),
});

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface RegisteredSchema {
  configKey: string;
  schema: ZodObject<ZodRawShape>;
  meta?: { description?: string; labels?: Record<string, string> };
  moduleId: string;
}

export class ConfigManager {
  private schemas = new Map<string, RegisteredSchema>();
  private appSchema: ZodObject<ZodRawShape> | null = null;
  private configData: Record<string, unknown> = {};
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? join(getPonsHome(), "config.yaml");
  }

  // ─── Schema Discovery ──────────────────────────────────────

  /**
   * Discover and import config schemas from all modules.
   * Also registers kernel built-in schemas.
   */
  async discoverSchemas(modules: Array<{ manifest: ModuleManifest; moduleDir: string }>): Promise<void> {
    // Register kernel built-in schema keys
    const builtinShape = kernelBuiltinSchema.shape;
    for (const [key, fieldSchema] of Object.entries(builtinShape)) {
      this.schemas.set(key, {
        configKey: key,
        schema: z.object({ [key]: fieldSchema }) as unknown as ZodObject<ZodRawShape>,
        meta: { description: `Kernel ${key} configuration` },
        moduleId: "__kernel__",
      });
    }

    // Import module schemas
    for (const { manifest, moduleDir } of modules) {
      if (!manifest.configSchema || !manifest.configKey) continue;

      try {
        const schemaPath = join(moduleDir, manifest.configSchema);
        try { Deno.statSync(schemaPath); } catch { continue; }

        const realPath = Deno.realPathSync(schemaPath);
        const realModuleDir = Deno.realPathSync(moduleDir);
        // Security: verify schema path is within the module directory (prevent path traversal)
        if (!realPath.startsWith(realModuleDir + '/')) {
          console.warn(`[config] Schema path escapes module directory for "${manifest.id}" — skipping`);
          continue;
        }
        const mod = await import(toFileUrl(realPath).href);
        const definition: ConfigSchemaDefinition = mod.default;

        if (!definition?.schema) continue;

        this.schemas.set(manifest.configKey, {
          configKey: manifest.configKey,
          schema: z.object({ [manifest.configKey]: definition.schema }) as unknown as ZodObject<ZodRawShape>,
          meta: definition.meta ? {
            description: definition.meta.description,
            labels: definition.meta.labels as Record<string, string> | undefined,
          } : undefined,
          moduleId: manifest.id,
        });
      } catch (err) {
        // Log warning but don't fail — module will run with raw config
        console.warn(`[config] Failed to load schema for module "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.rebuildAppSchema();
  }

  /**
   * Register a schema manually (for kernel built-in sections or testing).
   */
  registerSchema(configKey: string, schema: ZodObject<ZodRawShape>, moduleId: string, meta?: { description?: string; labels?: Record<string, string> }): void {
    this.schemas.set(configKey, {
      configKey,
      schema: z.object({ [configKey]: schema }) as unknown as ZodObject<ZodRawShape>,
      meta,
      moduleId,
    });
    this.rebuildAppSchema();
  }

  private rebuildAppSchema(): void {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, reg] of this.schemas) {
      const innerShape = (reg.schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
      const fieldSchema = innerShape[key];
      if (fieldSchema) {
        // Wrap each section as optional with default so missing sections
        // in config.yaml are filled with schema defaults instead of failing
        if (fieldSchema instanceof z.ZodObject) {
          shape[key] = fieldSchema.default({});
        } else {
          shape[key] = fieldSchema.optional();
        }
      }
    }
    this.appSchema = z.object(shape).passthrough() as unknown as ZodObject<ZodRawShape>;
  }

  // ─── Load / Save ───────────────────────────────────────────

  /**
   * Load config.yaml, validate against AppConfig, fill defaults.
   */
  load(): KernelConfig {
    try { Deno.statSync(this.configPath); } catch {
      if (this.appSchema) {
        this.configData = this.appSchema.parse({}) as Record<string, unknown>;
      }
      return this.configData as KernelConfig;
    }

    const raw = Deno.readTextFileSync(this.configPath);
    const parsed: Record<string, unknown> = parseYaml(raw) || {};

    if (this.appSchema) {
      const result = this.appSchema.safeParse(parsed);
      if (result.success) {
        this.configData = result.data as Record<string, unknown>;
      } else {
        // Best-effort: use raw parsed data, warn about validation errors
        this.configData = parsed;
        const errorPaths = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
        console.warn(`[config] Validation warnings: ${errorPaths}`);
      }
    } else {
      this.configData = parsed;
    }

    return this.configData as KernelConfig;
  }

  /**
   * Save current config data back to YAML.
   */
  save(): void {
    const yaml = stringifyYaml(this.configData, { lineWidth: 120 });
    Deno.writeTextFileSync(this.configPath, yaml);
  }

  // ─── CRUD ──────────────────────────────────────────────────

  /**
   * Get a value by dot-separated key path.
   */
  get<T = unknown>(keyPath: string): T | undefined {
    const parts = keyPath.split(".");
    let val: unknown = this.configData;
    for (const part of parts) {
      if (UNSAFE_KEYS.has(part)) return undefined;
      if (val == null || typeof val !== "object") return undefined;
      val = (val as Record<string, unknown>)[part];
    }
    return val as T;
  }

  /**
   * Set a value by dot-separated key path.
   * Validates the value against the schema before writing.
   */
  set(keyPath: string, value: unknown): ValidationResult {
    const parts = keyPath.split(".");
    if (parts.length === 0) return { success: false, error: "Empty key path" };

    for (const part of parts) {
      if (UNSAFE_KEYS.has(part)) return { success: false, error: `Unsafe key: ${part}` };
    }

    const coerced = this.coerceValue(value);

    // Build a test object with the new value applied
    const testData = structuredClone(this.configData);
    let target: Record<string, unknown> = testData;
    for (let i = 0; i < parts.length - 1; i++) {
      if (target[parts[i]] == null || typeof target[parts[i]] !== "object") {
        target[parts[i]] = {};
      }
      target = target[parts[i]] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = coerced;

    // Validate if we have a schema
    const sectionKey = parts[0];
    const sectionSchema = this.schemas.get(sectionKey);
    if (sectionSchema && this.appSchema) {
      const result = this.appSchema.safeParse(testData);
      if (!result.success) {
        const issue = result.error.issues[0];
        return {
          success: false,
          error: `Validation failed at ${issue.path.join(".")}: ${issue.message}`,
        };
      }
    }

    this.configData = testData;
    this.save();
    return { success: true, coerced };
  }

  /**
   * Get the config section for a specific module (by configKey).
   */
  getSection(configKey: string): unknown {
    return this.configData[configKey];
  }

  /**
   * Get the full config data.
   */
  getAll(): Record<string, unknown> {
    return this.configData;
  }

  /**
   * Reset a key path to its schema default.
   */
  resetKey(keyPath: string): ValidationResult {
    const parts = keyPath.split(".");
    if (parts.length === 0) return { success: false, error: "Empty key path" };

    if (!this.appSchema) return { success: false, error: "No schema loaded" };

    const defaults = this.appSchema.parse({}) as Record<string, unknown>;
    let defaultVal: unknown = defaults;
    for (const part of parts) {
      if (defaultVal == null || typeof defaultVal !== "object") {
        defaultVal = undefined;
        break;
      }
      defaultVal = (defaultVal as Record<string, unknown>)[part];
    }

    return this.set(keyPath, defaultVal);
  }

  /**
   * Reset all config to schema defaults.
   */
  resetAll(): void {
    if (this.appSchema) {
      this.configData = this.appSchema.parse({}) as Record<string, unknown>;
    } else {
      this.configData = {};
    }
    this.save();
  }

  // ─── Doctor ────────────────────────────────────────────────

  /**
   * Diagnose config against all known schemas.
   */
  diagnose(): DiagnosticReport {
    const issues: DiagnosticIssue[] = [];

    if (!this.appSchema) {
      return { issues, valid: true };
    }

    const result = this.appSchema.safeParse(this.configData);
    if (result.success) {
      const knownKeys = new Set(this.schemas.keys());
      for (const key of Object.keys(this.configData)) {
        if (!knownKeys.has(key)) {
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
      defaults = this.appSchema.parse({}) as Record<string, unknown>;
    } catch { /* no defaults available */ }

    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      let suggestedValue: unknown = undefined;
      let fixable = false;

      let def: unknown = defaults;
      for (const part of issue.path) {
        if (def == null || typeof def !== "object") { def = undefined; break; }
        def = (def as Record<string, unknown>)[String(part)];
      }
      if (def !== undefined) {
        suggestedValue = def;
        fixable = true;
      }

      const type = issue.code === "invalid_type" && issue.received === "undefined" ? "missing" : "invalid";

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
        let target: Record<string, unknown> = this.configData;
        let valid = true;
        for (let i = 0; i < parts.length - 1; i++) {
          if (target[parts[i]] == null || typeof target[parts[i]] !== "object") { valid = false; break; }
          target = target[parts[i]] as Record<string, unknown>;
        }
        if (!valid) continue;
        delete target[parts[parts.length - 1]];
      } else if (issue.suggestedValue !== undefined) {
        this.set(issue.path, issue.suggestedValue);
      }
    }
    this.save();
  }

  // ─── Hot-reload notification ───────────────────────────────

  /**
   * Determine which modules are affected by changed config keys.
   */
  getAffectedModules(changedKeyPaths: string[]): string[] {
    const affectedModuleIds = new Set<string>();
    for (const keyPath of changedKeyPaths) {
      const sectionKey = keyPath.split(".")[0];
      const schema = this.schemas.get(sectionKey);
      if (schema) {
        affectedModuleIds.add(schema.moduleId);
      }
    }
    return [...affectedModuleIds];
  }

  /**
   * Get list of all registered config sections with metadata.
   */
  listSections(): Array<{ key: string; moduleId: string; description?: string; labels?: Record<string, string> }> {
    const sections: Array<{ key: string; moduleId: string; description?: string; labels?: Record<string, string> }> = [];
    for (const [key, reg] of this.schemas) {
      sections.push({
        key,
        moduleId: reg.moduleId,
        description: reg.meta?.description,
        labels: reg.meta?.labels,
      });
    }
    return sections;
  }

  /**
   * Get the Zod schema for a specific section key.
   */
  getSectionSchema(configKey: string): z.ZodTypeAny | undefined {
    const reg = this.schemas.get(configKey);
    if (!reg) return undefined;
    const innerShape = (reg.schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
    return innerShape[configKey];
  }

  // ─── Helpers ───────────────────────────────────────────────

  private coerceValue(value: unknown): unknown {
    if (typeof value !== "string") return value;

    if ((value.startsWith("{") && value.endsWith("}")) ||
        (value.startsWith("[") && value.endsWith("]"))) {
      try { return JSON.parse(value); } catch { /* fall through */ }
    }

    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;

    const num = Number(value);
    if (!Number.isNaN(num) && value.trim() !== "") return num;

    return value;
  }
}
