import { createHash } from "node:crypto";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";

export const DEFAULT_CONNECTOR_NAME = "Second Opinion";
const GLOBAL_CONNECTION_ID = "global";

export interface LastEndpoint {
  workspaceId: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  connectorName?: string;
  savedAt: string;
}

export function endpointFile(_workspaceId?: string): string {
  return path.join(getStateDir(), "endpoints", `${GLOBAL_CONNECTION_ID}.json`);
}

export function readLastEndpoint(workspaceId: string): LastEndpoint | null {
  return readJsonIfExists<LastEndpoint>(endpointFile(workspaceId));
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt">): LastEndpoint {
  const saved: LastEndpoint = {
    ...endpoint,
    workspaceId: GLOBAL_CONNECTION_ID,
    connectorName: endpoint.connectorName?.trim() || DEFAULT_CONNECTOR_NAME,
    savedAt: new Date().toISOString(),
  };
  writeSecureJson(endpointFile(saved.workspaceId), saved);
  return saved;
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function endpointFingerprint(url: string | null | undefined): string | null {
  if (!url) return null;
  return `sha256:${createHash("sha256").update(normalizePublicUrl(url)).digest("hex").slice(0, 16)}`;
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** What the Skill should do to the machine-global ChatGPT connector.
 *  `update` means the public address changed: Delete the old connector
 *  in ChatGPT, then create it again. Never click Reconnect (the old
 *  URL is dead and hangs on "This site cannot be reached"). */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
}

export function sanitizeConnectorLabel(name: string, workspaceId: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || workspaceId.slice(0, 6);
}

/**
 * Preserve the title of a connector that still points at the active endpoint.
 * First creation and explicit endpoint replacement use the current default.
 */
export function connectorNameFor(opts: {
  workspaceName: string;
  workspaceId: string;
  previousName?: string | null;
  hadEndpointBefore: boolean;
  replacingEndpoint?: boolean;
}): string {
  const previousName = opts.previousName?.trim();
  if (opts.hadEndpointBefore && !opts.replacingEndpoint && previousName) return previousName;
  return DEFAULT_CONNECTOR_NAME;
}

export function reclaimUserMessage(connectorName: string): string {
  return `这台机器的全局安全连接地址已经失效。我会删除「${connectorName}」再按新地址加回去。请稍等。`;
}
