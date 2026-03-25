/**
 * Unix socket control server for the Pons kernel.
 *
 * Listens on {PONS_HOME}/run/kernel.sock for newline-delimited JSON commands.
 * Allows the CLI (and other local tools) to interact with a running kernel.
 */

import { join } from "jsr:@std/path@^1";
import type { LifecycleManager } from "../lifecycle.ts";
import type { KernelLogger } from "../logs/logger.ts";
import { PermissionStore, computeManifestHash } from "../security/permissions.ts";
import type { ModuleManifest } from "@pons/sdk";

interface ControlCommand {
  cmd: string;
  moduleId?: string;
  moduleDir?: string;
  symlink?: boolean;
}

interface ControlResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export class ControlServer {
  private listener: Deno.Listener | null = null;
  private readonly sockPath: string;

  constructor(
    private readonly ponsHome: string,
    private readonly lifecycle: LifecycleManager,
    private readonly logger: KernelLogger,
  ) {
    this.sockPath = join(ponsHome, "run", "kernel.sock");
  }

  async start(): Promise<void> {
    // Ensure run/ directory exists
    const runDir = this.sockPath.replace(/\/[^/]+$/, "");
    Deno.mkdirSync(runDir, { recursive: true });

    // Remove stale socket if it exists
    try {
      Deno.removeSync(this.sockPath);
    } catch {
      // May not exist — that's fine
    }

    this.listener = Deno.listen({ transport: "unix", path: this.sockPath });
    this.logger.info(`Control socket listening on ${this.sockPath}`);

    this.acceptLoop();
  }

  stop(): void {
    if (this.listener) {
      this.listener.close();
      this.listener = null;
    }
    try {
      Deno.removeSync(this.sockPath);
    } catch {
      // Already gone
    }
  }

  private async acceptLoop(): Promise<void> {
    if (!this.listener) return;

    for await (const conn of this.listener) {
      this.handleConnection(conn).catch((err) => {
        this.logger.warn(`Control connection error: ${err}`);
      });
    }
  }

  private async handleConnection(conn: Deno.Conn): Promise<void> {
    const buf = new Uint8Array(4096);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let leftover = "";

    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;

        leftover += decoder.decode(buf.subarray(0, n));
        const lines = leftover.split("\n");
        leftover = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const response = await this.dispatch(trimmed);
          conn.write(encoder.encode(JSON.stringify(response) + "\n"));
        }
      }
    } finally {
      try { conn.close(); } catch { /* already closed */ }
    }
  }

  private async dispatch(raw: string): Promise<ControlResponse> {
    let cmd: ControlCommand;
    try {
      cmd = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Invalid JSON" };
    }

    switch (cmd.cmd) {
      case "module.restart":
        return this.handleModuleRestart(cmd.moduleId);

      case "module.list":
        return this.handleModuleList();

      case "module.status":
        return this.handleModuleStatus(cmd.moduleId);

      case "module.install":
        return this.handleModuleInstall(cmd.moduleDir, cmd.symlink);

      default:
        return { ok: false, error: `Unknown command: ${cmd.cmd}` };
    }
  }

  private async handleModuleRestart(moduleId?: string): Promise<ControlResponse> {
    if (!moduleId) {
      return { ok: false, error: "moduleId is required" };
    }

    const entry = this.lifecycle.getRegistry().get(moduleId);
    if (!entry) {
      return { ok: false, error: `Module "${moduleId}" not found` };
    }

    try {
      await this.lifecycle.restartWithUpdatedPermissions(moduleId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private handleModuleList(): ControlResponse {
    const modules = this.lifecycle.getRegistry().allPublic();
    return { ok: true, data: { modules } };
  }

  private async handleModuleInstall(moduleDir?: string, symlink?: boolean): Promise<ControlResponse> {
    if (!moduleDir) {
      return { ok: false, error: "moduleDir is required" };
    }

    // Resolve real path
    let realDir: string;
    try {
      realDir = Deno.realPathSync(moduleDir);
    } catch {
      return { ok: false, error: `Module directory not found: ${moduleDir}` };
    }

    // Read module.json
    const manifestPath = join(realDir, "module.json");
    let manifest: ModuleManifest;
    try {
      manifest = JSON.parse(Deno.readTextFileSync(manifestPath));
    } catch {
      return { ok: false, error: `Failed to read module.json from ${manifestPath}` };
    }

    if (!manifest.id || !manifest.name) {
      return { ok: false, error: "module.json missing required 'id' or 'name' field" };
    }

    if (!manifest.permissions) {
      return { ok: false, error: "module.json missing 'permissions' block (required by security policy)" };
    }

    // Create symlink in ~/.kiria/modules/ (default: true)
    const modulesDir = join(this.ponsHome, "modules");
    const linkPath = join(modulesDir, manifest.id);

    if (symlink !== false) {
      try {
        Deno.mkdirSync(modulesDir, { recursive: true });
        // Remove existing link/dir if present
        try { Deno.removeSync(linkPath); } catch { /* may not exist */ }
        Deno.symlinkSync(realDir, linkPath);
        this.logger.info(`Symlinked ${realDir} -> ${linkPath}`);
      } catch (err) {
        return { ok: false, error: `Failed to create symlink: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // Compute manifest hash and approve in permissions.yaml
    const hash = computeManifestHash(join(symlink !== false ? linkPath : realDir, "module.json"));
    const store = new PermissionStore(this.ponsHome);
    store.approve(manifest.id, manifest.permissions, hash);

    // Store IPC capabilities
    const topics = [...(manifest.subscribes ?? []), ...(manifest.publishes ?? [])];
    const services = [...(manifest.requires ?? []), ...(manifest.optionalRequires ?? [])];
    store.approveCapabilities(manifest.id, { topics, services });

    this.logger.info({ module: manifest.id }, "Module installed and approved via control socket");

    // Signal kernel to reload modules (SIGHUP to self)
    try { Deno.kill(Deno.pid, "SIGHUP"); } catch { /* ignore */ }

    return { ok: true, data: { moduleId: manifest.id, manifestHash: hash } };
  }

  private handleModuleStatus(moduleId?: string): ControlResponse {
    if (!moduleId) {
      return { ok: false, error: "moduleId is required" };
    }

    const entry = this.lifecycle.getRegistry().get(moduleId);
    if (!entry) {
      return { ok: false, error: `Module "${moduleId}" not found` };
    }

    return {
      ok: true,
      data: {
        id: moduleId,
        status: entry.status,
        pid: entry.pid,
        provides: entry.manifest.provides ?? [],
        restartCount: entry.restartCount,
        startedAt: entry.startedAt?.toISOString() ?? null,
      },
    };
  }
}
