/** Interactive terminal permission prompter for foreground mode. */

import type { PermissionStore } from './permissions.ts';
import type { KernelLogger } from '../logs/logger.ts';

export type PromptDecision = 'grant-session' | 'grant-always' | 'deny';

export interface PermissionPromptRequest {
  moduleId: string;
  type: 'net' | 'env' | 'read' | 'write' | 'run' | 'sys' | 'topic' | 'service';
  value: string;
  reason?: string;
}

export class PermissionPrompter {
  private readonly pending = new Map<string, { resolve: (d: PromptDecision) => void }>();
  private isPrompting = false;
  private queue: Array<{ request: PermissionPromptRequest; resolve: (d: PromptDecision) => void }> = [];
  private reader: ReadableStreamDefaultReader<string> | null = null;

  constructor(
    private readonly logger: KernelLogger,
    private readonly interactive: boolean,  // true when running in foreground with a TTY
  ) {}

  /** Check if we can prompt (foreground + TTY). */
  get canPrompt(): boolean {
    return this.interactive && Deno.stdin.isTerminal();
  }

  /**
   * Ask the user about a permission. Returns the decision.
   * If not interactive, returns 'deny' immediately.
   */
  async prompt(request: PermissionPromptRequest): Promise<PromptDecision> {
    if (!this.canPrompt) return 'deny';

    return new Promise<PromptDecision>((resolve) => {
      this.queue.push({ request, resolve });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isPrompting || this.queue.length === 0) return;
    this.isPrompting = true;

    const { request, resolve } = this.queue.shift()!;

    const typeLabel = request.type === 'topic' ? 'topic access to'
      : request.type === 'service' ? 'service access to'
      : `${request.type} access to`;

    // Use dim for the border, bold for the module name
    const DIM = '\x1b[2m';
    const BOLD = '\x1b[1m';
    const CYAN = '\x1b[36m';
    const RESET = '\x1b[0m';
    const YELLOW = '\x1b[33m';

    console.log('');
    console.log(`${DIM}───────────────────────────────────────────${RESET}`);
    console.log(`${YELLOW}[PERM]${RESET} Module ${BOLD}${CYAN}"${request.moduleId}"${RESET} requests ${typeLabel} ${BOLD}"${request.value}"${RESET}`);
    if (request.reason) {
      console.log(`       Reason: ${request.reason}`);
    }

    const answer = await this.readLine(`${DIM}Allow? [y]es / [n]o / [a]lways: ${RESET}`);

    const normalized = answer.trim().toLowerCase();
    let decision: PromptDecision;
    if (normalized === 'y' || normalized === 'yes') {
      decision = 'grant-session';
    } else if (normalized === 'a' || normalized === 'always') {
      decision = 'grant-always';
    } else {
      decision = 'deny';
    }

    resolve(decision);
    this.isPrompting = false;
    this.processQueue(); // process next in queue
  }

  private async readLine(prompt: string): Promise<string> {
    // Write prompt to stderr (stdout is used for IPC in some contexts)
    const encoder = new TextEncoder();
    await Deno.stderr.write(encoder.encode(prompt));

    // Read from stdin
    const buf = new Uint8Array(256);
    const n = await Deno.stdin.read(buf);
    if (n === null) return 'n';
    return new TextDecoder().decode(buf.subarray(0, n));
  }

  /** Cleanup any pending prompts on shutdown. */
  shutdown(): void {
    for (const item of this.queue) {
      item.resolve('deny');
    }
    this.queue = [];
  }
}
