import { assertEquals, assertExists } from 'jsr:@std/assert';
import { PermissionStore } from '../../src/security/permissions.ts';

function makeTmpHome(): string {
  const dir = Deno.makeTempDirSync();
  return dir;
}

const MOCK_PERMS = { net: ['https://api.example.com'], read: ['/tmp'] };
const MOCK_HASH = 'abc123';

Deno.test('PermissionStore: approve and isApproved', () => {
  const store = new PermissionStore(makeTmpHome());
  assertEquals(store.isApproved('mod-a'), false);
  store.approve('mod-a', MOCK_PERMS, MOCK_HASH);
  assertEquals(store.isApproved('mod-a'), true);
  const approved = store.getApproved('mod-a');
  assertExists(approved);
  assertEquals(approved!.permissions.net, ['https://api.example.com']);
});

Deno.test('PermissionStore: deriveCapabilitiesFromManifest — merges subscribes + publishes', () => {
  const store = new PermissionStore(makeTmpHome());
  const caps = store.deriveCapabilitiesFromManifest({
    subscribes: ['inbound:message', 'system:module:ready'],
    publishes: ['outbound:ws', 'inbound:message'],
    requires: ['llm', 'memory'],
    optionalRequires: ['skills'],
    capabilities: { topics: ['extra:topic'], services: ['extra:svc'] },
  });
  // topics: merged + deduped
  assertEquals(caps.topics!.includes('inbound:message'), true);
  assertEquals(caps.topics!.includes('outbound:ws'), true);
  assertEquals(caps.topics!.includes('system:module:ready'), true);
  assertEquals(caps.topics!.includes('extra:topic'), true);
  // services: merged + deduped
  assertEquals(caps.services!.includes('llm'), true);
  assertEquals(caps.services!.includes('memory'), true);
  assertEquals(caps.services!.includes('skills'), true);
  assertEquals(caps.services!.includes('extra:svc'), true);
});

Deno.test('PermissionStore: addPendingRequest and resolvePending grant', () => {
  const store = new PermissionStore(makeTmpHome());
  store.approve('mod-a', MOCK_PERMS, MOCK_HASH);
  const pending = store.addPendingRequest('mod-a', { env: ['API_KEY'] }, 'needs api key');
  assertExists(pending.id);

  const resolved = store.resolvePending('mod-a', pending.id, 'grant');
  assertEquals(resolved, true);

  // Should now be in effective permissions
  const effective = store.getEffectivePermissions('mod-a');
  assertExists(effective);
  assertEquals(effective!.env!.includes('API_KEY'), true);
});

Deno.test('PermissionStore: resolvePending deny moves to denied', () => {
  const store = new PermissionStore(makeTmpHome());
  store.approve('mod-a', MOCK_PERMS, MOCK_HASH);
  const pending = store.addPendingRequest('mod-a', { env: ['SECRET'] });
  store.resolvePending('mod-a', pending.id, 'deny');
  assertEquals(store.isDenied('mod-a', { env: ['SECRET'] }), true);
});

Deno.test('PermissionStore: isDenied returns true for denied permission', () => {
  const store = new PermissionStore(makeTmpHome());
  store.approve('mod-a', MOCK_PERMS, MOCK_HASH);
  const pending = store.addPendingRequest('mod-a', { run: ['/bin/sh'] });
  store.resolvePending('mod-a', pending.id, 'deny');
  assertEquals(store.isDenied('mod-a', { run: ['/bin/sh'] }), true);
  assertEquals(store.isDenied('mod-a', { run: ['/bin/ls'] }), false);
});

Deno.test('PermissionStore: getEffectivePermissions merges base + dynamic', () => {
  const store = new PermissionStore(makeTmpHome());
  store.approve('mod-a', { net: ['https://a.com'], read: ['/data'] }, MOCK_HASH);
  store.addDynamicPermission('mod-a', { net: ['https://b.com'] });
  const effective = store.getEffectivePermissions('mod-a');
  assertExists(effective);
  assertEquals(effective!.net!.includes('https://a.com'), true);
  assertEquals(effective!.net!.includes('https://b.com'), true);
  assertEquals(effective!.read!.includes('/data'), true);
});
