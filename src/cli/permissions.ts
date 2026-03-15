/**
 * CLI commands for managing module permissions via the kernel HTTP API.
 *
 * Talks to the running kernel's permission endpoints on 127.0.0.1
 * rather than accessing the PermissionStore directly. This ensures
 * that permission changes are immediately reflected in the kernel
 * (e.g., module restarts after grant/revoke).
 */

import { join } from "jsr:@std/path@^1";
import chalk from "npm:chalk@^5.6.2";
import { getPonsHome } from "@pons/sdk";
import {
  createTable,
  outputJson,
  printError,
  printHeader,
} from "../formatters.ts";

// deno-lint-ignore no-explicit-any
type Command = { command(name: string): any; description(desc: string): any; action(fn: any): any; option(flags: string, desc: string): any; argument?(name: string, desc: string): any };

/* ------------------------------------------------------------------ */
/*  API helper                                                         */
/* ------------------------------------------------------------------ */

async function apiCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const home = getPonsHome();
  const port = Deno.readTextFileSync(join(home, '.runtime', 'kernel.port')).trim();
  const token = Deno.readTextFileSync(join(home, '.runtime', 'kernel.token')).trim();

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/*  Type definitions for API responses                                 */
/* ------------------------------------------------------------------ */

interface ModulePermissions {
  net?: string[];
  read?: string[];
  write?: string[];
  env?: string[];
  run?: string[];
  sys?: string[];
}

interface PendingRequest {
  id: string;
  permissions: Partial<ModulePermissions>;
  reason?: string;
  requestedAt: string;
}

interface DeniedRequest {
  permissions: Partial<ModulePermissions>;
  reason?: string;
  deniedAt: string;
}

interface ModulePermissionInfo {
  effective: ModulePermissions | null;
  base?: ModulePermissions;
  pending: PendingRequest[];
  denied?: DeniedRequest[];
}

interface ListAllResponse {
  modules: Record<string, ModulePermissionInfo>;
}

interface ListModuleResponse {
  moduleId: string;
  effective: ModulePermissions | null;
  pending: PendingRequest[];
}

/* ------------------------------------------------------------------ */
/*  Display helpers                                                    */
/* ------------------------------------------------------------------ */

function formatPermissionValues(perms: Partial<ModulePermissions>): string {
  const parts: string[] = [];
  const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];
  for (const field of fields) {
    const values = perms[field];
    if (values && values.length > 0) {
      parts.push(`${chalk.cyan(field)}: ${values.join(', ')}`);
    }
  }
  return parts.length > 0 ? parts.join('  ') : chalk.dim('\u2014');
}

function displayModulePermissions(moduleId: string, info: ModulePermissionInfo): void {
  printHeader(`Permissions: ${moduleId}`);

  // Base permissions
  if (info.base) {
    const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];
    const hasBase = fields.some(f => info.base![f] && info.base![f]!.length > 0);
    if (hasBase) {
      console.log(chalk.bold('  Base permissions:'));
      const table = createTable(['Type', 'Values']);
      for (const field of fields) {
        const values = info.base[field];
        if (values && values.length > 0) {
          table.push([field, values.join(', ')]);
        }
      }
      console.log(table.toString());
    } else {
      console.log(chalk.dim('  No base permissions.'));
    }
  }

  // Effective permissions (base + dynamic merged)
  if (info.effective) {
    const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];
    const hasEffective = fields.some(f => info.effective![f] && info.effective![f]!.length > 0);
    if (hasEffective) {
      console.log();
      console.log(chalk.bold('  Effective permissions (base + dynamic):'));
      const table = createTable(['Type', 'Values']);
      for (const field of fields) {
        const values = info.effective[field];
        if (values && values.length > 0) {
          table.push([field, values.join(', ')]);
        }
      }
      console.log(table.toString());
    }
  }

  // Pending requests
  if (info.pending && info.pending.length > 0) {
    console.log();
    console.log(chalk.bold.yellow(`  Pending requests (${info.pending.length}):`));
    const table = createTable(['ID', 'Permissions', 'Reason', 'Requested']);
    for (const req of info.pending) {
      table.push([
        req.id.slice(0, 8),
        formatPermissionValues(req.permissions),
        req.reason ?? chalk.dim('\u2014'),
        req.requestedAt.split('T')[0],
      ]);
    }
    console.log(table.toString());
  }

  // Denied entries
  if (info.denied && info.denied.length > 0) {
    console.log();
    console.log(chalk.bold.red(`  Denied (${info.denied.length}):`));
    const table = createTable(['Permissions', 'Reason', 'Denied']);
    for (const d of info.denied) {
      table.push([
        formatPermissionValues(d.permissions),
        d.reason ?? chalk.dim('\u2014'),
        d.deniedAt.split('T')[0],
      ]);
    }
    console.log(table.toString());
  }

  console.log();
}

