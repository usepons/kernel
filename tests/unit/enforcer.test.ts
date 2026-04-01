import { assertEquals } from 'jsr:@std/assert';
import { SecurityEnforcer } from '../../src/security/enforcer.ts';
import { PermissionStore } from '../../src/security/permissions.ts';
import type { KernelLogger } from '../../src/logs/logger.ts';

function makeLogger(): KernelLogger {
  const noop = () => {};
  return {
    info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop,
    child: () => makeLogger(),
    level: 'info',
    isLevelEnabled: () => true,
  } as unknown as KernelLogger;
}

function makeEnforcer(mode: 'strict' | 'warn' | 'off' = 'strict'): SecurityEnforcer {
  const store = new PermissionStore(Deno.makeTempDirSync());
  return new SecurityEnforcer(store, makeLogger(), mode);
}

// ─── RPC Checks ──────────────────────────────────────────────

Deno.test('SecurityEnforcer: checkRpc — allows declared service', () => {
  const enforcer = makeEnforcer();
  const result = enforcer.checkRpc('mod-a', 'llm', { services: ['llm', 'memory'] });
  assertEquals(result, null);
});

Deno.test('SecurityEnforcer: checkRpc — denies undeclared service in strict mode', () => {
  const enforcer = makeEnforcer('strict');
  const result = enforcer.checkRpc('mod-a', 'secret-service', { services: ['llm'] });
  assertEquals(result?.action, 'deny');
  assertEquals(result?.type, 'rpc');
});

Deno.test('SecurityEnforcer: checkRpc — warns for undeclared service in warn mode', () => {
  const enforcer = makeEnforcer('warn');
  const result = enforcer.checkRpc('mod-a', 'secret-service', { services: ['llm'] });
  assertEquals(result?.action, 'warn');
});

Deno.test('SecurityEnforcer: checkRpc — allows everything in off mode', () => {
  const enforcer = makeEnforcer('off');
  const result = enforcer.checkRpc('mod-a', 'anything', { services: [] });
  assertEquals(result, null);
});

// ─── Topic Checks ────────────────────────────────────────────

Deno.test('SecurityEnforcer: checkTopic — allows declared topic', () => {
  const enforcer = makeEnforcer();
  const result = enforcer.checkTopic('mod-a', 'inbound:message', 'publish', { topics: ['inbound:message'] });
  assertEquals(result, null);
});

Deno.test('SecurityEnforcer: checkTopic — denies undeclared topic in strict mode', () => {
  const enforcer = makeEnforcer('strict');
  const result = enforcer.checkTopic('mod-a', 'secret:topic', 'subscribe', { topics: ['inbound:message'] });
  assertEquals(result?.action, 'deny');
  assertEquals(result?.type, 'topic');
});

// ─── Config Checks ───────────────────────────────────────────

Deno.test('SecurityEnforcer: checkConfig — allows own section', () => {
  const enforcer = makeEnforcer();
  const result = enforcer.checkConfig('mod-a', 'agent.model', 'agent');
  assertEquals(result, null);
});

Deno.test('SecurityEnforcer: checkConfig — denies other section', () => {
  const enforcer = makeEnforcer('strict');
  const result = enforcer.checkConfig('mod-a', 'llm.apiKey', 'agent');
  assertEquals(result?.action, 'deny');
  assertEquals(result?.type, 'config');
});

Deno.test('SecurityEnforcer: checkConfig — denies path traversal', () => {
  const enforcer = makeEnforcer('strict');
  const result = enforcer.checkConfig('mod-a', '__proto__.polluted', 'agent');
  assertEquals(result?.action, 'deny');
});
