/** Spawns module child processes with sandboxed environments and runtime-specific flags. */

import { dirname, join } from 'jsr:@std/path@^1';
import type { ModuleManifest } from '@pons/sdk';
import type { KernelLogger } from '../logs/logger.ts';
import { translateToDenoFlags } from '../security/permissions.ts';
import type { PermissionStore } from '../security/permissions.ts';
import { existsSync } from '../utils/fs.ts';
import { DenoChildProcessWrapper } from './child-process-wrapper.ts';
import { COMMON_ENV_ALLOWLIST } from '../security/constants.ts';

const SYSTEM_ENV_KEYS = [
  'PATH', 'HOME', 'TERM', 'LANG', 'SHELL', 'USER',
  'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DENO_DIR',
  ...COMMON_ENV_ALLOWLIST,
];

export class ProcessForker {
  private denoConfigPath: string | null;

  constructor(
    private readonly logger: KernelLogger,
    private readonly permissionStore: PermissionStore | undefined,
    projectRoot: string,
  ) {
    this.denoConfigPath = this.findDenoConfig(projectRoot);
  }

  fork(runnerPath: string, manifest: ModuleManifest, env?: Record<string, string>): DenoChildProcessWrapper {
    const effectivePerms = this.permissionStore?.getEffectivePermissions(manifest.id);
    const allowedEnvKeys = new Set([
      ...SYSTEM_ENV_KEYS,
      ...(effectivePerms?.env ?? []),
    ]);

    const childEnv: Record<string, string> = {};
    for (const key of allowedEnvKeys) {
      const val = Deno.env.get(key);
      if (val !== undefined) childEnv[key] = val;
    }
    if (env) Object.assign(childEnv, env);

    const runtime = manifest.runtime ?? 'deno';
    const { executable, args: runtimeArgs } = this.buildRuntimeCommand(runtime, runnerPath, manifest);

    const cmd = new Deno.Command(executable, {
      args: runtimeArgs,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
      env: childEnv,
    });

    const proc = cmd.spawn();
    return new DenoChildProcessWrapper(proc);
  }

  private buildRuntimeCommand(
    runtime: string,
    runnerPath: string,
    manifest: ModuleManifest,
  ): { executable: string; args: string[] } {
    const moduleDir = dirname(runnerPath);

    switch (runtime) {
      case 'deno': {
        const effective = this.permissionStore?.getEffectivePermissions(manifest.id);
        // Dangerous binaries (sh, bash, etc.) are allowed if explicitly approved in permission store
        const approvedRun = effective?.run ?? [];
        const denoPerms = effective
          ? translateToDenoFlags(effective, moduleDir, approvedRun)
          : ['--deny-all'];
        const moduleDenoConfig = join(moduleDir, 'deno.json');
        const configPath = existsSync(moduleDenoConfig) ? moduleDenoConfig : this.denoConfigPath;
        const denoArgs = configPath ? [`--config=${configPath}`] : [];
        return {
          executable: Deno.execPath(),
          args: ['run', ...denoPerms, '--unstable-sloppy-imports', ...denoArgs, runnerPath],
        };
      }
      case 'node':
        return { executable: 'node', args: [runnerPath] };
      case 'bun':
        return { executable: 'bun', args: ['run', runnerPath] };
      case 'python':
        return { executable: 'python', args: [runnerPath] };
      case 'php':
        return { executable: 'php', args: [runnerPath] };
      case 'go':
      case 'rust':
      case 'binary':
        return { executable: runnerPath, args: [] };
      default:
        this.logger.warn({ module: manifest.id, runtime }, `Unknown runtime "${runtime}" — falling back to deno`);
        return this.buildRuntimeCommand('deno', runnerPath, manifest);
    }
  }

  private findDenoConfig(projectRoot: string): string | null {
    const fromProject = join(projectRoot, 'deno.json');
    if (existsSync(fromProject)) return fromProject;

    let dir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, 'deno.json');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    return null;
  }
}
