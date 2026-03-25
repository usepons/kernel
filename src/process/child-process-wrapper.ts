/**
 * DenoChildProcessWrapper — bridges Deno's native process API to a Node.js-style interface.
 *
 * Deno's ChildProcess speaks ReadableStream and WritableStream. The rest of the kernel
 * was designed around Node-style event emitters (`proc.on('message', ...)`) because that
 * model maps naturally to the message-passing protocol. Rather than rewrite the kernel's
 * IPC layer, we wrap each spawned process in this adapter so the rest of the system
 * never needs to know which runtime it's running on.
 *
 * IPC messages travel as newline-delimited JSON over stdout/stdin. This is intentional:
 * it works across runtimes (Node, Deno, Bun, Python) without any native bindings, and
 * it makes the protocol observable with nothing more than `cat`.
 */

import type { ModuleProcess } from '../module/registry.ts';

type MessageHandler = (msg: unknown) => void;
type ExitHandler = (code: number | null, signal: string | null) => void;
type DataHandler = (data: Uint8Array) => void;

export class DenoChildProcessWrapper implements ModuleProcess {
  readonly pid: number;
  connected: boolean = true;

  private messageHandlers: MessageHandler[] = [];
  private exitHandlers: ExitHandler[] = [];
  private stdoutHandlers: DataHandler[] = [];
  private stderrHandlers: DataHandler[] = [];

  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  private readonly _proc: Deno.ChildProcess;
  private readonly _stdin: WritableStreamDefaultWriter<Uint8Array>;

  /** Serialized write queue — ensures ordering and backpressure on stdin writes. */
  private _writeChain: Promise<void> = Promise.resolve();
  private _writeQueueDepth = 0;
  private static readonly MAX_WRITE_QUEUE = 512;

  constructor(proc: Deno.ChildProcess) {
    this._proc = proc;
    this.pid = proc.pid;
    this._stdin = proc.stdin.getWriter();

    // Read stdout lines as JSON IPC messages
    this._readLines(proc.stdout, (line) => {
      // Try to parse as IPC JSON first
      try {
        const msg = JSON.parse(line);
        for (const h of this.messageHandlers) h(msg);
      } catch {
        // Not JSON — treat as plain stdout data
        const data = this.encoder.encode(line + '\n');
        for (const h of this.stdoutHandlers) h(data);
      }
    });

    // Read stderr as plain data
    this._readLines(proc.stderr, (line) => {
      const data = this.encoder.encode(line + '\n');
      for (const h of this.stderrHandlers) h(data);
    });

    // Watch for exit
    proc.status.then((status) => {
      this.connected = false;
      const code = status.success ? 0 : (status.code ?? 1);
      const signal = status.signal ?? null;
      for (const h of this.exitHandlers) h(code, signal);
    }).catch(() => {
      // OS-level error reading process status (e.g. waitpid failure)
      this.connected = false;
      for (const h of this.exitHandlers) h(null, null);
    });
  }

  private async _readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += this.decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      }
      if (buffer.trim()) onLine(buffer.trim());
    } catch {
      // Stream closed
    } finally {
      reader.releaseLock();
    }
  }

  on(event: 'message', handler: MessageHandler): void;
  on(event: 'exit', handler: ExitHandler): void;
  on(event: string, handler: MessageHandler | ExitHandler): void {
    if (event === 'message') this.messageHandlers.push(handler as MessageHandler);
    else if (event === 'exit') this.exitHandlers.push(handler as ExitHandler);
  }

  once(event: 'exit', handler: ExitHandler): void {
    const wrapper: ExitHandler = (code, signal) => {
      this.exitHandlers = this.exitHandlers.filter((h) => h !== wrapper);
      handler(code, signal);
    };
    this.exitHandlers.push(wrapper);
  }

  get stdout() {
    return {
      on: (event: string, handler: DataHandler) => {
        if (event === 'data') this.stdoutHandlers.push(handler);
      },
    };
  }

  get stderr() {
    return {
      on: (event: string, handler: DataHandler) => {
        if (event === 'data') this.stderrHandlers.push(handler);
      },
    };
  }

  send(msg: unknown): void {
    if (!this.connected) return;
    // Drop messages if queue is saturated — prevent unbounded memory growth
    if (this._writeQueueDepth >= DenoChildProcessWrapper.MAX_WRITE_QUEUE) {
      this.connected = false;
      return;
    }
    const line = JSON.stringify(msg) + '\n';
    const bytes = this.encoder.encode(line);
    this._writeQueueDepth++;
    // Queue writes to preserve ordering and apply backpressure.
    // No retry — a partial write + retry would duplicate/garble IPC messages.
    this._writeChain = this._writeChain.then(async () => {
      this._writeQueueDepth--;
      if (!this.connected) return;
      try {
        await this._stdin.write(bytes);
      } catch {
        this.connected = false;
      }
    });
  }

  kill(signal: string = 'SIGTERM'): void {
    try {
      this._proc.kill(signal as Deno.Signal);
    } catch {
      // Process already exited
    }
    this.connected = false;
  }
}
