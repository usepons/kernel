/**
 * Config CLI commands — get, set, list, doctor, edit, reset, wizard.
 *
 * Works without a running kernel by importing ConfigManager directly
 * and discovering module schemas from the filesystem.
 */

import { join, resolve } from "jsr:@std/path@^1";
import chalk from "npm:chalk@^5.6.2";
import { getPonsHome } from "jsr:@pons/sdk@^0.2";
import type { ModuleManifest } from "jsr:@pons/sdk@^0.2";
import { ConfigManager } from "./manager.ts";
import { printHeader, printError, printWarning } from "../formatters.ts";

// deno-lint-ignore no-explicit-any
type Command = { command(name: string): any; description(desc: string): any; action(fn: any): any; option(flags: string, desc: string): any };

/**
 * Discover all installed modules and their directories.
 */
function discoverModules(home: string): Array<{ manifest: ModuleManifest; moduleDir: string }> {
  const modulesDir = resolve(home, "modules");
  try { Deno.statSync(modulesDir); } catch { return []; }

  const result: Array<{ manifest: ModuleManifest; moduleDir: string }> = [];

  for (const entry of Deno.readDirSync(modulesDir)) {
    const moduleDir = join(modulesDir, entry.name);
    try { if (!Deno.statSync(moduleDir).isDirectory) continue; } catch { continue; }

    const manifestPath = join(moduleDir, "module.json");
    try { Deno.statSync(manifestPath); } catch { continue; }

    try {
      const manifest: ModuleManifest = JSON.parse(Deno.readTextFileSync(manifestPath));
      if (manifest.id && manifest.name) {
        result.push({ manifest, moduleDir });
      }
    } catch { /* skip */ }
  }

  return result;
}

/**
 * Create a ConfigManager with all schemas loaded.
 */
async function createManager(): Promise<ConfigManager> {
  const home = getPonsHome();
  const manager = new ConfigManager(join(home, "config.yaml"));
  const modules = discoverModules(home);
  await manager.discoverSchemas(modules);
  manager.load();
  return manager;
}

/**
 * Check if kernel is running and send config update signal.
 */
function notifyKernel(_changedKeys: string[]): void {
  const home = getPonsHome();
  const pidPath = join(home, ".runtime", "kernel.pid");
  try { Deno.statSync(pidPath); } catch { return; }

  try {
    const pid = parseInt(Deno.readTextFileSync(pidPath).trim(), 10);
    if (!Number.isNaN(pid)) {
      Deno.kill(pid, "SIGUSR1");
    }
  } catch {
    // Kernel not running — ignore
  }
}

/**
 * Format a config value for display.
 */
function formatValue(value: unknown): string {
  if (value === undefined) return chalk.dim("(not set)");
  if (value === null) return chalk.dim("null");
  if (typeof value === "object") return chalk.white(JSON.stringify(value, null, 2));
  return chalk.white(String(value));
}

/**
 * Print config as a tree.
 */
function printTree(data: Record<string, unknown>, prefix = ""): void {
  const entries = Object.entries(data);
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└─" : "├─";
    const childPrefix = isLast ? "  " : "│ ";

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      console.log(`${prefix}${connector} ${chalk.cyan(key)}`);
      printTree(value as Record<string, unknown>, prefix + childPrefix);
    } else {
      console.log(`${prefix}${connector} ${chalk.cyan(key)}: ${formatValue(value)}`);
    }
  }
}

