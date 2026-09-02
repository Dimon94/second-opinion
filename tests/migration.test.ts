import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthStore,
  canonicalOAuthIdentity,
  clientRegistrationFingerprint,
} from "../src/auth/store.js";
import { readLastEndpoint } from "../src/config/endpoint.js";
import {
  acknowledgeLegacyRuntimeReload,
  hasLegacyStateToMigrate,
  migrateLegacyState,
} from "../src/config/legacy-migration.js";
import { legacyMigrationRevocationFile, writeSecureJson } from "../src/config/paths.js";
import { readSession, sessionFile } from "../src/session/state.js";
import { readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const dirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

function exactLegacyFixture(
  stateDir: string,
  workspaceId = "legacy-workspace",
  baseUrl = "https://c2c-demo.example.com"
): void {
  const client = {
    clientId: "c2c_client_fixture",
    clientName: "Legacy ChatGPT",
    redirectUris: ["https://chatgpt.com/oauth/callback"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const binding = canonicalOAuthIdentity({
    baseUrl,
    clientId: client.clientId,
    clientRegistration: clientRegistrationFingerprint(client),
    scopes: ["workspace.read", "offline_access"],
    bridgeId: "c2c_bridge_fixture",
  });
  writeSecureJson(path.join(stateDir, "endpoints", `${workspaceId}.json`), {
    workspaceId,
    port: 48765,
    publicUrl: baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    connectorName: "Codex with ChatGPT · Demo",
    savedAt: "2026-01-01T00:00:00.000Z",
    homePath: "/Users/alice/private",
  });
  writeSecureJson(path.join(stateDir, "tunnels", `${workspaceId}.json`), {
    workspaceId,
    preference: baseUrl.includes("trycloudflare.com") ? "quick" : "named",
    provider: baseUrl.includes("trycloudflare.com") ? "cloudflare-quick" : "cloudflare-named",
    ...(baseUrl.includes("trycloudflare.com")
      ? {}
      : { tunnelName: "c2c-demo", hostname: new URL(baseUrl).hostname }),
    pairingCode: "ABCD-EFGH",
  });
  writeSecureJson(path.join(stateDir, "auth", `${workspaceId}.json`), {
    version: 2,
    bridgeId: "c2c_bridge_fixture",
    clients: [
      {
        ...client,
        binding: canonicalOAuthIdentity({
          baseUrl,
          clientId: client.clientId,
          clientRegistration: clientRegistrationFingerprint(client),
          scopes: [],
          bridgeId: "c2c_bridge_fixture",
        }),
        grantedScopes: binding.scopes,
        grant: {
          binding,
          state: "active",
          proof: "protected_resource",
          accessExpiresAt: Date.now() + 60_000,
          refreshExpiresAt: Date.now() + 120_000,
        },
        browserCookie: "browser-cookie-secret",
      },
    ],
    tokens: [
      {
        hash: "a".repeat(64),
        kind: "access",
        binding,
        issuedAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
        revoked: false,
        rawToken: "c2c_at_access_should_never_appear",
      },
    ],
    refreshToken: "c2c_rt_refresh_should_never_appear",
  });
  writeSecureJson(sessionFile(workspaceId), {
    url: "https://chatgpt.com/c/legacy-chat",
    connectorName: "Codex with ChatGPT · Demo",
    savedAt: "2026-01-01T00:00:00.000Z",
    browserCredential: "browser-credential-secret",
  });
}

describe("legacy global-state migration", () => {
  it("moves workspace transport state when auth is already canonical", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    fs.renameSync(
      path.join(stateDir, "auth", "legacy-workspace.json"),
      path.join(stateDir, "auth", "store.json")
    );

    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "migrated",
      reason: "exact_match",
    });
    expect(readLastEndpoint("global")).toMatchObject({
      workspaceId: "global",
      publicUrl: "https://c2c-demo.example.com",
    });
    expect(readTunnelState("global")).toMatchObject({
      workspaceId: "global",
      preference: "named",
    });
  });

  it("migrates one exact named identity once through the canonical state seams", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    const liveStore = new AuthStore();

    const first = migrateLegacyState();
    const second = migrateLegacyState();

    expect(first).toEqual({ version: 1, status: "migrated", reason: "exact_match" });
    expect(second).toEqual(first);
    expect(hasLegacyStateToMigrate()).toBe(true);
    expect(liveStore.authorizationStatus("https://c2c-demo.example.com").state).toBe("missing");
    liveStore.reload();
    expect(liveStore.authorizationStatus("https://c2c-demo.example.com")).toMatchObject({
      state: "healthy",
      recoverable: true,
    });
    acknowledgeLegacyRuntimeReload();
    expect(hasLegacyStateToMigrate()).toBe(false);
    expect(readLastEndpoint("another-workspace")).toMatchObject({
      workspaceId: "global",
      publicUrl: "https://c2c-demo.example.com",
      connectorName: "Codex with ChatGPT",
    });
    expect(readTunnelState("another-workspace")).toMatchObject({
      workspaceId: "global",
      preference: "named",
      hostname: "c2c-demo.example.com",
    });
    expect(readSession("legacy-workspace")).toMatchObject({
      url: "https://chatgpt.com/c/legacy-chat",
      connectorName: "Codex with ChatGPT",
    });
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, "auth", "store.json"), "utf8"))).toMatchObject({
      version: 2,
      bridgeId: "c2c_bridge_fixture",
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(stateDir, "migrations", "legacy-global-v1.json"), "utf8")
      )
    ).toMatchObject({ version: 1, status: "completed", result: first });
    const migratedOutput = [
      path.join(stateDir, "auth", "store.json"),
      path.join(stateDir, "endpoints", "global.json"),
      path.join(stateDir, "tunnels", "global.json"),
      sessionFile("legacy-workspace"),
      path.join(stateDir, "migrations", "legacy-global-v1.json"),
    ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
    expect(migratedOutput).not.toMatch(
      /access_should_never_appear|refresh_should_never_appear|ABCD-EFGH|browser-(?:cookie|credential)-secret|\/Users\/alice/
    );
  });

  it("requires new global consent when more than one workspace has a legacy grant", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir, "workspace-one");
    exactLegacyFixture(stateDir, "workspace-two");

    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "consent_required",
      reason: "multiple_legacy_grants",
    });
    expect(fs.existsSync(path.join(stateDir, "auth", "store.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "endpoints", "global.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "tunnels", "global.json"))).toBe(false);
  });

  it("requires new global consent when the legacy identity binding is incomplete", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    const legacyAuthFile = path.join(stateDir, "auth", "legacy-workspace.json");
    const legacy = JSON.parse(fs.readFileSync(legacyAuthFile, "utf8")) as {
      version?: number;
      bridgeId?: string;
      clients: Array<{ binding?: unknown; grant?: unknown }>;
    };
    delete legacy.version;
    delete legacy.bridgeId;
    delete legacy.clients[0].binding;
    delete legacy.clients[0].grant;
    writeSecureJson(legacyAuthFile, legacy);

    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "consent_required",
      reason: "identity_incomplete",
    });
    expect(fs.existsSync(path.join(stateDir, "auth", "store.json"))).toBe(false);
  });

  it("requires new consent instead of reusing a mismatched saved session", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    writeSecureJson(sessionFile("legacy-workspace"), {
      url: "https://chatgpt.com/c/wrong-connector",
      connectorName: "Different connector",
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "consent_required",
      reason: "identity_incomplete",
    });
    expect(fs.existsSync(path.join(stateDir, "auth", "store.json"))).toBe(false);
  });

  it("requires new global consent when transport state exists without an identity", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    fs.rmSync(path.join(stateDir, "auth", "legacy-workspace.json"));

    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "consent_required",
      reason: "identity_incomplete",
    });
    expect(fs.existsSync(path.join(stateDir, "endpoints", "global.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "tunnels", "global.json"))).toBe(false);
  });

  it("keeps a reclaimed Quick endpoint as evidence without migrating its grant", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(
      stateDir,
      "quick-workspace",
      "https://old-quick.trycloudflare.com"
    );

    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "consent_required",
      reason: "quick_endpoint",
    });
    expect(readLastEndpoint("global")).toMatchObject({
      publicUrl: "https://old-quick.trycloudflare.com",
    });
    expect(readTunnelState("global")).toMatchObject({ preference: "quick" });
    expect(fs.existsSync(path.join(stateDir, "auth", "store.json"))).toBe(false);
  });

  it("keeps a revoked legacy grant invalid across retries", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    const legacyAuthFile = path.join(stateDir, "auth", "legacy-workspace.json");
    const legacy = JSON.parse(fs.readFileSync(legacyAuthFile, "utf8")) as {
      clients: Array<{ grant: { state: string } }>;
    };
    legacy.clients[0].grant.state = "revoked";
    writeSecureJson(legacyAuthFile, legacy);

    const first = migrateLegacyState();
    const second = migrateLegacyState();

    expect(first).toEqual({ version: 1, status: "consent_required", reason: "revoked" });
    expect(second).toEqual(first);
    expect(fs.existsSync(path.join(stateDir, "auth", "store.json"))).toBe(false);
  });

  it("fails closed on a partial migration and safely completes the retry", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    writeSecureJson(path.join(stateDir, "migrations", "legacy-global-v1.json"), {
      version: 1,
      status: "pending",
    });
    fs.copyFileSync(
      path.join(stateDir, "auth", "legacy-workspace.json"),
      path.join(stateDir, "auth", "store.json")
    );

    expect(new AuthStore().authorizationStatus("https://c2c-demo.example.com").state).toBe(
      "missing"
    );

    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "migrated",
      reason: "exact_match",
    });
    expect(new AuthStore().authorizationStatus("https://c2c-demo.example.com")).toMatchObject({
      state: "healthy",
      recoverable: true,
    });
  });

  it("keeps unpair available while a partial migration is pending", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    writeSecureJson(path.join(stateDir, "migrations", "legacy-global-v1.json"), {
      version: 1,
      status: "pending",
    });
    fs.copyFileSync(
      path.join(stateDir, "auth", "legacy-workspace.json"),
      path.join(stateDir, "auth", "store.json")
    );

    expect(new AuthStore().revokeAll()).toBe(0);
    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "consent_required",
      reason: "revoked",
    });
    expect(new AuthStore().authorizationStatus("https://c2c-demo.example.com").state).toBe(
      "missing"
    );
  });

  it("lets concurrent revocation win over a completed active migration", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    exactLegacyFixture(stateDir);
    expect(migrateLegacyState().status).toBe("migrated");
    writeSecureJson(legacyMigrationRevocationFile(), {
      version: 1,
      revokedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(new AuthStore().authorizationStatus("https://c2c-demo.example.com")).toMatchObject({
      state: "revoked",
      recoverable: false,
    });
    expect(migrateLegacyState()).toEqual({
      version: 1,
      status: "consent_required",
      reason: "revoked",
    });
    expect(fs.existsSync(path.join(stateDir, "auth", "store.json"))).toBe(false);
  });
});
