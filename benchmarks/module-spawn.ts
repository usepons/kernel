/**
 * Module Spawn Time Benchmark
 *
 * Creates a minimal dummy module, boots the kernel, and measures
 * how long it takes for the module to reach "ready" state.
 */

import { join } from "jsr:@std/path@^1";
import {
  type BenchmarkResult,
  clearProgress,
  colors as c,
  computeStats,
  formatMs,
  getPonsHome,
  JSON_MODE,
  writeResultFile,
  killProcess,
  printHeader,
  printResult,
  removePidFile,
  spawnKernel,
  waitForPidFile,
  writeProgress,
} from "./utils.ts";

const ITERATIONS = parseInt(Deno.env.get("BENCH_ITERATIONS") || "5");

async function ensureDummyModule(ponsHome: string): Promise<void> {
  const moduleDir = join(ponsHome, "modules", "__bench_dummy__");
  await Deno.mkdir(moduleDir, { recursive: true });

  await Deno.writeTextFile(
    join(moduleDir, "module.json"),
    JSON.stringify({
      id: "__bench_dummy__",
      name: "Benchmark Dummy Module",
      version: "0.0.1",
      permissions: {},
    }, null, 2),
  );

  await Deno.writeTextFile(
    join(moduleDir, "runner.ts"),
    `
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function send(msg: Record<string, unknown>) {
  const line = JSON.stringify(msg) + "\\n";
  Deno.stdout.writeSync(encoder.encode(line));
}

async function readMessages() {
  const reader = Deno.stdin.readable.getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === "init") {
        send({ type: "ready", manifest: { id: "__bench_dummy__", name: "Benchmark Dummy", version: "0.0.1", permissions: {} } });
      }
      if (msg.type === "ping") {
        send({ type: "pong" });
      }
      if (msg.type === "shutdown") {
        Deno.exit(0);
      }
    }
  }
}

readMessages();
`,
  );

  const permPath = join(ponsHome, "permissions.yaml");
  try {
    const existing = await Deno.readTextFile(permPath);
    if (!existing.includes("__bench_dummy__")) {
      await Deno.writeTextFile(permPath, existing + `\n__bench_dummy__:\n  approved: true\n  manifest_hash: ""\n`);
    }
  } catch {
    await Deno.writeTextFile(permPath, `__bench_dummy__:\n  approved: true\n  manifest_hash: ""\n`);
  }
}

async function cleanupDummyModule(ponsHome: string): Promise<void> {
  try {
    await Deno.remove(join(ponsHome, "modules", "__bench_dummy__"), { recursive: true });
  } catch { /* */ }

  const permPath = join(ponsHome, "permissions.yaml");
  try {
    const content = await Deno.readTextFile(permPath);
    const cleaned = content.replace(/\n?__bench_dummy__:[\s\S]*?(?=\n\w|\n?$)/, "");
    await Deno.writeTextFile(permPath, cleaned);
  } catch { /* */ }
}

async function waitForModuleReady(ponsHome: string, timeoutMs: number): Promise<boolean> {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const logPath = join(ponsHome, ".runtime", "logs", `kernel-${stamp}.log`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const content = Deno.readTextFileSync(logPath);
      if (content.includes("__bench_dummy__") && content.includes("ready")) {
        return true;
      }
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function measureSpawn(): Promise<number | null> {
  removePidFile();
  const start = performance.now();
  const process = spawnKernel();

  const pid = await waitForPidFile(30_000);
  if (pid === null) {
    await killProcess(process, "SIGKILL");
    return null;
  }

  const moduleReady = await waitForModuleReady(getPonsHome(), 15_000);
  const totalMs = performance.now() - start;

  await killProcess(process);
  removePidFile();

  return moduleReady ? totalMs : null;
}

async function main(): Promise<BenchmarkResult> {
  const home = getPonsHome();

  if (!JSON_MODE) {
    printHeader("Module Spawn", { iterations: ITERATIONS });
    console.log(`   ${c.dim}Installing dummy module...${c.reset}`);
  }

  await ensureDummyModule(home);

  const times: number[] = [];

  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const ms = await measureSpawn();
      if (ms !== null) times.push(ms);

      if (!JSON_MODE) {
        writeProgress(i + 1, ITERATIONS, ms !== null ? formatMs(ms) : "failed");
      }
    }
  } finally {
    await cleanupDummyModule(home);
  }

  if (!JSON_MODE) clearProgress();

  if (times.length === 0) {
    if (!JSON_MODE) console.log("   All iterations failed.\n");
    return { name: "Module Spawn", passed: false };
  }

  const stats = computeStats(times);

  if (!JSON_MODE) {
    printResult(times.length, ITERATIONS, stats, { good: 500, warn: 2000 });
  }

  return { name: "Module Spawn", passed: true, stats, unit: "ms" };
}

const result = await main();
writeResultFile(result);

if (JSON_MODE) console.log(JSON.stringify(result, null, 2));
if (!result.passed) Deno.exit(1);
