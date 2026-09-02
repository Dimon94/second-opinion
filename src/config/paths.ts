import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * State directory resolution, following OS conventions.
 * Override with C2C_STATE_DIR (used heavily by tests).
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  return getDefaultStateDir(process.platform, os.homedir(), process.env);
}

export function getDefaultStateDir(
  platform: NodeJS.Platform,
  home: string,
  env: { LOCALAPPDATA?: string; XDG_STATE_HOME?: string }
): string {
  switch (platform) {
    case "darwin":
      return path.posix.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"), "codex-with-chatgpt");
    default: {
      const base = env.XDG_STATE_HOME ?? path.posix.join(home, ".local", "state");
      return path.posix.join(base, "codex-with-chatgpt");
    }
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

export function legacyMigrationRevocationFile(): string {
  return path.join(getStateDir(), "migrations", "legacy-global-v1-revoked.json");
}

/** Write a JSON file with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