/* ------------------------------------------------------------------ */
/*  Command registration                                               */
/* ------------------------------------------------------------------ */

export function registerPermissionsCommand(program: Command): void {
  const permissions = program
    .command("permissions")
    .description("Manage module permissions");

  /* ---- permissions list [module] ---- */
  permissions
    .command("list [module]")
    .description("List permissions for a module or all modules")
    .option("--json", "Output as JSON")
    .action(async (moduleName: string | undefined, opts: { json?: boolean }) => {
      const json = opts.json ?? false;

      try {
        if (moduleName) {
          const data = await apiCall('GET', `/api/permissions/list?moduleId=${encodeURIComponent(moduleName)}`) as ListModuleResponse;

          if (json) {
            outputJson(data);
            return;
          }

          displayModulePermissions(data.moduleId, {
            effective: data.effective,
            pending: data.pending,
          });
        } else {
          const data = await apiCall('GET', '/api/permissions/list') as ListAllResponse;

          if (json) {
            outputJson(data);
            return;
          }

          const moduleIds = Object.keys(data.modules);
          if (moduleIds.length === 0) {
            console.log(chalk.dim('  No module permissions configured.'));
            console.log();
            return;
          }

          printHeader(`Module Permissions (${moduleIds.length})`);
          const table = createTable(['Module', 'Net', 'Read', 'Write', 'Env', 'Run', 'Sys', 'Pending']);
          for (const [id, info] of Object.entries(data.modules)) {
            const eff = info.effective ?? {};
            table.push([
              id,
              (eff.net ?? []).join(', ') || chalk.dim('\u2014'),
              (eff.read ?? []).join(', ') || chalk.dim('\u2014'),
              (eff.write ?? []).join(', ') || chalk.dim('\u2014'),
              (eff.env ?? []).join(', ') || chalk.dim('\u2014'),
              (eff.run ?? []).join(', ') || chalk.dim('\u2014'),
              (eff.sys ?? []).join(', ') || chalk.dim('\u2014'),
              info.pending.length > 0 ? chalk.yellow(String(info.pending.length)) : chalk.dim('0'),
            ]);
          }
          console.log(table.toString());
          console.log();
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        Deno.exitCode = 1;
      }
    });

  /* ---- permissions pending ---- */
  permissions
    .command("pending")
    .description("Show modules with pending permission requests")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const json = opts.json ?? false;

      try {
        const data = await apiCall('GET', '/api/permissions/list') as ListAllResponse;

        // Filter to only modules with pending requests
        const pending: Record<string, { pending: PendingRequest[] }> = {};
        for (const [id, info] of Object.entries(data.modules)) {
          if (info.pending && info.pending.length > 0) {
            pending[id] = { pending: info.pending };
          }
        }

        if (json) {
          outputJson({ modules: pending });
          return;
        }

        const moduleIds = Object.keys(pending);
        if (moduleIds.length === 0) {
          console.log(chalk.dim('  No pending permission requests.'));
          console.log();
          return;
        }

        printHeader(`Pending Permission Requests`);
        for (const [id, info] of Object.entries(pending)) {
          console.log(chalk.bold(`  ${id}`) + chalk.dim(` (${info.pending.length} pending)`));
          const table = createTable(['ID', 'Permissions', 'Reason', 'Requested']);
          for (const req of info.pending) {
            table.push([
              req.id.slice(0, 8),
              formatPermissionValues(req.permissions),
              req.reason ?? chalk.dim('\u2014'),
              req.requestedAt.split('T')[0],
            ]);
          }
          console.log(table.toString());
        }
        console.log();
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        Deno.exitCode = 1;
      }
    });

  /* ---- permissions grant <module> [request-id] ---- */
  permissions
    .command("grant <module> [request-id]")
    .description("Grant pending permission request(s) for a module")
    .option("--json", "Output as JSON")
    .action(async (moduleName: string, requestId: string | undefined, opts: { json?: boolean }) => {
      const json = opts.json ?? false;

      try {
        if (requestId) {
          // Grant a specific request
          const result = await apiCall('POST', '/api/permissions/resolve', {
            moduleId: moduleName,
            requestId,
            decision: 'grant',
          });

          if (json) {
            outputJson(result);
          } else {
            console.log(chalk.green(`  Granted request ${requestId.slice(0, 8)} for ${moduleName}.`));
          }
        } else {
          // Grant all pending requests for this module
          const data = await apiCall('GET', `/api/permissions/list?moduleId=${encodeURIComponent(moduleName)}`) as ListModuleResponse;

          if (!data.pending || data.pending.length === 0) {
            if (json) {
              outputJson({ module: moduleName, granted: 0 });
            } else {
              console.log(chalk.dim(`  No pending requests for ${moduleName}.`));
            }
            return;
          }

          let granted = 0;
          const results: unknown[] = [];
          for (const req of data.pending) {
            const result = await apiCall('POST', '/api/permissions/resolve', {
              moduleId: moduleName,
              requestId: req.id,
              decision: 'grant',
            });
            results.push(result);
            granted++;
          }

          if (json) {
            outputJson({ module: moduleName, granted, results });
          } else {
            console.log(chalk.green(`  Granted ${granted} pending request(s) for ${moduleName}.`));
          }
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        Deno.exitCode = 1;
      }
    });

  /* ---- permissions deny <module> [request-id] ---- */
  permissions
    .command("deny <module> [request-id]")
    .description("Deny pending permission request(s) for a module")
    .option("--json", "Output as JSON")
    .action(async (moduleName: string, requestId: string | undefined, opts: { json?: boolean }) => {
      const json = opts.json ?? false;

      try {
        if (requestId) {
          // Deny a specific request
          const result = await apiCall('POST', '/api/permissions/resolve', {
            moduleId: moduleName,
            requestId,
            decision: 'deny',
          });

          if (json) {
            outputJson(result);
          } else {
            console.log(chalk.yellow(`  Denied request ${requestId.slice(0, 8)} for ${moduleName}.`));
          }
        } else {
          // Deny all pending requests for this module
          const data = await apiCall('GET', `/api/permissions/list?moduleId=${encodeURIComponent(moduleName)}`) as ListModuleResponse;

          if (!data.pending || data.pending.length === 0) {
            if (json) {
              outputJson({ module: moduleName, denied: 0 });
            } else {
              console.log(chalk.dim(`  No pending requests for ${moduleName}.`));
            }
            return;
          }

          let denied = 0;
          const results: unknown[] = [];
          for (const req of data.pending) {
            const result = await apiCall('POST', '/api/permissions/resolve', {
              moduleId: moduleName,
              requestId: req.id,
              decision: 'deny',
            });
            results.push(result);
            denied++;
          }

          if (json) {
            outputJson({ module: moduleName, denied, results });
          } else {
            console.log(chalk.yellow(`  Denied ${denied} pending request(s) for ${moduleName}.`));
          }
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        Deno.exitCode = 1;
      }
    });

  /* ---- permissions revoke <module> ---- */
  permissions
    .command("revoke <module>")
    .description("Revoke permissions for a module")
    .option("--type <type>", "Permission type to revoke (net, read, write, env, run, sys)")
    .option("--value <value>", "Specific permission value to revoke")
    .option("--json", "Output as JSON")
    .action(async (moduleName: string, opts: { type?: string; value?: string; json?: boolean }) => {
      const json = opts.json ?? false;

      try {
        const body: Record<string, unknown> = { moduleId: moduleName };

        if (opts.type) {
          body.permissionType = opts.type;
          if (opts.value) {
            body.value = opts.value;
          }
        }

        const result = await apiCall('POST', '/api/permissions/revoke', body);

        if (json) {
          outputJson(result);
        } else {
          const desc = opts.type
            ? (opts.value ? `${opts.type}:${opts.value}` : opts.type)
            : 'all permissions';
          console.log(`  Revoked ${chalk.yellow(desc)} for ${chalk.green(moduleName)}.`);
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        Deno.exitCode = 1;
      }
    });
}
