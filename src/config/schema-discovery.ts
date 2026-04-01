/** Discovers and validates config schemas from module directories. */

import { join, toFileUrl } from "jsr:@std/path@^1";
import { z } from "npm:zod@^3.24";
import type { ZodObject, ZodRawShape } from "npm:zod@^3.24";
// deno-lint-ignore-file no-explicit-any
import Ajv2020Default, { type ValidateFunction } from "npm:ajv@^8/dist/2020.js";
import addFormatsDefault from "npm:ajv-formats@^3";
import type { ModuleManifest } from "@pons/sdk";
import type { ConfigSchemaDefinition } from "@pons/sdk/config";

const FORBIDDEN_PATTERNS = [
  /\bDeno\s*\.\s*(run|Command|exec|remove|writeFile|writeTextFile|mkdir|rename|chmod|chown|kill|exit)\b/,
  /\bDeno\s*\.\s*(listen|connect|listenTls|connectTls|serve)\b/,
  /\bchild_process\b/,
  /\bimport\s*\(/,       // dynamic imports
  /\brequire\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bfetch\s*\(/,
  /\bWebSocket\b/,
];

// CJS interop: ajv exports { default: class Ajv } in Deno
const Ajv = (Ajv2020Default as any).default ?? Ajv2020Default;
const addFormats = (addFormatsDefault as any).default ?? addFormatsDefault;
const ajv = new Ajv({ useDefaults: true, allErrors: true, coerceTypes: true });
addFormats(ajv);

export interface RegisteredSchema {
  configKey: string;
  schema: ZodObject<ZodRawShape> | null;
  jsonSchema?: Record<string, unknown>;
  ajvValidate?: ValidateFunction;
  meta?: { description?: string; labels?: Record<string, string> };
  moduleId: string;
}

// Kernel built-in schema (defined here to avoid JSR slow-type export issues in types.ts)
export const kernelBuiltinSchema = z.object({
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    levels: z.record(z.enum(["trace", "debug", "info", "warn", "error", "fatal"])).default({}),
  }).default({}),
  lifecycle: z.object({
    healthIntervalMs: z.number().int().min(1000).default(30_000),
    pingTimeoutMs: z.number().int().min(1000).default(10_000),
    healthMaxFailures: z.number().int().min(1).default(3),
    readyTimeoutMs: z.number().int().min(1000).default(30_000),
    requiresTimeoutMs: z.number().int().min(1000).default(30_000),
    shutdownGraceMs: z.number().int().min(1000).default(5_000),
    maxRestarts: z.number().int().min(0).default(5),
    maxRestartBackoffMs: z.number().int().min(1000).default(60_000),
    rpcTimeoutMs: z.number().int().min(1000).default(30_000),
  }).default({}),
});

/**
 * Register kernel built-in schemas into the provided map.
 */
function registerBuiltinSchemas(schemas: Map<string, RegisteredSchema>): void {
  const builtinShape = kernelBuiltinSchema.shape;
  for (const [key, fieldSchema] of Object.entries(builtinShape)) {
    schemas.set(key, {
      configKey: key,
      schema: z.object({ [key]: fieldSchema }) as unknown as ZodObject<ZodRawShape>,
      meta: { description: `Kernel ${key} configuration` },
      moduleId: "__kernel__",
    });
  }
}

/**
 * Validate that a schema file path is safe to load:
 * - Must be within the module directory (no path traversal)
 * - Must have an allowed extension (.ts, .js, or .json)
 */
function validateSchemaPath(
  realPath: string,
  realModuleDir: string,
  moduleId: string,
): { valid: boolean; isJson: boolean } {
  if (!realPath.startsWith(realModuleDir + "/")) {
    console.warn(`[config] Schema path escapes module directory for "${moduleId}" — skipping`);
    return { valid: false, isJson: false };
  }

  const isJson = realPath.endsWith(".json");
  const isTsJs = realPath.endsWith(".ts") || realPath.endsWith(".js");
  if (!isJson && !isTsJs) {
    console.warn(`[config] Schema file must be .ts, .js, or .json for "${moduleId}" — skipping`);
    return { valid: false, isJson: false };
  }

  return { valid: true, isJson };
}

/**
 * Load a JSON Schema file, compile it with ajv, and return a RegisteredSchema.
 * The Zod `schema` field is set to null — validation uses ajvValidate instead.
 */
function loadJsonSchema(realPath: string, configKey: string, moduleId: string): RegisteredSchema {
  const jsonContent = Deno.readTextFileSync(realPath);
  const jsonSchema = JSON.parse(jsonContent) as Record<string, unknown>;
  const validate = ajv.compile(jsonSchema);

  return {
    configKey,
    schema: null,
    jsonSchema,
    ajvValidate: validate,
    meta: {
      description: (jsonSchema.description as string | undefined) ?? `Config for ${moduleId}`,
    },
    moduleId,
  };
}

/**
 * Load a TypeScript/JS schema file after static analysis security scan.
 * Returns null if the file contains forbidden patterns or has no valid schema.
 */
async function loadTsSchema(
  realPath: string,
  configKey: string,
  moduleId: string,
): Promise<RegisteredSchema | null> {
  const schemaSource = Deno.readTextFileSync(realPath);
  const hasForbidden = FORBIDDEN_PATTERNS.find((p) => p.test(schemaSource));
  if (hasForbidden) {
    console.warn(
      `[config] Schema file for "${moduleId}" contains forbidden API pattern — skipping (matched: ${hasForbidden})`,
    );
    return null;
  }

  const mod = await import(toFileUrl(realPath).href);
  const definition: ConfigSchemaDefinition = mod.default;

  if (!definition?.schema) return null;

  return {
    configKey,
    schema: z.object({ [configKey]: definition.schema }) as unknown as ZodObject<ZodRawShape>,
    meta: definition.meta
      ? {
          description: definition.meta.description,
          labels: definition.meta.labels as Record<string, string> | undefined,
        }
      : undefined,
    moduleId,
  };
}

/**
 * Discover and import config schemas from all modules.
 * Also registers kernel built-in schemas.
 *
 * Returns a map of configKey -> RegisteredSchema.
 */
export async function discoverSchemas(
  modules: Array<{ manifest: ModuleManifest; moduleDir: string }>,
): Promise<Map<string, RegisteredSchema>> {
  const schemas = new Map<string, RegisteredSchema>();

  registerBuiltinSchemas(schemas);

  for (const { manifest, moduleDir } of modules) {
    if (!manifest.configSchema || !manifest.configKey) continue;

    try {
      const schemaPath = join(moduleDir, manifest.configSchema);
      try {
        Deno.statSync(schemaPath);
      } catch {
        continue;
      }

      const realPath = Deno.realPathSync(schemaPath);
      const realModuleDir = Deno.realPathSync(moduleDir);

      const { valid, isJson } = validateSchemaPath(realPath, realModuleDir, manifest.id);
      if (!valid) continue;

      if (isJson) {
        schemas.set(manifest.configKey, loadJsonSchema(realPath, manifest.configKey, manifest.id));
      } else {
        const registered = await loadTsSchema(realPath, manifest.configKey, manifest.id);
        if (registered) {
          schemas.set(manifest.configKey, registered);
        }
      }
    } catch (err) {
      // Log warning but don't fail — module will run with raw config
      console.warn(
        `[config] Failed to load schema for module "${manifest.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return schemas;
}
