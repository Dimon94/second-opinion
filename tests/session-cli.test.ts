import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSession, sessionFile, writeSession } from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const cli = path.resolve(import.meta.dirname, "../src/cli/index.ts");

function runSession(
  stateDir: string,
  workspace: string,
  taskId: string | undefined,
  ...args: string[]
) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, "session", ...args, "-w", workspace], {
    encoding: "utf8",
    env: {
      ...process.env,
      C2C_STATE_DIR: stateDir,
      CODEX_THREAD_ID: taskId,
    },
  });
}

function json(result: ReturnType<typeof runSession>) {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function claimAsync(stateDir: string, workspace: string, taskId: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cli, "session", "claim-legacy", "--json", "-w", workspace],
      {
        env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_THREAD_ID: taskId },
        stdio: "ignore",
      }
    );
    child.once("error", reject);
    child.once("close", resolve);
  });
}

function interruptClaim(
  stateDir: string,
  workspaceId: string,
  taskId: string,
  method: "renameSync" | "rmSync",
  target: string
) {
  const source = `
    import fs from "node:fs";
    const method = process.env.C2C_INTERRUPT_METHOD;
    const original = fs[method].bind(fs);
    fs[method] = (...args) => {
      const target = method === "renameSync" ? args[1] : args[0];
      if (String(target) === process.env.C2C_INTERRUPT_TARGET) process.kill(process.pid, "SIGKILL");
      return original(...args);
    };
    const { claimLegacySession } = await import("./src/session/state.ts");
    claimLegacySession(process.env.C2C_WORKSPACE_ID, process.env.CODEX_THREAD_ID);
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      C2C_STATE_DIR: stateDir,
      CODEX_THREAD_ID: taskId,
      C2C_WORKSPACE_ID: workspaceId,
      C2C_INTERRUPT_METHOD: method,
      C2C_INTERRUPT_TARGET: target,
    },
  });
}

describe("task-scoped session CLI", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("isolates same-workspace tasks and requires an explicit legacy choice", () => {
    const stateDir = makeTmpDir("session-cli-state");
    const workspace = makeTmpDir("session-cli-workspace");
    dirs.push(stateDir, workspace);
    process.env.C2C_STATE_DIR = stateDir;

    expect(runSession(stateDir, workspace, undefined, "get", "--json")).toMatchObject({ status: 1 });

    const workspaceId = new Workspace(workspace).id;
    for (const task of ["host-a", "host-b"]) writeSession(workspaceId, {
      conversationMode: "long-chat",
      url: `https://chatgpt.com/c/${task}`,
      taskId: `protocol-${task}`,
      savedAt: "2026-01-01T00:00:00.000Z",
    }, task);
    expect(json(runSession(stateDir, workspace, "host-a", "get", "--json"))).toMatchObject({
      session: { url: "https://chatgpt.com/c/host-a", taskId: "protocol-host-a" },
    });
    expect(json(runSession(stateDir, workspace, "host-b", "get", "--json"))).toMatchObject({
      session: { url: "https://chatgpt.com/c/host-b", taskId: "protocol-host-b" },
    });
    expect(runSession(stateDir, workspace, "host-a", "clear").status).toBe(0);
    expect(readSession(workspaceId, "host-a")).toMatchObject({ taskId: "protocol-host-a" });
    expect(readSession(workspaceId, "host-a")?.url).toBeUndefined();
    expect(readSession(workspaceId, "host-b")?.url).toBe("https://chatgpt.com/c/host-b");

    writeSession(workspaceId, {
      conversationMode: "project",
      projectUrl: "https://chatgpt.com/g/g-p-legacy/project",
      connectorName: "Second Opinion",
      url: "https://chatgpt.com/c/legacy",
      taskId: "legacy-protocol",
      checkpoint: {
        taskId: "legacy-protocol",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(json(runSession(stateDir, workspace, "host-c", "get", "--json"))).toMatchObject({
      session: null,
      legacyOwnership: "ambiguous",
    });
    expect(runSession(stateDir, workspace, "host-c", "start-new", "--json").status).toBe(0);
    expect(readSession(workspaceId, "host-c")).toMatchObject({
      conversationMode: "project",
      projectUrl: "https://chatgpt.com/g/g-p-legacy/project",
      connectorName: "Second Opinion",
    });
    expect(readSession(workspaceId, "host-c")).not.toMatchObject({
      url: "https://chatgpt.com/c/legacy", checkpoint: expect.anything(),
    });
    expect(fs.existsSync(sessionFile(workspaceId))).toBe(true);

    expect(runSession(stateDir, workspace, "host-d", "claim-legacy", "--json").status).toBe(0);
    expect(readSession(workspaceId, "host-d")).toMatchObject({
      url: "https://chatgpt.com/c/legacy",
      taskId: "legacy-protocol",
      checkpoint: { protocolState: "EXECUTED_SENT" },
    });
    expect(fs.existsSync(sessionFile(workspaceId))).toBe(false);
    expect(readSession(workspaceId, "host-e")).toBeNull();
  }, 60_000);

  it("allows only one process to claim a legacy checkpoint", async () => {
    const stateDir = makeTmpDir("session-claim-race-state");
    const workspace = makeTmpDir("session-claim-race-workspace");
    dirs.push(stateDir, workspace);
    process.env.C2C_STATE_DIR = stateDir;
    const workspaceId = new Workspace(workspace).id;
    writeSession(workspaceId, {
      url: "https://chatgpt.com/c/legacy-race",
      title: "x".repeat(2_000_000),
      taskId: "legacy-protocol",
      checkpoint: {
        taskId: "legacy-protocol",
        iteration: 7,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    const owners = Array.from({ length: 8 }, (_, index) => `racer-${index}`);

    const statuses = await Promise.all(owners.map((owner) => claimAsync(stateDir, workspace, owner)));
    const claimed = owners.filter((owner) => readSession(workspaceId, owner)?.url);

    expect(statuses.filter((status) => status === 0)).toHaveLength(1);
    expect(claimed).toHaveLength(1);
    expect(readSession(workspaceId)).toBeNull();
  }, 60_000);

  it.each(["before-task-write", "after-task-write"] as const)(
    "recovers the unique owner after interruption %s",
    (point) => {
      const stateDir = makeTmpDir(`session-claim-interrupt-${point}-state`);
      const workspace = makeTmpDir(`session-claim-interrupt-${point}-workspace`);
      dirs.push(stateDir, workspace);
      process.env.C2C_STATE_DIR = stateDir;
      const workspaceId = new Workspace(workspace).id;
      writeSession(workspaceId, {
        url: "https://chatgpt.com/c/interrupted-legacy",
        taskId: "legacy-protocol",
        checkpoint: {
          taskId: "legacy-protocol",
          iteration: 3,
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        savedAt: "2026-01-01T00:00:00.000Z",
      });
      const owner = `interrupted-owner-${point}`;
      const interrupted = interruptClaim(
        stateDir,
        workspaceId,
        owner,
        point === "before-task-write" ? "renameSync" : "rmSync",
        point === "before-task-write" ? sessionFile(workspaceId, owner) : sessionFile(workspaceId)
      );

      expect(interrupted.status).not.toBe(0);
      expect(fs.existsSync(sessionFile(workspaceId))).toBe(true);
      expect(runSession(stateDir, workspace, "other-owner", "claim-legacy", "--json").status).toBe(1);
      expect(runSession(stateDir, workspace, owner, "claim-legacy", "--json").status).toBe(0);
      expect(readSession(workspaceId, owner)).toMatchObject({
        url: "https://chatgpt.com/c/interrupted-legacy",
        checkpoint: { protocolState: "EXECUTED_SENT" },
      });
      expect(fs.existsSync(sessionFile(workspaceId))).toBe(false);
    },
    60_000
  );
});
