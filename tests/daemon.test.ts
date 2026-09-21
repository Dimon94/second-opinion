import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBridgeObservation, findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { ensureBridge } from "../src/process/daemon.js";
import { observeProcess } from "../src/process/liveness.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
vi.mock("../src/process/liveness.js", () => ({ observeProcess: vi.fn() }));
vi.mock("../src/bridge/runtime.js", () => ({
  findBridgeObservation: vi.fn(), findLiveBridge: vi.fn(), probeBridge: vi.fn(), readRuntimeState: vi.fn(),
}));

describe("incompatible Bridge replacement", () => {
  let root: string;
  let stateDir: string;
  let runtime: RuntimeState;

  beforeEach(() => {
    vi.useFakeTimers();
    stateDir = isolateStateDir();
    root = makeTmpDir("daemon");
    const workspace = new Workspace(root);
    runtime = {
      service: "codex-with-chatgpt", version: "old", workspaceId: workspace.id,
      workspaceRoot: workspace.root, pid: 12345, port: 48765, adminToken: "test-token",
      publicUrl: null, startedAt: "2026-01-01T00:00:00.000Z",
    };
    vi.mocked(findBridgeObservation).mockResolvedValue({ state: "healthy", runtime });
    vi.mocked(readRuntimeState).mockReturnValue(runtime);
    vi.mocked(probeBridge).mockResolvedValue(null).mockResolvedValueOnce({
      service: runtime.service, version: runtime.version, workspaceId: workspace.id, status: "ok",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn(), exitCode: null } as unknown as ReturnType<typeof spawn>);
    vi.mocked(findLiveBridge).mockResolvedValue({ ...runtime, pid: 54321 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    cleanup(root);
    cleanup(stateDir);
    delete process.env.C2C_STATE_DIR;
  });

  it.each(["active", "unknown"] as const)("does not spawn while the old PID is %s after health disappears", async (liveness) => {
    vi.mocked(observeProcess).mockReturnValue(liveness);
    const result = ensureBridge(root).then(() => "spawned", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(6000);
    expect(vi.mocked(spawn).mock.calls.length).toBe(0);
    expect(await result).toMatch(/did not stop/);
  });

  it("waits for the old PID to die before spawning its replacement", async () => {
    vi.mocked(observeProcess).mockReturnValue("active");
    const result = ensureBridge(root);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(spawn).mock.calls.length).toBe(0);
    vi.mocked(observeProcess).mockReturnValue("dead");
    await vi.advanceTimersByTimeAsync(400);
    expect(vi.mocked(spawn).mock.calls.length).toBe(1);
    expect(await result).toMatchObject({ spawned: true, runtime: { pid: 54321 } });
  });
});
