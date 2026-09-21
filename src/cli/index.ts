import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, bridgeSupportsRecovery, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace, workspacePathReference } from "../workspace/manager.js";
import { AuthStore, type AuthorizationStatus } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import {
  acknowledgeLegacyRuntimeReload,
  hasLegacyStateToMigrate,
  migrateLegacyState,
  type LegacyMigrationResult,
} from "../config/legacy-migration.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  DEFAULT_CONNECTOR_NAME,
  connectorAction,
  connectorNameFor,
  endpointFingerprint,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, SERVICE_NAME, VERSION } from "../version.js";
import type { TunnelDoctorReport } from "../tunnel/provider.js";
import {
  claimLegacySession,
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  startNewTaskSession,
  writeSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import { sanitizeDiagnosticText, sanitizeDiagnosticValue } from "../execution/sanitize.js";
import { WorkspaceBindingStore } from "../session/bindings.js";
import {
  createDoctorResult,
  createRecoveryLeaseDoctorResult,
  applyDoctorBrowserGate,
  observedConnectorReplacement,
  authorizationDisposition,
  DOCTOR_EXIT_STATUS,
  renderDoctorResult,
  type DoctorChatgptRepair,
  type DoctorCheck,
  type DoctorAuthorizationResult,
  type DoctorNamedRepair,
  type DoctorTunnelResult,
  type DoctorBrowserGate,
  type DoctorBridgeObservation,
  type DoctorRequestedWorkspaceIdentity,
  type DoctorWorkspaceIdentity,
} from "../doctor/result.js";
import { acquireRecoveryLease, type RecoveryLeaseHandle } from "../doctor/lease.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function doctorWorkspaceIdentity(workspace: Workspace): DoctorWorkspaceIdentity {
  return { id: workspace.id, name: workspace.name };
}

function doctorRequestedWorkspaceIdentity(
  root: string,
  workspace: Workspace | null
): DoctorRequestedWorkspaceIdentity {
  return workspace
    ? { ...doctorWorkspaceIdentity(workspace), reference: workspace.id }
    : { id: null, name: null, reference: workspacePathReference(root) };
}

function doctorRuntimeWorkspaceIdentity(runtime: RuntimeState): DoctorWorkspaceIdentity {
  try {
    return doctorWorkspaceIdentity(new Workspace(runtime.workspaceRoot));
  } catch {
    return { id: runtime.workspaceId, name: null };
  }
}

function parseInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new InvalidArgumentError("must be an integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("must be a safe integer");
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const count = parseInteger(normalized);
    if (count < 0) {
      throw new InvalidArgumentError("changed-files count must be a non-negative safe integer");
    }
    return count;
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

type PublicHealth = "passed" | "failed" | "unknown" | "not_checked";

async function probePublicHealth(publicUrl: string | null, workspaceId: string): Promise<PublicHealth> {
  if (!publicUrl) return "not_checked";
  try {
    const response = await fetch(`${normalizePublicUrl(publicUrl)}/health`, {
      signal: AbortSignal.timeout(8000),
    });
    const body = (await response.json().catch(() => null)) as {
      service?: unknown;
      workspaceId?: unknown;
      status?: unknown;
    } | null;
    return response.ok &&
      body?.service === SERVICE_NAME &&
      body.workspaceId === workspaceId &&
      body.status === "ok"
      ? "passed"
      : "failed";
  } catch {
    return "unknown";
  }
}

function requiresCloudflareLogin(message: string): boolean {
  return /origin certificate|cert\.pem|credentials? file|unauthorized|authentication|tunnel login/i.test(
    message
  );
}

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
    replacingEndpoint: connectorAction(previous?.mcpUrl, opts.mcpUrl) === "update",
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function emitCloudflareLoginAction(page: string, json: boolean): void {
  if (json) {
    say(JSON.stringify({
      outcome: "user_action_required",
      reason: "cloudflare_login_required",
      nextAction: { type: "cloudflare_login", reason: "cloudflare_login_required", page },
    }));
  } else {
    say(`请在 Codex 内置浏览器打开：${page}`);
  }
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  authorization: AuthorizationStatus;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl = mcpUrlFromPublic(info.publicUrl);
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = mcpUrlFromPublic(result.url);
  }
  return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

function acceptUnusedWorkspaceOption(command: Command): Command {
  return command.option("-w, --workspace <path>", "ignored; this command is machine-wide");
}

function hostTaskId(): string {
  const taskId = process.env.CODEX_THREAD_ID?.trim();
  if (!taskId || taskId.length > 200) {
    throw new Error("CODEX_THREAD_ID is required for a task-scoped workspace binding.");
  }
  return taskId;
}

const bindingCmd = program.command("binding").description("Authorize a task-scoped workspace binding");

const reviewCmd = program.command("review").description("Manage task-scoped asynchronous Second Opinion rounds");
for (const action of ["arm", "status", "ack", "cancel"]) {
  reviewCmd.command(action).option("--id <id>", "exact review ID for ack/cancel").option("--json", "machine-readable output", false)
    .action(async (opts: { id?: string; json: boolean }) => {
      try {
        const taskId = hostTaskId();
        const observation = await findBridgeObservation();
        if (observation.state !== "healthy") throw new Error("A healthy Bridge is required.");
        const result = await adminFetch(observation.runtime, "POST", "/admin/reviews", 20000,
          { action, id: opts.id, taskId, workspaceRoot: process.cwd() });
        say(JSON.stringify(result));
      } catch (error) { handleCliError(error, opts.json); }
    });
}

bindingCmd.command("authorize")
  .description("Authorize locally from JSON stdin: bootstrapToken and connectionProof")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const taskId = hostTaskId();
      if (process.stdin.isTTY) throw new Error("Pass authorization material through JSON stdin, never command arguments.");
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk.toString();
        if (input.length > 16384) throw new Error("Authorization input too large.");
      }
      let body: { bootstrapToken: string; connectionProof: string };
      try { body = JSON.parse(input); } catch { throw new Error("Invalid authorization JSON."); }
      const observation = await findBridgeObservation();
      if (observation.state !== "healthy") throw new Error("A healthy Bridge is required before authorization.");
      const result = await adminFetch<{ binding_token: string }>(observation.runtime, "POST", "/admin/bindings/authorize", 60_000,
        { bootstrapToken: body.bootstrapToken, connectionProof: body.connectionProof, workspaceRoot: process.cwd(), taskId });
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else say(result.binding_token);
    } catch (error) { handleCliError(error, opts.json); }
  });

bindingCmd
  .command("bootstrap")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const taskId = hostTaskId();
      const observation = await findBridgeObservation();
      if (observation.state !== "healthy") throw new Error("A healthy Bridge is required before workspace binding.");
      const result = await adminFetch<{ bootstrapToken: string; expiresAt: number }>(
        observation.runtime,
        "POST",
        "/admin/bindings/bootstrap",
        60_000,
        { workspaceRoot: process.cwd(), taskId }
      );
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else say(result.bootstrapToken);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

