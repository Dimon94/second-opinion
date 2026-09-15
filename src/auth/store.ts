import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ensureDir,
  getStateDir,
  legacyMigrationRevocationFile,
  readJsonIfExists,
  writeSecureJson,
} from "../config/paths.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export interface CanonicalOAuthIdentity {
  endpoint: string;
  issuer: string;
  resource: string;
  audience: string;
  clientId: string;
  clientRegistration: string;
  scopes: string[];
  bridgeId: string;
  fingerprint: string;
}

export type OAuthIdentityMismatchReason =
  | "endpoint_mismatch"
  | "resource_mismatch"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "client_mismatch"
  | "scope_mismatch"
  | "bridge_mismatch"
  | "fingerprint_mismatch";

export function canonicalOAuthIdentity(input: {
  baseUrl: string;
  clientId: string;
  clientRegistration: string;
  scopes: string[];
  bridgeId: string;
}): CanonicalOAuthIdentity {
  const url = new URL(input.baseUrl);
  const endpoint = url.origin.toLowerCase();
  const scopes = [...new Set(input.scopes)].sort();
  const values = {
    endpoint,
    issuer: endpoint,
    resource: `${endpoint}/mcp`,
    audience: `${endpoint}/mcp`,
    clientId: input.clientId,
    clientRegistration: input.clientRegistration,
    scopes,
    bridgeId: input.bridgeId,
  };
  return {
    ...values,
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`,
  };
}

export function compareOAuthIdentity(
  expected: CanonicalOAuthIdentity,
  actual: CanonicalOAuthIdentity
): OAuthIdentityMismatchReason | null {
  if (expected.endpoint !== actual.endpoint) return "endpoint_mismatch";
  if (expected.resource !== actual.resource) return "resource_mismatch";
  if (expected.issuer !== actual.issuer) return "issuer_mismatch";
  if (expected.audience !== actual.audience) return "audience_mismatch";
  if (
    expected.clientId !== actual.clientId ||
    expected.clientRegistration !== actual.clientRegistration
  ) {
    return "client_mismatch";
  }
  if (expected.scopes.join(" ") !== actual.scopes.join(" ")) return "scope_mismatch";
  if (expected.bridgeId !== actual.bridgeId) return "bridge_mismatch";
  if (expected.fingerprint !== actual.fingerprint) return "fingerprint_mismatch";
  return null;
}

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
  binding: CanonicalOAuthIdentity;
  grantedScopes?: string[];
  grant?: PersistedGrant;
}

export type AuthorizationProof = "authorization_code" | "protected_resource" | "refresh";

export type AuthorizationStatus =
  | {
      state: "healthy" | "expired" | "unverified";
      clientId: string;
      proof: AuthorizationProof;
      recoverable: boolean;
    }
  | {
      state: "revoked" | "invalid_client" | "identity_mismatch";
      clientId: string | null;
      proof: AuthorizationProof | null;
      recoverable: false;
      reason?: OAuthIdentityMismatchReason;
    }
  | {
      state: "missing";
      clientId: null;
      proof: null;
      recoverable: false;
    };

interface PersistedGrant {
  binding: CanonicalOAuthIdentity;
  state: "active" | "revoked";
  proof: AuthorizationProof;
  accessExpiresAt: number;
  refreshExpiresAt: number | null;
}

export function clientRegistrationFingerprint(
  client: Pick<ClientRegistration, "clientId" | "redirectUris">
): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ clientId: client.clientId, redirectUris: [...client.redirectUris].sort() }))
    .digest("hex")}`;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  pairingSessionId: string;
  binding: CanonicalOAuthIdentity;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  binding: CanonicalOAuthIdentity;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface PersistedAuthState {
  version: 2;
  bridgeId: string;
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | {
      ok: false;
      reason: "unknown" | "expired" | "revoked" | "wrong_kind" | OAuthIdentityMismatchReason;
    };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;
  private readonly onRevoke?: () => void;
  private migrationPending = false;
  bridgeId = `c2c_bridge_${randomBytes(16).toString("base64url")}`;

  constructor(opts: { file?: string; onRevoke?: () => void } = {}) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), "store.json");
    this.onRevoke = opts.onRevoke;
    this.load();
  }

  reload(): void {
    this.clients.clear();
    this.tokens.clear();
    this.authCodes.clear();
    this.migrationPending = false;
    this.bridgeId = `c2c_bridge_${randomBytes(16).toString("base64url")}`;
    this.load();
  }

  private load(): void {
    const migration = readJsonIfExists<{ version: number; status: string }>(
      path.join(getStateDir(), "migrations", "legacy-global-v1.json")
    );
    if (migration?.version === 1 && migration.status === "pending") {
      this.migrationPending = true;
      return;
    }
    const data = readJsonIfExists<PersistedAuthState>(this.file);
    if (!data || data.version !== 2 || typeof data.bridgeId !== "string") return;
    const migrationRevoked = fs.existsSync(legacyMigrationRevocationFile());
    this.bridgeId = data.bridgeId;
    for (const client of data.clients ?? []) {
      if (migrationRevoked && client.grant) {
        client.grant = { ...client.grant, state: "revoked" };
      }
      this.clients.set(client.clientId, client);
    }
    for (const token of data.tokens ?? []) {
      if (!migrationRevoked && !token.revoked) this.tokens.set(token.hash, token);
    }
  }

  private save(): void {
    if (this.migrationPending) throw new Error("legacy state migration is incomplete");
    const now = Date.now();
    const state: PersistedAuthState = {
      version: 2,
      bridgeId: this.bridgeId,
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
  }

  private grantFor(client: ClientRegistration): PersistedGrant | null {
    if (client.grant) return client.grant;
    const records = [...this.tokens.values()].filter(
      (token) => token.binding.clientId === client.clientId
    );
    if (records.length === 0) return null;
    const binding = records[0].binding;
    return {
      binding,
      state: "active",
      proof: "authorization_code",
      accessExpiresAt: Math.max(
        0,
        ...records.filter((token) => token.kind === "access").map((token) => token.expiresAt)
      ),
      refreshExpiresAt:
        Math.max(
          0,
          ...records.filter((token) => token.kind === "refresh").map((token) => token.expiresAt)
        ) || null,
    };
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[]; baseUrl: string }): ClientRegistration {
    const clientId = `c2c_client_${randomBytes(12).toString("base64url")}`;
    const client: ClientRegistration = {
      clientId,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
      binding: canonicalOAuthIdentity({
        baseUrl: input.baseUrl,
        bridgeId: this.bridgeId,
        clientId,
        clientRegistration: clientRegistrationFingerprint({ clientId, redirectUris: input.redirectUris }),
        scopes: [],
      }),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  identityForClient(
    baseUrl: string,
    clientId: string,
    scopes: string[]
  ): CanonicalOAuthIdentity | null {
    const client = this.clients.get(clientId);
    if (!client) return null;
    return canonicalOAuthIdentity({
      baseUrl,
      bridgeId: this.bridgeId,
      clientId,
      clientRegistration: clientRegistrationFingerprint(client),
      scopes,
    });
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    binding: CanonicalOAuthIdentity;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      pairingSessionId: input.pairingSessionId,
      binding: input.binding,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    identity: CanonicalOAuthIdentity;
    accessTtlMs?: number;
    proof?: AuthorizationProof;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;
    const client = this.clients.get(input.identity.clientId);
    const currentClient =
      client && clientRegistrationFingerprint(client) === input.identity.clientRegistration
        ? client
        : null;
    if (currentClient) currentClient.grantedScopes = [...input.identity.scopes];

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      binding: input.identity,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.identity.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        binding: input.identity,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    if (currentClient) {
      currentClient.grant = {
        binding: input.identity,
        state: "active",
        proof: input.proof ?? "authorization_code",
        accessExpiresAt: now + accessTtl,
        refreshExpiresAt: refreshToken ? now + REFRESH_TOKEN_TTL_MS : null,
      };
    }
    this.save();
    fs.rmSync(legacyMigrationRevocationFile(), { force: true });
    writeSecureJson(path.join(getStateDir(), "migrations", "legacy-global-v1.json"), {
      version: 1,
      status: "completed",
      runtimeReloadPending: false,
      result: { version: 1, status: "not_needed", reason: "canonical_state_exists" },
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.identity.scopes,
    };
  }

  verifyAccessToken(token: string, expected: CanonicalOAuthIdentity | string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    const expectedIdentity =
      typeof expected === "string"
        ? this.identityForClient(
            expected,
            record.binding.clientId,
            this.clients.get(record.binding.clientId)?.grantedScopes ?? record.binding.scopes
          )
        : expected;
    if (!expectedIdentity) return { ok: false, reason: "client_mismatch" };
    const mismatch = compareOAuthIdentity(expectedIdentity, record.binding);
    if (mismatch) return { ok: false, reason: mismatch };
    const client = this.clients.get(record.binding.clientId);
    const grant = client ? this.grantFor(client) : null;
    if (client && grant && grant.proof !== "protected_resource") {
      client.grant = { ...grant, proof: "protected_resource" };
      this.save();
    }
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    expected: { baseUrl: string; clientId: string; scopes?: string[] }
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    const currentScopes =
      this.clients.get(expected.clientId)?.grantedScopes ?? record.binding.scopes;
    const requestedScopes = expected.scopes
      ? [...new Set(expected.scopes)].sort()
      : currentScopes;
    if (requestedScopes.join(" ") !== currentScopes.join(" ")) {
      return { ok: false, reason: "scope_mismatch" };
    }
    const expectedIdentity = this.identityForClient(
      expected.baseUrl,
      expected.clientId,
      currentScopes
    );
    if (!expectedIdentity) return { ok: false, reason: "client_mismatch" };
    const mismatch = compareOAuthIdentity(expectedIdentity, record.binding);
    if (mismatch) return { ok: false, reason: mismatch };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      identity: record.binding,
      proof: "refresh",
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    if (this.migrationPending) {
      this.revokeAll();
      return true;
    }
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    writeSecureJson(legacyMigrationRevocationFile(), {
      version: 1,
      revokedAt: new Date().toISOString(),
    });
    const clientId = record.binding.clientId;
    const client = this.clients.get(clientId);
    const grant = client ? this.grantFor(client) : null;
    for (const [hash, candidate] of this.tokens) {
      if (candidate.binding.clientId === clientId) this.tokens.delete(hash);
    }
    if (client && grant) {
      client.grant = { ...grant, state: "revoked" };
    }
    this.save();
    this.onRevoke?.();
    return true;
  }

  /** Used by `c2c unpair`: revoke the machine-global Connector grant. */
  revokeAll(): number {
    writeSecureJson(legacyMigrationRevocationFile(), {
      version: 1,
      revokedAt: new Date().toISOString(),
    });
    const count = this.tokens.size;
    const grants = [...this.clients.values()].map(
      (client) => [client, this.grantFor(client)] as const
    );
    this.tokens.clear();
    this.authCodes.clear();
    for (const [client, grant] of grants) {
      if (grant) client.grant = { ...grant, state: "revoked" };
    }
    if (this.migrationPending) {
      this.migrationPending = false;
      this.save();
      writeSecureJson(path.join(getStateDir(), "migrations", "legacy-global-v1.json"), {
        version: 1,
        status: "completed",
        runtimeReloadPending: false,
        result: { version: 1, status: "consent_required", reason: "revoked" },
      });
      this.onRevoke?.();
      return count;
    }
    this.save();
    this.onRevoke?.();
    return count;
  }

  authorizationStatus(baseUrl: string): AuthorizationStatus {
    const clients = [...this.clients.values()]
      .filter((client) => this.grantFor(client))
      .reverse();
    const client = clients[0];
    const grant = client ? this.grantFor(client) : null;
    if (!client || !grant) {
      return this.tokens.size > 0
        ? {
            state: "invalid_client",
            clientId: null,
            proof: null,
            recoverable: false,
          }
        : {
            state: "missing",
            clientId: null,
            proof: null,
            recoverable: false,
          };
    }
    if (grant.state === "revoked") {
      return {
        state: "revoked",
        clientId: client.clientId,
        proof: grant.proof,
        recoverable: false,
      };
    }
    const expected = this.identityForClient(
      baseUrl,
      client.clientId,
      client.grantedScopes ?? grant.binding.scopes
    );
    if (!expected) {
      return {
        state: "invalid_client",
        clientId: client.clientId,
        proof: grant.proof,
        recoverable: false,
      };
    }
    const mismatch = compareOAuthIdentity(expected, grant.binding);
    if (mismatch) {
      return {
        state: mismatch === "client_mismatch" ? "invalid_client" : "identity_mismatch",
        clientId: client.clientId,
        proof: grant.proof,
        recoverable: false,
        reason: mismatch,
      };
    }
    const now = Date.now();
    if (grant.refreshExpiresAt !== null && grant.refreshExpiresAt <= now) {
      return {
        state: "expired",
        clientId: client.clientId,
        proof: grant.proof,
        recoverable: false,
      };
    }
    if (grant.accessExpiresAt > now) {
      return {
        state: grant.proof === "authorization_code" ? "unverified" : "healthy",
        clientId: client.clientId,
        proof: grant.proof,
        recoverable: true,
      };
    }
    return {
      state: "expired",
      clientId: client.clientId,
      proof: grant.proof,
      recoverable: grant.refreshExpiresAt !== null && grant.refreshExpiresAt > now,
    };
  }

  tokenCount(): number {
    return this.tokens.size;
  }

}

export function filterScopes(requested: string | undefined): string[] | null {
  if (!requested || requested.trim() === "") return [...SUPPORTED_SCOPES];
  const asked = [...new Set(requested.split(/[\s+]+/).filter(Boolean))];
  if (asked.some((scope) => !(SUPPORTED_SCOPES as readonly string[]).includes(scope))) return null;
  return asked.sort();
}
