/**
 * IPC Latency Benchmark
 *
 * Measures the round-trip time for a message sent from the kernel to a module
 * and back (ping → pong). This is the fundamental unit of kernel ↔ module
 * communication cost — every RPC call and pub/sub delivery has this as its floor.
 *
 * Methodology:
 *   1. Boot the kernel with a bench module that responds to pings
 *   2. The bench module counts received pings and logs timestamps
 *   3. We read the log to extract round-trip times
 *
 * Because we can't inject a test hook into a live kernel, we use a different
 * approach: spawn two cooperating bench modules — a "sender" and a "receiver".
 * The sender publishes a timestamped message, the receiver re-publishes it back,
 * and the sender measures the round-trip from its own clock.
 *
 * Simpler alternative used here: measure kernel ping/pong latency directly
 * using the LifecycleManager in-process (same approach as integration tests).
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

const ITERATIONS = parseInt(Deno.env.get("BENCH_ITERATIONS") || "100");
const WARMUP = 10;

// ─── Fake ping-pong module ─────────────────────────────────

const FAKE_RUNNER = `
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
          Deno.stdout.writeSync(enc.encode(JSON.stringify({ type: "ready", manifest: { id: "bench-ping", name: "Bench Ping", minProtocolVersion: "1.0", permissions: {}, provides: ["bench.ping"], requires: [] } }) + "\\n"));
        } else if (msg.type === "ping") {
          Deno.stdout.writeSync(enc.encode(JSON.stringify({ type: "pong" }) + "\\n"));
        } else if (msg.type === "call") {
          Deno.stdout.writeSync(enc.encode(JSON.stringify({ type: "call:response", id: msg.id, result: null }) + "\\n"));
        } else if (msg.type === "rpc_request") {
          Deno.stdout.writeSync(enc.encode(JSON.stringify({ type: "rpc_response", id: msg.id, result: null }) + "\\n"));
        } else if (msg.type === "shutdown") {
          Deno.exit(0);
        }
      } catch { /* */ }
    }
  }
}
main();
`;

async function setupRunner(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "runner.ts");
  await Deno.writeTextFile(path, FAKE_RUNNER);
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

// ─── Wait helpers ──────────────────────────────────────────

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
}

// ─── Main ──────────────────────────────────────────────────

async function main(): Promise<BenchmarkResult> {
  if (!JSON_MODE) {
    printHeader("IPC Ping/Pong Latency", {
      iterations: ITERATIONS,
      warmup: WARMUP,
      description: "kernel.call(ping) → module.pong round-trip",
    });
  }

  const { path: runnerPath, cleanup: cleanupRunner } = await setupRunner();
  const { store, cleanup: cleanupStore } = await setupPermStore("bench-ping");

  const logger = createLogger({ level: "fatal", levels: {} });
  const bus = new MessageBus();
  const lm = new LifecycleManager(
    logger, bus,
    { config: {}, workspacePath: "/tmp", projectRoot: "/tmp" },
    async () => undefined,
    undefined,
    store,
  );

  const mod: DiscoveredModule = {
    manifest: {
      id: "bench-ping",
      name: "Bench Ping",
      minProtocolVersion: "1.0",
      permissions: {},
      provides: [],
      requires: [],
    },
    runnerPath,
    moduleDir: runnerPath.slice(0, runnerPath.lastIndexOf("/")),
  };

  await lm.spawnAll([mod]);
  const ready = await waitFor(() => lm.getRegistry().get("bench-ping")?.status === "ready");

  if (!ready) {
    await lm.stopAll();
    await cleanupRunner();
    await cleanupStore();
    if (!JSON_MODE) console.log(`   ${c.red}Module failed to reach ready state${c.reset}\n`);
    return { name: "IPC Ping/Pong Latency", passed: false };
  }

  const times: number[] = [];

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await lm.call("bench-ping", "ping", undefined, 5000).catch(() => {});
  }

  // Measure
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await lm.call("bench-ping", "ping", undefined, 5000);
    times.push(performance.now() - t0);

    if (!JSON_MODE && i % 10 === 0) {
      writeProgress(i + 1, ITERATIONS);
    }
  }

  if (!JSON_MODE) clearProgress();

  await lm.stopAll();
  await cleanupRunner();
  await cleanupStore();

  const stats = computeStats(times);

  if (!JSON_MODE) {
    printResult(times.length, ITERATIONS, stats, { good: 2, warn: 10 });
    console.log(`   ${c.dim}Throughput: ~${Math.round(1000 / stats.avg).toLocaleString()} pings/sec${c.reset}\n`);
  }

  return {
    name: "IPC Ping/Pong Latency",
    passed: true,
    stats,
    unit: "ms",
    extra: { throughput: Math.round(1000 / stats.avg) },
  };
}

const result = await main();
writeResultFile(result);
if (JSON_MODE) console.log(JSON.stringify(result, null, 2));
if (!result.passed) Deno.exit(1);
