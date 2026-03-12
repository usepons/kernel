/**
 * Kernel Logger — centralized log aggregation with compact formatting.
 *
 * Dev:  custom log stream with single-line output, module prefix, and log grouping
 * Prod: plain JSON (no pretty-printing)
 */

import pino from 'npm:pino@^10.3.1';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

function createDailyFileOutput(logDir: string): (data: string) => void {
  mkdirSync(logDir, { recursive: true });

  let currentDate = todayStamp();
  let fileStream = createWriteStream(join(logDir, `kernel-${currentDate}.log`), { flags: 'a' });

  return (data: string) => {
    const now = todayStamp();
    if (now !== currentDate) {
      fileStream.end();
      currentDate = now;
      fileStream = createWriteStream(join(logDir, `kernel-${currentDate}.log`), { flags: 'a' });
    }
    fileStream.write(data);
  };
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

  const fileOutput = createDailyFileOutput(config.logDir);
  const fileStream = createLogStream({ colorize: false, output: fileOutput });

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

