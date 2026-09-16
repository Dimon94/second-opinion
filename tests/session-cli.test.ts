import { spawnSync } from "node:child_process";
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
});
