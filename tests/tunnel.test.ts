import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { findBinary } from "../src/tunnel/detect.js";
import {
  CloudflaredQuickTunnel,
  parseQuickTunnelUrl,
  type CloudflaredQuickTunnelOptions,
} from "../src/tunnel/cloudflared.js";
import {
  CloudflaredNamedTunnel,
  normalizeNamedTunnelHostname,
} from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  isBenignRouteError,
  parseCloudflareLoginUrl,
  parseCreatedTunnel,
  parseTunnelList,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import { resolveTunnelProtocol, tunnelProtocolArgs } from "../src/tunnel/protocol.js";
import { isNamedTunnelReady, needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
const previousCloudflaredPath = process.env.C2C_CLOUDFLARED_PATH;
const previousOriginCert = process.env.TUNNEL_ORIGIN_CERT;
const QUICK_URL = "https://random-words-here-1234.trycloudflare.com";
type FetchImpl = NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function setupTunnel(fetchImpl: FetchImpl, startTimeoutMs = 1_000) {
  const child = new FakeCloudflaredProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
    spawnImpl,
    fetchImpl,
    startTimeoutMs,
  });
  return { child, spawnImpl, tunnel };
}

function announceUrl(child: FakeCloudflaredProcess): void {
  child.stderr.write(`INF ${QUICK_URL}\n`);
}

function healthResponse(): Response {
  return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (previousCloudflaredPath === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
  else process.env.C2C_CLOUDFLARED_PATH = previousCloudflaredPath;
  if (previousOriginCert === undefined) delete process.env.TUNNEL_ORIGIN_CERT;
  else process.env.TUNNEL_ORIGIN_CERT = previousOriginCert;
});

describe("findBinary", () => {
  it("uses C2C_CLOUDFLARED_PATH for an accessible cloudflared executable", () => {
    const dir = makeTmpDir("cloudflared-path");
    stateDirs.push(dir);
    const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const configured = write(dir, filename, "placeholder");
    if (process.platform !== "win32") fs.chmodSync(configured, 0o755);
    process.env.C2C_CLOUDFLARED_PATH = configured;
    expect(findBinary("cloudflared")).toBe(configured);
  });
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe(QUICK_URL);
  });

  it("ignores unrelated lines and non-Quick-Tunnel hosts", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("rejects Cloudflare's API host", () => {
    expect(parseQuickTunnelUrl("INF https://api.trycloudflare.com")).toBeNull();
  });
});

