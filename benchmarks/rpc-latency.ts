/**
 * RPC Round-Trip Latency Benchmark
 *
 * Measures the time for a full module-to-module RPC call routed through the kernel:
 *   caller → kernel → provider → kernel → caller
 *
 * This is the cost of every `this.request(service, method)` call in a module.
 * Two fake modules are spawned: one declares a service ("bench-rpc-provider"),
 * the other calls it. The caller module reports timing back via IPC log messages.
 *
 * Because we can't inject JS into a running module from outside, we instead
 * measure RPC from the kernel side using LifecycleManager.call() which exercises
 * the same routing path as module-to-module RPC (kernel → module call).
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

// ─── RPC provider module ────────────────────────────────────
// Responds to onRequest("echo") by returning params unchanged.

const PROVIDER_RUNNER = `
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
              id: "rpc-provider",
              name: "RPC Provider",
              minProtocolVersion: "1.0",
              permissions: {},
              provides: ["bench.echo"],
              requires: [],
            }
          }) + "\\n"));
        } else if (msg.type === "rpc_request" || msg.type === "call") {
          // echo back the params
          const respType = msg.type === "rpc_request" ? "rpc_response" : "call:response";
          Deno.stdout.writeSync(enc.encode(JSON.stringify({
            type: respType,
            id: msg.id,
            result: msg.params ?? null,
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

async function setupPermStore(moduleIds: string[]): Promise<{ store: PermissionStore; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir();
  const store = new PermissionStore(dir);
  for (const id of moduleIds) {
    store.approve(id, { net: [], read: [], write: [], env: [], run: [], sys: [] }, "bench-hash");
  }
  return {
    store,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

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
    printHeader("RPC Round-Trip Latency", {
      iterations: ITERATIONS,
      warmup: WARMUP,
      description: "kernel → module call/response round-trip",
    });
  }

  const { path: providerPath, cleanup: cleanupProvider } = await setupRunner(PROVIDER_RUNNER);
  const { store, cleanup: cleanupStore } = await setupPermStore(["rpc-provider"]);

  const logger = createLogger({ level: "fatal", levels: {} });
  const bus = new MessageBus();
  const lm = new LifecycleManager(
    logger, bus,
    { config: {}, workspacePath: "/tmp", projectRoot: "/tmp" },
    async () => undefined,
    undefined,
    store,
  );

  const provider: DiscoveredModule = {
    manifest: {
      id: "rpc-provider",
      name: "RPC Provider",
      minProtocolVersion: "1.0",
      permissions: {},
      provides: ["bench.echo"],
      requires: [],
    },
    runnerPath: providerPath,
    moduleDir: providerPath.slice(0, providerPath.lastIndexOf("/")),
  };

  await lm.spawnAll([provider]);
  const ready = await waitFor(() => lm.getRegistry().get("rpc-provider")?.status === "ready");

  if (!ready) {
    await lm.stopAll();
    await cleanupProvider();
    await cleanupStore();
    if (!JSON_MODE) console.log(`   ${c.red}Provider module failed to reach ready state${c.reset}\n`);
    return { name: "RPC Round-Trip Latency", passed: false };
  }

  const times: number[] = [];

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await lm.call("rpc-provider", "echo", { n: i }, 5000).catch(() => {});
  }

  // Measure
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await lm.call("rpc-provider", "echo", { n: i }, 5000);
    times.push(performance.now() - t0);

    if (!JSON_MODE && i % 10 === 0) {
      writeProgress(i + 1, ITERATIONS);
    }
  }

  if (!JSON_MODE) clearProgress();

  await lm.stopAll();
  await cleanupProvider();
  await cleanupStore();

  const stats = computeStats(times);

  if (!JSON_MODE) {
    printResult(times.length, ITERATIONS, stats, { good: 2, warn: 10 });
    console.log(`   ${c.dim}Throughput: ~${Math.round(1000 / stats.avg).toLocaleString()} calls/sec${c.reset}\n`);
  }

  return {
    name: "RPC Round-Trip Latency",
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
