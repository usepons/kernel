import { assertEquals } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path@^1';
import { ModuleLoader } from '../../src/module/loader.ts';

// Helper: write a valid module.json to a temp dir
async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await Deno.writeTextFile(join(dir, 'module.json'), JSON.stringify(manifest));
}

// Helper: create a minimal valid runner file
async function writeRunner(dir: string, name = 'runner.ts'): Promise<void> {
  await Deno.writeTextFile(join(dir, name), '// fake runner\n');
}

Deno.test('ModuleLoader: discover() returns empty array when dir does not exist', () => {
  const loader = new ModuleLoader('/nonexistent/path/xyz');
  const result = loader.discover();
  assertEquals(result, []);
});

Deno.test('ModuleLoader: discover() skips dirs without module.json', async () => {
  const base = await Deno.makeTempDir();
  const mod = join(base, 'my-module');
  await Deno.mkdir(mod);
  // no module.json
  const loader = new ModuleLoader(base);
  const result = loader.discover();
  assertEquals(result, []);
  await Deno.remove(base, { recursive: true });
});

Deno.test('ModuleLoader: discover() skips module.json missing id', async () => {
  const base = await Deno.makeTempDir();
  const mod = join(base, 'bad-module');
  await Deno.mkdir(mod);
  await writeManifest(mod, { name: 'No Id', minProtocolVersion: '1.0', permissions: {} });
  await writeRunner(mod);
  const loader = new ModuleLoader(base);
  const result = loader.discover();
  assertEquals(result, []);
  await Deno.remove(base, { recursive: true });
});

Deno.test('ModuleLoader: discover() skips module.json missing name', async () => {
  const base = await Deno.makeTempDir();
  const mod = join(base, 'bad-module');
  await Deno.mkdir(mod);
  await writeManifest(mod, { id: 'no-name', minProtocolVersion: '1.0', permissions: {} });
  await writeRunner(mod);
  const loader = new ModuleLoader(base);
  const result = loader.discover();
  assertEquals(result, []);
  await Deno.remove(base, { recursive: true });
});

Deno.test('ModuleLoader: discover() skips module without permissions block', async () => {
  const base = await Deno.makeTempDir();
  const mod = join(base, 'no-perms');
  await Deno.mkdir(mod);
  await writeManifest(mod, { id: 'no-perms', name: 'No Perms', minProtocolVersion: '1.0' });
  await writeRunner(mod);
  const loader = new ModuleLoader(base);
  const result = loader.discover();
  assertEquals(result, []);
  await Deno.remove(base, { recursive: true });
});

Deno.test('ModuleLoader: discover() skips incompatible protocol version', async () => {
  const base = await Deno.makeTempDir();
  const mod = join(base, 'future-module');
  await Deno.mkdir(mod);
  await writeManifest(mod, { id: 'future', name: 'Future', minProtocolVersion: '99.0', permissions: {} });
  await writeRunner(mod);
  const loader = new ModuleLoader(base);
  const result = loader.discover();
  assertEquals(result, []);
  await Deno.remove(base, { recursive: true });
});

Deno.test('ModuleLoader: discover() returns valid module with correct runnerPath', async () => {
  const base = await Deno.makeTempDir();
  const mod = join(base, 'good-module');
  await Deno.mkdir(mod);
  await writeManifest(mod, {
    id: 'good',
    name: 'Good Module',
    minProtocolVersion: '1.0',
    permissions: {},
  });
  await writeRunner(mod);
  const loader = new ModuleLoader(base);
  const result = loader.discover();
  assertEquals(result.length, 1);
  assertEquals(result[0].manifest.id, 'good');
  assertEquals(result[0].runnerPath.endsWith('runner.ts'), true);
  await Deno.remove(base, { recursive: true });
});

Deno.test('ModuleLoader: discover() reads version from deno.json if present', async () => {
  const base = await Deno.makeTempDir();
  const mod = join(base, 'versioned');
  await Deno.mkdir(mod);
  await writeManifest(mod, { id: 'versioned', name: 'Versioned', minProtocolVersion: '1.0', permissions: {} });
  await writeRunner(mod);
  await Deno.writeTextFile(join(mod, 'deno.json'), JSON.stringify({ version: '2.5.0' }));
  const loader = new ModuleLoader(base);
  const result = loader.discover();
  assertEquals(result.length, 1);
  assertEquals(result[0].manifest.version, '2.5.0');
  await Deno.remove(base, { recursive: true });
});

Deno.test('ModuleLoader: discover() finds multiple valid modules', async () => {
  const base = await Deno.makeTempDir();
  for (const id of ['mod-a', 'mod-b', 'mod-c']) {
    const mod = join(base, id);
    await Deno.mkdir(mod);
    await writeManifest(mod, { id, name: `Module ${id}`, minProtocolVersion: '1.0', permissions: {} });
    await writeRunner(mod);
  }
  const loader = new ModuleLoader(base);
  const result = loader.discover();
  assertEquals(result.length, 3);
  const ids = result.map(r => r.manifest.id).sort();
  assertEquals(ids, ['mod-a', 'mod-b', 'mod-c']);
  await Deno.remove(base, { recursive: true });
});
