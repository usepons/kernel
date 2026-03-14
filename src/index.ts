/**
 * Pons Kernel — microkernel entry point.
 *
 * Responsibilities (and only these):
 *   1. In-memory message bus (pub/sub forwarding)
 *   2. Module process lifecycle (spawn / kill / restart / hot-swap)
 *   3. Centralized logging (all module logs flow through here)
 *   4. IPC protocol between kernel and modules
 *   5. Service directory — dynamic discovery of module-provided services
 *
 * Everything else lives in modules.
 */

import { join } from "jsr:@std/path";
import type { LogLevel } from "./config/types.ts";
import Kernel from './kernel.ts';
import { getPonsHome } from "jsr:@pons/sdk@0.2";


interface ParsedArgs {
  logLevel: LogLevel;
}

function parseArgs(): ParsedArgs {
  const args = Deno.args;
  let logLevel = 'info' as LogLevel;
  

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-log-level' || args[i] === '--log') logLevel = args[i + 1] as LogLevel;
  }

  return { logLevel };
}

const {logLevel} = parseArgs();
const configPath = join(getPonsHome(), "config.yaml");

const kernel = new Kernel(logLevel, configPath);

kernel
  .boot()
  .then(() => kernel.start())
  .then(() => {
    // Block forever — kernel runs until SIGINT/SIGTERM triggers shutdown()
    return new Promise(() => {});
  })
  .catch((err: unknown) => {
    console.error('Kernel failed to start:', err);
    Deno.exit(1);
  });
