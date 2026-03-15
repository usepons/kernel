/**
 * Scale Benchmark
 *
 * Measures how the kernel performs under increasing module load.
 * Installs N dummy modules (5, 10, 20, 50), boots the kernel,
 * and measures boot time, memory, and shutdown time at each scale.
 */

import { join } from "jsr:@std/path@^1";
import {
  type BenchmarkResult,
  colors as c,
  computeStats,
  formatKb,
  formatMs,
  getPonsHome,
  getTreeRssKb,
  JSON_MODE,
  killProcess,
  printHeader,
  removePidFile,
  spawnKernel,
  waitForPidFile,
  writeResultFile,
} from "./utils.ts";

const SCALES = (Deno.env.get("BENCH_SCALES") || "5,10,20,50")
  .split(",")
  .map((s) => parseInt(s.trim(), 10));
const STABILIZE_MS = 2_000;

// ─── Dummy Module Management ───────────────────────────────

function dummyRunnerCode(id: string): string {
  return `
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function send(msg) {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(msg) + "\\n"));
}

// Simulate work: allocate ~1MB buffer per module
const _workBuffer = new Uint8Array(1024 * 1024);
for (let i = 0; i < _workBuffer.length; i++) _workBuffer[i] = i % 256;

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
        send({ type: "ready", manifest: { id: "${id}", name: "${id}", version: "0.0.1", permissions: {} } });
      }
      if (msg.type === "ping") send({ type: "pong" });
      if (msg.type === "shutdown") Deno.exit(0);
    }
  }
}

readMessages();
`;
}

async function installDummyModules(ponsHome: string, count: number): Promise<void> {
  const permPath = join(ponsHome, "permissions.yaml");
  let perms = "";
  try {
    perms = await Deno.readTextFile(permPath);
  } catch { /* */ }

  for (let i = 0; i < count; i++) {
    const id = `__bench_scale_${i}__`;
    const moduleDir = join(ponsHome, "modules", id);
    await Deno.mkdir(moduleDir, { recursive: true });

    await Deno.writeTextFile(
      join(moduleDir, "module.json"),
      JSON.stringify({ id, name: `Scale Module ${i}`, version: "0.0.1", permissions: {} }, null, 2),
    );

    await Deno.writeTextFile(join(moduleDir, "runner.ts"), dummyRunnerCode(id));

    if (!perms.includes(id)) {
      perms += `\n${id}:\n  approved: true\n  manifest_hash: ""\n`;
    }
  }

  await Deno.writeTextFile(permPath, perms);
}

async function cleanupDummyModules(ponsHome: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const id = `__bench_scale_${i}__`;
    try {
      await Deno.remove(join(ponsHome, "modules", id), { recursive: true });
    } catch { /* */ }
  }

  // Clean permissions
  const permPath = join(ponsHome, "permissions.yaml");
  try {
    let content = await Deno.readTextFile(permPath);
    for (let i = 0; i < count; i++) {
      const id = `__bench_scale_${i}__`;
      content = content.replace(new RegExp(`\\n?${id}:[\\s\\S]*?(?=\\n\\w|\\n?$)`), "");
    }
    await Deno.writeTextFile(permPath, content);
  } catch { /* */ }
}

function waitForAllModulesReady(ponsHome: string, count: number, timeoutMs: number): Promise<boolean> {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const logPath = join(ponsHome, ".runtime", "logs", `kernel-${stamp}.log`);

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      while (Date.now() < deadline) {
        try {
          const content = Deno.readTextFileSync(logPath);
          let found = 0;
          for (let i = 0; i < count; i++) {
            if (content.includes(`__bench_scale_${i}__`) && content.includes("ready")) {
              found++;
            }
          }
          if (found >= count) {
            resolve(true);
            return;
          }
        } catch { /* */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      resolve(false);
    };
    check();
  });
}

// ─── Measurement ────────────────────────────────────────────

interface ScaleResult {
  moduleCount: number;
  bootMs: number;
  rssKb: number;
  shutdownMs: number;
  allReady: boolean;
}

