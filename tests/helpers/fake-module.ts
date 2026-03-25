/**
 * Fake module for integration tests.
 *
 * A minimal module runner that speaks the Pons IPC protocol over stdio.
 * Used by integration tests to spawn a real child process without needing
 * any of the real module infrastructure.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function send(msg: unknown): void {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(msg) + '\n'));
}

async function main(): Promise<void> {
  let buffer = '';
  try {
    for await (const chunk of Deno.stdin.readable) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          switch (msg.type) {
            case 'init':
              send({
                type: 'ready',
                manifest: {
                  id: 'fake',
                  name: 'Fake Module',
                  minProtocolVersion: '1.0',
                  permissions: {},
                  provides: [],
                  requires: [],
                },
              });
              break;
            case 'ping':
              send({ type: 'pong' });
              break;
            case 'shutdown':
              Deno.exit(0);
              break;
            case 'install':
              // no-op for tests
              break;
            default:
              break;
          }
        } catch {
          // ignore malformed lines
        }
      }
    }
  } catch {
    // stdin closed
  }
  Deno.exit(0);
}

main();
