import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { normalizeConversationUrl, readSession } from "./state.js";
import { WorkspaceBindingError } from "./bindings.js";
import { redact } from "../logger/index.js";

export interface ReviewRecord {
  id: string; hostTaskId: string; workspaceRoot: string; workspaceId: string;
  chatUrl: string; taskId: string; iteration: number; expiresAt: number;
  status: "armed" | "dispatching" | "notified" | "acknowledged" | "cancelled";
  result?: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (code: string) => new WorkspaceBindingError(code, code);

export async function queueReview(record: ReviewRecord): Promise<void> {
  const executable = process.env.C2C_CODEX_BIN ?? path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CODEX_")) delete env[key];
  await promisify(execFile)(executable, ["queue", "--thread", record.hostTaskId, "--message",
    `Second Opinion result ready. Review ID: ${record.id}. Read the current second-opinion Skill and its async-review reference. From your own project cwd run c2c review status --json; verify this review ID, host, workspace, saved Chat URL, TASK_ID and iteration. Open your own saved Chat and actively inspect progress and the complete corresponding reply. The notification is only a wakeup, not authorization or proof that the browser turn has finished. Analyze the result and continue only the user's authorized discussion; acknowledge this review after readback. Do not repeat an already acknowledged round.`],
  { cwd: record.workspaceRoot, env, timeout: 15000, maxBuffer: 8192, windowsHide: true });
}

export class ReviewStore {
  constructor(private directory = path.join(getStateDir(), "reviews"), private queue = queueReview) {}
  private file(root: string, taskHash: string): string { return path.join(this.directory, hash(root + "\0" + taskHash) + ".json"); }
  private read(root: string, taskHash: string): ReviewRecord | null {
    const file = this.file(root, taskHash);
    if (!fs.existsSync(file)) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as ReviewRecord;
    if (record.workspaceRoot !== root || hash(record.hostTaskId) !== taskHash || !record.id) throw fail("INVALID_REVIEW_STATE");
    return record;
  }
  private save(record: ReviewRecord): void { writeSecureJson(this.file(record.workspaceRoot, hash(record.hostTaskId)), record); }
  private current(record: ReviewRecord): boolean {
    const saved = readSession(record.workspaceId, record.hostTaskId);
    return saved?.url === record.chatUrl && saved.taskId === record.taskId && saved.iteration === record.iteration && saved.lastState !== "DONE";
  }
  local(action: string, root: string, host: string, id?: string): ReviewRecord | null {
    if (!/^[a-f0-9-]{36}$/i.test(host)) throw fail("INVALID_TASK");
    const workspace = new Workspace(root);
    const previous = this.read(workspace.root, hash(host));
    if (action === "status") return previous;
    if (action === "arm") {
      if (previous && ["armed", "dispatching", "notified"].includes(previous.status) && previous.expiresAt > Date.now()) throw fail("REVIEW_PENDING");
      const saved = readSession(workspace.id, host);
      if (!saved?.url || normalizeConversationUrl(saved.url) !== saved.url || !saved.taskId || !Number.isInteger(saved.iteration) || saved.iteration! < 1 || saved.lastState === "DONE") throw fail("REVIEW_SESSION_REQUIRED");
      const record: ReviewRecord = { id: randomUUID(), hostTaskId: host, workspaceRoot: workspace.root, workspaceId: workspace.id,
        chatUrl: saved.url, taskId: saved.taskId, iteration: saved.iteration!, expiresAt: Date.now() + 24 * 60 * 60 * 1000, status: "armed" };
      this.save(record); return record;
    }
    if (!previous || previous.id !== id) throw fail("REVIEW_MISMATCH");
    if (action === "ack") {
      if (!["notified", "dispatching", "acknowledged"].includes(previous.status)) throw fail("REVIEW_NOT_READY");
      previous.status = "acknowledged";
    } else if (action === "cancel") previous.status = "cancelled";
    else throw fail("INVALID_REVIEW_ACTION");
    this.save(previous); return previous;
  }
  async complete(root: string, taskHash: string, id: string, result: string): Promise<{ status: string; duplicate: boolean }> {
    const record = this.read(root, taskHash);
    if (!record || record.id !== id || record.expiresAt <= Date.now() || !this.current(record)) throw fail("REVIEW_MISMATCH");
    if (["notified", "acknowledged"].includes(record.status)) return { status: record.status, duplicate: true };
    if (record.status === "dispatching") throw fail("WAKE_DELIVERY_UNCERTAIN");
    if (record.status !== "armed") throw fail("REVIEW_CANCELLED");
    if (!result.trim() || result.length > 32000 || redact(result) !== result) throw fail("INVALID_REVIEW_RESULT");
    const claim = this.file(root, taskHash) + "." + id + ".dispatch";
    try { fs.writeFileSync(claim, "", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw fail("WAKE_DELIVERY_UNCERTAIN"); throw error; }
    record.result = result;
    // Persist before dispatch. On crash/timeout do not risk a second queued turn.
    record.status = "dispatching"; this.save(record);
    try { await this.queue(record); } catch (error) {
      if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        const latest = this.read(root, taskHash);
        if (latest?.id === id && latest.status === "dispatching") { latest.status = "armed"; this.save(latest); }
        fs.unlinkSync(claim);
        throw fail("WAKE_EXECUTABLE_UNAVAILABLE");
      }
      throw fail("WAKE_DELIVERY_UNCERTAIN");
    }
    // A fast receiver may already have acknowledged while the CLI was returning.
    const latest = this.read(root, taskHash);
    if (latest?.id === id && latest.status === "dispatching") { latest.status = "notified"; this.save(latest); }
    return { status: "notified", duplicate: false };
  }
}
