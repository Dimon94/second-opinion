import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import {
  AuthStore,
  canonicalOAuthIdentity,
  compareOAuthIdentity,
  type CanonicalOAuthIdentity,
} from "../src/auth/store.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

let root: string;
let bridge: Bridge;
let base: string;

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

describe("canonical OAuth identity", () => {
  it("has a stable fingerprint independent of URL and scope ordering", () => {
    const first = canonicalOAuthIdentity({
      baseUrl: "HTTPS://Bridge.Example/",
      bridgeId: "bridge-1",
      clientId: "client-1",
      clientRegistration: "registration-1",
      scopes: ["workspace.search", "workspace.read", "workspace.read"],
    });
    const second = canonicalOAuthIdentity({
      baseUrl: "https://bridge.example",
      bridgeId: "bridge-1",
      clientId: "client-1",
      clientRegistration: "registration-1",
      scopes: ["workspace.read", "workspace.search"],
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      endpoint: "https://bridge.example",
      issuer: "https://bridge.example",
      resource: "https://bridge.example/mcp",
      audience: "https://bridge.example/mcp",
      clientId: "client-1",
      clientRegistration: "registration-1",
      scopes: ["workspace.read", "workspace.search"],
      bridgeId: "bridge-1",
    });
    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    ["endpoint", "endpoint_mismatch"],
    ["resource", "resource_mismatch"],
    ["issuer", "issuer_mismatch"],
    ["audience", "audience_mismatch"],
    ["clientId", "client_mismatch"],
    ["clientRegistration", "client_mismatch"],
    ["scopes", "scope_mismatch"],
    ["bridgeId", "bridge_mismatch"],
    ["fingerprint", "fingerprint_mismatch"],
  ] as const)("reports an exact %s mismatch", (field, reason) => {
    const expected = canonicalOAuthIdentity({
      baseUrl: "https://bridge.example",
      bridgeId: "bridge-1",
      clientId: "client-1",
      clientRegistration: "registration-1",
      scopes: ["workspace.read"],
    });
    const actual: CanonicalOAuthIdentity = {
      ...expected,
      [field]: field === "scopes" ? ["workspace.search"] : `${String(expected[field])}-changed`,
    };

    expect(compareOAuthIdentity(expected, actual)).toBe(reason);

    const dir = makeTmpDir(`oauth-${field}-mismatch`);
    try {
      const store = new AuthStore({ file: path.join(dir, "store.json") });
      const tokens = store.issueTokens({ identity: actual });
      expect(store.verifyAccessToken(tokens.accessToken, expected)).toEqual({ ok: false, reason });
    } finally {
      cleanup(dir);
    }
  });

  it("persists only token hashes and binding metadata in an owner-only file", () => {
    const dir = makeTmpDir("oauth-identity-store");
    const file = path.join(dir, "store.json");
    try {
      const store = new AuthStore({ file });
      const client = store.registerClient({
        baseUrl: "https://bridge.example",
        redirectUris: [REDIRECT_URI],
      });
      const identity = store.identityForClient(
        "https://bridge.example",
        client.clientId,
        ["workspace.read", "offline_access"]
      )!;
      const tokens = store.issueTokens({ identity });
      const persisted = fs
        .readdirSync(dir, { recursive: true, encoding: "utf8" })
        .map((relative) => path.join(dir, relative))
        .filter((entry) => fs.statSync(entry).isFile())
        .map((entry) => fs.readFileSync(entry, "utf8"))
        .join("\n");

      expect(persisted).not.toContain(tokens.accessToken);
      expect(persisted).not.toContain(tokens.refreshToken!);
      expect(persisted).toContain(identity.fingerprint);
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);

      const previousShape = JSON.parse(fs.readFileSync(file, "utf8")) as {
        clients: Array<{ grant?: unknown }>;
      };
      delete previousShape.clients[0].grant;
      fs.writeFileSync(file, JSON.stringify(previousShape));
      const beforeStatus = fs.readFileSync(file, "utf8");
      const reloaded = new AuthStore({ file });
      expect(reloaded.bridgeId).toBe(store.bridgeId);
      expect(reloaded.authorizationStatus("https://bridge.example")).toMatchObject({
        state: "unverified",
        proof: "authorization_code",
        recoverable: true,
      });
      expect(fs.readFileSync(file, "utf8")).toBe(beforeStatus);
      expect(reloaded.verifyAccessToken(tokens.accessToken, identity)).toMatchObject({ ok: true });
      expect(reloaded.authorizationStatus("https://bridge.example")).toMatchObject({
        state: "healthy",
        proof: "protected_resource",
      });
      const refreshed = reloaded.refresh(tokens.refreshToken!, {
        baseUrl: "https://bridge.example",
        clientId: client.clientId,
      });
      expect(refreshed.ok).toBe(true);
      expect(reloaded.authorizationStatus("https://bridge.example")).toMatchObject({
        state: "healthy",
        proof: "refresh",
      });
      expect(
        reloaded.refresh(tokens.refreshToken!, {
          baseUrl: "https://bridge.example",
          clientId: client.clientId,
        })
      ).toEqual({ ok: false, reason: "invalid_grant" });
    } finally {
      cleanup(dir);
    }
  });
});

