/** CLI commands for module management (list, install, approve, uninstall, update). */

import { join } from "jsr:@std/path@^1";
import chalk from "npm:chalk@^5.6.2";
import ora from "npm:ora@^8.2.0";
import { getPonsHome } from "@pons/sdk";
import { existsSync } from "../utils/fs.ts";
import type { ModuleManifest } from "@pons/sdk";
import {
  createTable,
  outputJson,
  printError,
  printHeader,
  printWarning,
} from "../formatters.ts";
import {
  detectInstallSource,
  displayAndApprovePermissions,
  getInstalledModules,
  installModule,
  updateModuleFromJsr,
} from "../modules/installer.ts";
import { PermissionStore, computeManifestHash, modulePermissionsSchema } from "../security/permissions.ts";
import { readPid, isProcessRunning } from "./kernel-commands.ts";

// deno-lint-ignore no-explicit-any
type Command = { command(name: string): any; description(desc: string): any; action(fn: any): any; option(flags: string, desc: string): any };

/* ------------------------------------------------------------------ */
/*  Post-update re-approval                                           */
/* ------------------------------------------------------------------ */

/**
 * After a module update, check if the manifest hash changed and re-approve.
 * Shows the updated permissions to the user for consent.
 */
async function reapproveAfterUpdate(moduleId: string, moduleDir: string, home: string): Promise<void> {
  const manifestPath = join(moduleDir, "module.json");
  if (!existsSync(manifestPath)) return;

  let manifest: ModuleManifest;
  try {
    manifest = JSON.parse(Deno.readTextFileSync(manifestPath)) as ModuleManifest;
  } catch {
    return;
  }

  const store = new PermissionStore(home);
  const storedHash = store.getManifestHash(manifest.id ?? moduleId);
  const currentHash = computeManifestHash(manifestPath);

  if (storedHash === currentHash) return; // No manifest change

  console.log(chalk.yellow(`\n  Module manifest changed — re-approval required.`));
  const approved = await displayAndApprovePermissions(manifest, manifestPath, store);
  if (!approved) {
    console.log(chalk.yellow('  Permissions not approved — module may fail to load.'));
  }
}

/* ------------------------------------------------------------------ */
/*  Command registration                                              */
/* ------------------------------------------------------------------ */

/** Send a command to the running kernel via Unix socket and return the response. */
async function controlRequest(home: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sockPath = join(home, "run", "kernel.sock");
  const conn = await Deno.connect({ transport: "unix", path: sockPath });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  try {
    await conn.write(encoder.encode(JSON.stringify(command) + "\n"));

    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    if (n === null) throw new Error("No response from kernel");

    return JSON.parse(decoder.decode(buf.subarray(0, n)).trim());
  } finally {
    conn.close();
  }
}

