/**
 * Integration tests for LifecycleManager.
 *
 * These tests spawn real child processes (the fake-module helper) and verify
 * that the kernel correctly manages their lifecycle: spawning, ready detection,
 * and graceful shutdown.
 *
 * Uses sanitizeOps: false and sanitizeResources: false because child processes
 * leave lingering resources that Deno's sanitizer would flag as leaks.
 */

import { assertEquals } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path@^1';
import { LifecycleManager } from '../../src/lifecycle.ts';
import { MessageBus } from '../../src/messaging/bus.ts';
import { createLogger } from '../../src/logs/logger.ts';
import { PermissionStore } from '../../src/security/permissions.ts';
import type { DiscoveredModule } from '../../src/module/loader.ts';
import type { ModuleManifest } from '@pons/sdk';

const FAKE_MODULE_PATH = new URL('../helpers/fake-module.ts', import.meta.url).pathname;

function makeDiscoveredModule(overrides: Partial<ModuleManifest> = {}): DiscoveredModule {
  const manifest: ModuleManifest = {
    id: 'fake',
    name: 'Fake Module',
    minProtocolVersion: '1.0',
    permissions: {},
    provides: [],
    requires: [],
    ...overrides,
  };
  return {
    manifest,
    runnerPath: FAKE_MODULE_PATH,
    moduleDir: new URL('../helpers/', import.meta.url).pathname,
  };
}

/** Wait until condition() returns true or timeout expires. Returns true if condition met. */
async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function makePermissionStore(moduleId: string): Promise<{ store: PermissionStore; cleanup: () => Promise<void> }> {
  // Use a temp dir so save() doesn't pollute the real ~/.kiria/permissions.yaml
  const tmpDir = await Deno.makeTempDir();
  const store = new PermissionStore(tmpDir);
  store.approve(moduleId, {
    net: [], read: [], write: [], env: [], run: [], sys: [],
  }, 'test-hash');
  return {
    store,
    cleanup: () => Deno.remove(tmpDir, { recursive: true }).catch(() => {}),
  };
}

async function makeLifecycle(config: unknown = {}) {
  const logger = createLogger({ level: 'fatal', levels: {} });
  const bus = new MessageBus();
  const { store: permissionStore, cleanup } = await makePermissionStore('fake');
  const lm = new LifecycleManager(
    logger,
    bus,
    { config, workspacePath: Deno.env.get('HOME') ?? '/tmp', projectRoot: Deno.env.get('HOME') ?? '/tmp' },
    async (_moduleId, _method, _params) => undefined,
    undefined,
    permissionStore,
  );
  return { lm, bus, cleanup };
}

// ─── Tests ────────────────────────────────────────────────────

Deno.test({
  name: 'LifecycleManager: spawned module reaches ready status',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { lm, cleanup } = await makeLifecycle();
    const mod = makeDiscoveredModule();

    await lm.spawnAll([mod]);

    const ready = await waitFor(() => lm.getRegistry().get('fake')?.status === 'ready');
    assertEquals(ready, true, 'Module should reach ready status within 5s');

    await lm.stopAll();
    await cleanup();
  },
});

Deno.test({
  name: 'LifecycleManager: module is registered in registry after spawn',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { lm, cleanup } = await makeLifecycle();
    const mod = makeDiscoveredModule();

    await lm.spawnAll([mod]);
    await waitFor(() => lm.getRegistry().get('fake')?.status === 'ready');

    const entry = lm.getRegistry().get('fake');
    assertEquals(entry?.manifest.id, 'fake');
    assertEquals(entry?.pid !== undefined, true);

    await lm.stopAll();
    await cleanup();
  },
});

Deno.test({
  name: 'LifecycleManager: kill() transitions module to stopped',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { lm, cleanup } = await makeLifecycle();
    const mod = makeDiscoveredModule();

    await lm.spawnAll([mod]);
    await waitFor(() => lm.getRegistry().get('fake')?.status === 'ready');

    await lm.kill('fake', 'test');

    const stopped = await waitFor(() => {
      const status = lm.getRegistry().get('fake')?.status;
      return status === 'stopped' || status === 'killed';
    });
    assertEquals(stopped, true, 'Module should reach stopped/killed status');
    await cleanup();
  },
});

Deno.test({
  name: 'LifecycleManager: stopAll() shuts down all modules cleanly',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { lm, cleanup } = await makeLifecycle();
    const mod = makeDiscoveredModule();

    await lm.spawnAll([mod]);
    await waitFor(() => lm.getRegistry().get('fake')?.status === 'ready');

    await lm.stopAll();

    const entries = lm.getRegistry().all();
    for (const e of entries) {
      assertEquals(
        ['stopped', 'killed', 'crashed'].includes(e.status),
        true,
        `Module ${e.manifest.id} should be stopped, got ${e.status}`,
      );
    }
    await cleanup();
  },
});
