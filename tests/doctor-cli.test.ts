import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import {
  probeBridge,
  readRuntimeState,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { getDefaultStateDir, writeSecureJson } from "../src/config/paths.js";
import { mcpUrlFromPublic, writeLastEndpoint } from "../src/config/endpoint.js";
import { adminFetch, ensureBridge, stopBridge } from "../src/process/daemon.js";
import { sessionFile, writeSession } from "../src/session/state.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const previousOriginCert = process.env.TUNNEL_ORIGIN_CERT;

class FixtureTunnel implements TunnelProvider {
  private running = false;
  private url: string | null = null;
  startCalls = 0;

  constructor(
    readonly name: string,
    private readonly nextUrl: (port: number) => string,
    private readonly binaryFound = true,
    private readonly startError?: string
  ) {}

  async start(localPort: number): Promise<string> {
    this.startCalls += 1;
    if (this.startError) throw new Error(this.startError);
    this.running = true;
    this.url = this.nextUrl(localPort);
    return this.url;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.url = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return { running: this.running, url: this.url, provider: this.name };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: this.binaryFound,
      binaryPath: this.binaryFound ? "fixture-cloudflared" : null,
      running: this.running,
      url: this.url,
      problems: [],
    };
  }
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  command: string,
  workspace: string,
  stateDir: string,
  codexHome: string,
  ...args: string[]
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        path.join(projectRoot, "src", "cli", "index.ts"),
        command,
        "-w",
        workspace,
        ...args,
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: codexHome },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runDoctor(
  workspace: string,
  stateDir: string,
  codexHome: string,
  ...args: string[]
): Promise<CliResult> {
  return runCli("doctor", workspace, stateDir, codexHome, ...args);
}

async function startFixtureTunnel(runtime: RuntimeState): Promise<{ url: string }> {
  try {
    return await adminFetch(runtime, "POST", "/admin/tunnel/start");
  } catch {
    return adminFetch(runtime, "POST", "/admin/tunnel/start");
  }
}

function isolatedWorkspace(name: string): {
  workspace: string;
  stateDir: string;
  codexHome: string;
} {
  const workspace = makeTmpDir(`${name}-workspace`);
  write(workspace, "README.md", "fixture\n");
  return {
    workspace,
    stateDir: makeTmpDir(`${name}-state`),
    codexHome: makeTmpDir(`${name}-codex-home`),
  };
}