export function registerModuleCommands(program: Command): void {
  const modules = program
    .command("modules")
    .description("Manage installed modules");

  /* ---- modules restart <module> ---- */
  modules
    .command("restart <module>")
    .description("Restart a running module via the kernel control socket")
    .option("--home <path>", "Override PONS_HOME directory")
    .action(async (moduleName: string, opts: { home?: string }) => {
      const home = opts.home || getPonsHome();

      // Verify kernel is running
      const pid = readPid(home);
      if (pid === null || !isProcessRunning(pid)) {
        printError("Kernel is not running. Start it first with `pons kernel start`.");
        Deno.exitCode = 1;
        return;
      }

      const spinner = ora(`Restarting module "${moduleName}"...`).start();

      try {
        const result = await controlRequest(home, { cmd: "module.restart", moduleId: moduleName });

        if (result.ok) {
          spinner.succeed(`Module ${chalk.green(moduleName)} restarted successfully.`);
        } else {
          spinner.fail(`Failed to restart "${moduleName}": ${result.error ?? "unknown error"}`);
          Deno.exitCode = 1;
        }
      } catch (err) {
        spinner.fail(`Could not connect to kernel control socket.`);
        printError(err instanceof Error ? err.message : String(err));
        Deno.exitCode = 1;
      }
    });

  /* ---- modules list ---- */
  modules
    .command("list")
    .description("List installed modules")
    .option("--home <path>", "Override PONS_HOME directory")
    .option("--json", "Output as JSON")
    .action(async (opts: { home?: string; json?: boolean }) => {
      const json = opts.json ?? false;
      const home = opts.home || getPonsHome();
      const modulesDir = join(home, "modules");

      if (!existsSync(modulesDir)) {
        if (json) {
          outputJson({ modules: [] });
        } else {
          console.log(
            chalk.dim(
              "  No modules installed. Run `npx @pons/cli onboard` first.",
            ),
          );
          console.log();
        }
        return;
      }

      const store = new PermissionStore(home);

      const moduleList: Array<{
        id: string;
        version: string;
        provides: string[];
        requires: string[];
        linked: boolean;
        approved: boolean;
        manifestOk: boolean;
        permsValid: boolean;
        hasCaps: boolean;
      }> = [];

      for (const entry of Deno.readDirSync(modulesDir)) {
        const modDir = join(modulesDir, entry.name);
        const stat = Deno.lstatSync(modDir);
        if (!stat.isDirectory && !stat.isSymlink) continue;
        const manifestPath = join(modDir, "module.json");
        if (!existsSync(manifestPath)) continue;

        try {
          const manifest: ModuleManifest = JSON.parse(
            Deno.readTextFileSync(manifestPath),
          );
          const linked = stat.isSymlink;

          // Resolve version from deno.json
          let version = manifest.version;
          if (!version) {
            const denoJsonPath = join(modDir, "deno.json");
            if (existsSync(denoJsonPath)) {
              try {
                const denoJson = JSON.parse(Deno.readTextFileSync(denoJsonPath));
                version = denoJson.version;
              } catch { /* ignore */ }
            }
          }

          // Check approval status
          const approved = store.isApproved(manifest.id);

          // Check manifest hash
          let manifestOk = false;
          if (approved) {
            const storedHash = store.getManifestHash(manifest.id);
            const currentHash = computeManifestHash(manifestPath);
            manifestOk = storedHash === currentHash;
          }

          // Validate permissions block
          let permsValid = false;
          if (manifest.permissions) {
            try {
              modulePermissionsSchema.parse(manifest.permissions);
              permsValid = true;
            } catch { /* invalid */ }
          }

          // Check if capabilities are stored
          const caps = store.getApprovedCapabilities(manifest.id);
          const hasCaps = !!caps && ((caps.topics?.length ?? 0) > 0 || (caps.services?.length ?? 0) > 0);

          moduleList.push({
            id: manifest.id,
            version: version ?? "0.0.0",
            provides: manifest.provides ?? [],
            requires: manifest.requires ?? [],
            linked,
            approved,
            manifestOk,
            permsValid,
            hasCaps,
          });
        } catch {
          // Skip malformed manifests
        }
      }

      moduleList.sort((a, b) => a.id.localeCompare(b.id));

      if (json) {
        outputJson({ modules: moduleList });
        return;
      }

      printHeader(`Installed Modules (${moduleList.length})`);

      const ok = chalk.green("\u2713");
      const fail = chalk.red("\u2717");
      const table = createTable(["Module", "Version", "Provides", "Type", "Approved", "Manifest", "Perms", "Caps"]);
      for (const mod of moduleList) {
        table.push([
          mod.id,
          mod.version,
          mod.provides.join(", ") || chalk.dim("\u2014"),
          mod.linked ? chalk.yellow("linked") : "installed",
          mod.approved ? ok : fail,
          mod.approved ? (mod.manifestOk ? ok : chalk.red("tampered")) : chalk.dim("\u2014"),
          mod.permsValid ? ok : fail,
          mod.hasCaps ? ok : chalk.yellow("empty"),
        ]);
      }
      console.log(table.toString());
      console.log();
    });

  /* ---- modules install-dir <path> ---- */
  modules
    .command("install-dir <path>")
    .description("Install a module from a local directory (symlink + approve + spawn)")
    .option("--home <path>", "Override PONS_HOME directory")
    .option("--no-symlink", "Skip symlinking into ~/.kiria/modules/")
    .option("--json", "Output as JSON")
    .action(async (dirPath: string, opts: { home?: string; symlink?: boolean; json?: boolean }) => {
      const json = opts.json ?? false;
      const home = opts.home || getPonsHome();

      // Verify kernel is running
      const pid = readPid(home);
      if (pid === null || !isProcessRunning(pid)) {
        if (json) {
          outputJson({ installed: false, error: "kernel not running" });
        } else {
          printError("Kernel is not running. Start it first with `pons kernel start`.");
        }
        Deno.exitCode = 1;
        return;
      }

      const spinner = ora(`Installing module from "${dirPath}"...`).start();

      try {
        const result = await controlRequest(home, {
          cmd: "module.install",
          moduleDir: dirPath,
          symlink: opts.symlink !== false,
        });

        if (result.ok) {
          const data = result.data as { moduleId: string; manifestHash: string } | undefined;
          spinner.succeed(`Module ${chalk.green(data?.moduleId ?? dirPath)} installed and approved.`);
          if (json) {
            outputJson({ installed: true, ...data });
          }
        } else {
          spinner.fail(`Failed to install: ${result.error ?? "unknown error"}`);
          if (json) {
            outputJson({ installed: false, error: result.error });
          }
          Deno.exitCode = 1;
        }
      } catch (err) {
        spinner.fail("Could not connect to kernel control socket.");
        printError(err instanceof Error ? err.message : String(err));
        if (json) {
          outputJson({ installed: false, error: String(err) });
        }
        Deno.exitCode = 1;
      }
    });

  /* ---- modules install <module> ---- */
  modules
    .command("install <module>")
    .description("Install a module from npm, git URL, or local path")
    .option("--home <path>", "Override PONS_HOME directory")
    .option("--json", "Output as JSON")
    .option("-y, --yes", "Auto-approve permissions")
    .action(async (moduleName: string, opts: { home?: string; json?: boolean; yes?: boolean }) => {
      const json = opts.json ?? false;

      const success = await installModule(moduleName, opts.home, opts.yes);

      // Notify running kernel to discover and spawn the new module
      if (success) {
        const home = opts.home || getPonsHome();
        const pid = readPid(home);
        if (pid !== null && isProcessRunning(pid)) {
          try { Deno.kill(pid, "SIGHUP"); } catch { /* kernel may be gone */ }
        }
      }

      if (json) {
        outputJson({ module: moduleName, installed: success });
      }

      if (!success) {
        Deno.exitCode = 1;
      }
    });

  /* ---- modules approve <module> ---- */
  modules
    .command("approve <module>")
    .description("Approve permissions for a module that was added without install")
    .option("--home <path>", "Override PONS_HOME directory")
    .option("-y, --yes", "Auto-approve permissions")
    .action(async (moduleName: string, opts: { home?: string; yes?: boolean }) => {
      const home = opts.home || getPonsHome();
      const modulesDir = join(home, "modules");
      const moduleDir = join(modulesDir, moduleName);

      if (!existsSync(moduleDir)) {
        printError(`Module "${moduleName}" not found in ${modulesDir}`);
        Deno.exitCode = 1;
        return;
      }

      const manifestPath = join(moduleDir, "module.json");
      if (!existsSync(manifestPath)) {
        printError(`No module.json found in ${moduleDir}`);
        Deno.exitCode = 1;
        return;
      }

      let manifest: ModuleManifest;
      try {
        manifest = JSON.parse(Deno.readTextFileSync(manifestPath)) as ModuleManifest;
      } catch {
        printError(`Failed to parse module.json at ${manifestPath}`);
        Deno.exitCode = 1;
        return;
      }

      const store = new PermissionStore(home);

      if (store.isApproved(manifest.id)) {
        const storedHash = store.getManifestHash(manifest.id);
        const currentHash = computeManifestHash(manifestPath);
        if (storedHash === currentHash) {
          console.log(chalk.dim(`Module "${manifest.id}" is already approved and up to date.`));
          return;
        }
        console.log(chalk.yellow(`  Module "${manifest.id}" manifest has changed since last approval — re-approval required.`));
      }

      const approved = await displayAndApprovePermissions(manifest, manifestPath, store, opts.yes);

      if (!approved) {
        console.log(chalk.yellow("  Approval cancelled."));
        Deno.exitCode = 1;
        return;
      }

      console.log(chalk.green(`  Module "${manifest.id}" approved.`));

      // Notify running kernel to discover and spawn the module
      const pid = readPid(home);
      if (pid !== null && isProcessRunning(pid)) {
        try { Deno.kill(pid, "SIGHUP"); } catch { /* kernel may be gone */ }
        console.log(chalk.dim("  Kernel notified — module will be spawned."));
      }
    });

  /* ---- modules uninstall <module> ---- */
  modules
    .command("uninstall <module>")
    .description("Uninstall an installed module")
    .option("--home <path>", "Override PONS_HOME directory")
    .option("--json", "Output as JSON")
    .action(async (moduleName: string, opts: { home?: string; json?: boolean }) => {
      const json = opts.json ?? false;
      const home = opts.home || getPonsHome();
      const modulesDir = join(home, "modules");
      const moduleDir = join(modulesDir, moduleName);

      if (!existsSync(moduleDir)) {
        if (json) {
          outputJson({
            module: moduleName,
            uninstalled: false,
            error: "not installed",
          });
        } else {
          printError(`Module "${moduleName}" is not installed.`);
        }
        Deno.exitCode = 1;
        return;
      }

      // Read manifest to check dependents
      const manifestPath = join(moduleDir, "module.json");
      let manifest: ModuleManifest | null = null;
      if (existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(
            Deno.readTextFileSync(manifestPath),
          ) as ModuleManifest;
        } catch {
          // Proceed without manifest data
        }
      }

      // Check if other installed modules require services this one provides
      if (manifest?.provides && manifest.provides.length > 0) {
        const installed = getInstalledModules(modulesDir);
        const dependents = installed.filter(
          (m) =>
            m.id !== (manifest!.id) &&
            m.requires?.some((svc: string) => manifest!.provides!.includes(svc)),
        );

        if (dependents.length > 0) {
          const names = dependents.map((d) => d.id).join(", ");
          printWarning(
            `The following modules require services provided by "${moduleName}": ${names}`,
          );
        }
      }

      const spinner = ora(`Removing module "${moduleName}"...`).start();

      try {
        Deno.removeSync(moduleDir, { recursive: true });

        // Security: revoke permissions on uninstall
        const store = new PermissionStore(home);
        const moduleId = manifest?.id ?? moduleName;
        store.revoke(moduleId);

        // Signal kernel to reload permissions if running
        const pid = readPid(home);
        if (pid !== null && isProcessRunning(pid)) {
          try { Deno.kill(pid, "SIGUSR2"); } catch { /* kernel may be gone */ }
        }

        spinner.succeed(`Uninstalled ${chalk.green(moduleName)}`);

        if (json) {
          outputJson({ module: moduleName, uninstalled: true });
        }
      } catch (error) {
        spinner.fail(`Failed to uninstall "${moduleName}"`);
        printError(error instanceof Error ? error.message : String(error));
        if (json) {
          outputJson({
            module: moduleName,
            uninstalled: false,
            error: String(error),
          });
        }
        Deno.exitCode = 1;
      }
    });

  /* ---- modules update [module] ---- */
  modules
    .command("update [module]")
    .description("Update installed module(s)")
    .option("--all", "Update all installed modules")
    .option("--home <path>", "Override PONS_HOME directory")
    .option("--json", "Output as JSON")
    .action(async (moduleName: string | undefined, opts: { all?: boolean; home?: string; json?: boolean }) => {
      const json = opts.json ?? false;
      const home = opts.home || getPonsHome();
      const modulesDir = join(home, "modules");

      if (!existsSync(modulesDir)) {
        if (json) {
          outputJson({ updated: [], error: "no modules directory" });
        } else {
          printError("No modules directory found. Nothing to update.");
        }
        Deno.exitCode = 1;
        return;
      }

      let moduleIds: string[] = [];

      if (opts.all) {
        // Update all installed modules
        const installed = getInstalledModules(modulesDir);
        moduleIds = installed.map((m) => m.id);
      } else if (moduleName) {
        moduleIds = [moduleName];
      } else {
        if (json) {
          outputJson({
            updated: [],
            error: "specify a module name or use --all",
          });
        } else {
          printError(
            "Specify a module name or use --all to update all modules.",
          );
        }
        Deno.exitCode = 1;
        return;
      }

      if (moduleIds.length === 0) {
        if (json) {
          outputJson({ updated: [] });
        } else {
          console.log(chalk.dim("  No modules installed to update."));
          console.log();
        }
        return;
      }

      const results: Array<{ id: string; updated: boolean; error?: string }> = [];

      for (const id of moduleIds) {
        const moduleDir = join(modulesDir, id);

        if (!existsSync(moduleDir)) {
          printError(`Module "${id}" is not installed.`);
          results.push({ id, updated: false, error: "not installed" });
          continue;
        }

        // Skip symlinked (local) modules -- they are managed by the developer
        try {
          const stat = Deno.statSync(moduleDir);
          if (!stat) {
            results.push({ id, updated: false, error: "not found" });
            continue;
          }
        } catch {
          // Continue with update attempt
        }

        const source = detectInstallSource(moduleDir);

        if (source === "symlink") {
          const spinner = ora(`Skipping "${id}"...`).start();
          spinner.warn(
            `Skipping "${id}" — locally linked module (managed by developer)`,
          );
          results.push({ id, updated: false, error: "symlinked" });
          continue;
        }

        if (source === "jsr") {
          const result = await updateModuleFromJsr(id, moduleDir);
          if (result.updated) {
            await reapproveAfterUpdate(id, moduleDir, home);
          }
          results.push({ id, ...result });
          continue;
        }

        // Git-cloned module
        const spinner = ora(`Updating "${id}" from git...`).start();

        try {
          const gitCmd = new Deno.Command("git", {
            args: ["pull"],
            cwd: moduleDir,
            stdout: "piped",
            stderr: "piped",
          });
          const gitResult = await gitCmd.output();
          if (!gitResult.success) {
            throw new Error(new TextDecoder().decode(gitResult.stderr));
          }

          spinner.succeed(`Updated ${chalk.green(id)}`);
          await reapproveAfterUpdate(id, moduleDir, home);
          results.push({ id, updated: true });
        } catch (error) {
          spinner.fail(`Failed to update "${id}"`);
          printError(error instanceof Error ? error.message : String(error));
          results.push({ id, updated: false, error: String(error) });
        }
      }

      if (json) {
        outputJson({ updated: results });
      } else {
        const successCount = results.filter((r) => r.updated).length;
        if (successCount > 0) {
          console.log();
          console.log(
            chalk.yellow("  Restart the gateway for changes to take effect."),
          );
          console.log(chalk.dim("    pons gateway restart"));
          console.log();
        }
      }
    });
}
