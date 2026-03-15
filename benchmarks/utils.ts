/**
 * Shared utilities for kernel benchmarks.
 */

import { join } from "jsr:@std/path@^1";

// ─── ANSI Colors ────────────────────────────────────────────

const isTTY = Deno.stdout.isTerminal();

const c = {
  reset: isTTY ? "\x1b[0m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  red: isTTY ? "\x1b[31m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  magenta: isTTY ? "\x1b[35m" : "",
};

export { c as colors };

// ─── Formatting ─────────────────────────────────────────────

export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatKb(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

/** Color a value green/yellow/red based on thresholds. */
export function colorValue(value: number, good: number, warn: number): string {
  const color = value <= good ? c.green : value <= warn ? c.yellow : c.red;
  return `${color}${formatMs(value)}${c.reset}`;
}

// ─── Progress Bar ───────────────────────────────────────────

export function progressBar(current: number, total: number, width = 20): string {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = `${c.green}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
  return `${bar} ${current}/${total}`;
}

export function writeProgress(current: number, total: number, extra = ""): void {
  if (isTTY) {
    const line = `   ${progressBar(current, total)}${extra ? `  ${c.dim}${extra}${c.reset}` : ""}`;
    Deno.stdout.writeSync(new TextEncoder().encode(`\r${line}`));
  }
}

export function clearProgress(): void {
  if (isTTY) {
    Deno.stdout.writeSync(new TextEncoder().encode("\r\x1b[K"));
  }
}

// ─── Stats ──────────────────────────────────────────────────

export interface Stats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  count: number;
  total: number;
}

export function computeStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    count: sorted.length,
    total: sorted.length,
  };
}

export function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function printStats(
  stats: Stats,
  opts: { unit?: "ms" | "kb"; good?: number; warn?: number } = {},
): void {
  const { unit = "ms", good = Infinity, warn = Infinity } = opts;
  const fmt = unit === "kb" ? formatKb : formatMs;
  const cv = (v: number) =>
    unit === "ms" ? colorValue(v, good, warn) : fmt(v);

  const rows = [
    ["Min", cv(stats.min)],
    ["Avg", cv(stats.avg)],
    ["P50", cv(stats.p50)],
    ["P95", cv(stats.p95)],
    ["Max", cv(stats.max)],
  ];

  for (const [label, value] of rows) {
    console.log(`   ${c.dim}${label.padEnd(4)}${c.reset}  ${value}`);
  }
}

// ─── Benchmark Header / Footer ──────────────────────────────

export function printHeader(name: string, config: Record<string, string | number>): void {
  console.log(`\n   ${c.bold}${name}${c.reset}`);
  for (const [key, val] of Object.entries(config)) {
    console.log(`   ${c.dim}${key}: ${val}${c.reset}`);
  }
  console.log();
}

export function printResult(
  succeeded: number,
  total: number,
  stats: Stats,
  opts: { unit?: "ms" | "kb"; good?: number; warn?: number } = {},
): void {
  if (succeeded < total) {
    console.log(
      `   ${c.yellow}${succeeded}/${total} succeeded${c.reset}\n`,
    );
  }
  printStats(stats, opts);
  console.log();
}

// ─── JSON output ────────────────────────────────────────────

export const JSON_MODE = Deno.args.includes("--json");

/** Path where a benchmark writes its structured result for run-all to pick up. */
export function getResultFilePath(): string | null {
  const idx = Deno.args.indexOf("--result-file");
  return idx !== -1 ? Deno.args[idx + 1] : null;
}

/** Write structured result to file if --result-file was passed. */
export function writeResultFile(result: BenchmarkResult): void {
  const path = getResultFilePath();
  if (path) {
    Deno.writeTextFileSync(path, JSON.stringify(result));
  }
}

export interface BenchmarkResult {
  name: string;
  passed: boolean;
  stats?: Stats;
  unit?: string;
  extra?: Record<string, unknown>;
}

// ─── Process Management ─────────────────────────────────────

export function getPonsHome(): string {
  return Deno.env.get("PONS_HOME") || join(Deno.env.get("HOME") || "", ".pons");
}

export function getPidFilePath(): string {
  return join(getPonsHome(), ".runtime", "kernel.pid");
}

export function removePidFile(): void {
  try {
    Deno.removeSync(getPidFilePath());
  } catch { /* may not exist */ }
}

export async function waitForPidFile(timeoutMs: number, pollMs = 50): Promise<number | null> {
  const pidPath = getPidFilePath();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const content = Deno.readTextFileSync(pidPath).trim();
      const pid = parseInt(content, 10);
      if (!isNaN(pid) && pid > 0) return pid;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

export function spawnKernel(): Deno.ChildProcess {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/index.ts", "--log", "info"],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "null",
    stderr: "null",
  });
  return cmd.spawn();
}

export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

export async function killProcess(process: Deno.ChildProcess, signal: Deno.Signal = "SIGTERM"): Promise<number | null> {
  const start = performance.now();
  try {
    process.kill(signal);
  } catch { /* already exited */ }

  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (!isProcessAlive(process.pid)) {
      return performance.now() - start;
    }
  }

  try { process.kill("SIGKILL"); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 200));
  return null;
}

export async function getRssKb(pid: number): Promise<number | null> {
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-o", "rss=", "-p", String(pid)],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    const text = new TextDecoder().decode(output.stdout).trim();
    const kb = parseInt(text, 10);
    return isNaN(kb) ? null : kb;
  } catch {
    return null;
  }
}

/**
 * Get total RSS for a process and all its children (entire process tree).
 * Uses `ps -o pid,ppid,rss` to walk the tree.
 */
export async function getTreeRssKb(rootPid: number): Promise<number | null> {
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-A", "-o", "pid=,ppid=,rss="],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    const text = new TextDecoder().decode(output.stdout);

    // Parse all processes
    const procs: { pid: number; ppid: number; rss: number }[] = [];
    for (const line of text.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        procs.push({
          pid: parseInt(parts[0], 10),
          ppid: parseInt(parts[1], 10),
          rss: parseInt(parts[2], 10),
        });
      }
    }

    // BFS to find all descendants of rootPid
    const treePids = new Set<number>([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of procs) {
        if (treePids.has(p.ppid) && !treePids.has(p.pid)) {
          treePids.add(p.pid);
          changed = true;
        }
      }
    }

    // Sum RSS of all tree members
    let totalRss = 0;
    for (const p of procs) {
      if (treePids.has(p.pid)) {
        totalRss += p.rss;
      }
    }

    return totalRss > 0 ? totalRss : null;
  } catch {
    return null;
  }
}