function tree(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

function parseResult(output: string): Record<string, unknown> {
  expect(output.trim().split("\n")).toHaveLength(1);
  return JSON.parse(output) as Record<string, unknown>;
}

function recoveryLeasePath(stateDir: string): string {
  return path.join(stateDir, "recovery", "active");
}

function writeRecoveryLeaseFixture(
  stateDir: string,
  workspace: Workspace,
  input: { leaseId: string; pid: number; startedAt: string; expiresAt: string }
): void {
  const leaseDir = recoveryLeasePath(stateDir);
  writeSecureJson(path.join(leaseDir, "lease.json"), {
    version: 1,
    leaseId: input.leaseId,
    ownerPid: input.pid,
    startedAt: input.startedAt,
    expiresAt: input.expiresAt,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    phase: "bridge",
  });
}

async function waitForFile(file: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function stopSpawnedBridge(workspace: string, stateDir: string): Promise<void> {
  process.env.C2C_STATE_DIR = stateDir;
  const runtime = readRuntimeState();
  await stopBridge(workspace);
  if (runtime) {
    for (let attempt = 0; attempt < 20 && (await probeBridge(runtime.port, 100)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function mcpJson<T>(result: { content?: unknown }): T {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text) as T;
}

function runtimeFor(workspace: Workspace, pid: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid,
    port: 1,
    adminToken: "c2c_admin_should_never_appear",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("c2c doctor contract", () => {
  const dirs: string[] = [];
  const bridges: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) await bridge.close();
    for (const dir of dirs.splice(0)) cleanup(dir);
    delete process.env.C2C_STATE_DIR;
    if (previousOriginCert === undefined) delete process.env.TUNNEL_ORIGIN_CERT;
    else process.env.TUNNEL_ORIGIN_CERT = previousOriginCert;
  });

  it("requires explicit global OAuth consent for ambiguous legacy identity", async () => {
    const fixture = isolatedWorkspace("doctor-legacy-ambiguous");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const workspace = new Workspace(fixture.workspace);
    writeSecureJson(path.join(fixture.stateDir, "auth", `${workspace.id}.json`), {
      clients: [{ clientId: "legacy-client", redirectUris: [], createdAt: "2026-01-01" }],
      tokens: [],
    });
    const bridge = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
    });
    bridges.push(bridge);

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");

    expect(result.status).toBe(2);
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: "user_action_required",
      reason: "auth_required",
      migration: {
        version: 1,
        status: "consent_required",
        reason: "identity_incomplete",
      },
      nextAction: { type: "authorize_oauth", reason: "auth_required" },
    });
    expect(bridge.pairing.hasActiveSession()).toBe(false);
    expect(fs.existsSync(path.join(fixture.stateDir, "auth", "store.json"))).toBe(false);
  });

  it("resolves owner state with native macOS and Windows path semantics", () => {
    expect(getDefaultStateDir("darwin", "/Users/alice", {})).toBe(
      "/Users/alice/Library/Application Support/codex-with-chatgpt"
    );
    expect(getDefaultStateDir("win32", "C:\\Users\\alice", {})).toBe(
      "C:\\Users\\alice\\AppData\\Local\\codex-with-chatgpt"
    );
    expect(getDefaultStateDir("win32", "C:\\Users\\alice", { LOCALAPPDATA: "D:\\Local Data" })).toBe(
      "D:\\Local Data\\codex-with-chatgpt"
    );
  });

  it("reports repaired then healthy through the same versioned result", async () => {
    const fixture = isolatedWorkspace("doctor-healthy");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const bridge = await startBridge({ workspaceRoot: fixture.workspace, port: 0, persistRuntime: true });
    bridges.push(bridge);

    const repaired = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--json"
    );
    expect(repaired.status).toBe(0);
    expect(repaired.stderr).toBe("");
    expect(parseResult(repaired.stdout)).toMatchObject({
      version: 1,
      outcome: "repaired",
      reason: "local_repairs_completed",
      safeRetry: true,
      nextAction: { type: "create_conversation", reason: "conversation_missing" },
      conversation: { mode: "project", workspaceId: expect.any(String) },
    });

    const healthy = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--json"
    );
    expect(healthy.status).toBe(0);
    expect(healthy.stderr).toBe("");
    expect(parseResult(healthy.stdout)).toMatchObject({
      version: 1,
      outcome: "healthy",
      reason: "all_checks_passed",
      repairs: [],
      safeRetry: true,
      nextAction: { type: "create_conversation", reason: "conversation_missing" },
      conversation: { mode: "project", workspaceId: expect.any(String) },
    });

    const direct = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--direct",
      "--json"
    );
    expect(direct.status).toBe(0);
    expect(parseResult(direct.stdout)).toMatchObject({
      outcome: "healthy",
      reason: "all_checks_passed",
      nextAction: { type: "none" },
      conversation: null,
    });
  });

  it("replaces a healthy bridge without auth-reload capability before migrating", async () => {
    const fixture = isolatedWorkspace("doctor-legacy-bridge");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const workspace = new Workspace(fixture.workspace);
    const legacy = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" }));
        return;
      }
      if (req.url === "/admin/info") {
        res.end(JSON.stringify({ workspaceId: workspace.id, authorization: { state: "healthy" } }));
        return;
      }
      if (req.url === "/admin/shutdown" && req.method === "POST") {
        res.end(JSON.stringify({ shuttingDown: true }));
        setTimeout(() => legacy.close(), 10);
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => legacy.listen(0, "127.0.0.1", resolve));
    const address = legacy.address();
    expect(address && typeof address === "object").toBe(true);
    writeRuntimeState({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port: (address as { port: number }).port,
      adminToken: "legacy-admin-token",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    });
    writeSecureJson(path.join(fixture.stateDir, "auth", `${workspace.id}.json`), {
      clients: [{ clientId: "legacy-client", redirectUris: [], createdAt: "2026-01-01" }],
      tokens: [],
    });

    try {
      const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");

      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(parseResult(result.stdout)).toMatchObject({
        version: 1,
        outcome: "user_action_required",
        reason: "auth_required",
        repairs: expect.arrayContaining(["已自动启动 Bridge"]),
        nextAction: { type: "authorize_oauth", reason: "auth_required" },
      });
    } finally {
      await stopSpawnedBridge(fixture.workspace, fixture.stateDir);
      if (legacy.listening) {
        await new Promise<void>((resolve, reject) => legacy.close((error) => error ? reject(error) : resolve()));
      }
    }
  });

  it("uses the doctor contract for setup and creates pairing only for OAuth authorization", async () => {
    const fixture = isolatedWorkspace("doctor-setup-handoff");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const workspace = new Workspace(fixture.workspace);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "quick",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-quick",
    });
    const bridge = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: new FixtureTunnel("cloudflare-quick", (port) => `http://127.0.0.1:${port}`),
    });
    bridges.push(bridge);

    const setup = await runCli(
      "setup",
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--json"
    );
    expect(setup.status).toBe(2);
    expect(parseResult(setup.stdout)).toMatchObject({
      version: 1,
      outcome: "user_action_required",
      reason: "connector_missing",
      nextAction: {
        type: "replace_connector",
        reason: "connector_missing",
        connectorName: expect.any(String),
        endpoint: `${bridge.localBaseUrl()}/mcp/session`,
      },
    });
    expect(
      await adminFetch<{ pairingActive: boolean }>(readRuntimeState()!, "GET", "/admin/info")
    ).toMatchObject({ pairingActive: false });

    const authorize = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--json"
    );
    expect(authorize.status).toBe(2);
    expect(parseResult(authorize.stdout)).toMatchObject({
      outcome: "user_action_required",
      reason: "auth_required",
      nextAction: {
        type: "authorize_oauth",
        reason: "auth_required",
      },
    });
    expect(
      await adminFetch<{ pairingActive: boolean }>(readRuntimeState()!, "GET", "/admin/info")
    ).toMatchObject({ pairingActive: false });

    const rejectedPage = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--json",
      "--browser-gate",
      "chatgpt_login",
      "--browser-page",
      "https://evil.example/login"
    );
    expect(rejectedPage.status).toBe(1);
    expect(parseResult(rejectedPage.stdout)).toMatchObject({
      outcome: "blocked",
      reason: "checks_failed",
      nextAction: { type: "manual_recovery", reason: "checks_failed" },
    });

    const pairing = await runCli(
      "pair",
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--json"
    );
    expect(pairing.status).toBe(0);
    expect(parseResult(pairing.stdout)).toMatchObject({
      ok: true,
      pairingCode: expect.any(String),
      expiresAt: expect.any(Number),
    });
    expect(
      await adminFetch<{ pairingActive: boolean }>(readRuntimeState()!, "GET", "/admin/info")
    ).toMatchObject({ pairingActive: true });
  });

  it.each([
    ["chatgpt_login", "chatgpt_login_required", "chatgpt_login", "https://chatgpt.com/auth/login", "https://chatgpt.com/auth/login"],
    ["administrator_approval", "administrator_approval_required", "administrator_approval", "https://chatgpt.com/auth/login?next=%2Fplugins", "https://chatgpt.com/auth/login?next=%2Fplugins"],
  ] as const)("normalizes an observed %s gate through public doctor JSON", async (gate, reason, action, page, expectedPage) => {
    const fixture = isolatedWorkspace(`doctor-browser-${gate}`);
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const workspace = new Workspace(fixture.workspace);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "quick",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-quick",
    });
    const bridge = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: new FixtureTunnel("cloudflare-quick", (port) => `http://127.0.0.1:${port}`),
    });
    bridges.push(bridge);

    const result = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--json",
      "--browser-gate",
      gate,
      "--browser-page",
      page
    );

    expect(result.status).toBe(2);
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: "user_action_required",
      reason,
      nextAction: {
        type: action,
        reason,
        page: expectedPage,
      },
    });
  });

  it("does not recover a saved public connection for setup --no-tunnel", async () => {
    const fixture = isolatedWorkspace("doctor-setup-no-tunnel");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const workspace = new Workspace(fixture.workspace);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "quick",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-quick",
    });
    const tunnel = new FixtureTunnel("cloudflare-quick", (port) => `http://127.0.0.1:${port}`);
    const bridge = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: tunnel,
    });
    bridges.push(bridge);

    const result = await runCli(
      "setup",
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--no-tunnel",
      "--json"
    );

    expect(result.status).toBe(1);
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: "unknown",
      reason: "probe_inconclusive",
      nextAction: { type: "retry_wait" },
    });
    expect(tunnel.startCalls).toBe(0);
  });

  it("reuses a protected grant across a stable bridge restart without pairing", async () => {
    const fixture = isolatedWorkspace("doctor-oauth-restart");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const tunnel = new FixtureTunnel("fixture-named", (port) => `http://127.0.0.1:${port}`);
    const first = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: tunnel,
    });
    bridges.push(first);
    const runtime = readRuntimeState()!;
    const started = await startFixtureTunnel(runtime);
    const client = first.authStore.registerClient({
      clientName: "stable-chatgpt-client",
      redirectUris: ["https://chatgpt.com/oauth/callback"],
      baseUrl: started.url,
    });
    const tokens = first.authStore.issueTokens({
      identity: first.authStore.identityForClient(
        started.url,
        client.clientId,
        ["workspace.read", "offline_access"]
      )!,
    });
    expect(
      await fetch(`${started.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tokens.accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      })
    ).toMatchObject({ status: 200 });
    writeLastEndpoint({
      workspaceId: first.workspace.id,
      port: first.port,
      publicUrl: started.url,
      mcpUrl: `${started.url}/mcp/session`,
      connectorName: "Codex with ChatGPT",
    });

    await first.close();
    const restarted = await startBridge({
      workspaceRoot: fixture.workspace,
      port: first.port,
      persistRuntime: true,
      tunnelProvider: new FixtureTunnel("fixture-named", (port) => `http://127.0.0.1:${port}`),
    });
    bridges.push(restarted);
    await startFixtureTunnel(readRuntimeState()!);

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
    expect(result.status).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: expect.stringMatching(/^(healthy|repaired)$/),
      authorization: {
        state: "healthy",
        proof: "protected_resource",
        clientId: client.clientId,
      },
      nextAction: { type: expect.not.stringMatching(/^authorize_oauth$/) },
    });
    expect(
      await adminFetch<{ pairingActive: boolean }>(readRuntimeState()!, "GET", "/admin/info")
    ).toMatchObject({ pairingActive: false });
  });

  it("advances recoverable access expiry through a real refresh-capable conversation action", async () => {
    const fixture = isolatedWorkspace("doctor-oauth-access-expired");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const first = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: new FixtureTunnel("fixture-named", (port) => `http://127.0.0.1:${port}`),
    });
    bridges.push(first);
    const started = await startFixtureTunnel(readRuntimeState()!);
    const client = first.authStore.registerClient({
      clientName: "recoverable-chatgpt-client",
      redirectUris: ["https://chatgpt.com/oauth/callback"],
      baseUrl: started.url,
    });
    const tokens = first.authStore.issueTokens({
      identity: first.authStore.identityForClient(
        started.url,
        client.clientId,
        ["workspace.read", "offline_access"]
      )!,
    });
    const conversationUrl = "https://chatgpt.com/c/recoverable-expiry";
    writeLastEndpoint({
      workspaceId: first.workspace.id,
      port: first.port,
      publicUrl: started.url,
      mcpUrl: mcpUrlFromPublic(started.url),
      connectorName: "Codex with ChatGPT",
    });
    writeSession(first.workspace.id, {
      url: conversationUrl,
      conversationMode: "long-chat",
      connectorName: "Codex with ChatGPT",
      savedAt: new Date().toISOString(),
    });
    await first.close();

    const storeFile = path.join(fixture.stateDir, "auth", "store.json");
    const persisted = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      clients: Array<{ grant: { accessExpiresAt: number } }>;
    };
    persisted.clients[0].grant.accessExpiresAt = 0;
    fs.writeFileSync(storeFile, JSON.stringify(persisted));

    const restarted = await startBridge({
      workspaceRoot: fixture.workspace,
      port: first.port,
      persistRuntime: true,
      tunnelProvider: new FixtureTunnel("fixture-named", (port) => `http://127.0.0.1:${port}`),
    });
    bridges.push(restarted);
    await startFixtureTunnel(readRuntimeState()!);

    const expired = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
    expect(expired.status).toBe(1);
    expect(parseResult(expired.stdout)).toMatchObject({
      outcome: "unknown",
      reason: "auth_refresh_required",
      authorization: {
        state: "expired",
        recoverable: true,
      },
      nextAction: {
        type: "open_conversation",
        reason: "auth_refresh_required",
        page: conversationUrl,
      },
    });
    expect(
      await adminFetch<{ pairingActive: boolean }>(readRuntimeState()!, "GET", "/admin/info")
    ).toMatchObject({ pairingActive: false });

    const refreshed = await fetch(`${started.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken!,
        client_id: client.clientId,
        resource: `${started.url}/mcp`,
      }),
    });
    expect(refreshed.status).toBe(200);
    const refreshedTokens = await refreshed.json() as {
      access_token: string;
      refresh_token: string;
    };
    const persistedAfterRefresh = fs.readFileSync(storeFile, "utf8");
    expect(persistedAfterRefresh).not.toContain(refreshedTokens.access_token);
    expect(persistedAfterRefresh).not.toContain(refreshedTokens.refresh_token);

    const healthy = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
    expect(healthy.status).toBe(0);
    expect(parseResult(healthy.stdout)).toMatchObject({
      outcome: expect.stringMatching(/^(healthy|repaired)$/),
      authorization: {
        state: "healthy",
        proof: "refresh",
      },
      nextAction: { type: "open_conversation", page: conversationUrl },
    });
  });

  it.each([
    "unpair",
    "revoked",
    "expired",
    "lost",
    "invalid_client",
    "scope_mismatch",
    "identity_mismatch",
    "unverified",
  ] as const)(
    "classifies a %s persisted grant without guessing",
    async (failure) => {
      const fixture = isolatedWorkspace(`doctor-oauth-${failure}`);
      dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
      process.env.C2C_STATE_DIR = fixture.stateDir;
      const first = await startBridge({
        workspaceRoot: fixture.workspace,
        port: 0,
        persistRuntime: true,
        tunnelProvider: new FixtureTunnel("fixture-named", (port) => `http://127.0.0.1:${port}`),
      });
      bridges.push(first);
      const started = await startFixtureTunnel(readRuntimeState()!);
      const client = first.authStore.registerClient({
        clientName: "persisted-chatgpt-client",
        redirectUris: ["https://chatgpt.com/oauth/callback"],
        baseUrl: started.url,
      });
      const tokens = first.authStore.issueTokens({
        identity: first.authStore.identityForClient(
          started.url,
          client.clientId,
          ["workspace.read", "offline_access"]
        )!,
      });
      writeLastEndpoint({
        workspaceId: first.workspace.id,
        port: first.port,
        publicUrl: started.url,
        mcpUrl: `${started.url}/mcp/session`,
        connectorName: "Codex with ChatGPT",
      });
      await first.close();

      const storeFile = path.join(fixture.stateDir, "auth", "store.json");
      if (failure === "unpair") {
        expect(
          (await runCli("unpair", fixture.workspace, fixture.stateDir, fixture.codexHome)).status
        ).toBe(0);
      } else if (failure === "revoked") {
        first.authStore.revokeToken(tokens.refreshToken!);
      } else if (failure === "lost") {
        fs.rmSync(storeFile);
      } else {
        const persisted = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
          clients: Array<{
            grantedScopes?: string[];
            grant?: {
              accessExpiresAt: number;
              refreshExpiresAt: number | null;
              binding: { bridgeId: string };
            };
          }>;
        };
        if (failure === "invalid_client") persisted.clients = [];
        else if (failure === "expired") {
          persisted.clients[0].grant!.accessExpiresAt = 0;
          persisted.clients[0].grant!.refreshExpiresAt = 0;
        }
        else if (failure === "unverified") {
          delete persisted.clients[0].grant;
        }
        else if (failure === "identity_mismatch") {
          persisted.clients[0].grant!.binding.bridgeId += "-changed";
        }
        else persisted.clients[0].grantedScopes = [
          "workspace.read",
          "workspace.search",
          "offline_access",
        ];
        fs.writeFileSync(storeFile, JSON.stringify(persisted));
      }

      const restarted = await startBridge({
        workspaceRoot: fixture.workspace,
        port: first.port,
        persistRuntime: true,
        tunnelProvider: new FixtureTunnel("fixture-named", (port) => `http://127.0.0.1:${port}`),
      });
      bridges.push(restarted);
      await startFixtureTunnel(readRuntimeState()!);

      const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
      const retry = failure === "unverified";
      expect(result.status).toBe(retry ? 1 : 2);
      expect(parseResult(result.stdout)).toMatchObject({
        outcome: retry ? "unknown" : "user_action_required",
        reason: retry
          ? "probe_inconclusive"
          : failure === "invalid_client"
            ? "invalid_client"
            : "auth_required",
        authorization: {
          state: failure === "scope_mismatch" || failure === "identity_mismatch"
            ? "identity_mismatch"
            : failure === "unpair"
              ? "revoked"
            : failure === "lost"
              ? "missing"
              : failure,
          ...(failure === "scope_mismatch"
            ? { reason: "scope_mismatch" }
            : failure === "identity_mismatch"
              ? { reason: "bridge_mismatch" }
              : {}),
          recoverable: retry,
        },
        nextAction: retry
          ? { type: "retry_wait" }
          : { type: "authorize_oauth" },
      });
      expect(
        await adminFetch<{ pairingActive: boolean }>(readRuntimeState()!, "GET", "/admin/info")
      ).toMatchObject({ pairingActive: false });
    }
  );

  it("returns a normalized workspace-scoped action for a saved long chat", async () => {
    const fixture = isolatedWorkspace("doctor-conversation");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const bridge = await startBridge({ workspaceRoot: fixture.workspace, port: 0, persistRuntime: true });
    bridges.push(bridge);
    writeSecureJson(sessionFile(bridge.workspace.id), {
      url: "https://chatgpt.com/c/WEB:saved-chat?model=auto",
      conversationMode: "long-chat",
      connectorName: "Codex with ChatGPT",
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 3,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");

    expect(result.status).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({
      conversation: {
        workspaceId: bridge.workspace.id,
        mode: "long-chat",
        chatUrl: "https://chatgpt.com/c/saved-chat",
        connectorName: "Codex with ChatGPT",
        reuseSavedChat: true,
      },
      nextAction: {
        type: "open_conversation",
        page: "https://chatgpt.com/c/saved-chat",
      },
      chatgptRepair: { needed: false, connectorAction: "none" },
    });
    expect(bridge.pairing.hasActiveSession()).toBe(false);
  });

  it("opens the retained Project when its conversation is missing without changing bindings", async () => {
    const fixture = isolatedWorkspace("doctor-project-missing");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const bridge = await startBridge({ workspaceRoot: fixture.workspace, port: 0, persistRuntime: true });
    bridges.push(bridge);
    const projectUrl = "https://chatgpt.com/g/g-p-abc123/project";
    writeSession(bridge.workspace.id, {
      conversationMode: "project",
      projectUrl,
      connectorName: "Codex with ChatGPT",
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    const before = fs.readFileSync(sessionFile(bridge.workspace.id), "utf8");

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");

    expect(result.status).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({
      conversation: {
        workspaceId: bridge.workspace.id,
        mode: "project",
        projectUrl,
        chatUrl: null,
        connectorName: "Codex with ChatGPT",
      },
      nextAction: { type: "open_conversation", reason: "conversation_missing", page: projectUrl },
      chatgptRepair: { needed: false, connectorAction: "none" },
    });
    expect(fs.readFileSync(sessionFile(bridge.workspace.id), "utf8")).toBe(before);
  });

  it("activates the requested workspace without replacing the healthy global bridge", async () => {
    const fixture = isolatedWorkspace("doctor-switch");
    const requestedRoot = makeTmpDir("doctor-switch-target");
    const driftRoot = makeTmpDir("doctor-switch-drift");
    write(requestedRoot, "target.txt", "target\n");
    write(driftRoot, "drift.txt", "drift\n");
    dirs.push(fixture.workspace, requestedRoot, driftRoot, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const bridge = await startBridge({ workspaceRoot: fixture.workspace, port: 0, persistRuntime: true });
    bridges.push(bridge);
    const oauthClient = bridge.authStore.registerClient({
      clientName: "existing-client",
      redirectUris: ["https://chatgpt.com/oauth/callback"],
      baseUrl: bridge.localBaseUrl(),
    });
    const tokens = bridge.authStore.issueTokens({
      identity: bridge.authStore.identityForClient(
        bridge.localBaseUrl(),
        oauthClient.clientId,
        ["workspace.read"]
      )!,
    });
    writeSession(bridge.workspace.id, {
      url: "https://chatgpt.com/c/existing",
      conversationMode: "long-chat",
      savedAt: new Date().toISOString(),
    });
    const sessionBefore = fs.readFileSync(sessionFile(bridge.workspace.id), "utf8");
    const before = readRuntimeState(bridge.workspace.id);
    expect(before).not.toBeNull();
    const tokenCount = bridge.authStore.tokenCount();
    const tunnel = bridge.tunnel.status();

    const repaired = await runDoctor(requestedRoot, fixture.stateDir, fixture.codexHome, "--json");
    expect(repaired.status).toBe(0);
    expect(parseResult(repaired.stdout)).toMatchObject({
      outcome: "repaired",
      reason: "local_repairs_completed",
      nextAction: { type: "create_conversation", reason: "conversation_missing" },
    });

    const requested = new Workspace(requestedRoot);
    const active = readRuntimeState(requested.id);
    expect(active).toMatchObject({
      workspaceId: requested.id,
      workspaceRoot: requested.root,
      pid: before?.pid,
      port: before?.port,
      adminToken: before?.adminToken,
      startedAt: before?.startedAt,
    });
    expect(await adminFetch<{ workspaceId: string }>(active!, "GET", "/admin/info")).toMatchObject({
      workspaceId: requested.id,
    });
    expect(bridge.authStore.tokenCount()).toBe(tokenCount);
    expect(bridge.tunnel.status()).toEqual(tunnel);
    expect(fs.readFileSync(sessionFile(before!.workspaceId), "utf8")).toBe(sessionBefore);

    const client = new Client({ name: "doctor-switch-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
    });
    await client.connect(transport);
    try {
      const info = mcpJson<{ workspaceId: string }>(
        await client.callTool({ name: "workspace_info", arguments: {} })
      );
      expect(info.workspaceId).toBe(requested.id);
      expect((await client.listTools()).tools).toHaveLength(9);

      await adminFetch(active!, "POST", "/admin/workspace", 60_000, { workspaceRoot: driftRoot });
      expect(
        mcpJson<{ workspaceId: string }>(
          await client.callTool({ name: "workspace_info", arguments: {} })
        ).workspaceId
      ).toBe(new Workspace(driftRoot).id);

      const reactivated = await runDoctor(requestedRoot, fixture.stateDir, fixture.codexHome, "--json");
      expect(reactivated.status).toBe(0);
      expect(parseResult(reactivated.stdout)).toMatchObject({
        outcome: "repaired",
        nextAction: { type: "create_conversation", reason: "conversation_missing" },
      });
      expect(
        mcpJson<{ workspaceId: string }>(
          await client.callTool({ name: "workspace_info", arguments: {} })
        ).workspaceId
      ).toBe(requested.id);
    } finally {
      await client.close();
    }

    const healthy = await runDoctor(requestedRoot, fixture.stateDir, fixture.codexHome, "--json");
    expect(healthy.status).toBe(0);
    expect(parseResult(healthy.stdout)).toMatchObject({
      outcome: "healthy",
      repairs: [],
      nextAction: { type: "create_conversation", reason: "conversation_missing" },
    });
    expect(readRuntimeState(requested.id)).toEqual(active);
  });

  it("keeps the machine-global named tunnel while switching workspaces", async () => {
    const fixture = isolatedWorkspace("doctor-switch-named");
    const requestedRoot = makeTmpDir("doctor-switch-named-target");
    write(requestedRoot, "README.md", "named target\n");
    dirs.push(fixture.workspace, requestedRoot, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const requested = new Workspace(requestedRoot);
    writeTunnelState({
      workspaceId: requested.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${requested.id}`,
      hostname: "c2c-target.example.com",
    });
    const bridge = await startBridge({ workspaceRoot: fixture.workspace, port: 0, persistRuntime: true });
    bridges.push(bridge);
    expect(bridge.tunnel.name).toBe("cloudflare-named");
    const runtime = readRuntimeState();

    await adminFetch(runtime!, "POST", "/admin/workspace", 60_000, {
      workspaceRoot: requestedRoot,
    });

    expect(bridge.tunnel.name).toBe("cloudflare-named");
    expect(await adminFetch(runtime!, "GET", "/admin/tunnel/doctor")).toMatchObject({
      provider: "cloudflare-named",
      url: null,
    });
  });

  it.each([
    { label: "macOS paths and the same workspace", segments: ["Library", "Application Support"], different: false },
    { label: "Windows paths and different workspaces", segments: ["AppData", "Local"], different: true },
  ])("serializes spawned recovery calls across $label and task homes", async ({ segments, different }) => {
    const stateRoot = makeTmpDir("doctor-concurrent-state");
    const stateDir = path.join(stateRoot, ...segments, "codex-with-chatgpt");
    const firstRoot = makeTmpDir("doctor-concurrent-first");
    const secondRoot = different ? makeTmpDir("doctor-concurrent-second") : firstRoot;
    const firstHome = makeTmpDir("doctor-concurrent-first-home");
    const secondHome = makeTmpDir("doctor-concurrent-second-home");
    write(firstRoot, "README.md", "first\n");
    if (different) write(secondRoot, "README.md", "second\n");
    dirs.push(stateRoot, firstRoot, firstHome, secondHome, ...(different ? [secondRoot] : []));

    const first = runDoctor(firstRoot, stateDir, firstHome, "--json");
    const leaseFile = path.join(recoveryLeasePath(stateDir), "lease.json");
    await waitForFile(leaseFile);
    const owner = JSON.parse(fs.readFileSync(leaseFile, "utf8")) as Record<string, unknown>;
    expect(owner).toMatchObject({
      ownerPid: expect.any(Number),
      startedAt: expect.any(String),
      expiresAt: expect.any(String),
      workspaceId: new Workspace(firstRoot).id,
      workspaceRoot: new Workspace(firstRoot).root,
      phase: expect.stringMatching(/^(starting|migration|sandbox|bridge|tunnel)$/),
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(recoveryLeasePath(stateDir)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(leaseFile).mode & 0o777).toBe(0o600);
    }

    const busy = await runDoctor(secondRoot, stateDir, secondHome, "--json");
    expect(busy.status).toBe(2);
    expect(parseResult(busy.stdout)).toMatchObject({
      outcome: "busy",
      reason: "recovery_in_progress",
      safeRetry: true,
      nextAction: { type: "retry_wait", reason: "recovery_in_progress" },
    });

    const completed = await first;
    expect(completed.status).toBe(0);
    expect(parseResult(completed.stdout)).toMatchObject({ outcome: "repaired" });
    expect(fs.existsSync(recoveryLeasePath(stateDir))).toBe(false);
    expect(tree(secondHome)).toEqual([]);

    await stopSpawnedBridge(firstRoot, stateDir);
  });

  it.each([
    {
      label: "active even after expiry",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      status: 2,
      outcome: "busy",
      reason: "recovery_in_progress",
    },
    {
      label: "dead but not expired",
      pid: 999_999_999,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      status: 2,
      outcome: "busy",
      reason: "recovery_in_progress",
    },
    {
      label: "inconclusive",
      pid: 0,
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      expiresAt: new Date(Date.now() - 300_000).toISOString(),
      status: 1,
      outcome: "unknown",
      reason: "probe_inconclusive",
    },
  ])("fails closed for a $label recovery owner", async (owner) => {
    const fixture = isolatedWorkspace(`doctor-lease-${owner.outcome}`);
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    const workspace = new Workspace(fixture.workspace);
    writeRecoveryLeaseFixture(fixture.stateDir, workspace, {
      leaseId: `fixture-${owner.outcome}`,
      pid: owner.pid,
      startedAt: owner.startedAt,
      expiresAt: owner.expiresAt,
    });

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
    expect(result.status).toBe(owner.status);
    expect(result.stderr).toBe("");
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: owner.outcome,
      reason: owner.reason,
      safeRetry: true,
      nextAction: { type: "retry_wait", reason: owner.reason },
    });
    expect(fs.existsSync(path.join(fixture.stateDir, "runtime", "global.json"))).toBe(false);
    expect(fs.existsSync(recoveryLeasePath(fixture.stateDir))).toBe(true);
  });

  it("reclaims an expired dead owner after PID reuse and retains stale evidence", async () => {
    const fixture = isolatedWorkspace("doctor-lease-expired");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    const workspace = new Workspace(fixture.workspace);
    writeRecoveryLeaseFixture(fixture.stateDir, workspace, {
      leaseId: "expired-owner",
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000 - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 300_000).toISOString(),
    });

    try {
      const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
      expect(result.status).toBe(0);
      expect(parseResult(result.stdout)).toMatchObject({ outcome: "repaired" });
      expect(fs.existsSync(recoveryLeasePath(fixture.stateDir))).toBe(false);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(fixture.stateDir, "recovery", "reclaimed", "expired-owner", "reclaimed.json"),
            "utf8"
          )
        )
      ).toMatchObject({ reason: "owner_dead_and_lease_expired", reclaimedByPid: expect.any(Number) });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(fixture.stateDir, "recovery", "reclaimed", "expired-owner", "lease.json"),
            "utf8"
          )
        )
      ).toMatchObject({ ownerPid: process.pid, phase: "bridge" });
    } finally {
      await stopSpawnedBridge(fixture.workspace, fixture.stateDir);
    }
  });

  it("does not make explicit unpair or stop wait for the recovery lease", async () => {
    const fixture = isolatedWorkspace("doctor-lease-explicit-actions");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    await ensureBridge(fixture.workspace);
    const workspace = new Workspace(fixture.workspace);
    writeRecoveryLeaseFixture(fixture.stateDir, workspace, {
      leaseId: "active-explicit-actions",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    try {
      const unpair = await runCli("unpair", fixture.workspace, fixture.stateDir, fixture.codexHome);
      expect(unpair.status).toBe(0);
      expect(unpair.stdout).toContain("全局 Bridge");
      expect(fs.existsSync(recoveryLeasePath(fixture.stateDir))).toBe(true);

      const stop = await runCli("stop", fixture.workspace, fixture.stateDir, fixture.codexHome);
      expect(stop.status).toBe(0);
      expect(fs.existsSync(recoveryLeasePath(fixture.stateDir))).toBe(true);
    } finally {
      await stopSpawnedBridge(fixture.workspace, fixture.stateDir);
    }
  });

  it("releases the recovery lease when doctor exits with an error", async () => {
    const fixture = isolatedWorkspace("doctor-lease-error");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const bridge = await startBridge({ workspaceRoot: fixture.workspace, port: 0, persistRuntime: true });
    bridges.push(bridge);
    const runtime = readRuntimeState();
    expect(runtime).not.toBeNull();
    writeRuntimeState({ ...runtime!, adminToken: "invalid-admin-token" });

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: "blocked",
      reason: "checks_failed",
      nextAction: { type: "manual_recovery" },
    });
    expect(fs.existsSync(recoveryLeasePath(fixture.stateDir))).toBe(false);
  });

  it.each(["missing", "dead"] as const)(
    "starts one replacement when the global runtime is %s",
    async (initialState) => {
      const fixture = isolatedWorkspace(`doctor-${initialState}`);
      dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
      process.env.C2C_STATE_DIR = fixture.stateDir;
      const workspace = new Workspace(fixture.workspace);
      if (initialState === "dead") writeRuntimeState(runtimeFor(workspace, 999_999_999));

      try {
        const repaired = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
        expect(repaired.status).toBe(0);
        expect(parseResult(repaired.stdout)).toMatchObject({
          outcome: "repaired",
          nextAction: { type: "create_conversation", reason: "conversation_missing" },
        });
        const replacement = readRuntimeState(workspace.id);
        if (initialState === "dead") expect(replacement?.pid).not.toBe(999_999_999);
        expect(replacement?.pid).toBeGreaterThan(0);

        const healthy = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");
        expect(healthy.status).toBe(0);
        expect(parseResult(healthy.stdout)).toMatchObject({
          outcome: "healthy",
          repairs: [],
          nextAction: { type: "create_conversation", reason: "conversation_missing" },
        });
        expect(readRuntimeState(workspace.id)?.pid).toBe(replacement?.pid);
      } finally {
        const runtime = readRuntimeState(workspace.id);
        await stopBridge(fixture.workspace);
        if (runtime) {
          for (let attempt = 0; attempt < 20 && (await probeBridge(runtime.port, 100)); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }
    }
  );

  it("repairs a named tunnel at the same endpoint only after public health passes", async () => {
    const fixture = isolatedWorkspace("doctor-named-stable");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    process.env.TUNNEL_ORIGIN_CERT = write(fixture.stateDir, "cloudflare-cert.pem", "fixture\n");
    const workspace = new Workspace(fixture.workspace);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      hostname: "c2c-demo.example.com",
    });
    const tunnel = new FixtureTunnel("cloudflare-named", (port) => `http://127.0.0.1:${port}`);
    const bridge = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: tunnel,
    });
    bridges.push(bridge);
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: bridge.port,
      publicUrl: bridge.localBaseUrl(),
      mcpUrl: `${bridge.localBaseUrl()}/mcp/session`,
      connectorName: "Codex with ChatGPT",
    });

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");

    expect(result.status).toBe(2);
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: "user_action_required",
      reason: "auth_required",
      nextAction: { type: "authorize_oauth" },
      authorization: { state: "missing", recoverable: false },
      endpointIdentity: {
        changed: false,
        previousFingerprint: expect.stringMatching(/^sha256:/),
        currentFingerprint: expect.stringMatching(/^sha256:/),
      },
      tunnel: {
        provider: "cloudflare-named",
        component: "available",
        cloudflareLogin: "ready",
        publicHealth: "passed",
      },
      chatgptRepair: { needed: false, connectorAction: "none" },
    });
    expect(tunnel.startCalls).toBe(1);
    expect(bridge.pairing.hasActiveSession()).toBe(false);
  });

  it("starts Quick Tunnel without Cloudflare login and reports endpoint replacement fingerprints", async () => {
    const fixture = isolatedWorkspace("doctor-quick-rotation");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    process.env.TUNNEL_ORIGIN_CERT = path.join(fixture.stateDir, "missing-cert.pem");
    const workspace = new Workspace(fixture.workspace);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "quick",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-quick",
    });
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48765,
      publicUrl: "https://old.trycloudflare.com",
      mcpUrl: "https://old.trycloudflare.com/mcp",
      connectorName: "Codex with ChatGPT",
    });
    const tunnel = new FixtureTunnel("cloudflare-quick", (port) => `http://127.0.0.1:${port}`);
    const bridge = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: tunnel,
    });
    bridges.push(bridge);
    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");

    expect(result.status).toBe(2);
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: "user_action_required",
      reason: "endpoint_changed",
      nextAction: { type: "replace_connector", endpoint: `${bridge.localBaseUrl()}/mcp/session` },
      endpointIdentity: {
        changed: true,
        previousFingerprint: "sha256:0dbfbcb78cb5d5a5",
        currentFingerprint: expect.stringMatching(/^sha256:/),
      },
      tunnel: {
        provider: "cloudflare-quick",
        component: "available",
        cloudflareLogin: "not_applicable",
        publicHealth: "passed",
      },
      chatgptRepair: { needed: true, connectorAction: "update" },
    });
    expect(tunnel.startCalls).toBe(1);
    expect(bridge.pairing.hasActiveSession()).toBe(false);
  });

  it.each([
    { label: "the origin certificate is absent", hasCert: false, startError: undefined, startCalls: 0 },
    {
      label: "cloudflared rejects the saved credentials",
      hasCert: true,
      startError: "Cannot determine default origin certificate path; run cloudflared tunnel login",
      startCalls: 1,
    },
  ])("asks for one Cloudflare login action when $label", async (scenario) => {
    const fixture = isolatedWorkspace(`doctor-named-login-${scenario.hasCert}`);
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    process.env.TUNNEL_ORIGIN_CERT = scenario.hasCert
      ? write(fixture.stateDir, "cloudflare-cert.pem", "fixture\n")
      : path.join(fixture.stateDir, "missing-cert.pem");
    const workspace = new Workspace(fixture.workspace);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      hostname: "c2c-demo.example.com",
    });
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48765,
      publicUrl: "https://c2c-demo.example.com",
      mcpUrl: "https://c2c-demo.example.com/mcp/session",
      connectorName: "Codex with ChatGPT",
    });
    const tunnel = new FixtureTunnel(
      "cloudflare-named",
      (port) => `http://127.0.0.1:${port}`,
      true,
      scenario.startError
    );
    const bridge = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: tunnel,
    });
    bridges.push(bridge);

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");

    expect(result.status).toBe(2);
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: "user_action_required",
      reason: "cloudflare_login_required",
      nextAction: { type: "cloudflare_login" },
      endpointIdentity: { changed: false },
      tunnel: {
        provider: "cloudflare-named",
        component: "available",
        cloudflareLogin: "required",
        publicHealth: "not_checked",
      },
      chatgptRepair: { needed: false, connectorAction: "none" },
    });
    expect(tunnel.startCalls).toBe(scenario.startCalls);
  });

  it.each([
    {
      label: "missing cloudflared",
      tunnel: new FixtureTunnel("cloudflare-quick", () => "", false),
      status: 1,
      outcome: "blocked",
      reason: "cloudflared_missing",
      publicHealth: "not_checked",
    },
    {
      label: "failed public health",
      tunnel: new FixtureTunnel("cloudflare-quick", (port) => `http://127.0.0.1:${port}/missing`),
      status: 1,
      outcome: "blocked",
      reason: "transport_down",
      publicHealth: "failed",
    },
    {
      label: "inconclusive public health",
      tunnel: new FixtureTunnel("cloudflare-quick", () => "http://127.0.0.1:1"),
      status: 1,
      outcome: "unknown",
      reason: "probe_inconclusive",
      publicHealth: "unknown",
    },
  ])("returns a distinct structured result for $label", async (scenario) => {
    const fixture = isolatedWorkspace(`doctor-tunnel-${scenario.outcome}`);
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const workspace = new Workspace(fixture.workspace);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "quick",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-quick",
    });
    const bridge = await startBridge({
      workspaceRoot: fixture.workspace,
      port: 0,
      persistRuntime: true,
      tunnelProvider: scenario.tunnel,
    });
    bridges.push(bridge);
    if (scenario.reason === "probe_inconclusive") {
      const client = bridge.authStore.registerClient({
        clientName: "unreachable-chatgpt-client",
        redirectUris: ["https://chatgpt.com/oauth/callback"],
        baseUrl: "http://127.0.0.1:1",
      });
      bridge.authStore.issueTokens({
        identity: bridge.authStore.identityForClient(
          "http://127.0.0.1:1",
          client.clientId,
          ["workspace.read", "offline_access"]
        )!,
      });
      writeLastEndpoint({
        workspaceId: workspace.id,
        port: bridge.port,
        publicUrl: "http://127.0.0.1:1",
        mcpUrl: "http://127.0.0.1:1/mcp/session",
        connectorName: "Codex with ChatGPT",
      });
    }

    const result = await runDoctor(fixture.workspace, fixture.stateDir, fixture.codexHome, "--json");

    expect(result.status).toBe(scenario.status);
    expect(parseResult(result.stdout)).toMatchObject({
      outcome: scenario.outcome,
      reason: scenario.reason,
      tunnel: {
        provider: "cloudflare-quick",
        component: scenario.reason === "cloudflared_missing" ? "missing" : "available",
        publicHealth: scenario.publicHealth,
      },
      ...(scenario.reason === "probe_inconclusive"
        ? { authorization: { state: "unreachable" } }
        : {}),
      chatgptRepair: { needed: false, connectorAction: "none" },
    });
    expect(bridge.pairing.hasActiveSession()).toBe(false);
  });

  it("reports a stopped bridge without mutating diagnose-only state or leaking sensitive output", async () => {
    const fixture = isolatedWorkspace("doctor-stopped");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    const workspace = new Workspace(fixture.workspace);
    writeSecureJson(path.join(fixture.stateDir, "endpoints", `${workspace.id}.json`), {
      workspaceId: workspace.id,
      port: 1234,
      publicUrl: "https://alice:browser-secret@example.com",
      mcpUrl: "https://alice:browser-secret@example.com/mcp/session",
      connectorName:
        '/Users/dimon/ABCD-EFGH C:\\Users\\alice\\private Cookie: session="browser-cookie-secret"; Path=/ c2c_rt_refresh_should_never_appear Bearer c2c_at_access_should_never_appear',
      savedAt: new Date().toISOString(),
    });
    const before = tree(fixture.stateDir);

    const stopped = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--diagnose-only",
      "--json"
    );

    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toBe("");
    expect(parseResult(stopped.stdout)).toMatchObject({
      version: 1,
      outcome: "blocked",
      reason: "bridge_stopped",
      repairs: [],
      safeRetry: true,
      nextAction: { type: "manual_recovery", reason: "bridge_stopped" },
    });
    expect(tree(fixture.stateDir)).toEqual(before);
    expect(stopped.stdout).not.toContain("browser-secret");
    expect(stopped.stdout).not.toContain("ABCD-EFGH");
    expect(stopped.stdout).not.toContain("refresh_should_never_appear");
    expect(stopped.stdout).not.toContain("access_should_never_appear");
    expect(stopped.stdout).not.toContain("/Users/dimon");
    expect(stopped.stdout).not.toContain("alice");
    expect(stopped.stdout).not.toContain("browser-cookie-secret");

    const human = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--no-fix"
    );
    expect(human.status).toBe(1);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Outcome: blocked (bridge_stopped)");
    expect(human.stdout).toContain("Next action: manual_recovery");
    expect(tree(fixture.stateDir)).toEqual(before);
    expect(human.stdout).not.toContain("browser-secret");
    expect(human.stdout).not.toContain("ABCD-EFGH");
    expect(human.stdout).not.toContain("refresh_should_never_appear");
    expect(human.stdout).not.toContain("access_should_never_appear");
    expect(human.stdout).not.toContain("/Users/dimon");
    expect(human.stdout).not.toContain("alice");
    expect(human.stdout).not.toContain("browser-cookie-secret");
  });

  it("fails closed when the bridge probe is inconclusive", async () => {
    const fixture = isolatedWorkspace("doctor-unknown");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    process.env.C2C_STATE_DIR = fixture.stateDir;
    const workspace = new Workspace(fixture.workspace);
    writeRuntimeState(runtimeFor(workspace, process.pid));

    const unknown = await runDoctor(
      fixture.workspace,
      fixture.stateDir,
      fixture.codexHome,
      "--diagnose-only",
      "--json"
    );

    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toBe("");
    expect(parseResult(unknown.stdout)).toMatchObject({
      version: 1,
      outcome: "unknown",
      reason: "probe_inconclusive",
      repairs: [],
      safeRetry: true,
      nextAction: { type: "retry_wait", reason: "probe_inconclusive" },
    });
    expect(unknown.stdout).not.toContain("c2c_admin_should_never_appear");
  });
});
