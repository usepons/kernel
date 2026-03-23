/** SHA-256 tamper detection for module manifests. */

import { encodeHex } from 'jsr:@std/encoding@^1/hex';
import { crypto as stdCrypto } from 'jsr:@std/crypto@^1';

/**
 * Compute SHA-256 hash of a module.json file for tamper detection.
 */
export function computeManifestHash(manifestPath: string): string {
  const content = Deno.readTextFileSync(manifestPath);
  const data = new TextEncoder().encode(content);
  const hash = stdCrypto.subtle.digestSync("SHA-256", data);
  return encodeHex(new Uint8Array(hash));
}
