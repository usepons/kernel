import type { PermissionStore } from '../security/permissions.ts';
import type { ModulePermissions } from '../security/permissions.ts';
import type { LifecycleManager } from '../lifecycle.ts';

export async function handlePermissionRequest(
  req: Request,
  permissionStore: PermissionStore,
  lifecycle: LifecycleManager,
  expectedToken: string,
): Promise<Response | null> {
  const url = new URL(req.url);

  // Validate bearer token
  const auth = req.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${expectedToken}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!url.pathname.startsWith('/api/permissions')) return null;

  if (url.pathname === '/api/permissions/request' && req.method === 'POST') {
    return await handleRequest(req, permissionStore);
  }
  if (url.pathname === '/api/permissions/resolve' && req.method === 'POST') {
    return await handleResolve(req, permissionStore, lifecycle);
  }
  if (url.pathname === '/api/permissions/revoke' && req.method === 'POST') {
    return await handleRevoke(req, permissionStore, lifecycle);
  }
  if (url.pathname === '/api/permissions/list' && req.method === 'GET') {
    return handleList(url, permissionStore);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readBody<T>(req: Request): Promise<T> {
  return await req.json() as T;
}

// POST /api/permissions/request
async function handleRequest(
  req: Request,
  permissionStore: PermissionStore,
): Promise<Response> {
  const { moduleId, permissions, reason } = await readBody<{
    moduleId: string;
    permissions: Partial<ModulePermissions>;
    reason?: string;
  }>(req);

  if (!moduleId || !permissions) {
    return json({ error: 'Missing moduleId or permissions' }, 400);
  }

  // Check if already granted
  const effective = permissionStore.getEffectivePermissions(moduleId);
  if (effective && isSubsetOf(permissions, effective)) {
    return json({ granted: true });
  }

  // Check if denied
  if (permissionStore.isDenied(moduleId, permissions)) {
    return json({ granted: false, denied: true });
  }

  // Check for existing pending
  const existing = permissionStore.findExistingPending(moduleId, permissions);
  if (existing) {
    return json({ granted: false, pending: true, requestId: existing.id });
  }

  // Queue as pending
  const pending = permissionStore.addPendingRequest(moduleId, permissions, reason);
  return json({ granted: false, pending: true, requestId: pending.id });
}

// POST /api/permissions/resolve
async function handleResolve(
  req: Request,
  permissionStore: PermissionStore,
  lifecycle: LifecycleManager,
): Promise<Response> {
  const { moduleId, requestId, decision } = await readBody<{
    moduleId: string;
    requestId: string;
    decision: 'grant' | 'deny';
  }>(req);

  if (!moduleId || !requestId || !decision) {
    return json({ error: 'Missing moduleId, requestId, or decision' }, 400);
  }

  if (decision !== 'grant' && decision !== 'deny') {
    return json({ error: 'decision must be "grant" or "deny"' }, 400);
  }

  const resolved = permissionStore.resolvePending(moduleId, requestId, decision);
  if (!resolved) {
    return json({ error: 'Pending request not found' }, 404);
  }

  // On grant, restart the module so it picks up the new Deno flags
  if (decision === 'grant') {
    try {
      await lifecycle.restartWithUpdatedPermissions(moduleId);
    } catch {
      // Module may not be running — that's fine
    }
  }

  return json({ ok: true, decision });
}

// POST /api/permissions/revoke
async function handleRevoke(
  req: Request,
  permissionStore: PermissionStore,
  lifecycle: LifecycleManager,
): Promise<Response> {
  const { moduleId, permissionType, value } = await readBody<{
    moduleId: string;
    permissionType?: string;
    value?: string;
  }>(req);

  if (!moduleId) {
    return json({ error: 'Missing moduleId' }, 400);
  }

  const revoked = permissionStore.revoke(moduleId, permissionType, value);
  if (!revoked) {
    return json({ error: 'Module not found in permission store' }, 404);
  }

  // Restart the module so it picks up the reduced Deno flags
  try {
    await lifecycle.restartWithUpdatedPermissions(moduleId);
  } catch {
    // Module may not be running — that's fine
  }

  return json({ ok: true });
}

// GET /api/permissions/list?moduleId=xxx
function handleList(
  url: URL,
  permissionStore: PermissionStore,
): Response {
  const moduleId = url.searchParams.get('moduleId');

  if (moduleId) {
    const effective = permissionStore.getEffectivePermissions(moduleId);
    const pending = permissionStore.getPendingRequests(moduleId);
    return json({
      moduleId,
      effective,
      pending: pending[moduleId] ?? [],
    });
  }

  // List all modules
  const all = permissionStore.listAll();
  const allPending = permissionStore.getPendingRequests();
  const modules: Record<string, unknown> = {};
  for (const [id, granted] of Object.entries(all)) {
    modules[id] = {
      effective: permissionStore.getEffectivePermissions(id),
      base: granted.permissions,
      pending: allPending[id] ?? [],
    };
  }

  return json({ modules });
}

function isSubsetOf(requested: Partial<ModulePermissions>, granted: ModulePermissions): boolean {
  const fields: (keyof ModulePermissions)[] = ['net', 'read', 'write', 'env', 'run', 'sys'];
  for (const field of fields) {
    const reqValues = (requested as Record<string, string[]>)[field];
    if (!reqValues || reqValues.length === 0) continue;
    const grantedValues = (granted as Record<string, string[]>)[field] || [];
    if (!reqValues.every((v: string) => grantedValues.includes(v))) return false;
  }
  return true;
}
