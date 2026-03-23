/** IPC message validation for kernel-module communication. */

import type { ModuleMessage } from '@pons/sdk';

export const VALID_MODULE_TYPES = new Set([
  'ready', 'log', 'log-group', 'ack', 'nack',
  'publish', 'call', 'pong', 'call:response',
  'rpc_request', 'rpc_response',
]);

export const MAX_IPC_STRING_LEN = 256;

/** Validate incoming IPC data is a known ModuleMessage with required fields. */
export function validateModuleMessage(raw: unknown): { msg: ModuleMessage } | { msg: null; reason: string } {
  if (raw == null || typeof raw !== 'object') return { msg: null, reason: 'not an object' };
  const data = raw as Record<string, unknown>;
  if (typeof data.type !== 'string' || !VALID_MODULE_TYPES.has(data.type)) return { msg: null, reason: `unknown type: ${String(data.type)?.slice(0, 50)}` };

  // Validate required fields per message type
  const checkStr = (field: string): string | null => {
    const v = data[field];
    if (typeof v !== 'string') return `${field} is not a string`;
    if (v.length > MAX_IPC_STRING_LEN) return `${field} exceeds ${MAX_IPC_STRING_LEN} chars (${v.length})`;
    return null;
  };

  let err: string | null = null;
  switch (data.type) {
    case 'rpc_request':
      err = checkStr('id') ?? checkStr('service') ?? checkStr('method');
      break;
    case 'rpc_response':
      err = checkStr('id');
      break;
    case 'publish':
      err = checkStr('topic');
      break;
    case 'call':
      err = checkStr('id') ?? checkStr('method');
      break;
    case 'call:response':
      err = checkStr('id');
      break;
  }

  if (err) return { msg: null, reason: `${data.type}: ${err}` };
  return { msg: raw as ModuleMessage };
}
