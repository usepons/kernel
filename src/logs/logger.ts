/**
 * Kernel Logger — centralized log aggregation with compact formatting.
 *
 * Dev:  custom log stream with single-line output, module prefix, and log grouping
 * Prod: plain JSON (no pretty-printing)
 */

import pino from 'npm:pino@^10.3.1';
import { join } from 'jsr:@std/path@^1';
import type { LoggingConfig } from '../config/types.ts';
import { createLogStream } from './stream.ts';
import { formatInline } from './utils.ts';


export type KernelLogger = pino.Logger;

export interface CreateLoggerOptions extends LoggingConfig {
  logDir?: string;
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface DailyFileOutput {
  write: (data: string) => void;
  close: () => void;
}

function createDailyFileOutput(logDir: string): DailyFileOutput {
  Deno.mkdirSync(logDir, { recursive: true });

  let currentDate = todayStamp();
  let fileHandle = Deno.openSync(join(logDir, `kernel-${currentDate}.log`), { write: true, create: true, append: true });
  const encoder = new TextEncoder();

  return {
    write(data: string) {
      const now = todayStamp();
      if (now !== currentDate) {
        fileHandle.close();
        currentDate = now;
        fileHandle = Deno.openSync(join(logDir, `kernel-${currentDate}.log`), { write: true, create: true, append: true });
      }
      fileHandle.writeSync(encoder.encode(data));
    },
    close() {
      try { fileHandle.close(); } catch { /* already closed */ }
    },
  };
}

/** Close the log file handle if the logger was created with a logDir. */
let _activeFileOutput: DailyFileOutput | null = null;
export function closeLogger(): void {
  _activeFileOutput?.close();
  _activeFileOutput = null;
}

export function createLogger(config?: CreateLoggerOptions): KernelLogger {
  const level = config?.level || 'info';

  if (Deno.env.get('NODE_ENV') === 'production') {
    return pino({ level });
  }

  const stdoutStream = createLogStream({ colorize: true });

  if (!config?.logDir) {
    return pino({ level }, stdoutStream);
  }

  // Close any previous file output to avoid fd leaks on multiple createLogger() calls
  _activeFileOutput?.close();
  const dailyFile = createDailyFileOutput(config.logDir);
  _activeFileOutput = dailyFile;
  const fileStream = createLogStream({ colorize: false, output: dailyFile.write });

  const multi = pino.multistream([
    { stream: stdoutStream, level: level as pino.Level },
    { stream: fileStream, level: level as pino.Level },
  ]);
  return pino({ level }, multi);
}

/**
 * Write a log message forwarded from a module process.
 * Data fields are inlined as key=value in the message string.
 */
export function writeModuleLog(
  logger: pino.Logger,
  moduleId: string,
  level: string,
  msg: string,
  data?: Record<string, unknown>,
  topic?: string,
): void {
  const child = logger.child({ module: moduleId, ...(topic ? { topic } : {}) });
  const fullMsg = data ? msg + ' ' + formatInline(data) : msg;
  const fn = child[level as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'];
  if (typeof fn === 'function') {
    fn.call(child, fullMsg);
  } else {
    child.info(fullMsg);
  }
}

/**
 * Write a grouped log message — header line + sub-items rendered as a tree.
 * The custom log stream picks up `_groupItems` and formats them with ├/└ chars.
 */
export function writeModuleLogGroup(
  logger: pino.Logger,
  moduleId: string,
  level: string,
  msg: string,
  data: Record<string, unknown> | undefined,
  items: Array<{ msg: string; data?: Record<string, unknown> }>,
): void {
  const child = logger.child({ module: moduleId });
  const fullMsg = data ? msg + ' ' + formatInline(data) : msg;
  const logObj = { _groupItems: items };
  const fn = child[level as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'];
  if (typeof fn === 'function') {
    fn.call(child, logObj, fullMsg);
  } else {
    child.info(logObj, fullMsg);
  }
}

