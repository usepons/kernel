/** CLI commands for kernel lifecycle management (start, stop, restart, status, logs). */

import { join } from "jsr:@std/path@^1";
import chalk from "npm:chalk@^5.6.2";
import { getPonsHome } from "@pons/sdk";
import { existsSync } from "../utils/fs.ts";
import { PermissionStore } from "../security/permissions.ts";
import { formatUptime, todayStamp, sleep } from "./utils.ts";
import { getGatewayUrl, gatewayFetch, resolveGatewayConfig } from "./gateway.ts";

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

export function readPid(home: string): number | null {
  const p = pidPath(home);
  if (!existsSync(p)) return null;
  const raw = Deno.readTextFileSync(p).trim();
  const pid = parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
}

export function writePid(home: string, pid: number): void {
  const dir = runtimeDir(home);
  if (!existsSync(dir)) {
    Deno.mkdirSync(dir, { recursive: true });
  }
  Deno.writeTextFileSync(pidPath(home), String(pid));
}

export function removePid(home: string): void {
  const p = pidPath(home);
  try {
    Deno.removeSync(p);
  } catch {
    // file may already be gone
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
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
  const entryPath = new URL("../index.ts", import.meta.url).pathname;

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
  const Kernel = (await import("../kernel.ts")).default;
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

export function registerKernelCommands(program: Command): void {
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

      // Count pending permission requests
      try {
        const store = new PermissionStore(home);
        const allPending = store.getPendingRequests();
        const pendingCount = Object.values(allPending).reduce(
          (sum, requests) => sum + requests.length, 0
        );
        if (pendingCount > 0) {
          console.log(chalk.yellow(`Pending permissions: ${pendingCount} request(s) (run 'pons permissions pending')`));
        }
      } catch { /* permission store not available */ }
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
}