export function initConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("Manage Pons configuration");

  /* ---- config get ---- */
  config
    .command("get <key-path>")
    .description("Get a config value by key path (e.g. models.default.provider)")
    .action(async (keyPath: string) => {
      const manager = await createManager();
      const value = manager.get(keyPath);
      if (value === undefined) {
        printError(`Key "${keyPath}" not found`);
        Deno.exitCode = 1;
      } else {
        console.log(formatValue(value));
      }
    });

  /* ---- config set ---- */
  config
    .command("set <key-path> <value>")
    .description("Set a config value (validates against schema)")
    .action(async (keyPath: string, value: string) => {
      const manager = await createManager();
      const result = manager.set(keyPath, value);
      if (result.success) {
        console.log(chalk.green(`✓ ${keyPath} = ${formatValue(result.coerced)}`));
        notifyKernel([keyPath]);
      } else {
        printError(result.error!);
        Deno.exitCode = 1;
      }
    });

  /* ---- config list ---- */
  config
    .command("list")
    .description("Show full configuration")
    .option("--section <key>", "Show only a specific section")
    .option("--json", "Output as JSON")
    .action(async (opts: { section?: string; json?: boolean }) => {
      const manager = await createManager();

      if (opts.json) {
        const data = opts.section ? manager.getSection(opts.section) : manager.getAll();
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      if (opts.section) {
        const data = manager.getSection(opts.section);
        if (data === undefined) {
          printError(`Section "${opts.section}" not found`);
          Deno.exitCode = 1;
          return;
        }
        printHeader(`Config: ${opts.section}`);
        if (typeof data === "object" && data !== null) {
          printTree(data as Record<string, unknown>);
        } else {
          console.log(formatValue(data));
        }
      } else {
        printHeader("Configuration");
        printTree(manager.getAll());
      }
      console.log();
    });

  /* ---- config doctor ---- */
  config
    .command("doctor")
    .description("Validate config and offer to fix issues")
    .action(async () => {
      const manager = await createManager();
      const report = manager.diagnose();

      printHeader("Config Doctor");

      if (report.valid && report.issues.length === 0) {
        console.log(chalk.green("  ✓ Configuration is valid"));
        console.log();
        return;
      }

      for (const issue of report.issues) {
        const icon = issue.fixable ? chalk.yellow("⚠") : chalk.red("✗");
        console.log(`  ${icon} ${chalk.cyan(issue.path)}: ${issue.message}`);
        if (issue.fixable && issue.suggestedValue !== undefined) {
          console.log(chalk.dim(`    → suggested: ${JSON.stringify(issue.suggestedValue)}`));
        }
      }
      console.log();

      const fixable = report.issues.filter(i => i.fixable);
      if (fixable.length > 0) {
        const { confirm } = await import("npm:@clack/prompts@^0.10.1");
        const shouldFix = await confirm({
          message: `Fix ${fixable.length} issue(s) automatically?`,
        });

        if (shouldFix === true) {
          manager.fix(report);
          console.log(chalk.green(`  ✓ Fixed ${fixable.length} issue(s)`));
          notifyKernel(fixable.map(i => i.path));
        }
      }
      console.log();
    });

  /* ---- config edit ---- */
  config
    .command("edit")
    .description("Open config.yaml in $EDITOR")
    .action(async () => {
      const home = getPonsHome();
      const configPath = join(home, "config.yaml");
      const editor = Deno.env.get("EDITOR") || Deno.env.get("VISUAL") || "vi";

      new Deno.Command(editor, { args: [configPath], stdin: "inherit", stdout: "inherit", stderr: "inherit" }).outputSync();

      // Re-validate after edit
      const manager = await createManager();
      const report = manager.diagnose();
      if (!report.valid) {
        printWarning("Config has validation issues after edit. Run 'pons config doctor' to fix.");
      } else {
        console.log(chalk.green("✓ Config is valid"));
        notifyKernel([]);
      }
    });

  /* ---- config reset ---- */
  config
    .command("reset [key-path]")
    .description("Reset config to schema defaults")
    .option("--all", "Reset everything to defaults")
    .action(async (keyPath: string | undefined, opts: { all?: boolean }) => {
      const manager = await createManager();

      if (opts.all) {
        const { confirm } = await import("npm:@clack/prompts@^0.10.1");
        const shouldReset = await confirm({
          message: "Reset ALL configuration to defaults? This cannot be undone.",
        });
        if (shouldReset !== true) return;

        manager.resetAll();
        console.log(chalk.green("✓ All config reset to defaults"));
        notifyKernel([]);
        return;
      }

      if (!keyPath) {
        printError("Specify a key path or use --all");
        Deno.exitCode = 1;
        return;
      }

      const result = manager.resetKey(keyPath);
      if (result.success) {
        console.log(chalk.green(`✓ ${keyPath} reset to default: ${formatValue(result.coerced)}`));
        notifyKernel([keyPath]);
      } else {
        printError(result.error!);
        Deno.exitCode = 1;
      }
    });

  /* ---- config wizard (interactive) ---- */
  config
    .command("wizard")
    .description("Interactive configuration wizard")
    .action(async () => {
      const { select, text, isCancel } = await import("npm:@clack/prompts@^0.10.1");
      const manager = await createManager();
      const sections = manager.listSections();

      if (sections.length === 0) {
        printError("No config schemas registered. Install modules first.");
        return;
      }

      while (true) {
        const sectionChoice = await select({
          message: "Select config section",
          options: [
            ...sections.map(s => ({
              value: s.key,
              label: s.key,
              hint: s.description,
            })),
            { value: "__exit__", label: "Exit" },
          ],
        });

        if (isCancel(sectionChoice) || sectionChoice === "__exit__") break;

        const sectionKey = sectionChoice as string;
        const currentData = manager.getSection(sectionKey);

        console.log();
        printHeader(`Current ${sectionKey} config`);
        if (currentData && typeof currentData === "object") {
          printTree(currentData as Record<string, unknown>);
        } else {
          console.log(chalk.dim("  (empty)"));
        }
        console.log();

        const keyToEdit = await text({
          message: `Enter key path to edit (relative to ${sectionKey})`,
          placeholder: "e.g. default.provider",
        });

        if (isCancel(keyToEdit) || !keyToEdit) continue;

        const fullPath = `${sectionKey}.${keyToEdit}`;
        const currentValue = manager.get(fullPath);
        console.log(`  Current value: ${formatValue(currentValue)}`);

        const newValue = await text({
          message: `New value for ${fullPath}`,
          placeholder: currentValue !== undefined ? String(currentValue) : "",
        });

        if (isCancel(newValue)) continue;

        const result = manager.set(fullPath, newValue);
        if (result.success) {
          console.log(chalk.green(`  ✓ ${fullPath} = ${formatValue(result.coerced)}`));
          notifyKernel([fullPath]);
        } else {
          printError(result.error!);
        }
      }
    });
}
