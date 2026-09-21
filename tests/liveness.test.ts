import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeProcess } from "../src/process/liveness.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe("Windows process identity probe", () => {
  it.each([
    { label: "slow cold start", delay: 3000, startedAt: "2026-09-20T00:00:00Z", expected: "active" },
    { label: "probe timeout", delay: Infinity, startedAt: "2026-09-20T00:00:00Z", expected: "unknown" },
    { label: "invalid start time", delay: 3000, startedAt: "not-a-date", expected: "unknown" },
    { label: "probe failure", delay: 3000, startedAt: "2026-09-20T00:00:00Z", expected: "unknown", status: 1 },
    { label: "reused PID", delay: 3000, startedAt: "2026-09-20T02:00:00Z", expected: "dead" },
  ])("handles $label without losing the identity check", ({ delay, startedAt, expected, status = 0 }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(spawnSync).mockImplementation(((_file: string, _args: string[], options: { timeout: number }) => {
      const timedOut = options.timeout < delay;
      return {
        status: timedOut ? null : status,
        stdout: timedOut ? "" : `${startedAt}\r\n`,
        stderr: "",
        error: timedOut ? Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) : undefined,
      };
    }) as typeof spawnSync);

    expect(observeProcess(process.pid + 1, "2026-09-20T01:00:00Z")).toBe(expected);
  });
});