describe("CloudflaredQuickTunnel", () => {
  it("resolves only after the public health endpoint identifies the bridge", async () => {
    const fetchImpl = vi.fn(async () => healthResponse());
    const { child, spawnImpl, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${QUICK_URL}/health`, {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });

  it("passes the configured protocol to cloudflared", async () => {
    vi.stubEnv("C2C_TUNNEL_PROTOCOL", "http2");
    const { child, spawnImpl, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate", "--protocol", "http2"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    await tunnel.stop();
  });

  it("keeps consuming cloudflared errors after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);

    child.stderr.write("ERR runtime connection error\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status().detail).toBe("ERR runtime connection error");
    await tunnel.stop();
  });

  it("does not accept an HTTP 200 response from another service", async () => {
    const { child, tunnel } = setupTunnel(
      async () =>
        new Response(JSON.stringify({ service: "cloudflare", status: "ok" }), { status: 200 }),
      20
    );
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not spawn twice or resolve a stopped pending start", async () => {
    const { child, spawnImpl, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(starting).rejects.toThrow(/stopped/i);
    await expect(concurrent).rejects.toThrow(/stopped/i);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not resolve if cloudflared exits while the health probe is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const { child, tunnel } = setupTunnel(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    child.exitCode = 1;
    child.emit("exit", 1, null);
    resolveFetch(healthResponse());
    await expect(starting).rejects.toThrow(/exited/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("rejects when spawning reports an asynchronous error", async () => {
    const { child, tunnel } = setupTunnel(async () => new Response(null));
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn cloudflared ENOENT"));

    await expect(starting).rejects.toThrow(/ENOENT/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("retries a non-ready health response before resolving", async () => {
    let calls = 0;
    const cancelBody = vi.fn(async () => undefined);
    const { child, tunnel } = setupTunnel(async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false, status: 503, body: { cancel: cancelBody } } as unknown as Response)
        : healthResponse();
    });
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(calls).toBe(2);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    await tunnel.stop();
  });
});

describe("CloudflaredQuickTunnel restart", () => {
  it("keeps the replacement tunnel state when the old process exits late", async () => {
    const first = new FakeCloudflaredProcess();
    const second = new FakeCloudflaredProcess();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
      spawnImpl,
      fetchImpl: async () => healthResponse(),
      startTimeoutMs: 1_000,
    });

    const initial = tunnel.start(3333);
    announceUrl(first);
    await expect(initial).resolves.toBe(QUICK_URL);

    const restarted = tunnel.restart(3333);
    announceUrl(second);
    await expect(restarted).resolves.toBe(QUICK_URL);
    first.emit("exit", 0, null);

    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });
});

describe("tunnel transport protocol", () => {
  it("keeps the default when unset and validates configured values", () => {
    expect(resolveTunnelProtocol({})).toBeNull();
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "  " })).toBeNull();
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "HTTP2" })).toBe("http2");
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: " quic " })).toBe("quic");
    expect(resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "auto" })).toBe("auto");
    expect(tunnelProtocolArgs(null)).toEqual([]);
    expect(tunnelProtocolArgs("http2")).toEqual(["--protocol", "http2"]);
    expect(() => resolveTunnelProtocol({ C2C_TUNNEL_PROTOCOL: "tcp" })).toThrow(
      /C2C_TUNNEL_PROTOCOL must be one of auto, quic, http2/
    );
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("CloudflaredNamedTunnel", () => {
  it.runIf(process.platform !== "win32")(
    "passes the configured protocol without changing the named hostname",
    async () => {
      vi.stubEnv("C2C_TUNNEL_PROTOCOL", "quic");
      const dir = makeTmpDir("named-tunnel-protocol");
      stateDirs.push(dir);
      const argsFile = path.join(dir, "args.json");
      const binary = write(
        dir,
        "cloudflared-fixture",
        `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stderr.write("INF Registered tunnel connection\\n");\nsetInterval(() => {}, 1000);\n`
      );
      fs.chmodSync(binary, 0o700);
      const tunnel = new CloudflaredNamedTunnel({
        tunnelName: "c2c-workspace",
        hostname: "c2c-demo.example.com",
        binaryOverride: binary,
        startTimeoutMs: 2000,
      });

      expect(await tunnel.start(48765)).toBe("https://c2c-demo.example.com");
      expect(JSON.parse(fs.readFileSync(argsFile, "utf8"))).toEqual([
        "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:48765",
        "--protocol", "quic", "run", "c2c-workspace",
      ]);
      await tunnel.stop();
    }
  );

  it.runIf(process.platform !== "win32")(
    "keeps the configured hostname when the connector process restarts",
    async () => {
      const dir = makeTmpDir("named-tunnel-binary");
      stateDirs.push(dir);
      const binary = write(
        dir,
        "cloudflared-fixture",
        "#!/usr/bin/env node\nprocess.stderr.write('INF Registered tunnel connection\\n');\nprocess.on('SIGTERM', () => setTimeout(() => { process.stderr.write('ERR stale named child\\n'); process.exit(0); }, 50));\nsetInterval(() => {}, 1000);\n"
      );
      fs.chmodSync(binary, 0o700);
      const tunnel = new CloudflaredNamedTunnel({
        tunnelName: "c2c-workspace",
        hostname: "c2c-demo.example.com",
        binaryOverride: binary,
        startTimeoutMs: 2000,
      });

      expect(await tunnel.start(48765)).toBe("https://c2c-demo.example.com");
      expect(await tunnel.restart(48765)).toBe("https://c2c-demo.example.com");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(tunnel.status()).toMatchObject({
        running: true,
        url: "https://c2c-demo.example.com",
        detail: undefined,
      });
      await tunnel.stop();
    }
  );
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("cloudflared output parsers", () => {
  it("extracts only the Cloudflare account login page", () => {
    expect(
      parseCloudflareLoginUrl(
        "Please open https://dash.cloudflare.com/argotunnel?callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc"
      )
    ).toBe(
      "https://dash.cloudflare.com/argotunnel?callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fabc"
    );
    expect(parseCloudflareLoginUrl("https://evil.example/argotunnel?callback=abc")).toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "surfaces the login page without launching an external browser",
    async () => {
      const dir = makeTmpDir("cloudflared-login-binary");
      stateDirs.push(dir);
      process.env.TUNNEL_ORIGIN_CERT = path.join(dir, "cert.pem");
      fs.writeFileSync(process.env.TUNNEL_ORIGIN_CERT, "stale");
      const binary = write(
        dir,
        "cloudflared-fixture",
        "#!/bin/sh\ntest -n \"$BROWSER\" || exit 9\nprintf '%s\\n' 'Open https://dash.cloudflare.com/argotunnel?callback=fixture' >&2\nprintf fresh > \"$TUNNEL_ORIGIN_CERT\"\n"
      );
      fs.chmodSync(binary, 0o700);
      const pages: string[] = [];

      await new ProcessCloudflaredAccount(binary).login((page) => pages.push(page), true);

      expect(pages).toEqual(["https://dash.cloudflare.com/argotunnel?callback=fixture"]);
      expect(fs.readFileSync(process.env.TUNNEL_ORIGIN_CERT, "utf8")).toBe("fresh");
    }
  );

  it.runIf(process.platform !== "win32")(
    "does not accept a failed forced login just because the stale certificate remains",
    async () => {
      const dir = makeTmpDir("cloudflared-login-failure");
      stateDirs.push(dir);
      process.env.TUNNEL_ORIGIN_CERT = path.join(dir, "cert.pem");
      fs.writeFileSync(process.env.TUNNEL_ORIGIN_CERT, "stale");
      const binary = write(dir, "cloudflared-fixture", "#!/bin/sh\nexit 7\n");
      fs.chmodSync(binary, 0o700);

      await expect(new ProcessCloudflaredAccount(binary).login(undefined, true)).rejects.toThrow(
        /exit 7/
      );
    }
  );

  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("treats an existing DNS route as success", () => {
    expect(isBenignRouteError("Failed to add route: record already exists")).toBe(true);
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("falls back to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.userMessage).toMatch(/临时地址/);
    });
  });
});
