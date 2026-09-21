import { spawnSync } from "node:child_process";

export type ProcessLiveness = "active" | "dead" | "unknown";

function processStartedAt(pid: number): number | null {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    const startedAt = Date.parse(result.stdout.trim());
    return result.status === 0 && Number.isFinite(startedAt) ? startedAt : null;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
    env: { ...process.env, LC_ALL: "C" },
  });
  const startedAt = Date.parse(result.stdout.trim());
  return result.status === 0 && Number.isFinite(startedAt) ? startedAt : null;
}

export function observeProcess(pid: number, ownerStartedAt?: string): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  if (!ownerStartedAt) return "active";
  const expected = Date.parse(ownerStartedAt);
  const observed = processStartedAt(pid);
  if (!Number.isFinite(expected) || observed === null) return "unknown";
  return observed > expected ? "dead" : "active";
}
