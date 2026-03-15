import { join } from 'jsr:@std/path@^1';
import { encodeHex } from 'jsr:@std/encoding@^1/hex';

export function generateAndWriteToken(ponsHome: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = encodeHex(bytes);

  const runtimeDir = join(ponsHome, '.runtime');
  try { Deno.mkdirSync(runtimeDir, { recursive: true }); } catch { /* exists */ }

  const tokenPath = join(runtimeDir, 'kernel.token');
  Deno.writeTextFileSync(tokenPath, token, { mode: 0o600 });

  return token;
}

export function readToken(ponsHome: string): string | null {
  try {
    return Deno.readTextFileSync(join(ponsHome, '.runtime', 'kernel.token')).trim();
  } catch {
    return null;
  }
}