async function measureAtScale(count: number): Promise<ScaleResult | null> {
  const home = getPonsHome();
  removePidFile();

  const bootStart = performance.now();
  const process = spawnKernel();

  const pid = await waitForPidFile(60_000);
  if (pid === null) {
    await killProcess(process, "SIGKILL");
    return null;
  }

  // Wait for all scale modules to be ready
  const allReady = await waitForAllModulesReady(home, count, 60_000);
  const bootMs = performance.now() - bootStart;

  // Let memory stabilize
  await new Promise((r) => setTimeout(r, STABILIZE_MS));

  // Sample total tree RSS (average of 3 samples)
  const rssSamples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const rss = await getTreeRssKb(pid);
    if (rss !== null) rssSamples.push(rss);
    await new Promise((r) => setTimeout(r, 300));
  }
  const rssKb = rssSamples.length > 0
    ? rssSamples.reduce((a, b) => a + b, 0) / rssSamples.length
    : 0;

  // Measure shutdown
  const shutdownMs = await killProcess(process, "SIGTERM");
  removePidFile();

  return {
    moduleCount: count,
    bootMs,
    rssKb: Math.round(rssKb),
    shutdownMs: shutdownMs ?? 10_000,
    allReady,
  };
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<BenchmarkResult> {
  const home = getPonsHome();
  const maxScale = Math.max(...SCALES);

  if (!JSON_MODE) {
    printHeader("Scale Test", {
      scales: SCALES.join(", ") + " modules",
    });
    console.log(`   ${c.dim}Installing ${maxScale} dummy modules...${c.reset}`);
  }

  // Install all modules up front (max scale)
  await installDummyModules(home, maxScale);

  const results: ScaleResult[] = [];

  try {
    for (const count of SCALES) {
      // Clean extras beyond current count
      if (count < maxScale) {
        for (let i = count; i < maxScale; i++) {
          try {
            // Temporarily hide modules beyond count by renaming
            const id = `__bench_scale_${i}__`;
            const dir = join(home, "modules", id);
            try { await Deno.stat(dir); } catch { continue; }
            await Deno.rename(dir, dir + ".disabled");
          } catch { /* */ }
        }
      }

      if (!JSON_MODE) {
        const label = `${count} modules`;
        Deno.stdout.writeSync(new TextEncoder().encode(`\r   ${c.cyan}${label.padEnd(14)}${c.reset} measuring...`));
      }

      const result = await measureAtScale(count);

      // Restore hidden modules
      if (count < maxScale) {
        for (let i = count; i < maxScale; i++) {
          const id = `__bench_scale_${i}__`;
          const dir = join(home, "modules", id);
          try { await Deno.rename(dir + ".disabled", dir); } catch { /* */ }
        }
      }

      if (result) {
        results.push(result);
        if (!JSON_MODE) {
          const readyStatus = result.allReady ? `${c.green}all ready${c.reset}` : `${c.yellow}partial${c.reset}`;
          Deno.stdout.writeSync(new TextEncoder().encode(
            `\r   ${c.cyan}${String(count).padStart(3)} modules${c.reset}  ` +
            `boot ${formatMs(result.bootMs).padStart(8)}  ` +
            `rss ${formatKb(result.rssKb).padStart(9)}  ` +
            `shutdown ${formatMs(result.shutdownMs).padStart(8)}  ` +
            `${readyStatus}\n`,
          ));
        }
      } else {
        if (!JSON_MODE) {
          Deno.stdout.writeSync(new TextEncoder().encode(
            `\r   ${c.red}${String(count).padStart(3)} modules  FAILED${c.reset}\n`,
          ));
        }
      }
    }
  } finally {
    if (!JSON_MODE) {
      console.log(`\n   ${c.dim}Cleaning up ${maxScale} dummy modules...${c.reset}`);
    }
    await cleanupDummyModules(home, maxScale);
  }

  if (results.length === 0) {
    if (!JSON_MODE) console.log(`   ${c.red}All scales failed.${c.reset}\n`);
    return { name: "Scale Test", passed: false };
  }

  // Print scaling analysis
  if (!JSON_MODE && results.length >= 2) {
    const first = results[0];
    const last = results[results.length - 1];
    const bootScaling = last.bootMs / first.bootMs;
    const memScaling = last.rssKb / first.rssKb;
    const moduleRatio = last.moduleCount / first.moduleCount;

    console.log();
    console.log(`   ${c.bold}Scaling Analysis${c.reset} ${c.dim}(${first.moduleCount} -> ${last.moduleCount} modules, ${moduleRatio.toFixed(0)}x)${c.reset}`);

    const bootColor = bootScaling < moduleRatio ? c.green : c.yellow;
    console.log(`   Boot   ${bootColor}${bootScaling.toFixed(1)}x${c.reset} ${c.dim}(${formatMs(first.bootMs)} -> ${formatMs(last.bootMs)})${c.reset}`);

    const memColor = memScaling < moduleRatio * 0.8 ? c.green : c.yellow;
    console.log(`   Memory ${memColor}${memScaling.toFixed(1)}x${c.reset} ${c.dim}(${formatKb(first.rssKb)} -> ${formatKb(last.rssKb)})${c.reset}`);

    const shutScaling = last.shutdownMs / first.shutdownMs;
    const shutColor = shutScaling < moduleRatio ? c.green : c.yellow;
    console.log(`   Shut   ${shutColor}${shutScaling.toFixed(1)}x${c.reset} ${c.dim}(${formatMs(first.shutdownMs)} -> ${formatMs(last.shutdownMs)})${c.reset}`);

    if (bootScaling < moduleRatio) {
      console.log(`\n   ${c.green}Sub-linear boot scaling — good!${c.reset}`);
    } else {
      console.log(`\n   ${c.yellow}Boot scales linearly or worse — may need optimization${c.reset}`);
    }
  }

  console.log();

  return {
    name: "Scale Test",
    passed: true,
    extra: { scales: results },
  };
}

const result = await main();
writeResultFile(result);

if (JSON_MODE) console.log(JSON.stringify(result, null, 2));
if (!result.passed) Deno.exit(1);
