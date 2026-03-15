/**
 * Shutdown Time Benchmark
 *
 * Measures how long the kernel takes to gracefully shut down after SIGTERM.
 */

import {
  type BenchmarkResult,
  clearProgress,
  computeStats,
  formatMs,
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

const ITERATIONS = parseInt(Deno.env.get("BENCH_ITERATIONS") || "10");

async function measureShutdown(): Promise<{ bootMs: number; shutdownMs: number } | null> {
  removePidFile();

  const bootStart = performance.now();
  const process = spawnKernel();

  const pid = await waitForPidFile(30_000);
  if (pid === null) {
    await killProcess(process, "SIGKILL");
    return null;
  }

  const bootMs = performance.now() - bootStart;
  const shutdownMs = await killProcess(process, "SIGTERM");
  removePidFile();

  if (shutdownMs === null) return null;

  return { bootMs, shutdownMs };
}

async function main(): Promise<BenchmarkResult> {
  if (!JSON_MODE) {
    printHeader("Shutdown Time", { iterations: ITERATIONS });
  }

  const shutdowns: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const result = await measureShutdown();
    if (result) shutdowns.push(result.shutdownMs);

    if (!JSON_MODE) {
      writeProgress(
        i + 1,
        ITERATIONS,
        result ? formatMs(result.shutdownMs) : "failed",
      );
    }
  }

  if (!JSON_MODE) clearProgress();

  if (shutdowns.length === 0) {
    if (!JSON_MODE) console.log("   All iterations failed.\n");
    return { name: "Shutdown Time", passed: false };
  }

  const stats = computeStats(shutdowns);

  if (!JSON_MODE) {
    printResult(shutdowns.length, ITERATIONS, stats, { good: 500, warn: 2000 });
  }

  return { name: "Shutdown Time", passed: true, stats, unit: "ms" };
}

const result = await main();
writeResultFile(result);

if (JSON_MODE) console.log(JSON.stringify(result, null, 2));
if (!result.passed) Deno.exit(1);
