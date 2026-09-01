import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { observeProcess } from "../process/liveness.js";

const RECOVERY_LEASE_TTL_MS = 5 * 60 * 1000;

export type RecoveryPhase = "starting" | "sandbox" | "bridge" | "tunnel";

export interface RecoveryLeaseOwner {
  version: 1;
  leaseId: string;
  ownerPid: number;
  startedAt: string;
  expiresAt: string;
  workspaceId: string;
  workspaceRoot: string;
}

export interface RecoveryLeaseRecord extends RecoveryLeaseOwner {
  phase: RecoveryPhase;
}

export interface RecoveryLeaseHandle {
  updatePhase(phase: RecoveryPhase): void;
  release(): void;
}

export type RecoveryLeaseAcquisition =
  | { status: "acquired"; lease: RecoveryLeaseHandle }
  | { status: "busy"; reason: "owner_active" | "lease_not_expired" }
  | { status: "unknown"; reason: "owner_invalid" | "liveness_unknown" | "reclaim_raced" };

function recoveryRoot(): string {
  return ensureDir(path.join(getStateDir(), "recovery"));
}

function activeLeaseDir(): string {
  return path.join(recoveryRoot(), "active");
}

function leaseFile(dir: string): string {
  return path.join(dir, "lease.json");
}

function isLeaseRecord(value: RecoveryLeaseRecord | null): value is RecoveryLeaseRecord {
  return Boolean(
    value &&
      value.version === 1 &&
      /^[A-Za-z0-9._-]{1,128}$/.test(value.leaseId) &&
      Number.isInteger(value.ownerPid) &&
      Number.isFinite(Date.parse(value.startedAt)) &&
      Number.isFinite(Date.parse(value.expiresAt)) &&
      value.workspaceId &&
      value.workspaceRoot &&
      ["starting", "sandbox", "bridge", "tunnel"].includes(value.phase)
  );
}

function replaceLeaseRecord(dir: string, record: RecoveryLeaseRecord): void {
  const temp = path.join(dir, `.lease-${randomUUID()}.json`);
  writeSecureJson(temp, record);
  try {
    fs.renameSync(temp, leaseFile(dir));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function candidateLease(owner: RecoveryLeaseOwner): string {
  const dir = fs.mkdtempSync(path.join(recoveryRoot(), ".candidate-"));
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  writeSecureJson(leaseFile(dir), { ...owner, phase: "starting" satisfies RecoveryPhase });
  return dir;
}

function handleFor(owner: RecoveryLeaseOwner): RecoveryLeaseHandle {
  const dir = activeLeaseDir();
  const stillOwned = (): boolean => readJsonIfExists<RecoveryLeaseRecord>(leaseFile(dir))?.leaseId === owner.leaseId;
  return {
    updatePhase(phase) {
      if (!stillOwned()) throw new Error("Recovery lease ownership changed unexpectedly.");
      replaceLeaseRecord(dir, { ...owner, phase });
    },
    release() {
      if (stillOwned()) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function acquireRecoveryLease(input: {
  workspaceId: string;
  workspaceRoot: string;
}): RecoveryLeaseAcquisition {
  const startedAt = Date.now();
  const owner: RecoveryLeaseOwner = {
    version: 1,
    leaseId: randomUUID(),
    ownerPid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(startedAt + RECOVERY_LEASE_TTL_MS).toISOString(),
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = candidateLease(owner);
    const active = activeLeaseDir();
    try {
      fs.renameSync(candidate, active);
      return { status: "acquired", lease: handleFor(owner) };
    } catch (error) {
      fs.rmSync(candidate, { recursive: true, force: true });
      if (!fs.existsSync(active)) throw error;
    }

    const current = readJsonIfExists<RecoveryLeaseRecord>(leaseFile(active));
    if (!isLeaseRecord(current)) return { status: "unknown", reason: "owner_invalid" };
    const expired = Date.now() >= Date.parse(current.expiresAt);
    const liveness = observeProcess(current.ownerPid, expired ? current.startedAt : undefined);
    if (liveness === "active") return { status: "busy", reason: "owner_active" };
    if (liveness === "unknown") return { status: "unknown", reason: "liveness_unknown" };
    if (!expired) {
      return { status: "busy", reason: "lease_not_expired" };
    }

    const reclaimedRoot = ensureDir(path.join(recoveryRoot(), "reclaimed"));
    const evidenceDir = path.join(reclaimedRoot, current.leaseId);
    if (fs.existsSync(evidenceDir)) continue;
    try {
      fs.renameSync(active, evidenceDir);
    } catch {
      continue;
    }
    writeSecureJson(path.join(evidenceDir, "reclaimed.json"), {
      reason: "owner_dead_and_lease_expired",
      reclaimedAt: new Date().toISOString(),
      reclaimedByPid: process.pid,
    });
    // ponytail: retain tiny crash evidence; add pruning only if state growth becomes measurable.
  }

  return { status: "unknown", reason: "reclaim_raced" };
}
