/**
 * Custom log stream — replaces pino-pretty to support grouped sub-logs.
 *
 * Two grouping modes:
 *
 * 1. Explicit (_groupItems) — module sends all items at once:
 *
 *   [19:35:11] INFO  agent               Starting agent loop agentId=default
 *                                         ├ SOUL.md loaded soulLength=1841
 *                                         ├ IDENTITY.md loaded agentMdLength=1065
 *                                         └ Context assembled systemPromptLength=8889
 *
 * 2. Auto-grouping (topic) — consecutive logs with same module:topic are buffered:
 *
 *   [19:35:11] INFO  agent               Boot
 *                                         ├ Starting agent loop
 *                                         └ Context assembled len=8889
 */

import { Writable } from 'node:stream';

// ─── ANSI Colors ─────────────────────────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RED_BRIGHT = '\x1b[91m';

// ─── Level formatting ────────────────────────────────────────

const LEVEL_MAP: Record<number, { label: string; color: string }> = {
  10: { label: 'TRACE', color: DIM },
  20: { label: 'DEBUG', color: DIM },
  30: { label: 'INFO ', color: GREEN },
  40: { label: 'WARN ', color: YELLOW },
  50: { label: 'ERROR', color: RED },
  60: { label: 'FATAL', color: RED_BRIGHT },
};

function levelInfo(level: number): { label: string; color: string } {
  return LEVEL_MAP[level] ?? { label: 'INFO ', color: GREEN };
}

/** Format a data record as inline key=value pairs for log output. */
export function formatInline(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([k, v]) => v !== undefined && v !== null && k !== 'stack')
    .map(([k, v]) => {
      if (typeof v === 'string') {
        const clean = v.split('\n')[0]!;
        const limit = k === 'error' ? 512 : 120;
        return `${k}=${clean.length > limit ? clean.slice(0, limit) + '...' : clean}`;
      }
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(' ');
}

// ─── Time formatting ─────────────────────────────────────────

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ─── Date formatting ─────────────────────────────────────────

function formatDate(epoch: number): string {
  const d = new Date(epoch);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();

  // Use locale to determine format: EU (DD-MM-YYYY) or US (MM-DD-YYYY)
  const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
  const isUSFormat = locale.startsWith('en-US');

  return isUSFormat ? `${mm}-${dd}-${yyyy}` : `${dd}-${mm}-${yyyy}`;
}

// ─── Layout constants ────────────────────────────────────────

// [DD-MM-YYYY HH:MM:ss] = 21 + 2 (brackets+space) = 23 + 1 (space) = 24
// LEVEL  = 5 + 1 = 6
// module (padded to 20) = 20
// Total prefix = 50
const MODULE_PAD = 20;
const FLUSH_TIMEOUT_MS = 100;

// ─── Stream factory ──────────────────────────────────────────

export interface LogStreamOptions {
  colorize?: boolean;
  output?: (data: string) => void;
}

export function createLogStream(opts: LogStreamOptions = {}): Writable {
  const color = opts.colorize ?? true;
  const encoder = new TextEncoder();
  const write = opts.output ?? ((data: string) => Deno.stdout.writeSync(encoder.encode(data)));

  // ─── Auto-grouping buffer ──────────────────────────────────
  let currentGroup: {
    key: string;
    topic: string;
    level: number;
    module: string;
    time: number;
    items: Array<{ msg: string; inlineData: string }>;
    flushTimer: ReturnType<typeof setTimeout>;
  } | null = null;

  function renderLine(time: number, level: number, mod: string, msg: string, inlineData: string): string {
    const timeStr = formatTime(time);
    const dateStr = formatDate(time);
    const { label, color: lvlColor } = levelInfo(level);
    const modStr = mod.padEnd(MODULE_PAD);

    if (color) {
      return `${DIM}[${dateStr} ${timeStr}]${RESET} ${lvlColor}${label}${RESET} ${CYAN}${modStr}${RESET}${msg}${DIM}${inlineData}${RESET}`;
    }
    return `[${dateStr} ${timeStr}] ${label} ${modStr}${msg}${inlineData}`;
  }

  function renderTreeItems(items: Array<{ msg: string; inlineData: string }>): void {
    const prefixLen = 24 + 6 + MODULE_PAD;
    const indent = ' '.repeat(prefixLen);

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const isLast = i === items.length - 1;
      const branch = isLast ? '└ ' : '├ ';

      let subLine: string;
      if (color) {
        subLine = `${DIM}${indent}${branch}${RESET}${item.msg}${DIM}${item.inlineData}${RESET}`;
      } else {
        subLine = `${indent}${branch}${item.msg}${item.inlineData}`;
      }
      write(subLine + '\n');
    }
  }

  function flushGroup(): void {
    if (!currentGroup) return;
    clearTimeout(currentGroup.flushTimer);

    // Header line: topic name with timestamp/level/module from first item
    const header = renderLine(currentGroup.time, currentGroup.level, currentGroup.module, currentGroup.topic, '');
    write(header + '\n');

    // Tree items
    renderTreeItems(currentGroup.items);

    currentGroup = null;
  }

  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const log = JSON.parse(chunk.toString());
        const time = log.time ?? Date.now();
        const level = log.level ?? 30;
        const mod = (log.module as string) || 'kernel';
        const msg = (log.msg as string) || '';
        const topic = log.topic as string | undefined;

        // Build inline data (skip pino internals + _groupItems + module + topic)
        const { level: _l, msg: _m, time: _t, pid: _p, hostname: _h, name: _n, module: _mod, _groupItems, topic: _topic, ...rest } = log;
        const inlineData = Object.keys(rest).length > 0 ? ' ' + formatInline(rest) : '';

        // ─── Existing _groupItems (explicit groups) — pass through immediately ──
        if (_groupItems) {
          flushGroup();
          const line = renderLine(time, level, mod, msg, inlineData);
          write(line + '\n');

          const items = _groupItems as Array<{ msg: string; data?: Record<string, unknown> }>;
          if (items.length > 0) {
            const mapped = items.map((item: { msg: string; data?: Record<string, unknown> }) => ({
              msg: item.msg,
              inlineData: item.data && Object.keys(item.data).length > 0 ? ' ' + formatInline(item.data) : '',
            }));
            renderTreeItems(mapped);
          }
          callback();
          return;
        }

        // ─── Auto-grouping by topic ──────────────────────────────
        if (topic) {
          const key = `${mod}:${topic}`;
          if (currentGroup && currentGroup.key === key) {
            // Same group — buffer the item
            currentGroup.items.push({ msg, inlineData });
            clearTimeout(currentGroup.flushTimer);
            currentGroup.flushTimer = setTimeout(flushGroup, FLUSH_TIMEOUT_MS);
          } else {
            // Different group — flush old, start new
            flushGroup();
            const flushTimer = setTimeout(flushGroup, FLUSH_TIMEOUT_MS);
            currentGroup = { key, topic, level, module: mod, time, items: [{ msg, inlineData }], flushTimer };
          }
          callback();
          return;
        }

        // ─── No topic — immediate output ─────────────────────────
        flushGroup();
        const line = renderLine(time, level, mod, msg, inlineData);
        write(line + '\n');
      } catch {
        // Non-JSON — pass through as-is
        const raw = chunk.toString().trim();
        if (raw) write(raw + '\n');
      }
      callback();
    },
  });
}
