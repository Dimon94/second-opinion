import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type ConversationMode = "long-chat" | "project";

export type ConversationReason = "existing-long-chat" | "project" | "new-workspace";

export type ProtocolState =
  | "INIT"
  | "PLAN_RECEIVED"
  | "EXECUTING"
  | "EXECUTED_LOCAL"
  | "EXECUTED_SENT"
  | "DONE"
  | "BLOCKED";

export type WaitingFor = "none" | "GPT_PLAN" | "GPT_REVIEW" | "USER";

export const PROTOCOL_STATES: readonly ProtocolState[] = [
  "INIT",
  "PLAN_RECEIVED",
  "EXECUTING",
  "EXECUTED_LOCAL",
  "EXECUTED_SENT",
  "DONE",
  "BLOCKED",
];

export const WAITING_FOR: readonly WaitingFor[] = ["none", "GPT_PLAN", "GPT_REVIEW", "USER"];

export interface TaskCheckpoint {
  taskId: string;
  iteration: number;
  protocolState: ProtocolState;
  waitingFor: WaitingFor;
  originalGoal?: string;
  completedSubtasks?: string;
  knownIssues?: string;
  nextExpectedStep?: string;
  chatUrl?: string;
  projectUrl?: string;
  updatedAt: string;
}

export interface SavedSession {
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  checkpoint?: TaskCheckpoint;
}

export interface SessionPatch {
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  checkpoint?: Partial<TaskCheckpoint> & { protocolState?: ProtocolState };
  clearCheckpoint?: boolean;
}

export interface ConversationView {
  mode: ConversationMode;
  reason: ConversationReason;
  projectUrl: string | null;
  projectReady: boolean;
  chatUrl: string | null;
  connectorName: string | null;
  /** long-chat: Skill may goto chatUrl. project: only if THIS Codex thread already bound it. */
  reuseSavedChat: boolean;
}

export function sessionFile(workspaceId: string): string {
  return path.join(getStateDir(), "sessions", `${workspaceId}.json`);
}

export function readSession(workspaceId: string): SavedSession | null {
  const session = readJsonIfExists<SavedSession>(sessionFile(workspaceId));
  if (!session) return null;
  const url = session.url ? normalizeConversationUrl(session.url) : null;
  return { ...session, url: url ?? undefined };
}

export function writeSession(workspaceId: string, session: SavedSession): SavedSession {
  const url = session.url ? normalizeConversationUrl(session.url) : null;
  if (session.url && !url) throw new Error("conversation URL must look like https://chatgpt.com/c/…");
  const normalized = { ...session, url: url ?? undefined };
  const previous = readJsonIfExists<SavedSession>(sessionFile(workspaceId));
  if (previous && isDeepStrictEqual(withoutUpdateTimes(previous), withoutUpdateTimes(normalized))) {
    return readSession(workspaceId) ?? normalized;
  }
  writeSecureJson(sessionFile(workspaceId), normalized);
  return normalized;
}

function withoutUpdateTimes(session: SavedSession): unknown {
  const { savedAt: _savedAt, checkpoint, ...rest } = session;
  if (!checkpoint) return rest;
  const { updatedAt: _updatedAt, ...stableCheckpoint } = checkpoint;
  return { ...rest, checkpoint: stableCheckpoint };
}

export function normalizeConversationUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") return null;
    const match = parsed.pathname.match(/^\/c\/(?:WEB:)?([a-zA-Z0-9_-]+)\/?$/i);
    if (!match) return null;
    return `https://chatgpt.com/c/${match[1]}`;
  } catch {
    return null;
  }
}

export function normalizeProjectUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") return null;
    const match = parsed.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9]+)\/project\/?$/);
    if (!match) return null;
    return `https://chatgpt.com/g/${match[1]}/project`;
  } catch {
    return null;
  }
}

export function projectIdFromUrl(url: string): string | null {
  const normalized = normalizeProjectUrl(url);
  if (!normalized) return null;
  return normalized.match(/\/g\/(g-p-[a-zA-Z0-9]+)\/project/)?.[1] ?? null;
}

export function resolveConversation(session: SavedSession | null): ConversationView {
  if (!session) {
    return {
      mode: "project",
      reason: "new-workspace",
      projectUrl: null,
      projectReady: false,
      chatUrl: null,
      connectorName: null,
      reuseSavedChat: false,
    };
  }

  const projectUrl = session.projectUrl ? normalizeProjectUrl(session.projectUrl) : null;
  const projectReady = Boolean(projectUrl);
  const chatUrl = session.url ? normalizeConversationUrl(session.url) : null;

  if (session.conversationMode === "long-chat") {
    return {
      mode: "long-chat",
      reason: "existing-long-chat",
      projectUrl: null,
      projectReady: false,
      chatUrl,
      connectorName: session.connectorName ?? null,
      reuseSavedChat: Boolean(chatUrl),
    };
  }

  if (session.conversationMode === "project" || projectReady) {
    return {
      mode: "project",
      reason: "project",
      projectUrl,
      projectReady,
      chatUrl,
      connectorName: session.connectorName ?? null,
      reuseSavedChat: false,
    };
  }

  return {
    mode: "long-chat",
    reason: "existing-long-chat",
    projectUrl: null,
    projectReady: false,
    chatUrl,
    connectorName: session.connectorName ?? null,
    reuseSavedChat: Boolean(chatUrl),
  };
}

