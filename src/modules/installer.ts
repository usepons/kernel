/**
 * Module install / uninstall logic for the kernel.
 *
 * Modules are published to JSR under `@pons/module-<name>` and installed
 * by downloading all package files from the JSR registry API.
 *
 * Also supports local paths and git URLs for development.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import ora from "npm:ora@^8.2.0";
import chalk from "npm:chalk@^5.6.2";
import { getPonsHome } from "jsr:@pons/sdk@^0.2";
import type { ModuleManifest } from "jsr:@pons/sdk@^0.2";
import { printError, printWarning } from "../formatters.ts";
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
  if (!existsSync(modulesDir)) return [];

  const manifests: ModuleManifest[] = [];

  const entries = readdirSync(modulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const manifestPath = join(modulesDir, entry.name, "module.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
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
  return last.replace(/^module-/, "");
}

/**
 * Display module permissions and ask the user for approval.
 * Returns true if approved, false if rejected.
 */
async function displayAndApprovePermissions(
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
    const localPath = join(targetDir, filePath);
    const dir = dirname(localPath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(localPath, content, "utf-8");
    downloaded++;
    onProgress?.(downloaded, filePaths.length);
  }
}

/**
 * Stamp the version from JSR into the downloaded module.json.
 */
function stampModuleVersion(targetDir: string, version: string): void {
  const manifestPath = join(targetDir, "module.json");
  if (!existsSync(manifestPath)) return;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.version = version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
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
  if (!existsSync(modulesDir)) {
    mkdirSync(modulesDir, { recursive: true });
  }

  // --- Local path ---
  if (
    nameOrUrl.startsWith("./") || nameOrUrl.startsWith("/") ||
    nameOrUrl.startsWith("../")
  ) {
    const localPath = resolve(nameOrUrl);
    const manifestPath = join(localPath, "module.json");

    if (!existsSync(manifestPath)) {
      printError(`No module.json found at ${localPath}`);
      return false;
    }

    let manifest: ModuleManifest;
    try {
      manifest = JSON.parse(
        readFileSync(manifestPath, "utf-8"),
      ) as ModuleManifest;
    } catch {
      printError(`Failed to parse module.json at ${manifestPath}`);
      return false;
    }

    const targetDir = join(modulesDir, manifest.id);

    if (existsSync(targetDir)) {
      printWarning(`Module "${manifest.id}" is already installed. Skipping.`);
      return true;
    }

    const spinner = ora(`Linking local module "${manifest.id}"...`).start();

    try {
      symlinkSync(localPath, targetDir, "dir");
      spinner.succeed(
        `Linked ${chalk.green(manifest.id)} from ${chalk.dim(localPath)}`,
      );

      // Security: approve permissions
      const store = permStore;
      const approved = await displayAndApprovePermissions(manifest, manifestPath, store, autoApprove);
      if (!approved) {
        // Clean up the symlink
        rmSync(targetDir, { force: true });
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
    const moduleName = extractModuleName(nameOrUrl);
    const targetDir = join(modulesDir, moduleName);

    if (existsSync(targetDir)) {
      printWarning(`Module "${moduleName}" is already installed. Skipping.`);
      return true;
    }

    const spinner = ora(`Cloning ${chalk.cyan(nameOrUrl)}...`).start();

    try {
      execFileSync('git', ['clone', '--depth', '1', '--', nameOrUrl, targetDir], {
        stdio: "pipe",
      });

      // Validate module.json exists after clone
      const manifestPath = join(targetDir, "module.json");
      if (!existsSync(manifestPath)) {
        spinner.fail(`Cloned repository does not contain a module.json`);
        rmSync(targetDir, { recursive: true, force: true });
        return false;
      }

      spinner.succeed(`Installed ${chalk.green(moduleName)} from git`);

      // Security: approve permissions
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ModuleManifest;
      const store = permStore;
      const approved = await displayAndApprovePermissions(manifest, manifestPath, store, autoApprove);
      if (!approved) {
        rmSync(targetDir, { recursive: true, force: true });
        console.log(chalk.yellow('  Installation cancelled — permissions rejected.'));
        return false;
      }

      return true;
    } catch (error) {
      spinner.fail(`Failed to install "${moduleName}" from git`);
      printError(error instanceof Error ? error.message : String(error));
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }
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

  if (existsSync(targetDir)) {
    printWarning(`Module "${moduleName}" is already installed. Skipping.`);
    return false;
  }

  const spinner = ora(`Resolving ${chalk.cyan(`@${JSR_SCOPE}/${jsrPackage}`)} on JSR...`).start();

  try {
    const version = requestedVersion || await fetchLatestVersion(jsrPackage);
    spinner.text = `Fetching ${chalk.cyan(moduleName)} v${version} file list...`;

    const versionMeta = await fetchVersionManifest(jsrPackage, version);
    const fileCount = Object.keys(versionMeta.manifest).length;

    spinner.text = `Downloading ${chalk.cyan(moduleName)} v${version} (${fileCount} files)...`;

    mkdirSync(targetDir, { recursive: true });

    await downloadPackageFiles(jsrPackage, version, versionMeta, targetDir, (current, total) => {
      spinner.text = `Downloading ${chalk.cyan(moduleName)} v${version} (${current}/${total} files)...`;
    });

    // Stamp version into module.json (JSR strips deno.json)
    stampModuleVersion(targetDir, version);

    // Validate module.json
    const manifestPath = join(targetDir, "module.json");
    if (!existsSync(manifestPath)) {
      spinner.fail(`Package @${JSR_SCOPE}/${jsrPackage} does not contain a module.json`);
      rmSync(targetDir, { recursive: true, force: true });
      return false;
    }

    // Check requires — warn about missing services
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as ModuleManifest;
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

    // Security: approve permissions
    const store = permStore;
    const approved = await displayAndApprovePermissions(manifest, manifestPath, store, autoApprove);
    if (!approved) {
      rmSync(targetDir, { recursive: true, force: true });
      console.log(chalk.yellow('  Installation cancelled — permissions rejected.'));
      return false;
    }

    return true;
  } catch (error) {
    spinner.fail(`Failed to install "${moduleName}" from JSR`);
    printError(error instanceof Error ? error.message : String(error));
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
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
    const stat = lstatSync(moduleDir);
    if (stat.isSymbolicLink()) return "symlink";
  } catch { /* not a symlink */ }

  if (existsSync(join(moduleDir, ".git"))) return "git";
  return "jsr";
}

/**
 * Read the currently installed version from a module's deno.json or module.json.
 */
function readInstalledVersion(moduleDir: string): string | undefined {
  // Try deno.json first (JSR packages always have it)
  for (const file of ["deno.json", "module.json"]) {
    const path = join(moduleDir, file);
    if (!existsSync(path)) continue;
    try {
      const json = JSON.parse(readFileSync(path, "utf-8"));
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
    rmSync(moduleDir, { recursive: true, force: true });
    mkdirSync(moduleDir, { recursive: true });

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
