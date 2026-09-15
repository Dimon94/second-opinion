import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { mcpUrlFromPublic } from "../src/config/endpoint.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const execFileAsync = promisify(execFile);

function issueAccessToken(bridge: Bridge, scopes = ["workspace.read"]): string {
  const client = bridge.authStore.registerClient({
    clientName: "session-routing-test",
    redirectUris: ["https://chatgpt.com/oauth/callback"],
    baseUrl: bridge.localBaseUrl(),
  });
  return bridge.authStore.issueTokens({
    identity: bridge.authStore.identityForClient(bridge.localBaseUrl(), client.clientId, scopes)!,
  }).accessToken;
}

async function sessionClient(bridge: Bridge, accessToken: string): Promise<Client> {
  const client = new Client({ name: "session-routing-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrlFromPublic(bridge.localBaseUrl())!), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  return client;
}

function call(client: Client, session: string, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args, _meta: { "openai/session": session } });
}

function data<T>(result: { content?: unknown }): T {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text) as T;
}

describe("session-routed MCP entry", () => {
  it("binds two local roots and rejects missing, mismatched, replayed and revoked credentials", async () => {
    const stateDir = isolateStateDir();
    const rootA = makeTmpDir("binding-a");
    const rootB = makeTmpDir("binding-b");
    makeGitRepo(rootA);
    makeGitRepo(rootB);
    write(rootA, "identity.txt", "workspace A\n");
    write(rootB, "identity.txt", "workspace B\n");
    const bridge = await startBridge({
      workspaceRoot: rootA,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(stateDir, "auth.json"),
    });
    const accessToken = issueAccessToken(bridge);
    const client = await sessionClient(bridge, accessToken);
    const admin = async (route: string, body: unknown, authorized = true) =>
      fetch(`${bridge.localBaseUrl()}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized ? { authorization: `Bearer ${bridge.adminToken}` } : {}),
        },
        body: JSON.stringify(body),
      });

    try {
      expect((await admin("/admin/bindings/bootstrap", { workspaceRoot: rootA, taskId: "task-a" }, false)).status).toBe(404);
      const mintedA = await admin("/admin/bindings/bootstrap", { workspaceRoot: rootA, taskId: "task-a" });
      expect(mintedA.status).toBe(200);
      const bootstrapA = await mintedA.json() as { bootstrapToken: string; expiresAt: number };
      expect(bootstrapA.bootstrapToken).toMatch(/^c2c_boot_/);

      const attempts = await Promise.all([
        call(client, "session-a", "bind_workspace", { bootstrap_token: bootstrapA.bootstrapToken }),
        call(client, "session-a", "bind_workspace", { bootstrap_token: bootstrapA.bootstrapToken }),
      ]);
      expect(attempts.filter((attempt) => !attempt.isError)).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.isError)).toHaveLength(1);
      const boundA = data<{ binding_token: string }>(attempts.find((attempt) => !attempt.isError)!);
      expect(boundA.binding_token).toMatch(/^c2c_bind_/);

      const missing = await call(client, "session-a", "workspace_info", {});
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toContain("WORKSPACE_BINDING_REQUIRED");
      const copiedMetadata = await call(client, "session-b", "workspace_info", {
        binding_token: boundA.binding_token,
      });
      expect(copiedMetadata.isError).toBe(true);
      expect(JSON.stringify(copiedMetadata)).toContain("WORKSPACE_BINDING_MISMATCH");

      const otherToken = issueAccessToken(bridge);
      const otherClient = await sessionClient(bridge, otherToken);
      const copiedToken = await call(otherClient, "session-a", "workspace_info", {
        binding_token: boundA.binding_token,
      });
      expect(copiedToken.isError).toBe(true);
      expect(JSON.stringify(copiedToken)).toContain("WORKSPACE_BINDING_MISMATCH");
      await otherClient.close();

      const narrowToken = issueAccessToken(bridge, ["git.read"]);
      const narrowClient = await sessionClient(bridge, narrowToken);
      const narrowBootstrap = await (await admin("/admin/bindings/bootstrap", {
        workspaceRoot: rootA, taskId: "task-narrow",
      })).json() as { bootstrapToken: string };
      const insufficient = await call(narrowClient, "session-narrow", "bind_workspace", {
        bootstrap_token: narrowBootstrap.bootstrapToken,
      });
      expect(insufficient.isError).toBe(true);
      expect(JSON.stringify(insufficient)).toContain("INSUFFICIENT_SCOPE");
      await narrowClient.close();

      const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
      await expect(execFileAsync(process.execPath, [
        "--import", "tsx", cli, "binding", "bootstrap", "--json",
      ], {
        cwd: rootB,
        encoding: "utf8",
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CODEX_THREAD_ID")),
      })).rejects.toMatchObject({
        stdout: expect.stringContaining("CODEX_THREAD_ID is required"),
      });
      const cliBootstrap = await execFileAsync(process.execPath, [
        "--import", "tsx", cli, "binding", "bootstrap", "--json",
      ], { cwd: rootB, encoding: "utf8", env: { ...process.env, CODEX_THREAD_ID: "task-b" } });
      expect(cliBootstrap.stderr).toBe("");
      const bootstrapB = JSON.parse(cliBootstrap.stdout) as { bootstrapToken: string };
      expect(bridge.workspace.root).toBe(rootA);
      const boundB = data<{ binding_token: string }>(await call(client, "session-b", "bind_workspace", {
        bootstrap_token: bootstrapB.bootstrapToken,
      }));
      const [infoAResult, fileAResult, infoBResult, fileBResult, repeatedAResult, repeatedBResult] = await Promise.all([
        call(client, "session-a", "workspace_info", { binding_token: boundA.binding_token }),
        call(client, "session-a", "read_file", { binding_token: boundA.binding_token, path: "identity.txt" }),
        call(client, "session-b", "workspace_info", { binding_token: boundB.binding_token }),
        call(client, "session-b", "read_file", { binding_token: boundB.binding_token, path: "identity.txt" }),
        call(client, "session-a", "read_file", { binding_token: boundA.binding_token, path: "identity.txt" }),
        call(client, "session-b", "read_file", { binding_token: boundB.binding_token, path: "identity.txt" }),
      ]);
      const infoA = data<{ workspaceId: string }>(infoAResult);
      const infoB = data<{ workspaceId: string }>(infoBResult);
      expect(infoA.workspaceId).not.toBe(infoB.workspaceId);
      expect([fileAResult, fileBResult, repeatedAResult, repeatedBResult].map((result) =>
        data<{ content: string }>(result).content
      )).toEqual(["workspace A", "workspace B", "workspace A", "workspace B"]);

      const outside = await call(client, "session-a", "read_file", {
        binding_token: boundA.binding_token, path: "../../etc/hosts",
      });
      expect(outside.isError).toBe(true);
      expect(JSON.stringify(outside)).toContain("PATH_OUTSIDE_WORKSPACE");

      const unsupported = await call(client, "session-a", "git_status", {
        binding_token: boundA.binding_token,
      });
      expect(unsupported.isError).toBe(true);
      expect(JSON.stringify(unsupported)).toContain("Tool git_status not found");

      const persisted = fs.readFileSync(path.join(stateDir, "bindings", "store.json"), "utf8");
      expect(persisted).not.toContain(bootstrapA.bootstrapToken);
      expect(persisted).not.toContain(boundA.binding_token);
      expect(persisted).toContain(rootA);

      const cliUnbind = await execFileAsync(process.execPath, [
        "--import", "tsx", cli, "binding", "unbind", "--json",
      ], { cwd: rootA, encoding: "utf8", env: { ...process.env, CODEX_THREAD_ID: "task-a" } });
      expect(cliUnbind.stderr).toBe("");
      expect(JSON.parse(cliUnbind.stdout)).toMatchObject({ ok: true, removed: 1 });
      const unbound = await call(client, "session-a", "workspace_info", {
        binding_token: boundA.binding_token,
      });
      expect(unbound.isError).toBe(true);
      expect(JSON.stringify(unbound)).toContain("WORKSPACE_BINDING_REQUIRED");

      bridge.authStore.revokeToken(accessToken);
      expect(bridge.bindings.count()).toBe(0);
      const revoked = await fetch(`${bridge.localBaseUrl()}/mcp/session`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(revoked.status).toBe(401);

      const replacementToken = issueAccessToken(bridge);
      const replacementClient = await sessionClient(bridge, replacementToken);
      const cannotRevive = await call(replacementClient, "session-b", "workspace_info", {
        binding_token: boundB.binding_token,
      });
      expect(cannotRevive.isError).toBe(true);
      expect(JSON.stringify(cannotRevive)).toContain("WORKSPACE_BINDING_REQUIRED");
      await replacementClient.close();
    } finally {
      await client.close();
      await bridge.close();
      cleanup(stateDir);
      cleanup(rootA);
      cleanup(rootB);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("rejects an expired local bootstrap", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("binding-expired");
    makeGitRepo(root);
    const bridge = await startBridge({
      workspaceRoot: root, port: 0, persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth.json"), bindingBootstrapTtlMs: -1,
    });
    const client = await sessionClient(bridge, issueAccessToken(bridge));
    try {
      const minted = bridge.bindings.mint(root, "expired-task");
      const expired = await call(client, "expired-session", "bind_workspace", {
        bootstrap_token: minted.bootstrapToken,
      });
      expect(expired.isError).toBe(true);
      expect(JSON.stringify(expired)).toContain("INVALID_BOOTSTRAP");
    } finally {
      await client.close();
      await bridge.close();
      cleanup(stateDir);
      cleanup(root);
      delete process.env.C2C_STATE_DIR;
    }
  });
});