describe("persisted grant lifecycle", () => {
  it("distinguishes access expiry from refresh expiry and records a real refresh", () => {
    const dir = makeTmpDir("oauth-grant-expiry");
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const store = new AuthStore({ file: path.join(dir, "store.json") });
      const client = store.registerClient({
        baseUrl: "https://bridge.example",
        redirectUris: [REDIRECT_URI],
      });
      const issued = store.issueTokens({
        identity: store.identityForClient(
          "https://bridge.example",
          client.clientId,
          ["workspace.read", "offline_access"]
        )!,
        accessTtlMs: 60_000,
      });

      vi.setSystemTime(new Date(now.getTime() + 60_001));
      expect(store.authorizationStatus("https://bridge.example")).toMatchObject({
        state: "expired",
        recoverable: true,
        proof: "authorization_code",
      });
      const refreshed = store.refresh(issued.refreshToken!, {
        baseUrl: "https://bridge.example",
        clientId: client.clientId,
      });
      expect(refreshed.ok).toBe(true);
      expect(store.authorizationStatus("https://bridge.example")).toMatchObject({
        state: "healthy",
        recoverable: true,
        proof: "refresh",
      });
      expect(
        store.refresh(issued.refreshToken!, {
          baseUrl: "https://bridge.example",
          clientId: client.clientId,
        })
      ).toEqual({ ok: false, reason: "invalid_grant" });

      vi.setSystemTime(new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000));
      expect(store.authorizationStatus("https://bridge.example")).toMatchObject({
        state: "expired",
        recoverable: false,
      });
    } finally {
      vi.useRealTimers();
      cleanup(dir);
    }
  });

  it.each(["revoked", "expired"] as const)(
    "retains %s evidence from the previous persisted store shape",
    (terminal) => {
      const dir = makeTmpDir(`oauth-previous-${terminal}`);
      const file = path.join(dir, "store.json");
      try {
        const store = new AuthStore({ file });
        const client = store.registerClient({
          baseUrl: "https://bridge.example",
          redirectUris: [REDIRECT_URI],
        });
        store.issueTokens({
          identity: store.identityForClient(
            "https://bridge.example",
            client.clientId,
            ["workspace.read", "offline_access"]
          )!,
        });
        const previousShape = JSON.parse(fs.readFileSync(file, "utf8")) as {
          clients: Array<{ grant?: unknown }>;
          tokens: Array<{ expiresAt: number }>;
        };
        delete previousShape.clients[0].grant;
        if (terminal === "expired") {
          for (const token of previousShape.tokens) token.expiresAt = 0;
        }
        fs.writeFileSync(file, JSON.stringify(previousShape));

        const reloaded = new AuthStore({ file });
        if (terminal === "revoked") reloaded.revokeAll();
        expect(new AuthStore({ file }).authorizationStatus("https://bridge.example")).toMatchObject({
          state: terminal,
          recoverable: false,
        });
      } finally {
        cleanup(dir);
      }
    }
  );
});

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-ws");
  write(root, "hello.txt", "hello oauth\n");
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  base = bridge.localBaseUrl();
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

function issueBridgeTokens(
  clientName: string,
  scopes: string[],
  identityBase = base,
  accessTtlMs?: number
) {
  const client = bridge.authStore.registerClient({
    clientName,
    redirectUris: [REDIRECT_URI],
    baseUrl: base,
  });
  const current = bridge.authStore.identityForClient(base, client.clientId, scopes)!;
  const identity = canonicalOAuthIdentity({
    baseUrl: identityBase,
    bridgeId: current.bridgeId,
    clientId: current.clientId,
    clientRegistration: current.clientRegistration,
    scopes: current.scopes,
  });
  return { ...bridge.authStore.issueTokens({ identity, accessTtlMs }), client };
}

