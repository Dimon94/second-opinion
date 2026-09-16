# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP Server (RO)    │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             └─────────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Read-only by design**: no write/exec tools exist in V1 at all.
- **Task binding is the routed data boundary**: one machine-global bridge serves several locally authorized canonical workspaces without remote root selection.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | Session-routed McpServer with all nine read-only workspace tools; legacy `/mcp` stays isolated and is never a routing fallback; stateless Streamable HTTP transport |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and machine-global Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `session/` | Task workspace bindings and task-scoped conversation/checkpoint state; legacy workspace records require an explicit claim or fresh-task choice |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp/session` → OAuth bearer
middleware → `binding_token` + `openai/session` validation → stateless
StreamableHTTP transport → tool handler → immutable per-request workspace layer
(path containment → ignore rules → pagination) → JSON result. The legacy
`/mcp` entry is never a fallback for a failed routed request.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports and workspace binding**: prefer 48765 and bind 127.0.0.1 only. The CLI
observes one machine-global runtime record. A healthy bridge is reused; local
Codex mints a short-lived bootstrap for the invoking task and canonical cwd.
ChatGPT redeems it once and supplies the returned binding token on every routed
request. Legacy workspace activation remains isolated for migration. Only a
missing runtime or a positively dead PID permits a replacement process.

**Conversation state**: local host task identity and canonical workspace form
the storage key. ChatGPT URL, protocol task and checkpoint belong to that key;
forks and same-workspace tasks do not inherit them. Legacy workspace records
remain untouched until one task explicitly claims them, while a fresh task may
reuse only Project/Connector metadata.

**Tunnel**: a machine-global Cloudflare Named Tunnel is the recommended stable
setup (`c2c tunnel choose --mode named`). The Skill asks before the first public
URL exists; `cloudflared tunnel login` is the only extra user step. Tunnel name,
hostname and preference live under the OS state dir
(`tunnels/global.json`), never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails, C2C falls back to Quick Tunnel. If a named tunnel later
drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead of
rotating the ChatGPT connector. Quick Tunnel (`cloudflared tunnel --url …`) is
the no-domain fallback; its URL changes per start, so doctor tells the Skill to
delete and recreate the machine-global **Second Opinion** connector before a new
OAuth authorization.

Set `C2C_TUNNEL_PROTOCOL=auto`, `quic`, or `http2` before starting Doctor or the
Bridge to pass that transport choice to both Named and Quick Tunnel processes.
An unset value preserves cloudflared's default; an invalid value stops startup
instead of silently changing the configured transport or public identity.
