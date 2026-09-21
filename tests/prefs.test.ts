import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeUiPrefs,
  prefsFile,
  readUiPrefs,
  SETUP_CHOICE_PROMPT,
} from "../src/config/ui-prefs.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("ui prefs", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("starts empty and is not bound to a workspace", () => {
    dirs.push(isolateStateDir());
    const prefs = readUiPrefs();
    expect(prefs.developerModeEnabled).toBe(false);
    expect(prefs.setupMode).toBeNull();
    expect(prefs.remembered).toEqual({ developerMode: false, setupMode: false });
    expect(prefs.setupChoicePrompt).toBe(SETUP_CHOICE_PROMPT);
    expect(prefs.setupChoicePrompt).toContain("AI 自动化配置（预览版）");
    expect(prefs.setupChoicePrompt).toContain("手动教学配置");
    expect(prefs.setupChoicePrompt).toContain("请回复「1」或「2」");
  });

  it("accepts legacy workspace options without making prefs workspace-scoped", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const missingRoot = path.join(stateDir, "not-a-workspace");
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, "prefs", ...args, "--json"], {
        encoding: "utf8", env: process.env,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    };

    expect(run(["set", "-w", missingRoot, "--setup-mode", "manual"])).toMatchObject({ setupMode: "manual" });
    expect(run(["get", "--workspace", missingRoot])).toMatchObject({ setupMode: "manual" });
    expect(run(["-w", missingRoot])).toMatchObject({ setupMode: "manual" });
    expect(run(["get"])).toMatchObject({ setupMode: "manual" });
    expect(fs.existsSync(missingRoot)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual(["prefs.json"]);
  });

  it("accepts legacy workspace options on every machine-wide command", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const codexHome = path.join(stateDir, "codex-home");
    const missingRoot = path.join(stateDir, "not-a-workspace");
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    fs.writeFileSync(path.join(stateDir, "update-check.json"), JSON.stringify({
      date: new Date().toLocaleDateString("en-CA"), updateAvailable: false,
    }));
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome },
    });

    for (const args of [
      ["sandbox-allow", "-w", missingRoot, "--json"],
      ["update-check", "--workspace", missingRoot, "--json"],
      ["tunnel", "login", "-w", missingRoot, "--help"],
    ]) {
      const result = run(args);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    expect(fs.existsSync(missingRoot)).toBe(false);
  });

  it("remembers developer mode as on only, never as off", () => {
    dirs.push(isolateStateDir());
    const saved = mergeUiPrefs({ developerModeEnabled: true });
    expect(saved.developerModeEnabled).toBe(true);
    const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as { developerModeEnabled?: boolean };
    expect(raw.developerModeEnabled).toBe(true);
    expect(JSON.stringify(raw)).not.toMatch(/token|pairing|secret/i);
  });

  it("saves setup mode without dropping developer mode", () => {
    dirs.push(isolateStateDir());
    mergeUiPrefs({ developerModeEnabled: true });
    const next = mergeUiPrefs({ setupMode: "manual" });
    expect(next.developerModeEnabled).toBe(true);
    expect(next.setupMode).toBe("manual");
    const auto = mergeUiPrefs({ setupMode: "auto" });
    expect(auto.setupMode).toBe("auto");
    expect(auto.developerModeEnabled).toBe(true);
  });

  it("rejects an unknown setup mode", () => {
    dirs.push(isolateStateDir());
    expect(() => mergeUiPrefs({ setupMode: "browser" as "auto" })).toThrow(/setup-mode/);
    expect(readUiPrefs().setupMode).toBeNull();
  });

  it("ignores a hand-edited developerModeEnabled false", () => {
    dirs.push(isolateStateDir());
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(
      prefsFile(),
      JSON.stringify({ developerModeEnabled: false, setupMode: "auto", updatedAt: "2026-01-01T00:00:00.000Z" }),
      { mode: 0o600 }
    );
    expect(readUiPrefs().developerModeEnabled).toBe(false);
    expect(readUiPrefs().remembered.developerMode).toBe(false);
    expect(readUiPrefs().setupMode).toBe("auto");
  });
});