const CHECKPOINT_LIMITS = {
  originalGoal: 500,
  completedSubtasks: 800,
  knownIssues: 800,
  nextExpectedStep: 400,
} as const;

function validateAndCapCheckpointSummary(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (/[\r\n]/.test(value)) throw new Error("checkpoint fields require a single-line summary, not file, diff, or log bodies");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function mergeSession(previous: SavedSession | null, patch: SessionPatch): SavedSession {
  const conversationMode = patch.conversationMode ?? previous?.conversationMode;
  const rawProjectUrl = patch.projectUrl ?? previous?.projectUrl;
  let projectUrl = rawProjectUrl;
  if (rawProjectUrl) {
    const normalized = normalizeProjectUrl(rawProjectUrl);
    if (!normalized) {
      throw new Error("project URL must look like https://chatgpt.com/g/g-p-…/project");
    }
    projectUrl = normalized;
  }

  if (conversationMode === "project" && !projectUrl && !previous?.projectUrl) {
    throw new Error("project mode requires --project-url");
  }

  const rawUrl = patch.url ?? previous?.url;
  const url = rawUrl ? normalizeConversationUrl(rawUrl) ?? undefined : undefined;
  if (patch.url && !url) {
    throw new Error("conversation URL must look like https://chatgpt.com/c/…");
  }
  const hasChat = Boolean(url);
  const hasProject = Boolean(projectUrl);
  const hasTask = Boolean(patch.taskId ?? previous?.taskId);
  const hasCheckpoint = Boolean(patch.checkpoint || patch.clearCheckpoint || previous?.checkpoint);
  if (!hasChat && !hasProject && conversationMode !== "long-chat" && !hasTask && !hasCheckpoint) {
    throw new Error("nothing to save: pass --url, --project-url, or --mode");
  }

  let checkpoint = previous?.checkpoint;
  if (patch.clearCheckpoint) {
    checkpoint = undefined;
  } else if (patch.checkpoint) {
    const taskId = patch.checkpoint.taskId ?? patch.taskId ?? previous?.checkpoint?.taskId ?? previous?.taskId;
    const iteration =
      patch.checkpoint.iteration ??
      patch.iteration ??
      previous?.checkpoint?.iteration ??
      previous?.iteration ??
      0;
    const protocolState = patch.checkpoint.protocolState ?? previous?.checkpoint?.protocolState;
    if (!taskId || !protocolState) {
      throw new Error("checkpoint requires task id and protocol state");
    }
    if (!PROTOCOL_STATES.includes(protocolState)) {
      throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
    }
    const waitingFor = patch.checkpoint.waitingFor ?? previous?.checkpoint?.waitingFor ?? "none";
    if (!WAITING_FOR.includes(waitingFor)) {
      throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
    }
    checkpoint = {
      taskId,
      iteration,
      protocolState,
      waitingFor,
      originalGoal: validateAndCapCheckpointSummary(
        patch.checkpoint.originalGoal ?? previous?.checkpoint?.originalGoal,
        CHECKPOINT_LIMITS.originalGoal
      ),
      completedSubtasks: validateAndCapCheckpointSummary(
        patch.checkpoint.completedSubtasks ?? previous?.checkpoint?.completedSubtasks,
        CHECKPOINT_LIMITS.completedSubtasks
      ),
      knownIssues: validateAndCapCheckpointSummary(
        patch.checkpoint.knownIssues ?? previous?.checkpoint?.knownIssues,
        CHECKPOINT_LIMITS.knownIssues
      ),
      nextExpectedStep: validateAndCapCheckpointSummary(
        patch.checkpoint.nextExpectedStep ?? previous?.checkpoint?.nextExpectedStep,
        CHECKPOINT_LIMITS.nextExpectedStep
      ),
      chatUrl: patch.checkpoint.chatUrl ?? previous?.checkpoint?.chatUrl ?? url,
      projectUrl: patch.checkpoint.projectUrl ?? previous?.checkpoint?.projectUrl ?? projectUrl,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    url,
    title: patch.title ?? previous?.title,
    taskId: patch.taskId ?? previous?.taskId,
    iteration: patch.iteration ?? previous?.iteration,
    lastState: patch.lastState ?? previous?.lastState,
    conversationMode: conversationMode === "project" && projectUrl ? "project" : conversationMode,
    projectUrl,
    connectorName: patch.connectorName ?? previous?.connectorName,
    checkpoint,
    savedAt: new Date().toISOString(),
  };
}

/** Drop the current chat pointer. Keep Project binding so the collection stays. */
export function clearChatPointer(workspaceId: string): { cleared: boolean; keptProject: boolean } {
  const previous = readSession(workspaceId);
  if (!previous) return { cleared: false, keptProject: false };
  const view = resolveConversation(previous);
  if (view.mode === "project" && view.projectUrl) {
    writeSession(workspaceId, {
      ...previous,
      url: undefined,
      conversationMode: "project",
      projectUrl: view.projectUrl,
      savedAt: new Date().toISOString(),
    });
    return { cleared: true, keptProject: true };
  }
  writeSession(workspaceId, {
    ...previous,
    url: undefined,
    conversationMode: "long-chat",
    savedAt: new Date().toISOString(),
  });
  return { cleared: true, keptProject: false };
}
