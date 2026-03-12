/**
 * Output formatting utilities for the kernel CLI.
 *
 * Subset of cli/src/formatters.ts — only the functions needed
 * by the kernel's module management commands.
 */

import chalk from "npm:chalk@^5.6.2";
import Table from "npm:cli-table3@^0.6.5";

// --- JSON Output ---

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// --- Table Helpers ---

export function createTable(
  headers: string[],
  colWidths?: number[],
): Table.Table {
  const opts: Table.TableConstructorOptions = {
    head: headers.map((h) => chalk.cyan.bold(h)),
    style: {
      head: [],
      border: [],
    },
    chars: {
      "top": "-",
      "top-mid": "+",
      "top-left": "+",
      "top-right": "+",
      "bottom": "-",
      "bottom-mid": "+",
      "bottom-left": "+",
      "bottom-right": "+",
      "left": "|",
      "left-mid": "+",
      "mid": "-",
      "mid-mid": "+",
      "right": "|",
      "right-mid": "+",
      "middle": "|",
    },
  };
  if (colWidths) {
    opts.colWidths = colWidths;
  }
  return new Table(opts) as Table.Table;
}

// --- Section Headers ---

export function printHeader(text: string): void {
  console.log();
  console.log(chalk.bold.white(text));
  console.log(chalk.dim("\u2500".repeat(text.length + 4)));
}

// --- Messages ---

export function printError(text: string): void {
  console.error(chalk.red(`  Error: ${text}`));
}

export function printWarning(text: string): void {
  console.log(chalk.yellow(`  Warning: ${text}`));
}
