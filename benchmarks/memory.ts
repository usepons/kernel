/**
 * Memory Consumption Benchmark
 *
 * Spawns the kernel, waits for it to be ready, then samples RSS
 * over a configurable window. Reports statistics and outputs CSV.
 */

import {
  type BenchmarkResult,
  colors as c,
  computeStats,
  formatKb,
  JSON_MODE,
  writeResultFile,
  killProcess,
  getRssKb,
  getTreeRssKb,
  printHeader,
  printStats,
  removePidFile,
  spawnKernel,
  waitForPidFile,
  writeProgress,
  clearProgress,
} from "./utils.ts";

const SAMPLE_INTERVAL_MS = parseInt(Deno.env.get("BENCH_SAMPLE_INTERVAL") || "500");
const SAMPLE_DURATION_MS = parseInt(Deno.env.get("BENCH_SAMPLE_DURATION") || "10000");
const STABILIZE_MS = 3_000;

interface MemorySample {
  timestampMs: number;
  rssKb: number;
  treeRssKb: number;
}

async function main(): Promise<BenchmarkResult> {
  if (!JSON_MODE) {
    printHeader("Memory (RSS)", {
      "sample window": `${SAMPLE_DURATION_MS}ms`,
      "sample interval": `${SAMPLE_INTERVAL_MS}ms`,
      "stabilization": `${STABILIZE_MS}ms`,
    });
  }

  removePidFile();
  const process = spawnKernel();

  const kernelPid = await waitForPidFile(30_000);
  if (kernelPid === null) {
    if (!JSON_MODE) console.log(`   ${c.red}Kernel did not start within 30s${c.reset}\n`);
    await killProcess(process, "SIGKILL");
    return { name: "Memory (RSS)", passed: false };
  }

  if (!JSON_MODE) {
    console.log(`   ${c.dim}PID ${kernelPid} — stabilizing...${c.reset}`);
  }
  await new Promise((r) => setTimeout(r, STABILIZE_MS));

  // Sample memory
  const samples: MemorySample[] = [];
  const startTime = performance.now();
  const totalSamples = Math.ceil(SAMPLE_DURATION_MS / SAMPLE_INTERVAL_MS);
  let sampleIdx = 0;

  while (performance.now() - startTime < SAMPLE_DURATION_MS) {
    const rssKb = await getRssKb(kernelPid);
    const treeRssKb = await getTreeRssKb(kernelPid);
    if (rssKb !== null && treeRssKb !== null) {
      samples.push({ timestampMs: performance.now() - startTime, rssKb, treeRssKb });
    }
    sampleIdx++;
    if (!JSON_MODE) {
      writeProgress(sampleIdx, totalSamples, treeRssKb !== null ? `tree: ${formatKb(treeRssKb)}` : "—");
    }
    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
  }

  if (!JSON_MODE) clearProgress();

  await killProcess(process);
  removePidFile();

  if (samples.length === 0) {
    if (!JSON_MODE) console.log(`   ${c.red}No samples collected.${c.reset}\n`);
    return { name: "Memory (RSS)", passed: false };
  }

  const rssValues = samples.map((s) => s.rssKb);
  const treeRssValues = samples.map((s) => s.treeRssKb);
  const stats = computeStats(rssValues);
  const treeStats = computeStats(treeRssValues);

  // Memory growth detection (time-ordered, not sorted)
  const q = Math.floor(treeRssValues.length / 4);
  const firstQ = treeRssValues.slice(0, q);
  const lastQ = treeRssValues.slice(treeRssValues.length - q);
  const firstAvg = firstQ.reduce((a, b) => a + b, 0) / firstQ.length;
  const lastAvg = lastQ.reduce((a, b) => a + b, 0) / lastQ.length;
  const growthPct = ((lastAvg - firstAvg) / firstAvg) * 100;

  if (!JSON_MODE) {
    console.log(`\n   ${c.bold}Kernel process${c.reset}`);
    printStats(stats, { unit: "kb" });

    console.log(`   ${c.bold}Full process tree${c.reset} ${c.dim}(kernel + modules)${c.reset}`);
    printStats(treeStats, { unit: "kb" });

    const growthColor = Math.abs(growthPct) < 5 ? c.green : growthPct > 10 ? c.red : c.yellow;
    console.log(`   ${c.dim}Growth${c.reset} ${growthColor}${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}%${c.reset} ${c.dim}(first vs last quarter, tree)${c.reset}`);

    if (growthPct > 10) {
      console.log(`\n   ${c.yellow}Possible memory leak detected${c.reset}`);
    }

    // Write CSV
    const csvPath = new URL("./memory-samples.csv", import.meta.url).pathname;
    const csv = ["timestamp_ms,rss_kb,tree_rss_kb"]
      .concat(samples.map((s) => `${s.timestampMs.toFixed(0)},${s.rssKb},${s.treeRssKb}`))
      .join("\n");
    await Deno.writeTextFile(csvPath, csv);
    console.log(`   ${c.dim}CSV: ${csvPath}${c.reset}\n`);
  }

  return {
    name: "Memory (RSS)",
    passed: true,
    stats: treeStats,
    unit: "kb",
    extra: { growthPct, samples: samples.length, kernelStats: stats },
  };
}

const result = await main();
writeResultFile(result);

if (JSON_MODE) console.log(JSON.stringify(result, null, 2));
if (!result.passed) Deno.exit(1);
