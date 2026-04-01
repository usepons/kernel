/**
 * ConfigManager — discovers module schemas, builds unified AppConfig,
 * validates config.yaml, provides CRUD, doctor diagnostics.
 */

import { join } from "jsr:@std/path@^1";
import { parse as parseYaml, stringify as stringifyYaml } from "npm:yaml@^2.7.1";
import { z } from "npm:zod@^3.24";
import type { ZodObject, ZodRawShape } from "npm:zod@^3.24";
import { getPonsHome } from "@pons/sdk";
import type { ModuleManifest } from "@pons/sdk";
import type {
  KernelConfig,
  DiagnosticReport,
  ValidationResult,
} from "./types.ts";
import { discoverSchemas } from "./schema-discovery.ts";
import type { RegisteredSchema } from "./schema-discovery.ts";
import { ConfigDoctor } from "./diagnostics.ts";

// Re-export extracted modules for backward compatibility
export { discoverSchemas } from "./schema-discovery.ts";
export type { RegisteredSchema } from "./schema-discovery.ts";
export { ConfigDoctor } from "./diagnostics.ts";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class ConfigManager {
  private schemas = new Map<string, RegisteredSchema>();
  private appSchema: ZodObject<ZodRawShape> | null = null;
  private configData: Record<string, unknown> = {};
  private configPath: string;
  private doctor: ConfigDoctor;

  constructor(configPath?: string) {
    this.configPath = configPath ?? join(getPonsHome(), "config.yaml");
    this.doctor = new ConfigDoctor({
      get configData() { return {} as Record<string, unknown>; },
      get appSchema() { return null; },
      get schemaKeys() { return new Set<string>(); },
      set: () => ({ success: false, error: "Not initialized" }),
      save: () => {},
    });
    this.rebuildDoctor();
  }

  /**
   * Rebuild the ConfigDoctor instance with current state.
   */
  private rebuildDoctor(): void {
    const self = this;
    this.doctor = new ConfigDoctor({
      get configData() { return self.configData; },
      get appSchema() { return self.appSchema; },
      get schemaKeys() { return new Set(self.schemas.keys()); },
      set: (keyPath: string, value: unknown) => self.set(keyPath, value),
      save: () => self.save(),
    });
  }

  // ─── Schema Discovery ──────────────────────────────────────

  /**
   * Discover and import config schemas from all modules.
   * Also registers kernel built-in schemas.
   */
  async discoverSchemas(modules: Array<{ manifest: ModuleManifest; moduleDir: string }>): Promise<void> {
    this.schemas = await discoverSchemas(modules);
    this.rebuildAppSchema();
    this.rebuildDoctor();
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
      // Skip JSON Schema sections — they validate independently via ajv
      if (!reg.schema) continue;

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
      console.warn(`[config] Config file not found at ${this.configPath} — using schema defaults`);
      if (this.appSchema) {
        this.configData = this.appSchema.parse({}) as Record<string, unknown>;
      }
      // Apply ajv defaults for JSON Schema sections
      for (const [key, reg] of this.schemas) {
        if (!reg.ajvValidate) continue;
        const dataCopy = {};
        reg.ajvValidate(dataCopy);
        this.configData[key] = dataCopy;
      }
      return this.configData as KernelConfig;
    }

    let raw: string;
    try {
      raw = Deno.readTextFileSync(this.configPath);
    } catch (err) {
      console.error(`[config] Failed to read config file: ${err instanceof Error ? err.message : String(err)} — keeping previous config`);
      return this.configData as KernelConfig;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseYaml(raw) || {};
    } catch (err) {
      // Invalid YAML: reject load, keep previous config, log error (spec §14)
      console.error(`[config] Invalid YAML in ${this.configPath}: ${err instanceof Error ? err.message : String(err)} — keeping previous config`);
      return this.configData as KernelConfig;
    }

    if (this.appSchema) {
      const result = this.appSchema.safeParse(parsed);
      if (result.success) {
        this.configData = result.data as Record<string, unknown>;
      } else {
        // Best-effort: use raw parsed data, warn about validation errors per field
        this.configData = parsed;
        const errorPaths = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
        console.warn(`[config] Validation warnings: ${errorPaths}`);
      }
    } else {
      this.configData = parsed;
    }

    // Validate JSON Schema sections independently via ajv
    for (const [key, reg] of this.schemas) {
      if (!reg.ajvValidate) continue;
      const sectionData = this.configData[key] ?? {};
      const dataCopy = structuredClone(sectionData);
      const valid = reg.ajvValidate(dataCopy);
      if (valid) {
        // ajv may have applied defaults via useDefaults — store the enriched copy
        this.configData[key] = dataCopy;
      } else {
        const errors = (reg.ajvValidate.errors ?? [])
          .map(e => `${key}${e.instancePath}: ${e.message}`)
          .join("; ");
        console.warn(`[config] Validation warnings (${key}): ${errors}`);
      }
    }

    return this.configData as KernelConfig;
  }

  /**
   * Save current config data back to YAML.
   */
  save(): void {
    const yaml = stringifyYaml(this.configData, { lineWidth: 120 });
    const tmpPath = this.configPath + '.tmp';
    Deno.writeTextFileSync(tmpPath, yaml, { mode: 0o600 });
    Deno.renameSync(tmpPath, this.configPath);
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
    if (sectionSchema) {
      if (sectionSchema.ajvValidate) {
        // JSON Schema validation via ajv
        const sectionData = structuredClone(testData[sectionKey] ?? {});
        const valid = sectionSchema.ajvValidate(sectionData);
        if (!valid) {
          const firstError = sectionSchema.ajvValidate.errors?.[0];
          return {
            success: false,
            error: `Validation failed at ${sectionKey}${firstError?.instancePath ?? ""}: ${firstError?.message ?? "unknown error"}`,
          };
        }
      } else if (this.appSchema) {
        // Zod validation
        const result = this.appSchema.safeParse(testData);
        if (!result.success) {
          const issue = result.error.issues[0];
          return {
            success: false,
            error: `Validation failed at ${issue.path.join(".")}: ${issue.message}`,
          };
        }
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
    return this.doctor.diagnose();
  }

  /**
   * Auto-fix fixable issues from a diagnostic report.
   */
  fix(report: DiagnosticReport): void {
    this.doctor.fix(report);
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
