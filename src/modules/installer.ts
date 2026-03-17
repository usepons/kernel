/**
 * Module install / uninstall logic for the kernel.
 *
 * Modules are published to JSR under `@pons/module-<name>` and installed
 * by downloading all package files from the JSR registry API.
 *
 * Also supports local paths and git URLs for development.
 */

import { dirname, join, resolve } from "jsr:@std/path@^1";
import ora from "npm:ora@^8.2.0";
import chalk from "npm:chalk@^5.6.2";
import { getPonsHome } from "@pons/sdk";
import type { ModuleManifest } from "@pons/sdk";
import { printError, printWarning } from "../formatters.ts";
import { auditModuleSource, formatAuditWarning } from "./audit.ts";
import { validatePermissions, computeManifestHash, PermissionStore } from '../security/permissions.ts';
import * as prompts from 'npm:@clack/prompts@^0.10.1';

// --- JSR API Types ---

interface JsrPackageMeta {
  scope: string;
  name: string;
  latest: string;
  versions: Record<string, { yanked?: boolean }>;
}

interface JsrVersionMeta {
  manifest: Record<string, { size: number; checksum: string }>;
  exports: Record<string, string>;
}

// --- Helpers ---

/**
 * Scan a modules directory for installed modules with valid module.json manifests.
 */
export function getInstalledModules(modulesDir: string): ModuleManifest[] {
  try { Deno.statSync(modulesDir); } catch { return []; }

  const manifests: ModuleManifest[] = [];

  for (const entry of Deno.readDirSync(modulesDir)) {
    if (!entry.isDirectory && !entry.isSymlink) continue;

    const manifestPath = join(modulesDir, entry.name, "module.json");
    try { Deno.statSync(manifestPath); } catch { continue; }

    try {
      const raw = Deno.readTextFileSync(manifestPath);
      const manifest = JSON.parse(raw) as ModuleManifest;
      manifests.push(manifest);
    } catch {
      // Skip malformed manifests
    }
  }

  return manifests;
}

/**
 * Extract module name from a URL or path for directory naming.
 */
function extractModuleName(nameOrUrl: string): string {
  // From URL: get last path segment, strip .git
  const segments = nameOrUrl.replace(/\.git$/, "").split("/");
  const last = segments[segments.length - 1];
  // Strip common prefixes like "module-"
  const name = last.replace(/^module-/, "");
  // Security: reject path traversal and invalid characters
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid module name derived from URL: "${name}". Module names must be alphanumeric with hyphens/underscores only.`);
  }
  return name;
}

/**
 * Display module permissions and ask the user for approval.
 * Returns true if approved, false if rejected.
 */
export async function displayAndApprovePermissions(
  manifest: ModuleManifest,
  manifestPath: string,
  permissionStore: PermissionStore,
  autoApprove = false,
): Promise<boolean> {
  if (!manifest.permissions) {
    printError(`Module "${manifest.id}" does not declare a permissions block. Cannot install.`);
    return false;
  }

  let permissions;
  try {
    permissions = validatePermissions(manifest.permissions);
  } catch {
    printError(`Module "${manifest.id}" has an invalid permissions block.`);
    return false;
  }

  // Display permissions summary
  console.log();
  console.log(chalk.bold(`  Permissions requested by ${chalk.cyan(manifest.id)}:`));
  console.log();

  const entries: [string, string[]][] = [
    ['Network', permissions.net ?? []],
    ['Read', permissions.read ?? []],
    ['Write', permissions.write ?? []],
    ['Env', permissions.env ?? []],
    ['Run', permissions.run ?? []],
    ['Services', permissions.services ?? []],
    ['Topics', permissions.topics ?? []],
  ];

  for (const [label, values] of entries) {
    if (values.length > 0) {
      console.log(`  ${chalk.yellow(label)}: ${values.join(', ')}`);
    }
  }
  console.log();

  if (autoApprove) {
    console.log(chalk.dim('  Auto-approved (--yes flag)'));
    const hash = computeManifestHash(manifestPath);
    permissionStore.approve(manifest.id, permissions, hash);
    // PONS-004: Store IPC capabilities in the permission store
    permissionStore.approveCapabilities(manifest.id, manifest.capabilities ?? {});

    // Register service providers
    for (const svc of manifest.provides ?? []) {
      permissionStore.registerServiceProvider(svc, manifest.id);
    }
    return true;
  }

  const approved = await prompts.confirm({
    message: 'Grant these permissions?',
  });

  if (prompts.isCancel(approved) || !approved) {
    return false;
  }

  const hash = computeManifestHash(manifestPath);
  permissionStore.approve(manifest.id, permissions, hash);
  // PONS-004: Store IPC capabilities in the permission store
  permissionStore.approveCapabilities(manifest.id, manifest.capabilities ?? {});

  // Register service providers
  for (const svc of manifest.provides ?? []) {
    permissionStore.registerServiceProvider(svc, manifest.id);
  }

  return true;
}

// --- JSR Helpers ---

const JSR_SCOPE = "pons";
const JSR_BASE = "https://jsr.io";

/**
 * Fetch the latest version of a JSR package.
 */
async function fetchLatestVersion(packageName: string): Promise<string> {
  const res = await fetch(`${JSR_BASE}/@${JSR_SCOPE}/${packageName}/meta.json`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Package @${JSR_SCOPE}/${packageName} not found on JSR (HTTP ${res.status})`);
  }

  const meta = (await res.json()) as JsrPackageMeta;
  return meta.latest;
}

