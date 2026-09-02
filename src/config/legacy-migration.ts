import fs from "node:fs";
import path from "node:path";
import {
  canonicalOAuthIdentity,
  clientRegistrationFingerprint,
  compareOAuthIdentity,
  type CanonicalOAuthIdentity,
  type ClientRegistration,
  type TokenRecord,
} from "../auth/store.js";
import { mergeSession, readSession, writeSession } from "../session/state.js";
import { writeTunnelState, type TunnelState } from "../tunnel/state.js";
import {
  DEFAULT_CONNECTOR_NAME,
  mcpUrlFromPublic,
  writeLastEndpoint,
  type LastEndpoint,
} from "./endpoint.js";
import {
  ensureDir,
  getStateDir,
  legacyMigrationRevocationFile,
  readJsonIfExists,
  writeSecureJson,
} from "./paths.js";

export const LEGACY_MIGRATION_VERSION = 1 as const;

export interface LegacyMigrationResult {
  version: typeof LEGACY_MIGRATION_VERSION;
  status: "migrated" | "consent_required" | "not_needed";
  reason:
    | "exact_match"
    | "multiple_legacy_grants"
    | "identity_incomplete"
    | "origin_mismatch"
    | "quick_endpoint"
    | "revoked"
    | "canonical_state_exists"
    | "no_legacy_state";
}

interface PersistedGrantFixture {
  binding: CanonicalOAuthIdentity;
  state: "active" | "revoked";
  proof: "authorization_code" | "protected_resource" | "refresh";
  accessExpiresAt: number;
  refreshExpiresAt: number | null;
}

interface LegacyAuthState {
  version: 2;
  bridgeId: string;
  clients: Array<ClientRegistration & { grant?: PersistedGrantFixture }>;
  tokens: TokenRecord[];
}

interface MigrationMarker {
  version: typeof LEGACY_MIGRATION_VERSION;
  status: "pending" | "completed";
  runtimeReloadPending?: boolean;
  result?: LegacyMigrationResult;
}

function markerFile(): string {
  return path.join(getStateDir(), "migrations", "legacy-global-v1.json");
}

function jsonFiles(dir: string, excluded: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== excluded)
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function consent(reason: LegacyMigrationResult["reason"]): LegacyMigrationResult {
  return { version: LEGACY_MIGRATION_VERSION, status: "consent_required", reason };
}

export function hasLegacyStateToMigrate(): boolean {
  const marker = readJsonIfExists<MigrationMarker>(markerFile());
  if (
    fs.existsSync(legacyMigrationRevocationFile()) &&
    (marker?.status !== "completed" || marker.runtimeReloadPending === true)
  ) {
    return true;
  }
  if (marker?.status === "completed") return marker.runtimeReloadPending === true;
  if (marker?.status === "pending") return true;
  const stateDir = getStateDir();
  return (
    jsonFiles(path.join(stateDir, "auth"), "store.json").length > 0 ||
    jsonFiles(path.join(stateDir, "endpoints"), "global.json").length > 0 ||
    jsonFiles(path.join(stateDir, "tunnels"), "global.json").length > 0
  );
}

export function acknowledgeLegacyRuntimeReload(): void {
  const marker = readJsonIfExists<MigrationMarker>(markerFile());
  if (marker?.status !== "completed" || !marker.runtimeReloadPending) return;
  writeSecureJson(markerFile(), { ...marker, runtimeReloadPending: false });
}

function exactAuth(state: LegacyAuthState, endpoint: LastEndpoint): boolean {
  try {
    if (
      state.version !== 2 ||
      typeof state.bridgeId !== "string" ||
      !Array.isArray(state.clients) ||
      state.clients.length !== 1 ||
      !Array.isArray(state.tokens)
    ) {
      return false;
    }
    const client = state.clients[0];
    const grant = client.grant;
    if (
      !grant ||
      grant.state !== "active" ||
      !["authorization_code", "protected_resource", "refresh"].includes(grant.proof) ||
      !Number.isFinite(grant.accessExpiresAt) ||
      !(
        grant.refreshExpiresAt === null || Number.isFinite(grant.refreshExpiresAt)
      ) ||
      typeof client.clientId !== "string" ||
      !Array.isArray(client.redirectUris) ||
      client.redirectUris.length === 0 ||
      !client.redirectUris.every((redirect) => {
        const url = new URL(redirect);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          (url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com"))
        );
      }) ||
      typeof client.createdAt !== "string" ||
      !Number.isFinite(Date.parse(client.createdAt)) ||
      !Array.isArray(client.grantedScopes) ||
      !client.grantedScopes.every((scope) => typeof scope === "string") ||
      typeof endpoint.publicUrl !== "string" ||
      !state.tokens.every(
        (token) =>
          typeof token.hash === "string" &&
          /^[a-f0-9]{64}$/i.test(token.hash) &&
          (token.kind === "access" || token.kind === "refresh") &&
          Number.isFinite(token.issuedAt) &&
          Number.isFinite(token.expiresAt)
      )
    ) {
      return false;
    }
    const registration = canonicalOAuthIdentity({
      baseUrl: endpoint.publicUrl,
      clientId: client.clientId,
      clientRegistration: clientRegistrationFingerprint(client),
      scopes: [],
      bridgeId: state.bridgeId,
    });
    const binding = canonicalOAuthIdentity({
      baseUrl: endpoint.publicUrl,
      clientId: client.clientId,
      clientRegistration: clientRegistrationFingerprint(client),
      scopes: client.grantedScopes ?? grant.binding.scopes,
      bridgeId: state.bridgeId,
    });
    return (
      compareOAuthIdentity(registration, client.binding) === null &&
      compareOAuthIdentity(binding, grant.binding) === null &&
      state.tokens.length > 0 &&
      state.tokens.every(
        (token) => !token.revoked && compareOAuthIdentity(binding, token.binding) === null
      )
    );
  } catch {
    return false;
  }
}