bindingCmd
  .command("unbind")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const taskId = hostTaskId();
      const observation = await findBridgeObservation();
      if (observation.state !== "healthy") throw new Error("A healthy Bridge is required before unbinding.");
      const result = await adminFetch<{ removed: number }>(
        observation.runtime,
        "POST",
        "/admin/bindings/unbind",
        60_000,
        { taskId, workspaceRoot: process.cwd() }
      );
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else check(`已解绑 ${result.removed} 个会话工作区`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge 已重启（${info.workspaceName}）`);
      if (mcpUrl) check(`安全连接已建立`);
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
      } else {
        cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge 未运行。使用 `c2c start` 启动。");
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全连接：${mcpUrlFromPublic(info.tunnel.url)}`);
    else say("· 安全连接：未启用（本地模式）");
    say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .alias("setup")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--diagnose-only", "diagnose only, do not repair", false)
  .option("--no-tunnel", "do not start or recover a public connection")
  .option("--direct", "prepare the current Codex task without a ChatGPT Web conversation", false)
  .option(
    "--browser-gate <gate>",
    "observed ChatGPT gate: connector_replaced, chatgpt_login, or administrator_approval"
  )
  .option("--browser-page <url>", "current ChatGPT page for an observed browser gate")
  .option("--browser-endpoint <url>", "endpoint visibly present in the Connector browser page")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string;
    fix: boolean;
    diagnoseOnly: boolean;
    tunnel: boolean;
    direct: boolean;
    browserGate?: string;
    browserPage?: string;
    browserEndpoint?: string;
    json: boolean;
  }) => {
    let localTaskId: string;
    try {
      localTaskId = hostTaskId();
    } catch (error) {
      handleCliError(error, opts.json);
      return;
    }
    const root = resolveWorkspace(opts.workspace);
    const browserGate = opts.browserGate as DoctorBrowserGate | undefined;
    if (
      browserGate &&
      browserGate !== "connector_replaced" &&
      browserGate !== "chatgpt_login" &&
      browserGate !== "administrator_approval"
    ) {
      handleCliError(
        new Error("browser-gate must be connector_replaced, chatgpt_login, or administrator_approval"),
        opts.json
      );
      return;
    }
    const shouldFix = opts.fix && !opts.diagnoseOnly;
    const report: Record<string, DoctorCheck> = {};
    const results: string[] = [];
    let recoveryLease: RecoveryLeaseHandle | null = null;
    let migration: LegacyMigrationResult | null = null;

    if (shouldFix) {
      let requested: Workspace | null = null;
      try {
        requested = new Workspace(root);
      } catch {
        // Workspace validation below renders the existing structured error.
      }
      if (requested) {
        const acquisition = acquireRecoveryLease({
          workspaceId: requested.id,
          workspaceRoot: requested.root,
        });
        if (acquisition.status !== "acquired") {
          const result = createRecoveryLeaseDoctorResult(
            acquisition.status,
            acquisition.status === "busy"
              ? "另一个恢复正在进行，请稍后安全重试"
              : "恢复 owner 状态无法安全确认，未执行任何修复",
            {
              developerMode: CHATGPT_DEVELOPER_MODE_URL,
              plugins: CHATGPT_PLUGINS_URL,
              createConnector: CHATGPT_CREATE_CONNECTOR_URL,
            },
            doctorRequestedWorkspaceIdentity(root, requested)
          );
          process.exitCode = DOCTOR_EXIT_STATUS[result.outcome];
          say(
            opts.json
              ? JSON.stringify(sanitizeDiagnosticValue(result))
              : sanitizeDiagnosticText(renderDoctorResult(result, PRODUCT_NAME, { recoveryLease: "Recovery" }))
          );
          return;
        }
        recoveryLease = acquisition.lease;
      }
    }

    try {

    if (shouldFix && recoveryLease) {
      recoveryLease.updatePhase("migration");
      const bridgeBeforeMigration = hasLegacyStateToMigrate()
        ? await findBridgeObservation()
        : null;
      if (bridgeBeforeMigration?.state !== "unknown") {
        let bridgeForReload = bridgeBeforeMigration?.state === "healthy"
          ? bridgeBeforeMigration.runtime
          : null;
        if (bridgeForReload && !(await bridgeSupportsRecovery(bridgeForReload))) {
          const ensured = await ensureBridge(root);
          bridgeForReload = ensured.runtime;
          if (ensured.spawned) results.push("已自动启动 Bridge");
          else if (ensured.activated) results.push("已激活目标 Workspace");
        }
        migration = migrateLegacyState();
        if (migration.status !== "not_needed" && bridgeForReload) {
          await adminFetch(bridgeForReload, "POST", "/admin/auth/reload");
        }
        if (migration.status !== "not_needed") acknowledgeLegacyRuntimeReload();
        if (migration.status === "migrated") results.push("已保守迁移旧连接状态");
      }
    }

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (shouldFix && recoveryLease) {
      recoveryLease.updatePhase("sandbox");
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "已在白名单" : "已写入白名单" };
        if (sandbox.added) results.push("已将本地设置目录加入 Codex 沙箱白名单");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "已在白名单" } : { ok: false, detail: "未在白名单" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    const requestedWorkspace = doctorRequestedWorkspaceIdentity(root, workspace);

    // Bridge
    recoveryLease?.updatePhase("bridge");
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    let bridgeStopped = false;
    let activeWorkspace: DoctorWorkspaceIdentity | null = null;
    let bridgeObservation: DoctorBridgeObservation = { state: "not_checked", reason: null };
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id);
      bridgeObservation = {
        state: observation.state,
        reason: observation.state === "healthy" ? null : observation.reason,
      };
      if (observation.state === "healthy") {
        activeWorkspace = doctorRuntimeWorkspaceIdentity(observation.runtime);
      }
      if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `状态无法确认（${observation.reason}），未自动修复` };
      } else if (shouldFix && recoveryLease) {
        try {
          if (opts.direct && observation.state === "healthy") {
            runtime = observation.runtime;
          } else {
            const ensured = await ensureBridge(root);
            runtime = ensured.runtime;
            if (ensured.spawned) results.push("已自动启动 Bridge");
            else if (ensured.activated) results.push("已激活目标 Workspace");
          }
          bridgeObservation = { state: "healthy", reason: null };
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      } else if (observation.state === "healthy") {
        if (
          opts.direct ||
          (observation.runtime.workspaceId === workspace.id &&
            observation.runtime.workspaceRoot === workspace.root)
        ) {
          runtime = observation.runtime;
        } else {
          report.bridge = { ok: false, detail: "当前 Bridge 未激活请求的 Workspace" };
        }
      } else {
        bridgeStopped = true;
      }
      if (runtime) {
        activeWorkspace = doctorRuntimeWorkspaceIdentity(runtime);
        report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      }
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    recoveryLease?.updatePhase("tunnel");
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : DEFAULT_CONNECTOR_NAME;
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: DoctorNamedRepair = { needed: false };
    let tunnelFailure: "cloudflared_missing" | "transport_down" | "probe_inconclusive" | undefined;
    let currentIdentityMcp = namedReady && tunnelState?.hostname
      ? mcpUrlFromPublic(`https://${tunnelState.hostname}`)
      : null;
    const tunnelResult: DoctorTunnelResult = {
      provider: tunnelState?.provider ?? null,
      component: "unknown",
      cloudflareLogin: namedReady ? "not_checked" : "not_applicable",
      publicHealth: "not_checked",
    };
    let authorization: DoctorAuthorizationResult = {
      state: "not_configured",
      clientId: null,
      proof: null,
      recoverable: false,
    };
    let chatgptRepair: DoctorChatgptRepair = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };
    let connectorReplacementCompleted = false;

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      const expectedPublic =
        Boolean(lastEndpoint?.publicUrl) ||
        tunnelState?.preference === "quick" ||
        namedReady ||
        info.tunnel.running;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      try {
        const tunnelDoctor = await adminFetch<TunnelDoctorReport>(runtime, "GET", "/admin/tunnel/doctor");
        tunnelResult.provider = tunnelDoctor.provider;
        tunnelResult.component = tunnelDoctor.binaryFound ? "available" : "missing";
      } catch {
        tunnelResult.component = detectTunnelBinaries().cloudflared ? "available" : "missing";
      }
      if (namedReady && tunnelResult.component !== "missing") {
        tunnelResult.cloudflareLogin = hasCloudflaredCert() ? "ready" : "required";
      }
      tunnelResult.publicHealth = await probePublicHealth(currentUrl, info.workspaceId);
      if (tunnelResult.publicHealth === "passed" && tunnelResult.component !== "missing") {
        tunnelFailure = undefined;
      }

      if (expectedPublic && tunnelResult.component === "missing") {
        report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
        tunnelFailure = "cloudflared_missing";
      } else if (expectedPublic && namedReady && tunnelResult.cloudflareLogin === "required") {
        report.tunnel = { ok: false, detail: "CLOUDFLARE_LOGIN_REQUIRED" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
        tunnelFailure = undefined;
      } else if (
        expectedPublic &&
        tunnelResult.publicHealth !== "passed" &&
        shouldFix &&
        opts.tunnel &&
        recoveryLease &&
        !tunnelFailure
      ) {
        try {
          const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
          if (started.url) {
            const previousUrl = lastEndpoint?.publicUrl;
            currentUrl = started.url;
            tunnelResult.publicHealth = await probePublicHealth(currentUrl, info.workspaceId);
            info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
            if (tunnelResult.publicHealth === "passed") {
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
            }
          }
        } catch (error) {
          const message = (error as Error).message;
          report.tunnel = { ok: false, detail: message };
          if (message.includes("NEED_CLOUDFLARED") || /cloudflared is not installed/i.test(message)) {
            tunnelResult.component = "missing";
            tunnelFailure = "cloudflared_missing";
          } else if (namedReady && requiresCloudflareLogin(message)) {
            tunnelResult.cloudflareLogin = "required";
            namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
            tunnelFailure = undefined;
          } else {
            tunnelFailure = "probe_inconclusive";
          }
        }
      }

      if (currentUrl && tunnelResult.publicHealth === "passed") {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        currentIdentityMcp = nextMcp;
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        connectorReplacementCompleted =
          action !== "none" &&
          shouldFix &&
          Boolean(recoveryLease) &&
          observedConnectorReplacement(browserGate, opts.browserPage, opts.browserEndpoint, nextMcp);
        const boundName = nextMcp && shouldFix && recoveryLease &&
          (action === "none" || connectorReplacementCompleted)
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorNameFor({
              workspaceName: info.workspaceName,
              workspaceId: info.workspaceId,
              previousName: lastEndpoint?.connectorName,
              hadEndpointBefore: Boolean(lastEndpoint),
              replacingEndpoint: action === "update",
            });
        chatgptRepair = {
          ...chatgptRepair,
          needed: action !== "none" && !connectorReplacementCompleted,
          reason: connectorReplacementCompleted
            ? undefined
            : action === "update"
              ? "address_reclaimed"
              : action === "create"
                ? "connector_missing"
                : undefined,
          connectorAction: connectorReplacementCompleted ? "none" : action,
          connectorName: boundName,
          userMessage: action === "update" && !connectorReplacementCompleted
            ? reclaimUserMessage(boundName)
            : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
      } else if (expectedPublic && !namedRepair.needed && !tunnelFailure) {
        report.tunnel = report.tunnel ?? {
          ok: false,
          detail: tunnelResult.publicHealth === "failed" ? "PUBLIC_HEALTH_FAILED" : "PUBLIC_HEALTH_UNKNOWN",
        };
        tunnelFailure = tunnelResult.publicHealth === "failed" ? "transport_down" : "probe_inconclusive";
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "未启用（本地模式）" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge 状态无法确认，未执行连接器修复" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    const previousFingerprint = endpointFingerprint(lastEndpoint?.mcpUrl);
    const currentFingerprint = endpointFingerprint(currentIdentityMcp);
    const endpointIdentity = {
      changed: Boolean(
        previousFingerprint && currentFingerprint && previousFingerprint !== currentFingerprint
      ),
      previousFingerprint,
      currentFingerprint,
    };

    if (
      (lastEndpoint?.mcpUrl || connectorReplacementCompleted) &&
      !chatgptRepair.needed &&
      !namedRepair.needed
    ) {
      if (tunnelResult.publicHealth !== "passed") {
        authorization = {
          state: "unreachable",
          clientId: null,
          proof: null,
          recoverable: false,
        };
        report.oauth = { ok: false, detail: "授权状态无法从当前网络探测确认" };
      } else if (runtime) {
        const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
        authorization = info.authorization;
        const disposition = authorizationDisposition(authorization);
        report.oauth = {
          ok: disposition === "usable",
          detail: authorization.state === "identity_mismatch"
            ? authorization.reason
            : authorization.state,
        };
      }
    }
    if (
      migration?.status === "consent_required" &&
      !chatgptRepair.needed &&
      !namedRepair.needed &&
      !tunnelFailure
    ) {
      authorization = {
        state: "missing",
        clientId: null,
        proof: null,
        recoverable: false,
      };
      report.oauth = { ok: false, detail: `legacy_migration:${migration.reason}` };
    }

    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    const taskSession = workspace && migration?.status !== "consent_required"
      ? readSession(workspace.id, localTaskId)
      : null;
    const result = applyDoctorBrowserGate(createDoctorResult({
      report,
      repairs: results,
      chatgptRepair,
      namedRepair,
      endpointIdentity,
      tunnel: tunnelResult,
      authorization,
      migration,
      authorizationPage: CHATGPT_PLUGINS_URL,
      direct: opts.direct,
      legacySessionAmbiguous: Boolean(workspace && !taskSession && readSession(workspace.id)),
      tunnelFailure,
      bridgeStopped,
      bridgeUnknown,
      requestedWorkspace,
      activeWorkspace,
      bridgeObservation,
      conversation: workspace
        ? {
            workspaceId: workspace.id,
            ...resolveConversation(taskSession),
          }
        : null,
    }), browserGate, opts.browserPage);
    process.exitCode = DOCTOR_EXIT_STATUS[result.outcome];
    say(
      opts.json
        ? JSON.stringify(sanitizeDiagnosticValue(result))
        : sanitizeDiagnosticText(renderDoctorResult(result, PRODUCT_NAME, labels))
    );
    } finally {
      recoveryLease?.release();
    }
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's machine-global Bridge access immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore({ onRevoke: () => new WorkspaceBindingStore().clear() }).revokeAll();
    }
    check("已断开 ChatGPT 对本机全局 Bridge 的访问（所有令牌已吊销）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

acceptUnusedWorkspaceOption(program.command("sandbox-allow"))
  .description("Add the local settings directory to the Codex sandbox allowlist")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

acceptUnusedWorkspaceOption(program.command("update-check"))
  .description("Check GitHub for a newer version (real check at most once per local day)")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session")
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const taskId = hostTaskId();
      const saved = readSession(workspace.id, taskId);
      const conversation = resolveConversation(saved);
      const legacyOwnership = !saved && readSession(workspace.id) ? "ambiguous" : "none";
      if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation, legacyOwnership }));
      else if (!saved) {
        say(legacyOwnership === "ambiguous"
          ? "发现旧 workspace 会话；请明确认领或为当前 task 新建会话。"
          : "尚未记录 ChatGPT 会话。新仓库默认使用 Project 合集。");
      } else {
        say(`模式：${conversation.mode === "project" ? "Project 合集" : "长对话"}`);
        if (conversation.projectUrl) say(`合集：${conversation.projectUrl}`);
        if (saved.title) say(`会话：${saved.title}`);
        if (saved.url) say(`对话：${saved.url}`);
        if (saved.connectorName) say(`连接器：${saved.connectorName}`);
        if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
        if (saved.checkpoint) {
          say(
            `存档：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 轮）`
          );
        }
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact machine-global connector title")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .action(
    (opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const hostOwner = hostTaskId();
      const modeRaw = opts.mode?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
        throw new Error("mode must be long-chat or project");
      }
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waitingNorm = waitingRaw
        ? waitingRaw.toLowerCase() === "none"
          ? "none"
          : waitingRaw.toUpperCase()
        : undefined;
      if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      const saved = mergeSession(readSession(workspace.id, hostOwner), {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
        lastState: opts.state,
        conversationMode: modeRaw as ConversationMode | undefined,
        projectUrl: opts.projectUrl,
        connectorName: opts.connectorName,
        clearCheckpoint: opts.clearCheckpoint,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
            }
          : undefined,
      });
      writeSession(workspace.id, saved, hostOwner);
      if (saved.projectUrl && saved.conversationMode === "project") {
        check("已记录 ChatGPT 合集，后续从合集页新开或复用对话");
      } else {
        check("已记录 ChatGPT 会话，后续任务将复用");
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id, hostTaskId());
    if (!result.cleared) say("尚未记录 ChatGPT 会话。");
    else if (result.keptProject) check("已清除当前对话，合集绑定仍保留");
    else check("已清除会话记录，下次任务将新建 ChatGPT 会话");
  });

