import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearChatPointer,
  mergeSession,
  normalizeConversationUrl,
  normalizeProjectUrl,
  projectIdFromUrl,
  readSession,
  resolveConversation,
  sessionFile,
  writeSession,
} from "../src/session/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

describe("normalizeConversationUrl", () => {
  it("canonicalizes ChatGPT conversation URLs, including the app WEB prefix", () => {
    expect(normalizeConversationUrl("https://chatgpt.com/c/WEB:abc-123?model=auto#top")).toBe(
      "https://chatgpt.com/c/abc-123"
    );
    expect(normalizeConversationUrl("https://www.chatgpt.com/c/abc-123/")).toBe(
      "https://chatgpt.com/c/abc-123"
    );
  });

  it("rejects non-conversation and untrusted URLs", () => {
    expect(normalizeConversationUrl("http://chatgpt.com/c/abc-123")).toBeNull();
    expect(normalizeConversationUrl("https://example.com/c/abc-123")).toBeNull();
    expect(normalizeConversationUrl(PROJECT)).toBeNull();
  });
});

describe("normalizeProjectUrl", () => {
  it("accepts the collection URL and strips extras", () => {
    expect(normalizeProjectUrl(`${PROJECT}/`)).toBe(PROJECT);
    expect(normalizeProjectUrl("https://www.chatgpt.com/g/g-p-abc123/project?foo=1")).toBe(
      "https://chatgpt.com/g/g-p-abc123/project"
    );
    expect(projectIdFromUrl(PROJECT)).toBe("g-p-6a94399430e08191860ab5364b7748b8");
  });

  it("rejects a normal chat URL or a guessed name", () => {
    expect(normalizeProjectUrl("https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBeNull();
    expect(normalizeProjectUrl("https://chatgpt.com/")).toBeNull();
    expect(normalizeProjectUrl("https://example.com/g/g-p-abc/project")).toBeNull();
  });
});

describe("resolveConversation", () => {
  it("treats a missing file as a new workspace (Project by default)", () => {
    const view = resolveConversation(null);
    expect(view.mode).toBe("project");
    expect(view.reason).toBe("new-workspace");
    expect(view.reuseSavedChat).toBe(false);
    expect(view.projectReady).toBe(false);
  });

  it("keeps a legacy session file on long-chat and does not migrate", () => {
    const view = resolveConversation({
      url: "https://chatgpt.com/c/old-chat",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("long-chat");
    expect(view.reason).toBe("existing-long-chat");
    expect(view.reuseSavedChat).toBe(true);
    expect(view.chatUrl).toBe("https://chatgpt.com/c/old-chat");
  });

  it("normalizes a repairable saved chat and treats an invalid one as missing", () => {
    expect(
      resolveConversation({
        url: "https://chatgpt.com/c/WEB:old-chat",
        savedAt: "2026-01-01T00:00:00.000Z",
      })
    ).toMatchObject({ chatUrl: "https://chatgpt.com/c/old-chat", reuseSavedChat: true });
    expect(
      resolveConversation({
        url: "https://example.com/c/not-chatgpt",
        savedAt: "2026-01-01T00:00:00.000Z",
      })
    ).toMatchObject({ chatUrl: null, reuseSavedChat: false });
  });

  it("lets an explicit long-chat opt-out win over a leftover collection URL", () => {
    const view = resolveConversation({
      conversationMode: "long-chat",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/keep",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("long-chat");
    expect(view.reuseSavedChat).toBe(true);
  });

  it("uses Project when a collection URL is stored", () => {
    const view = resolveConversation({
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/thread-1",
      connectorName: "Codex with ChatGPT · Demo",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("project");
    expect(view.projectReady).toBe(true);
    expect(view.reuseSavedChat).toBe(false);
    expect(view.connectorName).toBe("Codex with ChatGPT · Demo");
  });
});

describe("mergeSession", () => {
  it("keeps Project fields when only the chat URL is updated", () => {
    const next = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        connectorName: "Codex with ChatGPT · Demo",
        url: "https://chatgpt.com/c/old",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { url: "https://chatgpt.com/c/new", taskId: "c2c_ab12", iteration: 1 }
    );
    expect(next.projectUrl).toBe(PROJECT);
    expect(next.conversationMode).toBe("project");
    expect(next.url).toBe("https://chatgpt.com/c/new");
    expect(next.connectorName).toBe("Codex with ChatGPT · Demo");
    expect(next.taskId).toBe("c2c_ab12");
  });

  it("normalizes saved conversation URLs and rejects invalid replacements", () => {
    expect(
      mergeSession(null, {
        conversationMode: "long-chat",
        url: "https://chatgpt.com/c/WEB:new-chat?model=auto",
      }).url
    ).toBe("https://chatgpt.com/c/new-chat");
    expect(() =>
      mergeSession(null, {
        conversationMode: "long-chat",
        url: "https://example.com/c/not-chatgpt",
      })
    ).toThrow(/conversation URL/);
  });

  it("writes and clears a checkpoint without dropping the chat URL", () => {
    const withCheckpoint = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
          nextExpectedStep: "wait for review",
        },
      }
    );
    expect(withCheckpoint.url).toBe("https://chatgpt.com/c/keep");
    expect(withCheckpoint.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(withCheckpoint.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(withCheckpoint.checkpoint?.taskId).toBe("c2c_ab12");
    const cleared = mergeSession(withCheckpoint, { clearCheckpoint: true });
    expect(cleared.checkpoint).toBeUndefined();
    expect(cleared.url).toBe("https://chatgpt.com/c/keep");
  });

  it("keeps an existing checkpoint when only the chat URL is updated", () => {
    const previous = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
        },
      }
    );
    const next = mergeSession(previous, { url: "https://chatgpt.com/c/new" });
    expect(next.url).toBe("https://chatgpt.com/c/new");
    expect(next.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(next.checkpoint?.originalGoal).toBe("dark mode");
  });

  it("caps checkpoint summaries and rejects multiline file, diff, or log bodies", () => {
    const next = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          originalGoal: "x".repeat(600),
        },
      }
    );
    expect(next.checkpoint?.originalGoal?.length).toBeLessThanOrEqual(501);
    expect(next.checkpoint?.originalGoal?.endsWith("…")).toBe(true);
    expect(() =>
      mergeSession(next, {
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          knownIssues: "diff --git a/src/a.ts b/src/a.ts\n-old\n+new",
        },
      })
    ).toThrow(/single-line summary/);
  });

  it("leaves legacy sessions without a checkpoint unchanged", () => {
    const next = mergeSession(
      {
        url: "https://chatgpt.com/c/old",
        taskId: "c2c_aa01",
        iteration: 2,
        lastState: "EXECUTED",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { iteration: 3, lastState: "EXECUTED" }
    );
    expect(next.checkpoint).toBeUndefined();
    expect(next.taskId).toBe("c2c_aa01");
  });

  it("rejects a non-collection project URL", () => {
    expect(() =>
      mergeSession(null, {
        conversationMode: "project",
        projectUrl: "https://chatgpt.com/c/nope",
      })
    ).toThrow(/project URL/);
  });
});

describe("clearChatPointer", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("keeps the collection binding in Project mode", () => {
    const dir = makeTmpDir("session-clear");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    writeSession("abc123abc123", {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/gone",
      connectorName: "Codex with ChatGPT · Demo",
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        originalGoal: "dark mode",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("abc123abc123")).toEqual({ cleared: true, keptProject: true });
    const saved = readSession("abc123abc123");
    expect(saved?.projectUrl).toBe(PROJECT);
    expect(saved?.url).toBeUndefined();
    expect(saved?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
  });

  it("clears a legacy long-chat pointer without dropping its mode or checkpoint", () => {
    const dir = makeTmpDir("session-clear-legacy");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    writeSession("def456def456", {
      url: "https://chatgpt.com/c/legacy",
      conversationMode: "long-chat",
      connectorName: "Codex with ChatGPT",
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("def456def456")).toEqual({ cleared: true, keptProject: false });
    expect(readSession("def456def456")).toMatchObject({
      url: undefined,
      conversationMode: "long-chat",
      connectorName: "Codex with ChatGPT",
      checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" },
    });
  });

  it("isolates host tasks without inheriting legacy or fork checkpoints", () => {
    const dir = makeTmpDir("session-task-isolation");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    const legacy = writeSession("workspace", mergeSession(null, {
      url: "https://chatgpt.com/c/legacy", taskId: "legacy-protocol",
    }));
    const legacyBytes = fs.readFileSync(sessionFile("workspace"), "utf8");
    for (const owner of ["host-a", "host-b"]) {
      writeSession("workspace", mergeSession(null, {
        url: `https://chatgpt.com/c/${owner}`, taskId: `protocol-${owner}`,
        projectUrl: PROJECT, conversationMode: "project",
        checkpoint: { protocolState: "EXECUTED_LOCAL", waitingFor: "none" },
      }), owner);
    }
    const first = readSession("workspace", "host-a")!;
    const bytes = fs.readFileSync(sessionFile("workspace", "host-a"), "utf8");
    writeSession("workspace", { ...first, savedAt: "2099-01-01T00:00:00.000Z" }, "host-a");
    expect(fs.readFileSync(sessionFile("workspace", "host-a"), "utf8")).toBe(bytes);
    expect(readSession("workspace", "host-b")).toMatchObject({
      url: "https://chatgpt.com/c/host-b", checkpoint: { taskId: "protocol-host-b" },
    });
    expect(readSession("workspace", "fork-a")).toBeNull();
    expect(readSession("other-workspace", "host-a")).toBeNull();
    expect(() => readSession("workspace", " ")).toThrow(/task/i);
    clearChatPointer("workspace", "host-a");
    expect(readSession("workspace", "host-a")).toMatchObject({
      url: undefined, projectUrl: PROJECT, checkpoint: { taskId: "protocol-host-a" },
    });
    expect(readSession("workspace", "host-b")?.url).toBe("https://chatgpt.com/c/host-b");
    expect(readSession("workspace")).toEqual(legacy);
    expect(fs.readFileSync(sessionFile("workspace"), "utf8")).toBe(legacyBytes);
  });

  it("keeps repeated secure writes byte-identical and owner-only", () => {
    const dir = makeTmpDir("session-idempotent");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    const first = writeSession("abc123abc123", {
      url: "https://chatgpt.com/c/keep",
      conversationMode: "long-chat",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    const file = sessionFile("abc123abc123");
    const before = fs.readFileSync(file, "utf8");
    const second = writeSession("abc123abc123", {
      ...first,
      savedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(second.savedAt).toBe(first.savedAt);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });
});
