import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";

const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;

type OAuthPrincipal = { clientId: string; scopes: string[] };

interface BootstrapRecord {
  hash: string;
  workspaceRoot: string;
  taskHash: string;
  expiresAt: number;
}

interface BindingRecord {
  hash: string;
  workspaceRoot: string;
  taskHash: string;
  clientId: string;
  scopes: string[];
  sessionHash: string;
  createdAt: string;
}

interface StoredBindings {
  version: 1;
  bootstraps: BootstrapRecord[];
  bindings: BindingRecord[];
}

export class WorkspaceBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function validSecret(value: string, prefix: string): boolean {
  return value.length <= 128 && value.startsWith(`${prefix}_`);
}

function scopes(value: string[]): string[] {
  return [...new Set(value)].sort();
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validStoredBindings(value: unknown): value is StoredBindings {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<StoredBindings>;
  if (state.version !== 1 || !Array.isArray(state.bootstraps) || !Array.isArray(state.bindings)) return false;
  const bootstrapsValid = state.bootstraps.every((record) =>
    validHash(record.hash) && path.isAbsolute(record.workspaceRoot) && validHash(record.taskHash) &&
    Number.isFinite(record.expiresAt)
  );
  const bindingsValid = state.bindings.every((record) =>
    validHash(record.hash) && path.isAbsolute(record.workspaceRoot) && validHash(record.taskHash) &&
    typeof record.clientId === "string" && Boolean(record.clientId) &&
    Array.isArray(record.scopes) && record.scopes.every((scope) => typeof scope === "string") &&
    record.scopes.join(" ") === scopes(record.scopes).join(" ") && validHash(record.sessionHash) &&
    typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
  );
  const hashes = [...state.bootstraps, ...state.bindings].map((record) => record.hash);
  return bootstrapsValid && bindingsValid && new Set(hashes).size === hashes.length;
}

export class WorkspaceBindingStore {
  private bootstraps: BootstrapRecord[] = [];
  private bindings: BindingRecord[] = [];
  private readonly file: string;
  private readonly bootstrapTtlMs: number;

  constructor(opts: { file?: string; bootstrapTtlMs?: number } = {}) {
    this.file = opts.file ?? path.join(ensureDir(path.join(getStateDir(), "bindings")), "store.json");
    this.bootstrapTtlMs = opts.bootstrapTtlMs ?? BOOTSTRAP_TTL_MS;
    if (!fs.existsSync(this.file)) return;
    const stored = readJsonIfExists<StoredBindings>(this.file);
    if (!validStoredBindings(stored)) {
      throw new Error("Binding state is invalid; refusing to overwrite it.");
    }
    this.bootstraps = stored.bootstraps;
    this.bindings = stored.bindings;
    this.pruneExpired();
  }

  mint(workspaceRoot: string, taskId: string): { bootstrapToken: string; expiresAt: number } {
    const owner = taskId.trim();
    if (!owner || owner.length > 200) throw new WorkspaceBindingError("INVALID_TASK", "A valid local task id is required.");
    const workspace = new Workspace(workspaceRoot);
    this.pruneExpired();
    const bootstrapToken = secret("c2c_boot");
    const expiresAt = Date.now() + this.bootstrapTtlMs;
    this.bootstraps.push({
      hash: hash(bootstrapToken),
      workspaceRoot: workspace.root,
      taskHash: hash(owner),
      expiresAt,
    });
    this.save();
    return { bootstrapToken, expiresAt };
  }

  redeem(bootstrapToken: string, principal: OAuthPrincipal, sessionId: string): { binding_token: string } {
    this.pruneExpired();
    if (!validSecret(bootstrapToken, "c2c_boot")) {
      throw new WorkspaceBindingError("INVALID_BOOTSTRAP", "The workspace bootstrap is invalid or expired.");
    }
    const index = this.bootstraps.findIndex((record) => record.hash === hash(bootstrapToken));
    if (index < 0) throw new WorkspaceBindingError("INVALID_BOOTSTRAP", "The workspace bootstrap is invalid or expired.");
    const [bootstrap] = this.bootstraps.splice(index, 1);
    const bindingToken = secret("c2c_bind");
    this.bindings.push({
      hash: hash(bindingToken),
      workspaceRoot: bootstrap.workspaceRoot,
      taskHash: bootstrap.taskHash,
      clientId: principal.clientId,
      scopes: scopes(principal.scopes),
      sessionHash: hash(sessionId),
      createdAt: new Date().toISOString(),
    });
    this.save();
    return { binding_token: bindingToken };
  }

  resolve(bindingToken: string, principal: OAuthPrincipal, sessionId: string): Workspace {
    if (!validSecret(bindingToken, "c2c_bind")) {
      throw new WorkspaceBindingError("WORKSPACE_BINDING_REQUIRED", "A valid workspace binding token is required.");
    }
    const record = this.bindings.find((candidate) => candidate.hash === hash(bindingToken));
    if (!record) throw new WorkspaceBindingError("WORKSPACE_BINDING_REQUIRED", "A valid workspace binding token is required.");
    if (
      record.clientId !== principal.clientId ||
      record.scopes.join(" ") !== scopes(principal.scopes).join(" ") ||
      record.sessionHash !== hash(sessionId)
    ) {
      throw new WorkspaceBindingError("WORKSPACE_BINDING_MISMATCH", "The workspace binding does not match this session.");
    }
    try {
      const workspace = new Workspace(record.workspaceRoot);
      if (workspace.root !== record.workspaceRoot) throw new Error("Workspace root changed");
      return workspace;
    } catch {
      throw new WorkspaceBindingError("WORKSPACE_UNAVAILABLE", "The bound workspace is unavailable; authorize it again locally.");
    }
  }

  unbindTask(taskId: string): number {
    const owner = taskId.trim();
    if (!owner || owner.length > 200) throw new WorkspaceBindingError("INVALID_TASK", "A valid local task id is required.");
    const taskHash = hash(owner);
    const before = this.bindings.length;
    this.bindings = this.bindings.filter((binding) => binding.taskHash !== taskHash);
    this.bootstraps = this.bootstraps.filter((bootstrap) => bootstrap.taskHash !== taskHash);
    const removed = before - this.bindings.length;
    this.save();
    return removed;
  }

  clear(): void {
    this.bootstraps = [];
    this.bindings = [];
    this.save();
  }

  count(): number {
    return this.bindings.length;
  }

  private pruneExpired(): void {
    const active = this.bootstraps.filter((record) => record.expiresAt > Date.now());
    if (active.length === this.bootstraps.length) return;
    this.bootstraps = active;
    this.save();
  }

  private save(): void {
    writeSecureJson(this.file, { version: 1, bootstraps: this.bootstraps, bindings: this.bindings } satisfies StoredBindings);
  }
}
