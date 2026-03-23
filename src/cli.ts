/**
 * Kernel CLI extensions.
 *
 * Registers kernel lifecycle commands (start, stop, restart, status)
 * and module management commands into the CLI program.
 */

import { initConfigCommands } from "./config/cli.ts";
import { registerPermissionsCommand } from "./cli/permissions.ts";
import { registerKernelCommands } from "./cli/kernel-commands.ts";
import { registerModuleCommands } from "./cli/module-commands.ts";

// deno-lint-ignore no-explicit-any
type Command = { command(name: string): any; description(desc: string): any; action(fn: any): any; option(flags: string, desc: string): any };

export function init(program: Command): void {
  registerKernelCommands(program);
  registerModuleCommands(program);
  registerPermissionsCommand(program);
  initConfigCommands(program);
}