async function authorizeWithPairing(
  clientId: string,
  challenge: string,
  pairingCode: string,
  state = "st-123",
  overrides: { resource?: string; scope?: string; workspace?: string } = {}
): Promise<{ code: string | null; location: string | null; page?: string; status?: number }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set(
    "scope",
    overrides.scope ?? "workspace.read workspace.search git.read execution.read offline_access"
  );
  authorizeUrl.searchParams.set("resource", overrides.resource ?? `${base}/mcp`);
  if (overrides.workspace) authorizeUrl.searchParams.set("workspace", overrides.workspace);

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) {
    return {
      code: null,
      location: pageResponse.headers.get("location"),
      page: html,
      status: pageResponse.status,
    };
  }

  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) {
    return { code: null, location: null, page: await postResponse.text(), status: postResponse.status };
  }
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, status: postResponse.status };
}

async function exchangeToken(
  clientId: string,
  code: string,
  verifier: string,
  resource = `${base}/mcp`
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

describe("discovery metadata", () => {
  it("serves protected resource metadata", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resource: string;
      authorization_servers: string[];
      resource_name: string;
    };
    expect(body.resource).toBe(`${base}/mcp`);
    expect(body.authorization_servers).toEqual([base]);
    expect(body.resource_name).toBe("Second Opinion");
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp/session`)).status).toBe(200);
  });

  it("serves authorization server metadata with PKCE S256", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(base);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
  });
});

describe("authorization + token flow", () => {
  it("completes the full pairing + PKCE flow and calls MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code, location } = await authorizeWithPairing(clientId, challenge, pairing.code);
    expect(code).toBeTruthy();
    expect(location).toContain("state=st-123");

    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^c2c_at_/);
    expect(token.body.refresh_token).toMatch(/^c2c_rt_/);
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body.expires_in).toBe(3600);

    // authorized MCP request
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("describes the grant as covering only workspaces authorized by local Codex", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, pairing.code);

    expect(result.status).toBe(302);
    const pageRequest = new URL(`${base}/oauth/authorize`);
    pageRequest.searchParams.set("client_id", clientId);
    pageRequest.searchParams.set("redirect_uri", REDIRECT_URI);
    pageRequest.searchParams.set("response_type", "code");
    pageRequest.searchParams.set("code_challenge", challenge);
    pageRequest.searchParams.set("code_challenge_method", "S256");
    pageRequest.searchParams.set("resource", `${base}/mcp`);
    const page = await (await fetch(pageRequest)).text();
    expect(page).toContain("<h1>Second Opinion</h1>");
    expect(page).toContain("workspaces authorized by local Codex on this computer");
    expect(page).toContain("Authorization started from:");
    expect(page).not.toContain("requesting access to workspace");
  });

  it("rejects a wrong pairing code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA");
    expect(result.code).toBeNull();
    expect(result.status).toBe(401);
    expect(result.page).toContain("Incorrect pairing code");
  });

  it("escapes the workspace name in the pairing page", async () => {
    const xssWorkspaceRoot = makeTmpDir("oauth-html");
    write(xssWorkspaceRoot, ".c2c.json", JSON.stringify({ name: "<script>alert('xss')</script>" }));
    const xssBridge = await startBridge({
      workspaceRoot: xssWorkspaceRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-html"), "store.json"),
    });

    try {
      const xssBase = xssBridge.localBaseUrl();
      const registration = await fetch(`${xssBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTML-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${xssBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("resource", `${xssBase}/mcp`);

      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await xssBridge.close();
      cleanup(xssWorkspaceRoot);
    }
  });

  it("sets browser security headers on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", `${base}/mcp`);

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects PKCE verifier mismatch", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const token = await exchangeToken(clientId, code!, "wrong-verifier-wrong-verifier-wrong");
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("rejects a token exchange for a different resource", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);

    const token = await exchangeToken(clientId, code!, verifier, "https://other.example/mcp");
    expect(token.status).toBe(400);
    expect(token.body.error_description).toBe("resource_mismatch");
  });

  it("authorization codes are one-time", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const first = await exchangeToken(clientId, code!, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeToken(clientId, code!, verifier);
    expect(second.status).toBe(400);
  });

  it("requires PKCE at the authorization endpoint", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects wrong resources, scope expansion, and remote workspace selection", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();

    const wrongResource = await authorizeWithPairing(clientId, challenge, "unused", "state", {
      resource: "https://other.example/mcp",
    });
    expect(wrongResource.location).toContain("error_description=resource_mismatch");

    const expandedScope = await authorizeWithPairing(clientId, challenge, "unused", "state", {
      scope: "workspace.read workspace.write",
    });
    expect(expandedScope.location).toContain("error_description=scope_mismatch");

    const workspace = await authorizeWithPairing(clientId, challenge, "unused", "state", {
      workspace: "/tmp/remote-choice",
    });
    expect(workspace.location).toContain("error_description=remote_workspace_selection_denied");
    expect(bridge.workspace.root).toBe(root);
  });

  it("rejects a client registration reused at another endpoint origin", async () => {
    const dir = makeTmpDir("oauth-client-binding");
    try {
      const store = new AuthStore({ file: path.join(dir, "store.json") });
      const client = store.registerClient({
        redirectUris: [REDIRECT_URI],
        baseUrl: "https://first.example",
      });
      const current = store.identityForClient("https://second.example", client.clientId, [])!;
      expect(compareOAuthIdentity(current, client.binding)).toBe("endpoint_mismatch");
    } finally {
      cleanup(dir);
    }
  });

  it("rejects registration with non-https redirect uris", async () => {
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("token enforcement on /mcp", () => {
  const mcpCall = (token?: string): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("401 without a token, with resource metadata pointer", async () => {
    const response = await mcpCall();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource="${base}/mcp"`);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
    );
  });

  it("401 with an invalid token", async () => {
    const response = await mcpCall("c2c_at_totally-invalid");
    expect(response.status).toBe(401);
  });

  it("401 with an expired token", async () => {
    const expired = issueBridgeTokens("expired-test", ["workspace.read"], base, -1000);
    const response = await mcpCall(expired.accessToken);
    expect(response.status).toBe(401);
  });

  it("401 with a token bound to another endpoint", async () => {
    const foreign = issueBridgeTokens("foreign-test", ["workspace.read"], "https://other.example");
    const response = await mcpCall(foreign.accessToken);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("endpoint_mismatch");
  });

  it("401 when the current client registration no longer exactly matches", async () => {
    const issued = issueBridgeTokens("registration-drift", ["workspace.read"]);
    issued.client.redirectUris.push("https://chatgpt.com/oauth/changed");

    const response = await mcpCall(issued.accessToken);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("client_mismatch");
  });

  it("401 for an old token after the client's exact granted scope set changes", async () => {
    const client = bridge.authStore.registerClient({
      clientName: "scope-drift",
      redirectUris: [REDIRECT_URI],
      baseUrl: base,
    });
    const oldTokens = bridge.authStore.issueTokens({
      identity: bridge.authStore.identityForClient(base, client.clientId, ["workspace.read"])!,
    });
    bridge.authStore.issueTokens({
      identity: bridge.authStore.identityForClient(base, client.clientId, ["workspace.search"])!,
    });

    const response = await mcpCall(oldTokens.accessToken);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("scope_mismatch");
  });

  it("401 after revocation", async () => {
    const tokens = issueBridgeTokens("revocation-test", ["workspace.read"]);
    expect((await mcpCall(tokens.accessToken)).status).toBe(200);
    bridge.authStore.revokeToken(tokens.accessToken);
    expect((await mcpCall(tokens.accessToken)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("rotates refresh tokens and invalidates the old one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, string> }> => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          resource: `${base}/mcp`,
        }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const rotated = await refresh(initial.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(initial.body.refresh_token);

    const replayed = await refresh(initial.body.refresh_token);
    expect(replayed.status).toBe(400);
  });

  it("rejects refresh requests that change the exact scope set", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const response = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.body.refresh_token,
        client_id: clientId,
        resource: `${base}/mcp`,
        scope: "workspace.read",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_description: "scope_mismatch" });
  });

  it("revokes the whole persisted grant through the RFC revocation endpoint", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const revoked = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: initial.body.refresh_token }),
    });
    expect(revoked.status).toBe(200);
    expect((await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${initial.body.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })).status).toBe(401);
    const refresh = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.body.refresh_token,
        client_id: clientId,
        resource: `${base}/mcp`,
      }),
    });
    expect(refresh.status).toBe(400);
  });

  it("rejects an old broad refresh token after the current grant is narrowed", () => {
    const dir = makeTmpDir("oauth-refresh-scope-drift");
    try {
      const store = new AuthStore({ file: path.join(dir, "store.json") });
      const client = store.registerClient({
        baseUrl: "https://bridge.example",
        redirectUris: [REDIRECT_URI],
      });
      const broad = ["workspace.read", "workspace.search", "offline_access"];
      const old = store.issueTokens({
        identity: store.identityForClient("https://bridge.example", client.clientId, broad)!,
      });
      store.issueTokens({
        identity: store.identityForClient(
          "https://bridge.example",
          client.clientId,
          ["workspace.read", "offline_access"]
        )!,
      });

      expect(
        store.refresh(old.refreshToken!, {
          baseUrl: "https://bridge.example",
          clientId: client.clientId,
          scopes: broad,
        })
      ).toEqual({ ok: false, reason: "scope_mismatch" });
    } finally {
      cleanup(dir);
    }
  });
});
