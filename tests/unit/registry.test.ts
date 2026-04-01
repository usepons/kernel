import { assertEquals, assertExists } from 'jsr:@std/assert';
import { ModuleRegistry } from '../../src/module/registry.ts';
import type { ModuleManifest } from '@pons/sdk';

function makeManifest(id: string, overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id,
    name: `Module ${id}`,
    minProtocolVersion: '1.0',
    permissions: {},
    ...overrides,
  };
}

Deno.test('ModuleRegistry: register() adds module with starting status', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  const entry = reg.get('a');
  assertExists(entry);
  assertEquals(entry.status, 'starting');
  assertEquals(entry.restartCount, 0);
  assertEquals(entry.pid, undefined);
});

Deno.test('ModuleRegistry: setStatus() updates module status', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.setStatus('a', 'ready');
  assertEquals(reg.get('a')?.status, 'ready');
});

Deno.test('ModuleRegistry: setStatus() on unknown id does nothing', () => {
  const reg = new ModuleRegistry();
  // should not throw
  reg.setStatus('nonexistent', 'ready');
});

Deno.test('ModuleRegistry: setProcess() sets pid', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  const fakeProc = { pid: 1234, connected: true, send: () => {}, kill: () => {}, on: () => {}, once: () => {} };
  reg.setProcess('a', fakeProc);
  assertEquals(reg.get('a')?.pid, 1234);
});

Deno.test('ModuleRegistry: incrementRestarts() returns new count', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  assertEquals(reg.incrementRestarts('a'), 1);
  assertEquals(reg.incrementRestarts('a'), 2);
  assertEquals(reg.get('a')?.restartCount, 2);
});

Deno.test('ModuleRegistry: resetRestartCount() resets to zero', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.incrementRestarts('a');
  reg.incrementRestarts('a');
  reg.resetRestartCount('a');
  assertEquals(reg.get('a')?.restartCount, 0);
});

Deno.test('ModuleRegistry: ids() returns all registered ids', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.register(makeManifest('b'));
  const ids = reg.ids().sort();
  assertEquals(ids, ['a', 'b']);
});

Deno.test('ModuleRegistry: all() returns all entries', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.register(makeManifest('b'));
  assertEquals(reg.all().length, 2);
});

Deno.test('ModuleRegistry: remove() deletes the entry', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.remove('a');
  assertEquals(reg.get('a'), undefined);
});

// ─── Service Directory ────────────────────────────────────────

Deno.test('ModuleRegistry: registerServices() maps service to moduleId', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('llm'));
  reg.registerServices('llm', ['providerRegistry', 'model-router']);
  assertEquals(reg.resolveService('providerRegistry'), 'llm');
  assertEquals(reg.resolveService('model-router'), 'llm');
});

Deno.test('ModuleRegistry: registerServices() rejects duplicate from different module', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.register(makeManifest('b'));
  reg.registerServices('a', ['shared-service']);
  const rejected = reg.registerServices('b', ['shared-service']);
  assertEquals(rejected, ['shared-service']);
  // original owner unchanged
  assertEquals(reg.resolveService('shared-service'), 'a');
});

Deno.test('ModuleRegistry: registerServices() allows re-registration by same module', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.registerServices('a', ['svc']);
  const rejected = reg.registerServices('a', ['svc']);
  assertEquals(rejected, []);
});

Deno.test('ModuleRegistry: resolveService() returns undefined for unknown service', () => {
  const reg = new ModuleRegistry();
  assertEquals(reg.resolveService('unknown'), undefined);
});

Deno.test('ModuleRegistry: removeServices() clears all services for a module', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.registerServices('a', ['svc1', 'svc2']);
  reg.removeServices('a');
  assertEquals(reg.resolveService('svc1'), undefined);
  assertEquals(reg.resolveService('svc2'), undefined);
});

Deno.test('ModuleRegistry: listServices() returns all registered services', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  reg.registerServices('a', ['svc1', 'svc2']);
  const services = reg.listServices().map(s => s.service).sort();
  assertEquals(services, ['svc1', 'svc2']);
});

Deno.test('ModuleRegistry: allPublic() returns serializable shape', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a', { provides: ['svc1'] }));
  reg.setStatus('a', 'ready');
  const pub = reg.allPublic();
  assertEquals(pub.length, 1);
  assertEquals(pub[0].id, 'a');
  assertEquals(pub[0].status, 'ready');
  assertEquals(pub[0].provides, ['svc1']);
});

// ─── Circular Dependency Detection ────────────────────────────

Deno.test('ModuleRegistry: detectCircularDeps() returns null when no deps', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a'));
  assertEquals(reg.detectCircularDeps('a'), null);
});

Deno.test('ModuleRegistry: detectCircularDeps() returns null for linear chain', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a', { requires: ['svc-b'] }));
  reg.register(makeManifest('b', { provides: ['svc-b'] }));
  reg.registerServices('b', ['svc-b']);
  assertEquals(reg.detectCircularDeps('a'), null);
});

Deno.test('ModuleRegistry: detectCircularDeps() detects A→B→A cycle', () => {
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a', { requires: ['svc-b'] }));
  reg.register(makeManifest('b', { requires: ['svc-a'] }));
  reg.registerServices('a', ['svc-a']);
  reg.registerServices('b', ['svc-b']);
  const cycle = reg.detectCircularDeps('a');
  assertExists(cycle);
  // cycle should contain both a and b
  assertEquals(cycle!.includes('a'), true);
  assertEquals(cycle!.includes('b'), true);
});

Deno.test('ModuleRegistry: detectCircularDeps() — diamond graph no false positive', () => {
  // Diamond: A→B, A→C, B→D, C→D — no cycle
  const reg = new ModuleRegistry();
  reg.register(makeManifest('a', { requires: ['svc-b', 'svc-c'] }));
  reg.register(makeManifest('b', { requires: ['svc-d'] }));
  reg.register(makeManifest('c', { requires: ['svc-d'] }));
  reg.register(makeManifest('d', { provides: ['svc-d'] }));
  reg.registerServices('b', ['svc-b']);
  reg.registerServices('c', ['svc-c']);
  reg.registerServices('d', ['svc-d']);
  assertEquals(reg.detectCircularDeps('a'), null);
});
