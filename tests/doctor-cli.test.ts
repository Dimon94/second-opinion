import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { writeRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { writeSecureJson } from "../src/config/paths.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runDoctor(
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
        "doctor",
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
      nextAction: { type: "none" },
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
      nextAction: { type: "none" },
    });
  });

  it("reports a stopped bridge without mutating diagnose-only state or leaking sensitive output", async () => {
    const fixture = isolatedWorkspace("doctor-stopped");
    dirs.push(fixture.workspace, fixture.stateDir, fixture.codexHome);
    const workspace = new Workspace(fixture.workspace);
    writeSecureJson(path.join(fixture.stateDir, "endpoints", `${workspace.id}.json`), {
      workspaceId: workspace.id,
      port: 1234,
      publicUrl: "https://alice:browser-secret@example.com",
      mcpUrl: "https://alice:browser-secret@example.com/mcp",
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
