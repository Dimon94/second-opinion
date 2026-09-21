import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { WorkspaceBindingError, type WorkspaceBindingStore } from "../session/bindings.js";
import { registerWorkspaceTools } from "./server.js";
import type { Logger } from "../logger/index.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import type { ReviewStore } from "../session/reviews.js";

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

export function createSessionMcpServer(bindings: WorkspaceBindingStore, logger: Logger, reviews?: ReviewStore): McpServer {
  const server = new McpServer(
    { name: PRODUCT_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: "Use the locally authorized bearer binding for every workspace request." }
  );

  server.registerTool("connection_info", {
    title: "Inspect this connection",
    description: "Return a signed proof of this authenticated connection for a local challenge nonce. Does not bind a workspace, change permissions, or read project files. Return the proof to the local Codex task for authorization.",
    inputSchema: { nonce: z.string().regex(/^[a-f0-9]{64}$/) },
    outputSchema: { connection_proof: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try { return result(bindings.connectionInfo(principal(extra.authInfo), session(extra), args.nonce)); }
    catch (error) { return fail(error); }
  });

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

  if (reviews) server.registerTool("complete_review", {
    title: "Deliver completed review and wake its Codex task",
    description: "Use when the user requests delivery of a completed review to the locally authorized Codex task. Saves the review and sends a message that starts a new Codex turn. The sent message and started turn cannot be undone by this tool. Requires review.submit OAuth permission and host confirmation. Scope is restricted to the locally armed review; it does not authorize new work. Never include credentials in the review.",
    inputSchema: { binding_token: z.string().min(1).max(128), review_id: z.string().uuid(), result: z.string().min(1).max(32000) },
    outputSchema: { status: z.enum(["notified", "acknowledged"]), duplicate: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    // The installed MCP SDK exposes the documented ChatGPT compatibility field.
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["workspace.read", "review.submit"] }] },
  }, async (args, extra) => {
    try {
      const auth = principal(extra.authInfo);
      if (!auth.scopes.includes("review.submit")) return {
        ...fail(new WorkspaceBindingError("INSUFFICIENT_SCOPE", "Review delivery requires explicit review.submit OAuth consent.")),
        _meta: { "mcp/www_authenticate": ['Bearer error="insufficient_scope", error_description="Review delivery requires explicit OAuth consent", scope="workspace.read review.submit"'] },
      };
      const owner = bindings.identify(args.binding_token, auth, session(extra));
      return result(await reviews.complete(owner.workspaceRoot, owner.taskHash, args.review_id, args.result));
    } catch (error) { return fail(error); }
  });

  registerWorkspaceTools(server, (bindingToken, extra) =>
    bindings.resolve(bindingToken, principal(extra.authInfo), session(extra))
  );

  return server;
}
