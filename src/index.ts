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

import { join } from "node:path";
import type { LogLevel } from "./config/types.ts";
import Kernel from './kernel.ts';
import { getPonsHome } from "jsr:@pons/sdk@0.2";


interface ParsedArgs {
  daemon: boolean;
  logLevel: LogLevel;
}

function parseArgs(): ParsedArgs {
  const args = Deno.args;
  let daemon = false;
  let logLevel = 'info' as LogLevel;
  

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-d' || args[i] === '--daemon' || args[i] === '--background') daemon = true;
    if (args[i] === '-log-level' || args[i] === '--log') logLevel = args[i + 1] as LogLevel;
  }

  return { daemon, logLevel };
}

const {logLevel, daemon} = parseArgs();
const configPath = join(getPonsHome(), "config.yaml");

const kernel = new Kernel(logLevel);

kernel
  .boot(configPath)
  .then(() => kernel.start(daemon))
  .then(() => {
    // Block forever — kernel runs until SIGINT/SIGTERM triggers shutdown()
    return new Promise(() => {});
  })
  .catch((err: unknown) => {
    console.error('Kernel failed to start:', err);
    Deno.exit(1);
  });