/**
 * Fetch the file manifest for a specific version.
 */
async function fetchVersionManifest(packageName: string, version: string): Promise<JsrVersionMeta> {
  const res = await fetch(`${JSR_BASE}/@${JSR_SCOPE}/${packageName}/${version}_meta.json`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch version metadata for ${version}: HTTP ${res.status}`);
  }

  return (await res.json()) as JsrVersionMeta;
}

/**
 * Download all files from a JSR package version into a target directory.
 */
async function downloadPackageFiles(
  packageName: string,
  version: string,
  versionMeta: JsrVersionMeta,
  targetDir: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const filePaths = Object.keys(versionMeta.manifest);
  let downloaded = 0;

  for (const filePath of filePaths) {
    const url = `${JSR_BASE}/@${JSR_SCOPE}/${packageName}/${version}${filePath}`;
    const res = await fetch(url, {
      headers: { Accept: "application/octet-stream" },
    });

    if (!res.ok) {
      throw new Error(`Failed to download ${filePath}: HTTP ${res.status}`);
    }

    const content = await res.text();

    // PONS-007: Verify checksum before writing to disk
    const expected = versionMeta.manifest[filePath]?.checksum;
    if (expected) {
      const data = new TextEncoder().encode(content);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashBytes = new Uint8Array(hashBuffer);
      const hashB64 = btoa(String.fromCharCode(...hashBytes));
      const actual = `sha256-${hashB64}`;
      if (actual !== expected) {
        throw new Error(
          `Checksum mismatch for ${filePath}: expected ${expected}, got ${actual}. ` +
          `The download may have been tampered with.`
        );
      }
    }

    const localPath = join(targetDir, filePath);
    const dir = dirname(localPath);

    try { Deno.statSync(dir); } catch { Deno.mkdirSync(dir, { recursive: true }); }

    Deno.writeTextFileSync(localPath, content);
    downloaded++;
    onProgress?.(downloaded, filePaths.length);
  }
}

/**
 * Stamp the version from JSR into the downloaded module.json.
 */
function stampModuleVersion(targetDir: string, version: string): void {
  const manifestPath = join(targetDir, "module.json");
  try { Deno.statSync(manifestPath); } catch { return; }

  try {
    const manifest = JSON.parse(Deno.readTextFileSync(manifestPath));
    manifest.version = version;
    Deno.writeTextFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch { /* best effort */ }
}

// --- Install Logic ---

/**
 * Install a module from a local path, git URL, or JSR package.
 *
 * Resolution order:
 *   1. Local path  — starts with `./ | ../ | /`  → symlink
 *   2. Git URL     — contains `://` or ends `.git` → git clone
 *   3. JSR package — bare name like `llm` → resolves `@pons/module-llm` on JSR
 *
 * @param nameOrUrl - Local path, git URL, or module name (optionally with @version)
 * @param ponsHome - Override for PONS_HOME directory
 * @returns true if installation succeeded
 */
export async function installModule(
  nameOrUrl: string,
  ponsHome?: string,
  autoApprove = false,
): Promise<boolean> {
  const home = ponsHome || getPonsHome();
  const modulesDir = join(home, "modules");
  const permStore = new PermissionStore(home);

  // Ensure modules directory exists
  try { Deno.statSync(modulesDir); } catch { Deno.mkdirSync(modulesDir, { recursive: true }); }

  // --- Local path ---
  if (
    nameOrUrl.startsWith("./") || nameOrUrl.startsWith("/") ||
    nameOrUrl.startsWith("../")
  ) {
    const localPath = resolve(nameOrUrl);
    const manifestPath = join(localPath, "module.json");

    try { Deno.statSync(manifestPath); } catch {
      printError(`No module.json found at ${localPath}`);
      return false;
    }

    let manifest: ModuleManifest;
    try {
      manifest = JSON.parse(Deno.readTextFileSync(manifestPath)) as ModuleManifest;
    } catch {
      printError(`Failed to parse module.json at ${manifestPath}`);
      return false;
    }

    const targetDir = join(modulesDir, manifest.id);

    try {
      Deno.statSync(targetDir);
      printWarning(`Module "${manifest.id}" is already installed. Skipping.`);
      return true;
    } catch { /* not installed yet */ }

    const spinner = ora(`Linking local module "${manifest.id}"...`).start();

    try {
      Deno.symlinkSync(localPath, targetDir, { type: "dir" });
      spinner.succeed(
        `Linked ${chalk.green(manifest.id)} from ${chalk.dim(localPath)}`,
      );

      // Audit: warn about node: imports that bypass the sandbox
      const auditFindings = auditModuleSource(localPath);
      const auditWarning = formatAuditWarning(auditFindings);
      if (auditWarning) {
        console.log();
        console.log(chalk.yellow(auditWarning));
      }

      // Security: approve permissions
      const store = permStore;
      const approved = await displayAndApprovePermissions(manifest, manifestPath, store, autoApprove);
      if (!approved) {
        // Clean up the symlink
        Deno.removeSync(targetDir);
        console.log(chalk.yellow('  Installation cancelled — permissions rejected.'));
        return false;
      }

      return true;
    } catch (error) {
      spinner.fail(`Failed to create symlink for "${manifest.id}"`);
      printError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // --- Git URL (contains :// or ends with .git) ---
  if (nameOrUrl.includes("://") || nameOrUrl.endsWith(".git")) {
    // Security: validate URL scheme — only allow safe git transport protocols
    const ALLOWED_GIT_SCHEMES = ['https:', 'http:', 'ssh:', 'git:'];
    if (nameOrUrl.includes("://")) {
      try {
        const parsed = new URL(nameOrUrl);
        if (!ALLOWED_GIT_SCHEMES.includes(parsed.protocol)) {
          printError(`Unsupported git URL scheme: ${parsed.protocol}. Allowed: ${ALLOWED_GIT_SCHEMES.join(', ')}`);
          return false;
        }
      } catch {
        // Not a valid URL but may be an SSH shorthand (git@host:repo.git)
        if (!nameOrUrl.match(/^[\w.-]+@[\w.-]+:[\w./-]+\.git$/)) {
          printError(`Invalid git URL: ${nameOrUrl}`);
          return false;
        }
      }
    }

    const moduleName = extractModuleName(nameOrUrl);
    const targetDir = join(modulesDir, moduleName);

    try {
      Deno.statSync(targetDir);
      printWarning(`Module "${moduleName}" is already installed. Skipping.`);
      return true;
    } catch { /* not installed yet */ }

    const spinner = ora(`Cloning ${chalk.cyan(nameOrUrl)}...`).start();

    try {
      new Deno.Command('git', {
        args: ['clone', '--depth', '1', '--', nameOrUrl, targetDir],
        stdout: 'piped',
        stderr: 'piped',
      }).outputSync();

      // Validate module.json exists after clone
      const manifestPath = join(targetDir, "module.json");
      try { Deno.statSync(manifestPath); } catch {
        spinner.fail(`Cloned repository does not contain a module.json`);
        Deno.removeSync(targetDir, { recursive: true });
        return false;
      }

      spinner.succeed(`Installed ${chalk.green(moduleName)} from git`);

      // Audit: warn about node: imports that bypass the sandbox
      const gitAuditFindings = auditModuleSource(targetDir);
      const gitAuditWarning = formatAuditWarning(gitAuditFindings);
      if (gitAuditWarning) {
        console.log();
        console.log(chalk.yellow(gitAuditWarning));
      }

      // Security: approve permissions
      const manifest = JSON.parse(Deno.readTextFileSync(manifestPath)) as ModuleManifest;
      const store = permStore;
      const approved = await displayAndApprovePermissions(manifest, manifestPath, store, autoApprove);
      if (!approved) {
        Deno.removeSync(targetDir, { recursive: true });
        console.log(chalk.yellow('  Installation cancelled — permissions rejected.'));
        return false;
      }

      return true;
    } catch (error) {
      spinner.fail(`Failed to install "${moduleName}" from git`);
      printError(error instanceof Error ? error.message : String(error));
      try { Deno.statSync(targetDir); Deno.removeSync(targetDir, { recursive: true }); } catch { /* ignore */ }
      return false;
    }
  }

  // --- JSR module name (with optional @version) ---
  let moduleName = nameOrUrl;
  let requestedVersion: string | null = null;

  // Support name@version syntax
  const atIndex = nameOrUrl.lastIndexOf("@");
  if (atIndex > 0) {
    moduleName = nameOrUrl.slice(0, atIndex);
    requestedVersion = nameOrUrl.slice(atIndex + 1);
  }

  const jsrPackage = `module-${moduleName}`;
  const targetDir = join(modulesDir, moduleName);

  try {
    Deno.statSync(targetDir);
    printWarning(`Module "${moduleName}" is already installed. Skipping.`);
    return false;
  } catch { /* not installed yet */ }

  const spinner = ora(`Resolving ${chalk.cyan(`@${JSR_SCOPE}/${jsrPackage}`)} on JSR...`).start();

  try {
    const version = requestedVersion || await fetchLatestVersion(jsrPackage);
    spinner.text = `Fetching ${chalk.cyan(moduleName)} v${version} file list...`;

    const versionMeta = await fetchVersionManifest(jsrPackage, version);
    const fileCount = Object.keys(versionMeta.manifest).length;

    spinner.text = `Downloading ${chalk.cyan(moduleName)} v${version} (${fileCount} files)...`;

    Deno.mkdirSync(targetDir, { recursive: true });

    await downloadPackageFiles(jsrPackage, version, versionMeta, targetDir, (current, total) => {
      spinner.text = `Downloading ${chalk.cyan(moduleName)} v${version} (${current}/${total} files)...`;
    });

    // Stamp version into module.json (JSR strips deno.json)
    stampModuleVersion(targetDir, version);

    // Validate module.json
    const manifestPath = join(targetDir, "module.json");
    try { Deno.statSync(manifestPath); } catch {
      spinner.fail(`Package @${JSR_SCOPE}/${jsrPackage} does not contain a module.json`);
      Deno.removeSync(targetDir, { recursive: true });
      return false;
    }

    // Check requires — warn about missing services
    const manifest = JSON.parse(Deno.readTextFileSync(manifestPath)) as ModuleManifest;
    if (manifest.requires && manifest.requires.length > 0) {
      const installed = getInstalledModules(modulesDir);
      const providedServices = new Set(
        installed.flatMap((m) => m.provides || []),
      );

      const missing = manifest.requires.filter((svc: string) =>
        !providedServices.has(svc)
      );
      if (missing.length > 0) {
        printWarning(
          `Module "${moduleName}" requires services not currently provided: ${
            missing.join(", ")
          }`,
        );
      }
    }

    spinner.succeed(
      `Installed ${chalk.green(moduleName)} ${chalk.dim(`v${version}`)} from JSR`,
    );

    // Audit: warn about node: imports that bypass the sandbox
    const jsrAuditFindings = auditModuleSource(targetDir);
    const jsrAuditWarning = formatAuditWarning(jsrAuditFindings);
    if (jsrAuditWarning) {
      console.log();
      console.log(chalk.yellow(jsrAuditWarning));
    }

    // Security: approve permissions
    const store = permStore;
    const approved = await displayAndApprovePermissions(manifest, manifestPath, store, autoApprove);
    if (!approved) {
      Deno.removeSync(targetDir, { recursive: true });
      console.log(chalk.yellow('  Installation cancelled — permissions rejected.'));
      return false;
    }

    return true;
  } catch (error) {
    spinner.fail(`Failed to install "${moduleName}" from JSR`);
    printError(error instanceof Error ? error.message : String(error));
    try { Deno.statSync(targetDir); Deno.removeSync(targetDir, { recursive: true }); } catch { /* ignore */ }
    return false;
  }
}

// --- Update Logic ---

export interface UpdateResult {
  updated: boolean;
  from?: string;
  to?: string;
  error?: string;
}

/**
 * Detect how a module was installed.
 *
 * - "symlink" — local development link
 * - "git"     — cloned from a git URL
 * - "jsr"     — downloaded from JSR
 */
export function detectInstallSource(moduleDir: string): "symlink" | "git" | "jsr" {
  try {
    const stat = Deno.lstatSync(moduleDir);
    if (stat.isSymlink) return "symlink";
  } catch { /* not a symlink */ }

  try { Deno.statSync(join(moduleDir, ".git")); return "git"; } catch { /* not git */ }
  return "jsr";
}

/**
 * Read the currently installed version from a module's deno.json or module.json.
 */
function readInstalledVersion(moduleDir: string): string | undefined {
  // Try deno.json first (JSR packages always have it)
  for (const file of ["deno.json", "module.json"]) {
    const path = join(moduleDir, file);
    try {
      Deno.statSync(path);
      const json = JSON.parse(Deno.readTextFileSync(path));
      if (json.version) return json.version;
    } catch { /* skip */ }
  }
  return undefined;
}

/**
 * Update a JSR-installed module to the latest version.
 *
 * Re-downloads all files from JSR, replacing the existing directory.
 */
export async function updateModuleFromJsr(
  moduleName: string,
  moduleDir: string,
): Promise<UpdateResult> {
  const jsrPackage = `module-${moduleName}`;
  const currentVersion = readInstalledVersion(moduleDir);

  const spinner = ora(`Checking ${chalk.cyan(moduleName)} for updates...`).start();

  try {
    const latestVersion = await fetchLatestVersion(jsrPackage);

    if (currentVersion === latestVersion) {
      spinner.succeed(
        `${chalk.green(moduleName)} is already at v${latestVersion}`,
      );
      return { updated: false };
    }

    spinner.text = `Updating ${chalk.cyan(moduleName)}: v${currentVersion || "?"} → v${latestVersion}...`;

    const versionMeta = await fetchVersionManifest(jsrPackage, latestVersion);

    // Remove old files and re-download
    Deno.removeSync(moduleDir, { recursive: true });
    Deno.mkdirSync(moduleDir, { recursive: true });

    await downloadPackageFiles(jsrPackage, latestVersion, versionMeta, moduleDir, (current, total) => {
      spinner.text = `Downloading ${chalk.cyan(moduleName)} v${latestVersion} (${current}/${total} files)...`;
    });

    stampModuleVersion(moduleDir, latestVersion);

    spinner.succeed(
      `Updated ${chalk.green(moduleName)}: v${currentVersion || "?"} → ${chalk.green(`v${latestVersion}`)}`,
    );
    return { updated: true, from: currentVersion, to: latestVersion };
  } catch (error) {
    spinner.fail(`Failed to update "${moduleName}" from JSR`);
    printError(error instanceof Error ? error.message : String(error));
    return { updated: false, error: error instanceof Error ? error.message : String(error) };
  }
}
