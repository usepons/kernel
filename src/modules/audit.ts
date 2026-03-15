/**
 * Module source audit tool.
 *
 * Scans module source files for `node:` API imports that operate outside
 * the Deno permission sandbox. Findings are informational warnings shown
 * before the user approves permissions during installation.
 */

import { walkSync } from 'jsr:@std/fs@^1/walk';

const NODE_BYPASS_PATTERNS: { pattern: RegExp; label: string; bypasses: string }[] = [
  { pattern: /from\s+['"]node:fs['"]/, label: 'node:fs', bypasses: '--allow-read/--allow-write' },
  { pattern: /from\s+['"]node:fs\/promises['"]/, label: 'node:fs/promises', bypasses: '--allow-read/--allow-write' },
  { pattern: /from\s+['"]node:child_process['"]/, label: 'node:child_process', bypasses: '--allow-run' },
  { pattern: /from\s+['"]node:net['"]/, label: 'node:net', bypasses: '--allow-net' },
  { pattern: /from\s+['"]node:http['"]/, label: 'node:http', bypasses: '--allow-net' },
  { pattern: /from\s+['"]node:https['"]/, label: 'node:https', bypasses: '--allow-net' },
];

export interface AuditFinding {
  file: string;
  import: string;
  bypasses: string;
}

export function auditModuleSource(moduleDir: string): AuditFinding[] {
  const findings: AuditFinding[] = [];

  try {
    for (const entry of walkSync(moduleDir, {
      exts: ['.ts', '.js', '.mts', '.mjs'],
      skip: [/node_modules/, /\.git/],
    })) {
      if (!entry.isFile) continue;
      const content = Deno.readTextFileSync(entry.path);

      for (const { pattern, label, bypasses } of NODE_BYPASS_PATTERNS) {
        if (pattern.test(content)) {
          findings.push({
            file: entry.path.replace(moduleDir, '.'),
            import: label,
            bypasses,
          });
        }
      }
    }
  } catch {
    // If we can't scan, skip silently
  }

  return findings;
}

export function formatAuditWarning(findings: AuditFinding[]): string {
  if (findings.length === 0) return '';

  const imports = [...new Set(findings.map(f => f.import))];
  const bypasses = [...new Set(findings.map(f => f.bypasses))];

  return [
    '\u26a0 Sandbox notice:',
    `  This module uses Node.js APIs (${imports.join(', ')}) that operate outside`,
    '  the Deno permission sandbox. Declared restrictions for',
    `  ${bypasses.join(', ')} may not fully apply.`,
  ].join('\n');
}