export function migrateLegacyState(): LegacyMigrationResult {
  const stateDir = getStateDir();
  const authStoreFile = path.join(stateDir, "auth", "store.json");
  const marker = readJsonIfExists<MigrationMarker>(markerFile());
  const complete = (result: LegacyMigrationResult): LegacyMigrationResult => {
    writeSecureJson(markerFile(), {
      version: LEGACY_MIGRATION_VERSION,
      status: "completed",
      runtimeReloadPending: result.status !== "not_needed",
      result,
    });
    return result;
  };
  const requireConsent = (
    reason: LegacyMigrationResult["reason"],
    discardCanonical = false
  ): LegacyMigrationResult => {
    if (marker?.status === "pending" || discardCanonical) fs.rmSync(authStoreFile, { force: true });
    return complete(consent(reason));
  };
  if (
    fs.existsSync(legacyMigrationRevocationFile()) &&
    (marker?.status !== "completed" || marker.runtimeReloadPending === true)
  ) {
    fs.rmSync(authStoreFile, { force: true });
    return complete(consent("revoked"));
  }
  if (marker?.status === "completed" && marker.result) return marker.result;
  const authFiles = jsonFiles(path.join(stateDir, "auth"), "store.json");
  const canonicalAuth = marker?.status === "pending"
    ? null
    : readJsonIfExists<LegacyAuthState>(authStoreFile);
  const legacyEndpointFiles = jsonFiles(path.join(stateDir, "endpoints"), "global.json");
  const legacyTunnelFiles = jsonFiles(path.join(stateDir, "tunnels"), "global.json");
  if (
    canonicalAuth &&
    authFiles.length === 0 &&
    legacyEndpointFiles.length === 0 &&
    legacyTunnelFiles.length === 0
  ) {
    const result: LegacyMigrationResult = {
      version: LEGACY_MIGRATION_VERSION,
      status: "not_needed",
      reason: "canonical_state_exists",
    };
    return complete(result);
  }
  if (
    !canonicalAuth &&
    authFiles.length === 0 &&
    legacyEndpointFiles.length === 0 &&
    legacyTunnelFiles.length === 0
  ) {
    const result: LegacyMigrationResult = {
      version: LEGACY_MIGRATION_VERSION,
      status: "not_needed",
      reason: "no_legacy_state",
    };
    return marker?.status === "pending" ? requireConsent("identity_incomplete") : complete(result);
  }
  if (authFiles.length > (canonicalAuth ? 0 : 1)) {
    return requireConsent("multiple_legacy_grants", Boolean(canonicalAuth));
  }
  if (
    (!canonicalAuth && authFiles.length !== 1) ||
    legacyEndpointFiles.length !== 1 ||
    legacyTunnelFiles.length !== 1
  ) {
    return requireConsent("identity_incomplete", Boolean(canonicalAuth));
  }

  const workspaceId = path.basename(canonicalAuth ? legacyEndpointFiles[0] : authFiles[0], ".json");
  const auth = canonicalAuth ?? readJsonIfExists<LegacyAuthState>(authFiles[0]);
  const endpoint = readJsonIfExists<LastEndpoint>(
    path.join(stateDir, "endpoints", `${workspaceId}.json`)
  );
  const tunnel = readJsonIfExists<TunnelState>(
    path.join(stateDir, "tunnels", `${workspaceId}.json`)
  );
  if (Array.isArray(auth?.clients) && auth.clients.some((client) => client.grant?.state === "revoked")) {
    return requireConsent("revoked", Boolean(canonicalAuth));
  }
  if (
    !auth ||
    !endpoint ||
    !tunnel ||
    typeof endpoint.workspaceId !== "string" ||
    !Number.isInteger(endpoint.port) ||
    typeof endpoint.mcpUrl !== "string" ||
    typeof tunnel.workspaceId !== "string" ||
    !exactAuth(auth, endpoint)
  ) {
    return requireConsent("identity_incomplete", Boolean(canonicalAuth));
  }
  if (
    endpoint.workspaceId === workspaceId &&
    endpoint.mcpUrl === mcpUrlFromPublic(endpoint.publicUrl) &&
    tunnel.workspaceId === workspaceId &&
    tunnel.preference === "quick"
  ) {
    writeSecureJson(markerFile(), { version: LEGACY_MIGRATION_VERSION, status: "pending" });
    writeLastEndpoint({
      workspaceId,
      port: endpoint.port,
      publicUrl: endpoint.publicUrl,
      mcpUrl: endpoint.mcpUrl,
      connectorName: endpoint.connectorName,
    });
    writeTunnelState({
      workspaceId,
      preference: "quick",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-quick",
    });
    fs.rmSync(authStoreFile, { force: true });
    return complete(consent("quick_endpoint"));
  }
  if (
    endpoint.workspaceId !== workspaceId ||
    endpoint.mcpUrl !== mcpUrlFromPublic(endpoint.publicUrl) ||
    tunnel.workspaceId !== workspaceId ||
    tunnel.preference !== "named" ||
    typeof tunnel.hostname !== "string" ||
    !/^[a-z0-9.-]+$/i.test(tunnel.hostname) ||
    typeof tunnel.tunnelName !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(tunnel.tunnelName) ||
    new URL(endpoint.publicUrl!).hostname !== tunnel.hostname.toLowerCase()
  ) {
    return requireConsent("origin_mismatch", Boolean(canonicalAuth));
  }
  const session = readSession(workspaceId);
  if (session && session.connectorName !== endpoint.connectorName) {
    return requireConsent("identity_incomplete", Boolean(canonicalAuth));
  }

  writeSecureJson(markerFile(), { version: LEGACY_MIGRATION_VERSION, status: "pending" });
  writeLastEndpoint({
    workspaceId,
    port: endpoint.port,
    publicUrl: endpoint.publicUrl,
    mcpUrl: endpoint.mcpUrl,
    connectorName: endpoint.connectorName,
  });
  writeTunnelState({
    workspaceId,
    preference: "named",
    askedAt: new Date().toISOString(),
    provider: "cloudflare-named",
    tunnelName: tunnel.tunnelName,
    hostname: tunnel.hostname,
  });
  const client = auth.clients[0];
  const binding = canonicalOAuthIdentity({
    baseUrl: endpoint.publicUrl!,
    clientId: client.clientId,
    clientRegistration: clientRegistrationFingerprint(client),
    scopes: client.grantedScopes!,
    bridgeId: auth.bridgeId,
  });
  writeSecureJson(path.join(ensureDir(path.join(stateDir, "auth")), "store.json"), {
    version: 2,
    bridgeId: auth.bridgeId,
    clients: [
      {
        clientId: client.clientId,
        redirectUris: client.redirectUris,
        createdAt: client.createdAt,
        binding: canonicalOAuthIdentity({
          baseUrl: endpoint.publicUrl!,
          clientId: client.clientId,
          clientRegistration: clientRegistrationFingerprint(client),
          scopes: [],
          bridgeId: auth.bridgeId,
        }),
        grantedScopes: client.grantedScopes,
        grant: {
          binding,
          state: client.grant!.state,
          proof: client.grant!.proof,
          accessExpiresAt: client.grant!.accessExpiresAt,
          refreshExpiresAt: client.grant!.refreshExpiresAt,
        },
      },
    ],
    tokens: auth.tokens.map(({ hash, kind, issuedAt, expiresAt, revoked }) => ({
      hash,
      kind,
      binding,
      issuedAt,
      expiresAt,
      revoked,
    })),
  });
  if (session && session.connectorName === endpoint.connectorName) {
    writeSession(workspaceId, mergeSession(session, { connectorName: DEFAULT_CONNECTOR_NAME }));
  }
  const result: LegacyMigrationResult = {
    version: LEGACY_MIGRATION_VERSION,
    status: "migrated",
    reason: "exact_match",
  };
  if (fs.existsSync(legacyMigrationRevocationFile())) {
    fs.rmSync(authStoreFile, { force: true });
    return complete(consent("revoked"));
  }
  return complete(result);
}
