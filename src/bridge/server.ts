import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createSessionMcpServer } from "../mcp/session-server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { WorkspaceBindingStore } from "../session/bindings.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";

function tunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider {
  return configuredTunnelForWorkspace(workspaceId, logger) ?? new CloudflaredQuickTunnel(logger);
}

function configuredTunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider | null {
  const state = readTunnelState(workspaceId);
  const binding = namedTunnelBinding(state);
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return state.preference === "quick" ? new CloudflaredQuickTunnel(logger) : null;
}

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
  bindingStoreFile?: string;
  bindingBootstrapTtlMs?: number;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  bindings: WorkspaceBindingStore;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  let workspace = new Workspace(opts.workspaceRoot);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const bindings = new WorkspaceBindingStore({ file: opts.bindingStoreFile, bootstrapTtlMs: opts.bindingBootstrapTtlMs });
  const authStore = new AuthStore({ file: opts.authStoreFile, onRevoke: () => bindings.clear() });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  let tunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      getWorkspaceName: () => workspace.name,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace, logger }), logger);
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );
  const sessionMcpHandler = createMcpHttpHandler(() => createSessionMcpServer(bindings, logger), logger);
  app.all(
    "/mcp/session",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void sessionMcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post(
    "/admin/bindings/bootstrap",
    adminGuard,
    express.json({ limit: "8kb" }),
    (req: Request, res: Response) => {
      if (typeof req.body?.workspaceRoot !== "string" || typeof req.body?.taskId !== "string") {
        res.status(400).json({ error: "invalid_binding_bootstrap", message: "workspaceRoot and taskId are required" });
        return;
      }
      try {
        res.json(bindings.mint(req.body.workspaceRoot, req.body.taskId));
      } catch (error) {
        res.status(400).json({
          error: "invalid_binding_bootstrap",
          message: error instanceof Error ? error.message : "Unable to authorize workspace",
        });
      }
    }
  );

  app.post(
    "/admin/bindings/unbind",
    adminGuard,
    express.json({ limit: "8kb" }),
    (req: Request, res: Response) => {
      if (typeof req.body?.taskId !== "string" || !req.body.taskId.trim() || req.body.taskId.trim().length > 200) {
        res.status(400).json({ error: "invalid_task", message: "taskId is required" });
        return;
      }
      res.json({ removed: bindings.unbindTask(req.body.taskId) });
    }
  );

  app.post(
    "/admin/workspace",
    adminGuard,
    express.json({ limit: "8kb" }),
    async (req: Request, res: Response) => {
      if (typeof req.body?.workspaceRoot !== "string") {
        res.status(400).json({ error: "invalid_workspace", message: "workspaceRoot is required" });
        return;
      }
      let nextWorkspace: Workspace;
      try {
        nextWorkspace = new Workspace(req.body.workspaceRoot);
      } catch (error) {
        res.status(400).json({
          error: "invalid_workspace",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      try {
        persistRuntime(nextWorkspace);
        workspace = nextWorkspace;
        logger.info(`Activated workspace ${workspace.name} (${workspace.id})`);
        res.json({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceRoot: workspace.root,
        });
      } catch (error) {
        try {
          persistRuntime(workspace);
        } catch {
          // Preserve the original activation error.
        }
        res.status(500).json({
          error: "workspace_activation_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      capabilities: { authReload: true },
      bindingCount: bindings.count(),
      authorization: authStore.authorizationStatus(
        publicBaseUrl ?? `http://${host}:${port}`
      ),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    const start = tunnel.status().running ? tunnel.restart(port) : tunnel.start(port);
    start
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.get("/admin/tunnel/doctor", adminGuard, (_req, res) => {
    void tunnel.doctor().then(
      (report) => res.json(report),
      (error: Error) => res.status(500).json({ error: "tunnel_probe_failed", message: error.message })
    );
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/auth/reload", adminGuard, (_req, res) => {
    authStore.reload();
    res.json({ reloaded: true });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (activeWorkspace = workspace): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: activeWorkspace.id,
      workspaceRoot: activeWorkspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearRuntimeState(workspace.id);
    logger.info("Bridge stopped");
  };

  return {
    get workspace() {
      return workspace;
    },
    port,
    host,
    adminToken,
    authStore,
    bindings,
    pairing,
    get tunnel() {
      return tunnel;
    },
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
