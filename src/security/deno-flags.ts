/** Translates declared module permissions into Deno CLI sandbox flags. */

import { join } from 'jsr:@std/path@^1';
import type { ModulePermissions } from './types.ts';
import { COMMON_ENV_ALLOWLIST } from './constants.ts';

// ─── Binary Resolution ──────────────────────────────────────────

/**
 * Check whether a binary exists on the host by attempting to resolve it.
 * Returns true if the binary is found in PATH, false otherwise.
 */
function binaryExists(name: string): boolean {
  try {
    const cmd = Deno.build.os === 'windows' ? 'where' : 'which';
    const result = new Deno.Command(cmd, {
      args: [name],
      stdout: 'null',
      stderr: 'null',
    }).outputSync();
    return result.success;
  } catch {
    return false;
  }
}

// ─── Dangerous Binaries ─────────────────────────────────────────

const DANGEROUS_BINARIES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'csh', 'dash',
  'cmd', 'powershell', 'pwsh',
  'python', 'python3', 'node', 'ruby', 'perl',
]);

// ─── Deno Flag Translation ──────────────────────────────────────

/**
 * Convert declared permissions into Deno CLI permission flags.
 * Never produces --allow-all.
 *
 * Relative paths in read/write permissions are resolved against moduleDir
 * (the directory containing the module's runner). This lets modules declare
 * "." to mean "my own directory" and have it translate to an absolute path.
 *
 * Run permissions are resolved lazily: binaries not found on the host
 * are silently omitted from --allow-run. This lets modules declare all
 * binaries they *may* call without requiring every one to be installed.
 */
export function translateToDenoFlags(permissions: ModulePermissions, moduleDir?: string, approvedDangerous?: string[]): string[] {
  const flags: string[] = [];

  const home = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '';
  const expandTilde = (p: string): string => p.startsWith('~/') ? join(home, p.slice(2)) : p;
  const resolvePaths = (paths: string[]): string[] =>
    paths.map(p => {
      const expanded = expandTilde(p);
      return expanded.startsWith('/') ? expanded : (moduleDir ? join(moduleDir, expanded) : expanded);
    });

  // net
  if (permissions.net && permissions.net.length > 0) {
    flags.push(`--allow-net=${permissions.net.join(',')}`);
  } else {
    flags.push('--deny-net');
  }

  // read
  if (permissions.read && permissions.read.length > 0) {
    flags.push(`--allow-read=${resolvePaths(permissions.read).join(',')}`);
  } else {
    flags.push('--deny-read');
  }

  // write
  if (permissions.write && permissions.write.length > 0) {
    flags.push(`--allow-write=${resolvePaths(permissions.write).join(',')}`);
  } else {
    flags.push('--deny-write');
  }

  // env — exact names only, no globs; always include common allowlist
  const envVars = [...new Set([...COMMON_ENV_ALLOWLIST, ...(permissions.env ?? [])])];
  if (envVars.length > 0) {
    flags.push(`--allow-env=${envVars.join(',')}`);
  } else {
    flags.push('--deny-env');
  }

  // run — only include binaries found in PATH
  if (permissions.run && permissions.run.length > 0) {
    const approvedSet = new Set(approvedDangerous ?? []);
    const available = permissions.run.filter(binaryExists);
    const blocked = available.filter(b => DANGEROUS_BINARIES.has(b) && !approvedSet.has(b));
    if (blocked.length > 0) {
      console.warn(`[security] Blocking shell interpreters: ${blocked.join(', ')} — approve via UI or CLI to allow`);
    }
    const allowed = available.filter(b => !DANGEROUS_BINARIES.has(b) || approvedSet.has(b));
    if (allowed.length > 0) {
      flags.push(`--allow-run=${allowed.join(',')}`);
    } else {
      flags.push('--deny-run');
    }
  } else {
    flags.push('--deny-run');
  }

  // sys — specific keys
  if (permissions.sys && permissions.sys.length > 0) {
    flags.push(`--allow-sys=${permissions.sys.join(',')}`);
  } else {
    flags.push('--deny-sys');
  }

  return flags;
}
