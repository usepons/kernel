/**
 * Boot Time Benchmark
 *
 * Measures the time from kernel process spawn to PID file creation
 * (which happens after "Kernel running" in start()).
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
const TIMEOUT_MS = 30_000;

async function measureBoot(): Promise<number | null> {
  removePidFile();
  const start = performance.now();
  const process = spawnKernel();

  const pid = await waitForPidFile(TIMEOUT_MS);
  const durationMs = performance.now() - start;

  await killProcess(process);
  removePidFile();

  return pid !== null ? durationMs : null;
}

async function main(): Promise<BenchmarkResult> {
  if (!JSON_MODE) {
    printHeader("Boot Time", { iterations: ITERATIONS, timeout: `${TIMEOUT_MS}ms` });
  }

  const durations: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const ms = await measureBoot();
    if (ms !== null) durations.push(ms);

    if (!JSON_MODE) {
      writeProgress(i + 1, ITERATIONS, ms !== null ? formatMs(ms) : "timeout");
    }
  }

  if (!JSON_MODE) clearProgress();

  if (durations.length === 0) {
    if (!JSON_MODE) console.log("   All iterations timed out.\n");
    return { name: "Boot Time", passed: false };
  }

  const stats = computeStats(durations);

  if (!JSON_MODE) {
    printResult(durations.length, ITERATIONS, stats, { good: 300, warn: 1000 });
  }

  return { name: "Boot Time", passed: true, stats, unit: "ms" };
}

const result = await main();
writeResultFile(result);

if (JSON_MODE) console.log(JSON.stringify(result, null, 2));
if (!result.passed) Deno.exit(1);
