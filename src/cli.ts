/**
 * Kernel CLI extensions.
 *
 * Registers kernel lifecycle commands (start, stop, restart, status)
 * into the CLI program. Manages the kernel process via PID file and
 * communicates with the running gateway via its HTTP API.
 */

import { join } from "jsr:@std/path";
import chalk from "npm:chalk@^5.6.2";
import ora from "npm:ora@^8.2.0";
import { getPonsHome } from "jsr:@pons/sdk@^0.2";
import type { ModuleManifest } from "jsr:@pons/sdk@^0.2";
import {
  createTable,
  outputJson,
  printError,
  printHeader,
  printWarning,
} from "./formatters.ts";
import {
  detectInstallSource,
  displayAndApprovePermissions,
  getInstalledModules,
  installModule,
  updateModuleFromJsr,
} from "./modules/installer.ts";
import { initConfigCommands } from "./config/cli.ts";
import { PermissionStore } from './security/permissions.ts';

// deno-lint-ignore no-explicit-any
type Command = { command(name: string): any; description(desc: string): any; action(fn: any): any; option(flags: string, desc: string): any };

/* ------------------------------------------------------------------ */
/*  PID helpers                                                       */
/* ------------------------------------------------------------------ */

function runtimeDir(home: string): string {
  return join(home, ".runtime");
}

function pidPath(home: string): string {
  return join(runtimeDir(home), "kernel.pid");
}

