import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const spawnSyncCalls: { file: string; args: unknown[]; options: Record<string, unknown> }[] = [];
const spawnCalls: { file: string; args: unknown[]; options: Record<string, unknown> }[] = [];
const previousCloudflaredPath = process.env.C2C_CLOUDFLARED_PATH;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (file: string, args: unknown[], options: Record<string, unknown>) => {
      spawnSyncCalls.push({ file, args, options });
      return actual.spawnSync(file, args as readonly string[], options);
    },
    spawn: (file: string, args: unknown[], options: Record<string, unknown>) => {
      spawnCalls.push({ file, args, options });
      return actual.spawn(file, args as readonly string[], options);
    },
  };
});

import { findBinary } from "../src/tunnel/detect.js";
import { ProcessCloudflaredAccount } from "../src/tunnel/named-provision.js";
import { runGit } from "../src/workspace/git.js";
import { Workspace } from "../src/workspace/manager.js";
import { findRipgrep, resetRipgrepCache, searchWorkspace } from "../src/workspace/search.js";

describe("Windows background subprocesses", () => {
  let tmpDir: string;

  beforeEach(() => {
    spawnSyncCalls.length = 0;
    spawnCalls.length = 0;
    delete process.env.C2C_CLOUDFLARED_PATH;
    tmpDir = makeTmpDir("windows-process");
  });

  afterEach(() => {
    delete process.env.C2C_RG_PATH;
    if (previousCloudflaredPath === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
    else process.env.C2C_CLOUDFLARED_PATH = previousCloudflaredPath;
    vi.restoreAllMocks();
    resetRipgrepCache();
    cleanup(tmpDir);
  });

  it("hides non-interactive Git, rg and cloudflared windows", async () => {
    makeGitRepo(tmpDir);
    spawnSyncCalls.length = 0;
    runGit(tmpDir, ["status", "--porcelain"]);
    process.env.C2C_RG_PATH = "fake-rg";
    resetRipgrepCache();
    findRipgrep();
    write(tmpDir, "sample.txt", "hello windows\n");
    await searchWorkspace(new Workspace(tmpDir), { query: "hello" });
    await expect(new ProcessCloudflaredAccount("fake-cloudflared").listTunnels()).rejects.toThrow();

    expect(spawnSyncCalls.find((call) => call.file === "git")?.options.windowsHide).toBe(true);
    expect(spawnCalls.find((call) => call.file === "fake-rg")?.options.windowsHide).toBe(true);
    expect(
      spawnSyncCalls.find((call) => call.file === "fake-cloudflared")?.options.windowsHide
    ).toBe(true);
  });

  it.each([
    ["darwin", "cloudflared"],
    ["win32", "cloudflared.exe"],
  ] as const)("hides the %s cloudflared probe", (platform, executable) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);

    findBinary("cloudflared");

    expect(
      spawnSyncCalls.find((call) => call.file === executable && call.args[0] === "--version")
        ?.options.windowsHide
    ).toBe(true);
  });

  it("hides the update-check Git window", () => {
    const source = fs.readFileSync(path.resolve("src/cli/index.ts"), "utf8");
    const section = source.slice(source.indexOf("// ---------------------------------------------------------------- update-check"));
    expect(section.slice(0, section.indexOf("acceptUnusedWorkspaceOption"))).toContain(
      "windowsHide: true"
    );
  });
});
