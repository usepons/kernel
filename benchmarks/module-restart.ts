/**
 * Module Restart Time Benchmark
 *
 * Measures how long it takes the kernel to detect a crashed module and
 * bring it back to "ready" state. This is the system's resilience metric —
 * how fast does it recover from failures?
 *
 * Methodology:
 *   1. Boot kernel with a restartable module
 *   2. Kill the module process with SIGKILL (simulated crash)
 *   3. Measure time from kill to next "ready" state
 *   4. Repeat across iterations (restartBaseMs backoff applies after first restart,
 *      so we wait for counter reset between iterations)
 *
 * Note: kernel uses exponential backoff on restarts. We reset between iterations
 * by waiting for the 60s stability window to clear the counter — or, more
 * practically for benchmarking, we use a fresh lifecycle per iteration.
 */

import { join } from "jsr:@std/path@^1";
import {
  type BenchmarkResult,
  clearProgress,
  colors as c,
  computeStats,
  formatMs,
  JSON_MODE,
  writeResultFile,
  printHeader,
  printResult,
  writeProgress,
} from "./utils.ts";
import { LifecycleManager } from "../src/lifecycle.ts";
import { MessageBus } from "../src/messaging/bus.ts";
import { createLogger } from "../src/logs/logger.ts";
import { PermissionStore } from "../src/security/permissions.ts";
import type { DiscoveredModule } from "../src/module/loader.ts";

const ITERATIONS = parseInt(Deno.env.get("BENCH_ITERATIONS") || "10");

const RESTARTABLE_RUNNER = `
const enc = new TextEncoder(), dec = new TextDecoder();
let buf = "";
async function main() {
  for await (const chunk of Deno.stdin.readable) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "init") {
          Deno.stdout.writeSync(enc.encode(JSON.stringify({
            type: "ready",
            manifest: {
              id: "bench-restart",
              name: "Bench Restart",
              minProtocolVersion: "1.0",
              permissions: {},
              provides: [],
              requires: [],
            }
          }) + "\\n"));
        } else if (msg.type === "ping") {
          Deno.stdout.writeSync(enc.encode(JSON.stringify({ type: "pong" }) + "\\n"));
        } else if (msg.type === "shutdown") {
          Deno.exit(0);
        }
      } catch { /* */ }
    }
  }
}
main();
`;

async function setupRunner(content: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "runner.ts");
  await Deno.writeTextFile(path, content);
  return {
    path,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

async function setupPermStore(moduleId: string): Promise<{ store: PermissionStore; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir();
  const store = new PermissionStore(dir);
  store.approve(moduleId, { net: [], read: [], write: [], env: [], run: [], sys: [] }, "bench-hash");
  return {
    store,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

function makeModule(runnerPath: string): DiscoveredModule {
  return {
    manifest: {
      id: "bench-restart",
      name: "Bench Restart",
      minProtocolVersion: "1.0",
      permissions: {},
      provides: [],
      requires: [],
    },
    runnerPath,
    moduleDir: runnerPath.slice(0, runnerPath.lastIndexOf("/")),
  };
}

async function measureOneRestart(runnerPath: string): Promise<number | null> {
  const { store, cleanup: cleanupStore } = await setupPermStore("bench-restart");
  const logger = createLogger({ level: "fatal", levels: {} });
  const bus = new MessageBus();

  // restartBaseMs=0 so we don't wait for backoff between measurements
  const lm = new LifecycleManager(
    logger, bus,
    {
      config: { lifecycle: { restartBaseMs: 0, maxRestarts: 3 } },
      workspacePath: "/tmp",
      projectRoot: "/tmp",
    },
    async () => undefined,
    undefined,
    store,
  );

  await lm.spawnAll([makeModule(runnerPath)]);
  const ready = await waitFor(() => lm.getRegistry().get("bench-restart")?.status === "ready");

  if (!ready) {
    await lm.stopAll();
    await cleanupStore();
    return null;
  }

  // Kill the module process directly (simulate crash, not graceful shutdown)
  const entry = lm.getRegistry().get("bench-restart");
  const pid = entry?.pid;
  if (!pid) {
    await lm.stopAll();
    await cleanupStore();
    return null;
  }

  const t0 = performance.now();
  try {
    Deno.kill(pid, "SIGKILL");
  } catch { /* already dead */ }

  // Wait for kernel to detect crash and restart to ready
  const recovered = await waitFor(
    () => lm.getRegistry().get("bench-restart")?.status === "ready",
    8000,
  );

  const elapsed = performance.now() - t0;

  await lm.stopAll();
  await cleanupStore();

  return recovered ? elapsed : null;
}

async function main(): Promise<BenchmarkResult> {
  if (!JSON_MODE) {
    printHeader("Module Restart Time", {
      iterations: ITERATIONS,
      description: "SIGKILL → module back to ready (kernel crash recovery)",
    });
  }

  const { path: runnerPath, cleanup: cleanupRunner } = await setupRunner(RESTARTABLE_RUNNER);
  const times: number[] = [];

  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const ms = await measureOneRestart(runnerPath);
      if (ms !== null) times.push(ms);

      if (!JSON_MODE) {
        writeProgress(i + 1, ITERATIONS, ms !== null ? formatMs(ms) : "failed");
      }
    }
  } finally {
    await cleanupRunner();
  }

  if (!JSON_MODE) clearProgress();

  if (times.length === 0) {
    if (!JSON_MODE) console.log(`   ${c.red}All iterations failed${c.reset}\n`);
    return { name: "Module Restart Time", passed: false };
  }

  const stats = computeStats(times);

  if (!JSON_MODE) {
    printResult(times.length, ITERATIONS, stats, { good: 200, warn: 1000 });
  }

  return { name: "Module Restart Time", passed: true, stats, unit: "ms" };
}

const result = await main();
writeResultFile(result);
if (JSON_MODE) console.log(JSON.stringify(result, null, 2));
if (!result.passed) Deno.exit(1);
