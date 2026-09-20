# Security Model

## Trust boundaries

1. **Locally authorized task binding** is the routed data boundary. The
   machine-global bridge accepts a workspace root only through its loopback
   admin API. `/mcp/session` requires OAuth plus a separate task/session bearer
   binding and resolves one immutable canonical root per request. The remote
   caller cannot submit a root. Legacy `/mcp` activation remains isolated during
   migration and is never a fallback for a failed session-routed request.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees OAuth credentials.** Access/refresh tokens travel only
   inside the OAuth redirect/token endpoints between ChatGPT's client and the
   bridge. A C2C control message supplies a short-lived, single-use workspace
   bootstrap; the model redeems it for a task/session binding token used only as
   a tool argument.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp/session` request requires OAuth plus a matching task/session binding token; neither request can select or submit a workspace root |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace binding theft | Bootstrap is high-entropy, five-minute and single-use; binding token is hashed at rest and matched to OAuth client, exact scopes and `openai/session` on every request; unbind or OAuth revocation invalidates it. Complete valid credential-set theft remains a bearer limitation. |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 global runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated and MCP-bearer workspace switches get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. ChatGPT still cannot run commands. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |
| Concurrent recovery | One owner-only machine-global lease serializes doctor mutations. A live or inconclusive owner is never displaced; only an expired lease plus a PID identity proven dead or reused permits reclaim. |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. Tokens remain bound to
the exact endpoint, issuer, resource/audience, client registration, scope set,
and machine-global Bridge identity. Any mismatch fails closed with a specific
reason. The global grant covers only workspaces separately authorized by local
Codex. Remote OAuth or MCP requests cannot choose a root or broaden read-only
scopes; each routed request also needs its matching task/session binding token.
Doctor reuses a grant only when that exact binding still matches and the store
has a successful protected-resource or refresh result. Authorization-code-only
state requests a safe retry without creating a new pairing. Recoverable access
expiry returns the existing conversation action so ChatGPT's OAuth client makes
a real protected call or refresh with its in-memory credential. Explicit token
revocation revokes only that client grant; explicit unpair remains machine-global.
An unreachable probe stays unknown and never creates a pairing session or
masquerades as revocation.

## Storage

### Conversation ownership

Local conversation pointers are keyed by workspace and host task, not by the
message's protocol task ID. A normalized ChatGPT URL is atomically reserved for
one such owner; reads reject conflicting older task records. Reservations are
retained when a pointer changes, so clearing a pointer does not transfer the old
conversation to another task. Ambiguous legacy records require explicit repair.
On the MCP side, an already-bound OAuth client/session rejects a bootstrap from
another task or root (`SESSION_ALREADY_BOUND`) before consuming it. Recovery
must use the current task's own chat and recheck identity with a real bound read.
These checks prevent accidental routing, not theft of a complete bearer credential
set or authenticated proof of which visible ChatGPT URL emitted metadata.

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/global.json`) — never in the project. Only SHA-256 hashes plus
canonical binding metadata, expiry, the last successful grant-proof kind, and
an explicit revocation marker are persisted in the owner-only global auth store
— a stolen state file does not yield usable bearer tokens. Workspace bootstrap,
binding, access and refresh tokens are never written raw.
Recovery lease and reclaimed-stale evidence also stay in this owner-only state
directory; neither is written to a workspace repository.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## Restricted completion notifications

Completion requires an explicit `review.submit` OAuth grant in addition to
`workspace.read`. Existing read grants are not upgraded on refresh. The consent
page states that review delivery saves results and starts the locally authorized
Codex task. Missing write scope returns the official MCP OAuth challenge before
any review mutation or queue dispatch. The installed SDK advertises tool scopes
through ChatGPT's documented `_meta.securitySchemes` compatibility field.
The tool is marked destructive because the sent message/started turn cannot be
undone; bounded private routing retains `openWorldHint: false`.

Workspace tools cannot write/delete project files, commit, install packages,
or execute arbitrary commands. `complete_review` is explicitly a mutating tool:
it persists bounded analysis in owner-only state and invokes the fixed local
`codex queue` executable without a shell. Its target comes exclusively from a
locally armed review matched to the authenticated workspace/task binding; remote
arguments cannot choose a host, executable, path, or wakeup instructions.
The result is untrusted data, never interpolated into the queued prompt.

Each round has a unique ID, expiry, saved conversation/iteration check and an
exclusive dispatch claim. Duplicate completion does not enqueue twice. Unknown
dispatch failure remains uncertain; only definite executable-start failures
permit retry. A notification is not permission for new work: the resumed task
must validate its owner/round, read the original Chat, and honor the user's scope.
Wakeup acceptance covers a running local Codex App, not sleep or remote hosts.