session
  .command("start-new")
  .description("Start a new task session while retaining safe legacy Project metadata")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const saved = startNewTaskSession(workspace.id, hostTaskId());
      if (opts.json) say(JSON.stringify({ ok: true, session: saved }));
      else check("已为当前 task 新建独立会话记录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

session
  .command("claim-legacy")
  .description("Assign the legacy workspace session to the current host task")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const saved = claimLegacySession(workspace.id, hostTaskId());
      if (opts.json) say(JSON.stringify({ ok: true, claimed: Boolean(saved), session: saved }));
      else if (saved) check("已将旧 workspace 会话归属到当前 task");
      else say("没有可认领的旧 workspace 会话。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const prefsCmd = acceptUnusedWorkspaceOption(program.command("prefs"))
  .description("Remember ChatGPT developer mode and setup choice for this machine");

prefsCmd
  .command("get", { isDefault: true })
  .description("Show remembered ChatGPT setup choices (not per workspace)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(prefs.developerModeEnabled ? "开发人员模式：已记住已开启" : "开发人员模式：尚未记住");
    if (prefs.setupMode === "auto") say("配置方式：AI 自动化配置（预览版）");
    else if (prefs.setupMode === "manual") say("配置方式：手动教学配置");
    else say("配置方式：尚未选择");
  });

prefsCmd
  .command("set")
  .description("Save a ChatGPT setup choice for this machine")
  .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
  .option("--setup-mode <mode>", "auto (preview) or manual")
  .option("--json", "machine-readable output", false)
  .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      if (!opts.developerMode && !modeRaw) {
        throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (opts.developerMode) check("已记住开发人员模式已开启");
      if (modeRaw === "auto") check("已记住配置方式：AI 自动化配置（预览版）");
      if (modeRaw === "manual") check("已记住配置方式：手动教学配置");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = parseChangedFiles(opts.changedFiles);
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode: opts.exitCode ?? null,
          taskId: opts.task,
          iteration: opts.iteration,
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: opts.iteration,
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes?.slice(0, 400),
        outputId,
        outputAvailable,
      });
      if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
      else if (outputId !== undefined) check("已记录执行摘要与输出");
      else check("已记录执行摘要");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the machine-global public connection");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this machine still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the suggested c2c hostname")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
        onLoginUrl: (page) => emitCloudflareLoginAction(page, opts.json),
      });
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: true,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`固定域名已就绪：${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

acceptUnusedWorkspaceOption(tunnelCmd.command("login"))
  .description("Open the Cloudflare login window used by a named hostname")
  .option("--json", "machine-readable output", false)
  .option("--force", "replace an existing rejected Cloudflare login certificate", false)
  .action(async (opts: { force: boolean; json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login((page) => emitCloudflareLoginAction(page, opts.json), opts.force);
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(sanitizeDiagnosticText(error.message));
  process.exit(1);
});
