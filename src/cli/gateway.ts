/** Gateway HTTP connection helpers for CLI commands. */

import { join } from "jsr:@std/path@^1";
import { existsSync } from "../utils/fs.ts";

export interface GatewayConnectionConfig {
  host: string;
  port: number;
  token?: string;
}

export function getGatewayUrl(config: GatewayConnectionConfig): string {
  return `http://${config.host}:${config.port}`;
}

export async function gatewayFetch(
  config: GatewayConnectionConfig,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${getGatewayUrl(config)}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.token) {
    headers["Authorization"] = `Bearer ${config.token}`;
  }
  return fetch(url, { ...options, headers: { ...headers, ...options?.headers } });
}

export function resolveGatewayConfig(home: string): GatewayConnectionConfig {
  const defaults: GatewayConnectionConfig = { host: "127.0.0.1", port: 18790 };
  const configPath = join(home, "config.yaml");
  if (!existsSync(configPath)) return defaults;
  try {
    const raw = Deno.readTextFileSync(configPath);
    // Simple extraction — avoid pulling in a full YAML parser just for two fields.
    const hostMatch = raw.match(/^(?!\s*#)\s*host:\s*(.+)$/m);
    const portMatch = raw.match(/^(?!\s*#)\s*httpPort:\s*(\d+)/m);
    const tokenMatch = raw.match(/^(?!\s*#)\s*token:\s*(.+)$/m);
    return {
      host: hostMatch ? hostMatch[1].trim() : defaults.host,
      port: portMatch ? parseInt(portMatch[1], 10) : defaults.port,
      token: tokenMatch ? tokenMatch[1].trim() : undefined,
    };
  } catch {
    return defaults;
  }
}