function existsSync(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function readPid(home: string): number | null {
  const p = pidPath(home);
  if (!existsSync(p)) return null;
  const raw = Deno.readTextFileSync(p).trim();
  const pid = parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
}

function writePid(home: string, pid: number): void {
  const dir = runtimeDir(home);
  if (!existsSync(dir)) {
    Deno.mkdirSync(dir, { recursive: true });
  }
  Deno.writeTextFileSync(pidPath(home), String(pid));
}

function removePid(home: string): void {
  const p = pidPath(home);
  try {
    Deno.removeSync(p);
  } catch {
    // file may already be gone
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Gateway connection helpers                                        */
/* ------------------------------------------------------------------ */

interface GatewayConnectionConfig {
  host: string;
  port: number;
  token?: string;
}

function getGatewayUrl(config: GatewayConnectionConfig): string {
  return `http://${config.host}:${config.port}`;
}

async function gatewayFetch(
  config: GatewayConnectionConfig,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${getGatewayUrl(config)}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.token) {
    headers["Authorization"] = `Bearer ${config.token}`;
  }
  return fetch(url, { ...options, headers: { ...headers, ...options?.headers } });
}

function resolveGatewayConfig(home: string): GatewayConnectionConfig {
  const defaults: GatewayConnectionConfig = { host: "127.0.0.1", port: 18790 };
  const configPath = join(home, "config.yaml");
  if (!existsSync(configPath)) return defaults;
  try {
    const raw = Deno.readTextFileSync(configPath);
    // Simple extraction — avoid pulling in a full YAML parser just for two fields.
    const hostMatch = raw.match(/^(?!\s*#)\s*host:\s*(.+)$/m);
    const portMatch = raw.match(/^(?!\s*#)\s*httpPort:\s*(\d+)/m);
    const tokenMatch = raw.match(/^(?!\s*#)\s*token:\s*(.+)$/m);
    return {
      host: hostMatch ? hostMatch[1].trim() : defaults.host,
      port: portMatch ? parseInt(portMatch[1], 10) : defaults.port,
      token: tokenMatch ? tokenMatch[1].trim() : undefined,
    };
  } catch {
    return defaults;
  }
}

/* ------------------------------------------------------------------ */
/*  Utility                                                           */
/* ------------------------------------------------------------------ */

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Stop logic (shared by stop & restart)                             */
/* ------------------------------------------------------------------ */

async function stopKernel(home: string): Promise<boolean> {
  const pid = readPid(home);
  if (pid === null || !isProcessRunning(pid)) {
    removePid(home);
    return false; // nothing was running
  }

  console.log(`Stopping kernel (PID ${pid})...`);
  Deno.kill(pid, "SIGTERM");

  // Poll for exit — up to 5 seconds at 100ms intervals
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!isProcessRunning(pid)) {
      removePid(home);
      console.log("Kernel stopped.");
      return true;
    }
  }

  // Force kill
  console.log("Kernel did not exit in time, sending SIGKILL...");
  try {
    Deno.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await sleep(200);
  removePid(home);
  console.log("Kernel killed.");
  return true;
}

/* ------------------------------------------------------------------ */
/*  Start logic (shared by start & restart)                           */
/* ------------------------------------------------------------------ */

function spawnDetached(home: string, logLevel?: string): void {
  const entryPath = new URL("./index.ts", import.meta.url).pathname;

  // Security: kernel is the Trusted Computing Base — it requires --allow-all to manage
  // child processes, config, and signals. Module subprocesses are sandboxed with scoped Deno flags.
  const args = ["run", "--allow-all", "--unstable-sloppy-imports", entryPath];
  if (logLevel) {
    args.push("--log-level", logLevel);
  }

  const logsDir = join(runtimeDir(home), "logs");
  if (!existsSync(logsDir)) Deno.mkdirSync(logsDir, { recursive: true });

  const logFilePath = join(logsDir, `kernel-${todayStamp()}.log`);

  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), PONS_HOME: home },
  });

  let child: Deno.ChildProcess;
  try {
    child = cmd.spawn();
  } catch (err) {
    console.error(`Failed to spawn kernel: ${err instanceof Error ? err.message : String(err)}`);
    removePid(home);
    Deno.exitCode = 1;
    return;
  }

  const pid = child.pid;
  writePid(home, pid);
  console.log(`Kernel started in background (PID ${pid}).`);

  // Pipe stdout+stderr to log file asynchronously (fire-and-forget)
  const pipeToLog = async (stream: ReadableStream<Uint8Array>) => {
    const logFile = await Deno.open(logFilePath, { write: true, create: true, append: true });
    try {
      await stream.pipeTo(logFile.writable);
    } catch { /* ignore */ }
  };
  pipeToLog(child.stdout).catch(() => {});
  pipeToLog(child.stderr).catch(() => {});

  // Detach: don't await the child's status
  child.status.then(() => {}).catch(() => {});
  child.unref();
}

async function startForeground(logLevel?: string): Promise<never> {
  const Kernel = (await import("./kernel.ts")).default;
  const kernel = new Kernel(logLevel);
  await kernel.boot();
  await kernel.start();
  // Kernel registers its own SIGINT/SIGTERM handlers and writes its own PID file.
  // Block forever so the CLI's parseAsync never resolves and Deno.exit is not called.
  // The kernel's shutdown() sets Deno.exitCode and the process exits when the event loop drains.
  return new Promise(() => {});
}

/* ------------------------------------------------------------------ */
/*  Command registration                                              */
/* ------------------------------------------------------------------ */

export function init(program: Command): void {
  const kernel = program
    .command("kernel")
    .description("Kernel management commands");

  /* ---- kernel start ---- */
  kernel
    .command("start")
    .description("Start the kernel process")
    .option("-d, --detach", "Run the kernel in the background")
    .option("-f, --force", "Kill an existing kernel before starting")
    .option("--log-level <level>", "Set the kernel log level")
    .action(async (opts: { detach?: boolean; force?: boolean; logLevel?: string }) => {
      const home = getPonsHome();
      const existingPid = readPid(home);

      if (existingPid !== null && isProcessRunning(existingPid)) {
        if (opts.force) {
          await stopKernel(home);
        } else {
          console.error(
            `Kernel is already running (PID ${existingPid}). Use --force to replace it.`,
          );
          Deno.exit(1);
        }
      } else if (existingPid !== null) {
        // Stale PID file
        removePid(home);
      }

      if (opts.detach) {
        spawnDetached(home, opts.logLevel);
      } else {
        await startForeground(opts.logLevel);
      }
    });

  /* ---- kernel stop ---- */
  kernel
    .command("stop")
    .description("Stop the running kernel")
    .action(async () => {
      const home = getPonsHome();
      const stopped = await stopKernel(home);
      if (!stopped) {
        console.log("Kernel is not running.");
      }
    });

  /* ---- kernel restart ---- */
  kernel
    .command("restart")
    .description("Restart the kernel process")
    .option("-d, --detach", "Run the kernel in the background after restart")
    .option("--log-level <level>", "Set the kernel log level")
    .action(async (opts: { detach?: boolean; logLevel?: string }) => {
      const home = getPonsHome();

      // Stop existing kernel if running
      await stopKernel(home);

      // Start new kernel
      if (opts.detach) {
        spawnDetached(home, opts.logLevel);
      } else {
        await startForeground(opts.logLevel);
      }
    });

  /* ---- kernel status ---- */
  kernel
    .command("status")
    .description("Show the kernel status")
    .action(async () => {
      const home = getPonsHome();
      const pid = readPid(home);

      // PID status
      if (pid !== null && isProcessRunning(pid)) {
        console.log(`Kernel process: running (PID ${pid})`);
      } else if (pid !== null) {
        console.log("Kernel process: stale PID file (process not running)");
        removePid(home);
      } else {
        console.log("Kernel process: not running (no PID file)");
      }

      // Gateway HTTP status
      const gwConfig = resolveGatewayConfig(home);
      try {
        const res = await gatewayFetch(gwConfig, "/status");
        if (res.ok) {
          const data = await res.json();
          console.log(`Gateway:        reachable at ${getGatewayUrl(gwConfig)}`);
          if (data.uptime !== undefined) {
            console.log(`Uptime:         ${formatUptime(data.uptime)}`);
          }
          if (data.modules !== undefined) {
            console.log(`Modules:        ${data.modules}`);
          }
        } else {
          console.log(`Gateway:        responded with HTTP ${res.status}`);
        }
      } catch {
        console.log(`Gateway:        not reachable at ${getGatewayUrl(gwConfig)}`);
      }
    });

  /* ---- kernel logs ---- */
  kernel
    .command("logs")
    .description("Tail kernel log output")
    .option("-n, --lines <count>", "Number of initial lines to show", "50")
    .option("--date <YYYY-MM-DD>", "Show logs from a specific date")
    .option("--list", "List available log files")
    .action(async (opts: { lines: string; date?: string; list?: boolean }) => {
      const home = getPonsHome();
      const logsDir = join(home, ".runtime", "logs");

      if (!existsSync(logsDir)) {
        console.log("No log files found. Start the kernel first.");
        return;
      }

      // --list: show available log files
      if (opts.list) {
        const files: string[] = [];
        for (const entry of Deno.readDirSync(logsDir)) {
          if (entry.name.startsWith("kernel-") && entry.name.endsWith(".log")) {
            files.push(entry.name);
          }
        }
        files.sort();
        if (files.length === 0) {
          console.log("No log files found.");
        } else {
          for (const f of files) {
            const stat = Deno.statSync(join(logsDir, f));
            const sizeKb = ((stat.size ?? 0) / 1024).toFixed(1);
            console.log(`  ${f}  (${sizeKb} KB)`);
          }
        }
        return;
      }

      // Determine which log file to read
      const date = opts.date ?? todayStamp();
      const logFile = join(logsDir, `kernel-${date}.log`);

      if (!existsSync(logFile)) {
        console.log(`No log file for ${date}.`);
        console.log("Use --list to see available log files.");
        return;
      }

      const lineCount = parseInt(opts.lines, 10) || 50;
      const encoder = new TextEncoder();

      // Read existing content — show last N lines
      const content = Deno.readTextFileSync(logFile);
      const lines = content.split("\n");
      const tail = lines.slice(-lineCount - 1).join("\n");
      if (tail.trim()) {
        Deno.stdout.writeSync(encoder.encode(tail));
        if (!tail.endsWith("\n")) Deno.stdout.writeSync(encoder.encode("\n"));
      }

      // If viewing today's log, follow new output
      if (!opts.date || opts.date === todayStamp()) {
        const fh = await Deno.open(logFile, { read: true });
        let offset = (await fh.stat()).size;

        const poll = setInterval(async () => {
          const stat = await fh.stat();
          if (stat.size > offset) {
            const buf = new Uint8Array(stat.size - offset);
            await fh.seek(offset, Deno.SeekMode.Start);
            await fh.read(buf);
            Deno.stdout.writeSync(buf);
            offset = stat.size;
          }
        }, 200);

        Deno.addSignalListener("SIGINT", () => {
          clearInterval(poll);
          fh.close();
          Deno.exit(0);
        });

        // Keep alive
        await new Promise(() => {});
      }
    });

  /* ================================================================ */
  /*  Module management commands                                       */
  /* ================================================================ */

  const modules = program
    .command("modules")
    .description("Manage installed modules");

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

      const moduleList: Array<{
        id: string;
        version: string;
        provides: string[];
        requires: string[];
        linked: boolean;
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

          moduleList.push({
            id: manifest.id,
            version: version ?? "0.0.0",
            provides: manifest.provides ?? [],
            requires: manifest.requires ?? [],
            linked,
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

      const table = createTable(["Module", "Version", "Provides", "Type"]);
      for (const mod of moduleList) {
        table.push([
          mod.id,
          mod.version,
          mod.provides.join(", ") || chalk.dim("\u2014"),
          mod.linked ? chalk.yellow("linked") : "installed",
        ]);
      }
      console.log(table.toString());
      console.log();
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
        console.log(chalk.dim(`Module "${manifest.id}" is already approved.`));
        return;
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

  /* ================================================================ */
  /*  Permission management commands                                   */
  /* ================================================================ */

  const permissions = program
    .command("permissions")
    .description("Manage module permissions");

  /* ---- permissions list ---- */
  permissions
    .command("list [module]")
    .description("List approved permissions for a module or all modules")
    .option("--home <path>", "Override PONS_HOME directory")
    .option("--json", "Output as JSON")
    .action(async (moduleName: string | undefined, opts: { home?: string; json?: boolean }) => {
      const json = opts.json ?? false;
      const home = opts.home || getPonsHome();
      const store = new PermissionStore(home);
      const allPerms = store.listAll();

      if (moduleName) {
        const granted = store.getApproved(moduleName);
        if (!granted) {
          if (json) {
            outputJson({ module: moduleName, permissions: null, error: "not found" });
          } else {
            printError(`No permissions found for module "${moduleName}".`);
          }
          Deno.exitCode = 1;
          return;
        }

        if (json) {
          outputJson({ module: moduleName, ...granted });
          return;
        }

        printHeader(`Permissions: ${moduleName}`);
        const table = createTable(["Type", "Values", "Granted"]);
        const perms = granted.permissions;
        for (const [key, values] of Object.entries(perms)) {
          if (Array.isArray(values) && values.length > 0) {
            table.push([key, values.join(", "), granted.grantedAt.split("T")[0]]);
          }
        }
        console.log(table.toString());
        console.log();
      } else {
        // List all modules
        const moduleIds = Object.keys(allPerms);
        if (moduleIds.length === 0) {
          if (json) {
            outputJson({ modules: [] });
          } else {
            console.log(chalk.dim("  No module permissions configured."));
            console.log();
          }
          return;
        }

        if (json) {
          outputJson({ modules: allPerms });
          return;
        }

        printHeader(`Module Permissions (${moduleIds.length})`);
        const table = createTable(["Module", "Net", "Read", "Write", "Services", "Topics"]);
        for (const [id, granted] of Object.entries(allPerms)) {
          const p = granted.permissions;
          table.push([
            id,
            (p.net ?? []).join(", ") || chalk.dim("\u2014"),
            (p.read ?? []).join(", ") || chalk.dim("\u2014"),
            (p.write ?? []).join(", ") || chalk.dim("\u2014"),
            (p.services ?? []).join(", ") || chalk.dim("\u2014"),
            (p.topics ?? []).join(", ") || chalk.dim("\u2014"),
          ]);
        }
        console.log(table.toString());
        console.log();
      }
    });

  /* ---- permissions revoke ---- */
  permissions
    .command("revoke <module> [type] [value]")
    .description("Revoke permissions for a module")
    .option("--home <path>", "Override PONS_HOME directory")
    .option("--json", "Output as JSON")
    .action(async (moduleName: string, type: string | undefined, value: string | undefined, opts: { home?: string; json?: boolean }) => {
      const json = opts.json ?? false;
      const home = opts.home || getPonsHome();
      const store = new PermissionStore(home);

      const success = store.revoke(moduleName, type, value);

      if (!success) {
        if (json) {
          outputJson({ module: moduleName, revoked: false, error: "not found or invalid type" });
        } else {
          printError(`Failed to revoke permissions for "${moduleName}". Module may not have approved permissions.`);
        }
        Deno.exitCode = 1;
        return;
      }

      if (json) {
        outputJson({ module: moduleName, revoked: true, type: type ?? "all", value: value ?? "all" });
      } else {
        const desc = type ? (value ? `${type}:${value}` : type) : "all permissions";
        console.log(`Revoked ${chalk.yellow(desc)} for ${chalk.green(moduleName)}.`);
      }

      // Signal kernel to reload permissions if running
      const pid = readPid(home);
      if (pid !== null && isProcessRunning(pid)) {
        try {
          Deno.kill(pid, "SIGUSR2");
          console.log(chalk.dim("  Kernel notified — affected module will be restarted."));
        } catch {
          console.log(chalk.dim("  Could not signal kernel — restart manually for changes to take effect."));
        }
      }
    });

  // Config management commands
  initConfigCommands(program);
}
