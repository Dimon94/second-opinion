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
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const execFileAsync = promisify(execFile);

const ALL_SCOPES = ["workspace.read", "workspace.search", "git.read", "execution.read"];

function issueAccessToken(bridge: Bridge, scopes = ALL_SCOPES): string {
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
    write(rootA, ".c2cignore", "only-a.secret\n");
    write(rootB, ".c2cignore", "only-b.secret\n");
    write(rootA, "only-a.secret", "hidden-a\n");
    write(rootB, "only-b.secret", "hidden-b\n");
    write(rootA, "src/index.ts", "export const answer = 'only-a';\n");
    write(rootB, "src/index.ts", "export const answer = 'only-b';\n");
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
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "bind_workspace", "execution_output", "execution_summary", "git_diff", "git_status",
        "list_directory", "read_file", "search_workspace", "test_status", "workspace_info",
      ]);
      for (const tool of tools.filter((candidate) => candidate.name !== "bind_workspace")) {
        expect((tool.inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("binding_token");
      }

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

      const readOnlyToken = issueAccessToken(bridge, ["workspace.read"]);
      const readOnlyClient = await sessionClient(bridge, readOnlyToken);
      const readOnlyBootstrap = bridge.bindings.mint(rootA, "task-read-only");
      const readOnlyBinding = data<{ binding_token: string }>(await call(
        readOnlyClient, "session-read-only", "bind_workspace", { bootstrap_token: readOnlyBootstrap.bootstrapToken }
      ));
      const gitDenied = await call(readOnlyClient, "session-read-only", "git_status", {
        binding_token: readOnlyBinding.binding_token,
      });
      expect(gitDenied.isError).toBe(true);
      expect(JSON.stringify(gitDenied)).toContain("INSUFFICIENT_SCOPE");
      await readOnlyClient.close();

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
      appendExecutionRecord(infoId(rootA), execution("task-a", "tests-a"));
      appendExecutionRecord(infoId(rootB), execution("task-b", "tests-b"));
      saveExecutionOutput(infoId(rootA), { command: "test-a", raw: "output-a", exitCode: 0 });
      saveExecutionOutput(infoId(rootB), { command: "test-b", raw: "output-b", exitCode: 0 });

      const [infoAResult, fileAResult, infoBResult, fileBResult, searchA, searchB] = await Promise.all([
        call(client, "session-a", "workspace_info", { binding_token: boundA.binding_token }),
        call(client, "session-a", "read_file", { binding_token: boundA.binding_token, path: "identity.txt" }),
        call(client, "session-b", "workspace_info", { binding_token: boundB.binding_token }),
        call(client, "session-b", "read_file", { binding_token: boundB.binding_token, path: "identity.txt" }),
        call(client, "session-a", "search_workspace", { binding_token: boundA.binding_token, query: "only-a" }),
        call(client, "session-b", "search_workspace", { binding_token: boundB.binding_token, query: "only-b" }),
      ]);
      const infoA = data<{ workspaceId: string }>(infoAResult);
      const infoB = data<{ workspaceId: string }>(infoBResult);
      expect(infoA.workspaceId).not.toBe(infoB.workspaceId);
      expect([fileAResult, fileBResult].map((result) =>
        data<{ content: string }>(result).content
      )).toEqual(["workspace A", "workspace B"]);
      expect(data<{ matches: { text: string }[] }>(searchA).matches[0].text).toContain("only-a");
      expect(data<{ matches: { text: string }[] }>(searchB).matches[0].text).toContain("only-b");

      const bindings = [boundA, boundB];
      const sessions = ["session-a", "session-b"];
      const both = (name: string, args: Record<string, unknown> = {}) => Promise.all(bindings.map((bound, index) =>
        call(client, sessions[index], name, { binding_token: bound.binding_token, ...args })
      ));
      const inFlight = both("read_file", { path: "identity.txt" });
      const switched = await admin("/admin/workspace", { workspaceRoot: rootB });
      expect(switched.status).toBe(200);
      expect((await inFlight).map((result) => data<{ content: string }>(result).content)).toEqual([
        "workspace A", "workspace B",
      ]);
      const listings = await both("list_directory", { path: "." });
      const statuses = await both("git_status");
      const diffs = await both("git_diff", { mode: "unstaged" });
      const testStatuses = await both("test_status");
      const summaries = await both("execution_summary");
      const outputs = await both("execution_output", { action: "list" });
      const sides = ["a", "b"];
      for (let index = 0; index < sides.length; index++) {
        expect(data<{ entries: { path: string }[] }>(listings[index]).entries.some((entry) => entry.path === "identity.txt")).toBe(true);
        expect(data<{ unstaged: { path: string }[] }>(statuses[index]).unstaged).toContainEqual({ path: "src/index.ts", change: "M" });
        expect(JSON.stringify(statuses[index])).not.toContain(`only-${sides[index]}.secret`);
        expect(data<{ hidden: { changes: number } }>(statuses[index]).hidden.changes).toBeGreaterThan(0);
        expect(data<{ diff: string }>(diffs[index]).diff).toContain(`only-${sides[index]}`);
        expect(data<{ tests: string }>(testStatuses[index]).tests).toBe(`tests-${sides[index]}`);
        expect(data<{ records: { taskId: string }[] }>(summaries[index]).records[0].taskId).toBe(`task-${sides[index]}`);
        expect(data<{ items: { command: string }[] }>(outputs[index]).items[0].command).toBe(`test-${sides[index]}`);
      }

      const outside = await call(client, "session-a", "read_file", {
        binding_token: boundA.binding_token, path: "../../etc/hosts",
      });
      expect(outside.isError).toBe(true);
      expect(JSON.stringify(outside)).toContain("PATH_OUTSIDE_WORKSPACE");
      const sensitive = await call(client, "session-a", "read_file", {
        binding_token: boundA.binding_token, path: "only-a.secret",
      });
      expect(sensitive.isError).toBe(true);
      expect(JSON.stringify(sensitive)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
      expect(JSON.stringify(sensitive)).not.toContain("hidden-a");

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
      expect(data<{ workspaceId: string }>(await call(client, "session-b", "workspace_info", {
        binding_token: boundB.binding_token,
      })).workspaceId).toBe(infoB.workspaceId);

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

  it("keeps bindings isolated between worktrees of the same repository", async () => {
    const stateDir = isolateStateDir();
    const main = makeTmpDir("binding-worktree-main");
    const container = makeTmpDir("binding-worktree-alt");
    const alternate = path.join(container, "checkout");
    makeGitRepo(main);
    git(main, "worktree", "add", "-b", "alternate", alternate);
    write(main, "identity.txt", "main checkout\n");
    write(alternate, "identity.txt", "alternate checkout\n");
    write(main, "src/index.ts", "export const checkout = 'main-only';\n");
    write(alternate, "src/index.ts", "export const checkout = 'alternate-only';\n");
    appendExecutionRecord(infoId(main), execution("main-task", "main-tests"));
    appendExecutionRecord(infoId(alternate), execution("alternate-task", "alternate-tests"));
    const mainOutput = saveExecutionOutput(infoId(main), {
      command: "main-command", raw: "main-output", exitCode: 0,
    });
    const alternateOutput = saveExecutionOutput(infoId(alternate), {
      command: "alternate-command", raw: "alternate-output", exitCode: 0,
    });
    const bridge = await startBridge({
      workspaceRoot: main, port: 0, persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth.json"),
    });
    const client = await sessionClient(bridge, issueAccessToken(bridge));
    try {
      const bind = async (root: string, task: string, sessionId: string) => {
        const bootstrap = bridge.bindings.mint(root, task);
        return data<{ binding_token: string }>(await call(client, sessionId, "bind_workspace", {
          bootstrap_token: bootstrap.bootstrapToken,
        }));
      };
      const [mainBinding, alternateBinding] = await Promise.all([
        bind(main, "main-task", "main-session"),
        bind(alternate, "alternate-task", "alternate-session"),
      ]);
      const invoke = (session: string, token: string, name: string, args: Record<string, unknown> = {}) =>
        call(client, session, name, { binding_token: token, ...args });
      const each = (name: string, args: Record<string, unknown> = {}) => Promise.all([
        invoke("main-session", mainBinding.binding_token, name, args),
        invoke("alternate-session", alternateBinding.binding_token, name, args),
      ]);
      const [mainFile, alternateFile] = await each("read_file", { path: "identity.txt" });
      expect(data<{ content: string }>(mainFile).content).toBe("main checkout");
      expect(data<{ content: string }>(alternateFile).content).toBe("alternate checkout");

      const infos = await each("workspace_info");
      expect(data<{ workspaceId: string }>(infos[0]).workspaceId)
        .not.toBe(data<{ workspaceId: string }>(infos[1]).workspaceId);
      const searches = await Promise.all([
        invoke("main-session", mainBinding.binding_token, "search_workspace", { query: "main-only" }),
        invoke("alternate-session", alternateBinding.binding_token, "search_workspace", { query: "alternate-only" }),
      ]);
      expect(data<{ matches: { text: string }[] }>(searches[0]).matches[0].text).toContain("main-only");
      expect(data<{ matches: { text: string }[] }>(searches[1]).matches[0].text).toContain("alternate-only");

      const statuses = await each("git_status");
      const diffs = await each("git_diff", { mode: "unstaged" });
      const testStatuses = await each("test_status");
      const summaries = await each("execution_summary");
      const outputs = await each("execution_output", { action: "list" });
      for (const index of [0, 1]) {
        const own = index === 0 ? "main" : "alternate";
        const sibling = index === 0 ? "alternate" : "main";
        expect(data<{ unstaged: { path: string }[] }>(statuses[index]).unstaged)
          .toContainEqual({ path: "src/index.ts", change: "M" });
        expect(data<{ diff: string }>(diffs[index]).diff).toContain(`${own}-only`);
        expect(data<{ diff: string }>(diffs[index]).diff).not.toContain(`${sibling}-only`);
        expect(data<{ tests: string }>(testStatuses[index]).tests).toBe(`${own}-tests`);
        expect(data<{ records: { taskId: string }[] }>(summaries[index]).records[0].taskId)
          .toBe(`${own}-task`);
        expect(data<{ items: { command: string }[] }>(outputs[index]).items[0].command)
          .toBe(`${own}-command`);
      }
      const outputBodies = await Promise.all([
        invoke("main-session", mainBinding.binding_token, "execution_output", { action: "read", id: mainOutput.id }),
        invoke("alternate-session", alternateBinding.binding_token, "execution_output", { action: "read", id: alternateOutput.id }),
      ]);
      expect(data<{ text: string }>(outputBodies[0]).text).toBe("main-output");
      expect(data<{ text: string }>(outputBodies[1]).text).toBe("alternate-output");
    } finally {
      await client.close();
      await bridge.close();
      git(main, "worktree", "remove", "--force", alternate);
      cleanup(stateDir);
      cleanup(container);
      cleanup(main);
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

function infoId(root: string): string {
  return new Workspace(root).id;
}

function execution(taskId: string, tests: string) {
  return { taskId, iteration: 1, changedFiles: 1, tests, exitStatus: "ok", timestamp: new Date().toISOString() };
}
