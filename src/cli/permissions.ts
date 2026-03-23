/**
 * CLI commands for managing module permissions via direct file access.
 *
 * Reads/writes the PermissionStore directly and sends SIGUSR2 to the
 * running kernel to trigger permission reload.
 */

import { join } from "jsr:@std/path@^1";
import chalk from "npm:chalk@^5.6.2";
import { getPonsHome } from "@pons/sdk";
import {
  PermissionStore,
} from "../security/permissions.ts";
import type {
  ModulePermissions,
  PendingRequest,
  DeniedRequest,
} from "../security/permissions.ts";
import { PERMISSION_FIELDS } from "../security/constants.ts";
import {
  createTable,
  outputJson,
  printError,
  printHeader,
} from "../formatters.ts";

// deno-lint-ignore no-explicit-any
type Command = { command(name: string): any; description(desc: string): any; action(fn: any): any; option(flags: string, desc: string): any; argument?(name: string, desc: string): any };

/* ------------------------------------------------------------------ */
/*  Signal helper                                                      */
/* ------------------------------------------------------------------ */

function sendKernelSignal(home: string, signal: Deno.Signal): boolean {
  try {
    const pidFile = join(home, '.runtime', 'kernel.pid');
    const pid = parseInt(Deno.readTextFileSync(pidFile).trim());
    Deno.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Display helpers                                                    */
/* ------------------------------------------------------------------ */

function formatPermissionValues(perms: Partial<ModulePermissions>): string {
  const parts: string[] = [];
  const fields = PERMISSION_FIELDS;
  for (const field of fields) {
    const values = perms[field];
    if (values && values.length > 0) {
      parts.push(`${chalk.cyan(field)}: ${values.join(', ')}`);
    }
  }
  return parts.length > 0 ? parts.join('  ') : chalk.dim('\u2014');
}

interface ModulePermissionInfo {
  effective: ModulePermissions | null;
  base?: ModulePermissions;
  pending: PendingRequest[];
  denied?: DeniedRequest[];
}

function displayModulePermissions(moduleId: string, info: ModulePermissionInfo): void {
  printHeader(`Permissions: ${moduleId}`);

  // Base permissions
  if (info.base) {
    const fields = PERMISSION_FIELDS;
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
    const fields = PERMISSION_FIELDS;
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
    .action((moduleName: string | undefined, opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      const home = getPonsHome();

      try {
        const store = new PermissionStore(home);

        if (moduleName) {
          const effective = store.getEffectivePermissions(moduleName);
          const pendingMap = store.getPendingRequests(moduleName);
          const pending = pendingMap[moduleName] ?? [];

          if (json) {
            outputJson({ moduleId: moduleName, effective, pending });
            return;
          }

          const approved = store.getApproved(moduleName);
          displayModulePermissions(moduleName, {
            effective,
            base: approved?.permissions,
            pending,
          });
        } else {
          const all = store.listAll();
          const allPending = store.getPendingRequests();

          const moduleIds = Object.keys(all);
          if (moduleIds.length === 0) {
            if (json) {
              outputJson({ modules: {} });
            } else {
              console.log(chalk.dim('  No module permissions configured.'));
              console.log();
            }
            return;
          }

          const modules: Record<string, unknown> = {};
          for (const id of moduleIds) {
            modules[id] = {
              effective: store.getEffectivePermissions(id),
              base: all[id].permissions,
              pending: allPending[id] ?? [],
            };
          }

          if (json) {
            outputJson({ modules });
            return;
          }

          printHeader(`Module Permissions (${moduleIds.length})`);
          const table = createTable(['Module', 'Net', 'Read', 'Write', 'Env', 'Run', 'Sys', 'Pending']);
          for (const [id, info] of Object.entries(modules) as [string, { effective: ModulePermissions | null; pending: PendingRequest[] }][]) {
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
    .action((opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      const home = getPonsHome();

      try {
        const store = new PermissionStore(home);
        const allPending = store.getPendingRequests();

        if (json) {
          outputJson({ modules: allPending });
          return;
        }

        const moduleIds = Object.keys(allPending);
        if (moduleIds.length === 0) {
          console.log(chalk.dim('  No pending permission requests.'));
          console.log();
          return;
        }

        printHeader(`Pending Permission Requests`);
        for (const [id, pending] of Object.entries(allPending)) {
          console.log(chalk.bold(`  ${id}`) + chalk.dim(` (${pending.length} pending)`));
          const table = createTable(['ID', 'Permissions', 'Reason', 'Requested']);
          for (const req of pending) {
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
    .action((moduleName: string, requestId: string | undefined, opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      const home = getPonsHome();

      try {
        const store = new PermissionStore(home);

        if (requestId) {
          // Grant a specific request
          const resolved = store.resolvePending(moduleName, requestId, 'grant');
          if (!resolved) {
            printError(`Pending request not found: ${requestId}`);
            Deno.exitCode = 1;
            return;
          }

          sendKernelSignal(home, 'SIGUSR2');

          if (json) {
            outputJson({ ok: true, decision: 'grant' });
          } else {
            console.log(chalk.green(`  Granted request ${requestId.slice(0, 8)} for ${moduleName}.`));
          }
        } else {
          // Grant all pending requests for this module
          const pendingMap = store.getPendingRequests(moduleName);
          const pending = pendingMap[moduleName] ?? [];

          if (pending.length === 0) {
            if (json) {
              outputJson({ module: moduleName, granted: 0 });
            } else {
              console.log(chalk.dim(`  No pending requests for ${moduleName}.`));
            }
            return;
          }

          let granted = 0;
          for (const req of pending) {
            if (store.resolvePending(moduleName, req.id, 'grant')) {
              granted++;
            }
          }

          sendKernelSignal(home, 'SIGUSR2');

          if (json) {
            outputJson({ module: moduleName, granted });
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
    .action((moduleName: string, requestId: string | undefined, opts: { json?: boolean }) => {
      const json = opts.json ?? false;
      const home = getPonsHome();

      try {
        const store = new PermissionStore(home);

        if (requestId) {
          // Deny a specific request
          const resolved = store.resolvePending(moduleName, requestId, 'deny');
          if (!resolved) {
            printError(`Pending request not found: ${requestId}`);
            Deno.exitCode = 1;
            return;
          }

          sendKernelSignal(home, 'SIGUSR2');

          if (json) {
            outputJson({ ok: true, decision: 'deny' });
          } else {
            console.log(chalk.yellow(`  Denied request ${requestId.slice(0, 8)} for ${moduleName}.`));
          }
        } else {
          // Deny all pending requests for this module
          const pendingMap = store.getPendingRequests(moduleName);
          const pending = pendingMap[moduleName] ?? [];

          if (pending.length === 0) {
            if (json) {
              outputJson({ module: moduleName, denied: 0 });
            } else {
              console.log(chalk.dim(`  No pending requests for ${moduleName}.`));
            }
            return;
          }

          let denied = 0;
          for (const req of pending) {
            if (store.resolvePending(moduleName, req.id, 'deny')) {
              denied++;
            }
          }

          sendKernelSignal(home, 'SIGUSR2');

          if (json) {
            outputJson({ module: moduleName, denied });
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
    .action((moduleName: string, opts: { type?: string; value?: string; json?: boolean }) => {
      const json = opts.json ?? false;
      const home = getPonsHome();

      try {
        const store = new PermissionStore(home);
        const revoked = store.revoke(moduleName, opts.type, opts.value);

        if (!revoked) {
          printError(`Module "${moduleName}" not found in permission store.`);
          Deno.exitCode = 1;
          return;
        }

        sendKernelSignal(home, 'SIGUSR2');

        if (json) {
          outputJson({ ok: true });
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
