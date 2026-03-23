/**
 * Module source audit tool.
 *
 * Scans module source files for `node:` API imports that operate outside
 * the Deno permission sandbox. Findings are informational warnings shown
 * before the user approves permissions during installation.
 *
 * PONS-005: This scanner is defense-in-depth, not a security gate.
 * It can be bypassed via dynamic imports, string concatenation, or
 * transitive dependencies. Runtime Deno permissions are the primary control.
 */

import { walkSync } from 'jsr:@std/fs@^1/walk';

const NODE_BYPASS_PATTERNS: { pattern: RegExp; label: string; bypasses: string }[] = [
  // Static imports: from 'node:*'
  { pattern: /from\s+['"]node:fs['"]/, label: 'node:fs', bypasses: '--allow-read/--allow-write' },
  { pattern: /from\s+['"]node:fs\/promises['"]/, label: 'node:fs/promises', bypasses: '--allow-read/--allow-write' },
  { pattern: /from\s+['"]node:child_process['"]/, label: 'node:child_process', bypasses: '--allow-run' },
  { pattern: /from\s+['"]node:net['"]/, label: 'node:net', bypasses: '--allow-net' },
  { pattern: /from\s+['"]node:http['"]/, label: 'node:http', bypasses: '--allow-net' },
  { pattern: /from\s+['"]node:https['"]/, label: 'node:https', bypasses: '--allow-net' },
  { pattern: /from\s+['"]node:tls['"]/, label: 'node:tls', bypasses: '--allow-net (TLS)' },
  // PONS-005: Additional dangerous node:* modules
  { pattern: /from\s+['"]node:process['"]/, label: 'node:process', bypasses: '--allow-env (process.env bypass)' },
  { pattern: /from\s+['"]node:dgram['"]/, label: 'node:dgram', bypasses: '--allow-net (UDP)' },
  { pattern: /from\s+['"]node:worker_threads['"]/, label: 'node:worker_threads', bypasses: 'permission inheritance' },
  { pattern: /from\s+['"]node:os['"]/, label: 'node:os', bypasses: '--allow-sys' },
  { pattern: /from\s+['"]node:vm['"]/, label: 'node:vm', bypasses: 'arbitrary code execution' },
  { pattern: /from\s+['"]node:module['"]/, label: 'node:module', bypasses: 'createRequire bypass' },
  { pattern: /from\s+['"]node:dns['"]/, label: 'node:dns', bypasses: '--allow-net (DNS)' },
  { pattern: /from\s+['"]node:cluster['"]/, label: 'node:cluster', bypasses: 'process spawning' },
  { pattern: /from\s+['"]node:inspector['"]/, label: 'node:inspector', bypasses: 'debugger access' },
  // PONS-005: Dynamic import patterns
  { pattern: /import\s*\(\s*['"\`]node:/, label: 'dynamic import(node:*)', bypasses: 'Deno sandbox bypass' },
  { pattern: /import\s*\(.*['"\`]node:/, label: 'dynamic import with node:', bypasses: 'Deno sandbox bypass' },
  // PONS-005: createRequire patterns
  { pattern: /createRequire/, label: 'createRequire', bypasses: 'Deno sandbox bypass via require()' },
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
  } catch (err) {
    // PONS-005: Surface scan errors instead of swallowing silently
    findings.push({
      file: '<scan-error>',
      import: `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
      bypasses: 'unknown — manual review required',
    });
  }

  return findings;
}

export function formatAuditWarning(findings: AuditFinding[]): string {
  if (findings.length === 0) return '';

  const scanErrors = findings.filter(f => f.file === '<scan-error>');
  const realFindings = findings.filter(f => f.file !== '<scan-error>');

  const lines: string[] = [];

  if (realFindings.length > 0) {
    const imports = [...new Set(realFindings.map(f => f.import))];
    const bypasses = [...new Set(realFindings.map(f => f.bypasses))];
    lines.push(
      '\u26a0 Sandbox notice:',
      `  This module uses Node.js APIs (${imports.join(', ')}) that operate outside`,
      '  the Deno permission sandbox. Declared restrictions for',
      `  ${bypasses.join(', ')} may not fully apply.`,
      '  Note: This scan is best-effort and does not guarantee safety.',
    );
  }

  if (scanErrors.length > 0) {
    lines.push(
      '\u26a0 Scan incomplete:',
      `  ${scanErrors.map(e => e.import).join('; ')}`,
    );
  }

  return lines.join('\n');
}
