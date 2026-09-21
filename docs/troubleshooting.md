# Troubleshooting

First move, always:

```
c2c doctor
```

For automation, use the versioned recovery result:

```bash
c2c doctor -w /path/to/workspace --json
c2c doctor -w /path/to/workspace --diagnose-only --json
```

`--diagnose-only` (and its existing alias, `--no-fix`) never changes Bridge,
Tunnel, OAuth, session, lease, or endpoint state. JSON always contains
`version`, `outcome`, stable `reason`, `repairs`, `safeRetry`, and exactly one
structured `nextAction`, plus `requestedWorkspace`, `activeWorkspace` when
known, and `bridgeObservation`. Workspace identities contain only `id` and
`name`, never filesystem roots. `requestedWorkspace.reference` equals the
canonical `id` after validation; invalid requests instead receive a stable,
path-free reference while `id` and `name` remain `null`. The legacy `report`, `chatgptRepair`, and
`namedRepair` fields remain available for existing callers.

| Outcome | Exit status | Meaning |
| --- | ---: | --- |
| `healthy`, `repaired` | 0 | Recovery is complete. |
| `busy`, `user_action_required` | 2 | Nonfatal stop; follow the single `nextAction`. |
| `blocked`, `unknown` | 1 | Recovery failed or cannot be decided safely. |

Doctor output redacts bearer/refresh tokens, pairing-code patterns, browser
credentials, and user home-directory paths.

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

## Common situations

### "Bridge 未运行"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If doctor says the bridge state is **uncertain** (无法确认), do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

### Everything was quit and ChatGPT can no longer connect
With the recommended Named Tunnel, the next `c2c doctor` restarts the Bridge and
Tunnel at the same endpoint, then reuses the Second Opinion grant and saved
conversation. With Quick Tunnel, doctor starts a new address and sets
`chatgptRepair.needed`; **Delete** the machine-global connector and create it
again with the new address (never click Reconnect — the old URL is dead). Other
workspaces reuse that connector, but each task must revalidate its own Chat-to-workspace
binding; never fall back to the last active workspace.

After connector repair, a green Doctor result alone is not acceptance. In the
intended Chat, verify `workspace_info` and a real project-file read against the
expected binding. If that Chat still cannot use the connector, create a new Chat,
bind and verify it before replacing the saved conversation mapping.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c doctor`, then Delete + recreate the machine-global
connector if `chatgptRepair.needed`. Fresh pairing code: `c2c pair`.
If this machine uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps one hostname such as `advisor.your-domain.com`. This is the
recommended stable setup. To stay on the temporary address, say you do not have
a domain. Switching later: tell Codex you want the stable hostname; it runs
`c2c tunnel choose --mode named --zone <domain>`.

### Human confirmation and supported scope
Codex pauses at the visible browser gates: ChatGPT/Cloudflare login, MFA or
CAPTCHA, Cloudflare authorization, Connector deletion/creation, OAuth consent,
and administrator approval. The recovery workflow does not use OpenCLI, Secure
MCP Tunnel, or an unsupported ChatGPT Connector CRUD API.

Direct session routing is supported from Codex project tasks on macOS and
Windows when the host supplies `CODEX_THREAD_ID` and the task cwd. A shell or
host without that task identity cannot authorize a routed workspace: start the
command from the intended Codex task. Never invent an id or fall back to the
machine's last active workspace.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes:

```
c2c pair
```

generates a fresh one (older codes become invalid immediately). Generate it only
when the authorization form is ready; do not pre-mint it while waiting for login
or connector creation. Doctor does not need to generate a pairing code.

### Temporary address keeps dropping on a UDP-filtered network
Leave `C2C_TUNNEL_PROTOCOL` unset to keep cloudflared's default. If the network
repeatedly drops QUIC, set `C2C_TUNNEL_PROTOCOL=http2` before restarting the
Bridge. Valid values are `auto`, `quic`, and `http2`; any other value fails
before cloudflared starts.

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete the machine-global connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup`, `c2c doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Hover **Chats** /「聊天」, click the … that appears, and choose
**Organize by project** /「按项目整理」. Then create a project named after
this workspace, with **project-only memory**. Tell Codex「好了」when the
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex「已找到」, or say you want the old
long-chat instead. Each workspace has its own Project; all Projects use the
same machine-global connector name.

### Completely stuck
```
c2c stop
c2c setup
```

re-creates the bridge, tunnel and pairing session from scratch. Existing
authorizations stay valid unless you also ran `c2c unpair`.
