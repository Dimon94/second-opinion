import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { WorkspaceBindingError, type WorkspaceBindingStore } from "../session/bindings.js";
import { registerWorkspaceTools } from "./server.js";
import type { Logger } from "../logger/index.js";
import { PRODUCT_NAME, VERSION } from "../version.js";

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function result(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(error: unknown): ToolResult {
  const known = error instanceof WorkspaceBindingError;
  const body = {
    error: known ? error.code : "INTERNAL_ERROR",
    message: known ? error.message : "Session routing failed.",
  };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

function session(extra: { _meta?: Record<string, unknown> }): string {
  const value = extra._meta?.["openai/session"];
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new WorkspaceBindingError("SESSION_REQUIRED", "A valid ChatGPT session is required.");
  }
  return value;
}

function principal(authInfo: AuthInfo | undefined): AuthInfo {
  if (!authInfo) throw new WorkspaceBindingError("AUTHENTICATION_REQUIRED", "OAuth authentication is required.");
  if (!authInfo.scopes.includes("workspace.read")) {
    throw new WorkspaceBindingError("INSUFFICIENT_SCOPE", "The workspace.read OAuth scope is required.");
  }
  return authInfo;
}

export function createSessionMcpServer(bindings: WorkspaceBindingStore, logger: Logger): McpServer {
  const server = new McpServer(
    { name: PRODUCT_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: "Use the locally authorized bearer binding for every workspace request." }
  );

  server.registerTool(
    "bind_workspace",
    {
      title: "Bind locally authorized workspace",
      description: "Consume a short-lived local bootstrap. Keep the returned binding_token private and include it in every later session-routed tool call.",
      inputSchema: { bootstrap_token: z.string().min(1).max(128) },
      outputSchema: { binding_token: z.string() },
    },
    async (args, extra) => {
      try {
        return result(bindings.redeem(args.bootstrap_token, principal(extra.authInfo), session(extra)));
      } catch (error) {
        logger.warn("Workspace binding rejected", { reason: error instanceof WorkspaceBindingError ? error.code : "internal" });
        return fail(error);
      }
    }
  );

  registerWorkspaceTools(server, (bindingToken, extra) =>
    bindings.resolve(bindingToken, principal(extra.authInfo), session(extra))
  );

  return server;
}
