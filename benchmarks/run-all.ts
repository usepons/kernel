/**
 * Run All Benchmarks
 *
 * Executes each benchmark sequentially and produces a unified summary.
 *
 * Flags:
 *   --json   Output machine-readable JSON instead of pretty output
 *
 * Env:
 *   BENCH_ITERATIONS       Iteration count (default: 10)
 *   BENCH_SAMPLE_DURATION  Memory sampling window in ms (default: 10000)
 *   BENCH_SAMPLE_INTERVAL  Memory sampling interval in ms (default: 500)
 */

import { colors as c, formatKb, formatMs, type BenchmarkResult } from "./utils.ts";

const JSON_MODE = Deno.args.includes("--json");

const benchmarks = [
  { name: "Boot Time", file: "boot-time.ts" },
  { name: "Memory (RSS)", file: "memory.ts" },
  { name: "Shutdown Time", file: "shutdown-time.ts" },
  { name: "Module Spawn", file: "module-spawn.ts" },
  { name: "IPC Latency", file: "ipc-latency.ts" },
  { name: "RPC Latency", file: "rpc-latency.ts" },
  { name: "Module Restart", file: "module-restart.ts" },
  { name: "Scale Test", file: "scale.ts" },
];

async function runBenchmark(
  file: string,
  jsonMode: boolean,
): Promise<BenchmarkResult> {
  // Write structured result to a temp file so we only run once
  const resultFile = await Deno.makeTempFile({ suffix: ".json" });

  const args = ["run", "--allow-all", file, "--result-file", resultFile];
  if (jsonMode) args.push("--json");

  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    cwd: new URL(".", import.meta.url).pathname,
    stdout: jsonMode ? "null" : "inherit",
    stderr: "inherit",
    env: Deno.env.toObject(),
  });

  const { success: passed } = await cmd.output();

  // Read structured result from temp file
  try {
    const text = await Deno.readTextFile(resultFile);
    const result = JSON.parse(text) as BenchmarkResult;
    return result;
  } catch {
    return { name: file, passed };
  } finally {
    try { await Deno.remove(resultFile); } catch { /* */ }
  }
}

function printSummaryTable(results: BenchmarkResult[]): void {
  const nameWidth = 16;
  const colWidth = 12;

  console.log();
  console.log(
    `   ${c.bold}${"Benchmark".padEnd(nameWidth)}${"Avg".padStart(colWidth)}${"P50".padStart(colWidth)}${"P95".padStart(colWidth)}  Status${c.reset}`,
  );
  console.log(`   ${c.dim}${"─".repeat(nameWidth + colWidth * 3 + 8)}${c.reset}`);

  for (const r of results) {
    const name = r.name.padEnd(nameWidth);
    const status = r.passed
      ? `${c.green}PASS${c.reset}`
      : `${c.red}FAIL${c.reset}`;

    if (r.stats) {
      const fmt = r.unit === "kb" ? formatKb : formatMs;
      const avg = fmt(r.stats.avg).padStart(colWidth);
      const p50 = fmt(r.stats.p50).padStart(colWidth);
      const p95 = fmt(r.stats.p95).padStart(colWidth);
      console.log(`   ${name}${avg}${p50}${p95}  ${status}`);
    } else {
      const dash = "—".padStart(colWidth);
      console.log(`   ${name}${dash}${dash}${dash}  ${status}`);
    }
  }

  console.log();
}

async function main() {
  if (!JSON_MODE) {
    console.log();
    console.log(`   ${c.bold}Pons Kernel — Performance Benchmarks${c.reset}`);
    console.log(`   ${c.dim}${new Date().toISOString()}${c.reset}`);
    console.log(`   ${c.dim}Deno ${Deno.version.deno} / V8 ${Deno.version.v8} / TS ${Deno.version.typescript}${c.reset}`);
  }

  const results: BenchmarkResult[] = [];

  for (const bench of benchmarks) {
    if (!JSON_MODE) {
      console.log(`\n   ${c.dim}${"─".repeat(50)}${c.reset}`);
    }

    const result = await runBenchmark(bench.file, JSON_MODE);
    result.name = bench.name;
    results.push(result);
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({ benchmarks: results, timestamp: new Date().toISOString() }, null, 2));
  } else {
    console.log(`\n   ${c.dim}${"─".repeat(50)}${c.reset}`);
    printSummaryTable(results);
  }

  const failed = results.filter((r) => !r.passed).length;
  if (failed > 0) Deno.exit(1);
}

main();
