# Second Opinion

[简体中文](README.zh-CN.md)

Independent project review through ChatGPT Chat, with Codex retaining responsibility for verification, decisions, and user-authorized execution.

## Origin and attribution

Second Opinion is an independently maintained, substantially modified fork of
[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt).
Thanks to its authors and contributors for the original Bridge, OAuth, tunnel and agent workflow.
This fork adds task/workspace isolation, local authorization, recovery checks and asynchronous review delivery.
It is not an official upstream release and is not affiliated with or endorsed by OpenAI.
The original copyright notice and [MIT license](LICENSE) are retained; see [NOTICE](NOTICE).
Please report fork-specific issues to [this repository](https://github.com/Dimon94/second-opinion/issues).

## Names and responsibilities

- **Second Opinion**: this project and its [Codex Skill](skills/second-opinion/SKILL.md).
- **Codex Workspace Connector**: the ChatGPT MCP connector. Older installations may retain the Second Opinion display name.
- **c2c / codex-with-chatgpt**: retained CLI, package and state-directory identifiers. Renaming the repository does not migrate credentials or installed runtimes.

Codex opens its own Chat, obtains a connection proof, authorizes the workspace locally, and verifies a small real file read.
ChatGPT gives an independent opinion; Codex reads it back and decides what to accept within the user's scope.
The Skill uses **Chat, not Work**, and verifies the visible Pro model rather than inferring it from a subscription.

## Asynchronous round trip

1. Codex verifies the workspace/task/Chat mapping, registers a review round, sends the question, and ends its turn.
2. ChatGPT reads authorized project material and submits its completed review.
3. The Bridge saves the result and sends a fixed notification to the locally registered Codex task.
4. The resumed task verifies the round, opens its original Chat, reads the complete reply, analyzes it, and acknowledges it.
5. A follow-up registers a new round. Final completion clears the task's binding.

Workspace file access is read-only. **Review delivery is not**: it saves a result and starts a Codex turn.
It requires explicit `review.submit` OAuth consent in addition to `workspace.read`.
Notification, full readback and completion of authorized work are separate evidence.
Read file contents are transmitted to ChatGPT; this is not a promise that project data stays entirely on-device.

## Install and configure

Requirements: Node.js 20+, pnpm via Corepack, Git, a running local Codex App with browser tools,
a ChatGPT account exposing the required model/connector features, and cloudflared for public access.
Automatic wakeup additionally requires a Codex CLI supporting `queue --thread --message`.
No OpenAI API key is used by this workflow.

```sh
git clone https://github.com/Dimon94/second-opinion.git
cd second-opinion
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js --help
```

Install the whole `skills/second-opinion/` directory, including references.
Prefer a symlink from your Codex skills directory to its absolute path in this checkout.
If a skill named second-opinion is already installed, compare it first; do not overwrite local configuration blindly.
For a copied installation, record the deployed checkout location as described in [runtime discovery](skills/second-opinion/references/local-runtime.md).

For first-time connection setup, run `node <checkout>/bin/c2c.js setup --help` and follow
the existing [setup Skill](skill/SKILL.md) and [Doctor handoff](skill/DOCTOR-HANDOFF.md).
Use this fork's checkout, not an automatic pull from upstream.
Set the connector display name to **Codex Workspace Connector** and use the Doctor's `/mcp/session` endpoint.
Login, OAuth consent and platform confirmation remain user-owned gates.
A stable tunnel hostname avoids URL churn; an existing deployment must be inspected before replacement.

From a real Codex project task:

> Use $second-opinion to review this project's design in two rounds. Read back the recommendations and explain what you accept or reject; do not change project files.

Each host task, including forks and sibling tasks in one project, uses its own Chat.
Recovery revalidates the mapping and real reads; it never falls back to the last active workspace.

## Authorization recovery

Refresh connector metadata after deploying tool changes, then test in a new Chat.
An ordinary settings **Reconnect can retain old read-only scopes**.
For review delivery, follow the tool-level OAuth prompt and check that it actually requests `review.submit`.
After scope expansion, obtain a new connection proof and binding; an automatically retried old request may fail with `WORKSPACE_BINDING_MISMATCH`.
Do not relabel a write tool as read-only or retry around a platform safety refusal.
See [async delivery and recovery](skills/second-opinion/references/async-review.md).

## Validation and limits

On 2026-09-20, a live local Codex task and ChatGPT Chat / visible 6 Pro completed **two consecutive automatic rounds**:
send → end turn → real completion notification → new Codex turn → full readback → acknowledgement.
The final task cleared its binding. This does not certify four concurrent asynchronous tasks,
sleep/wake, a closed App, remote hosts, or every per-call confirmation UI.
See [validation record](docs/validation.md). Local tests do not substitute for live browser acceptance.

```sh
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Existing CI runs these checks on macOS and Windows.
The packaged Skill is checked by the test suite for missing local reference targets and machine-specific paths.

## Further reading

- [Second Opinion workflow](skills/second-opinion/SKILL.md)
- [Keeping this fork current](docs/upstream-sync.md)
- [Security boundaries](docs/security.md)
- [Architecture](docs/architecture.md) and [protocol](docs/protocol.md): inherited background; the async contract above extends the earlier read-only flow.
- [Troubleshooting](docs/troubleshooting.md) and [recovery smoke](docs/recovery-smoke.md)

## License

[MIT](LICENSE). Original notices are preserved. Independent maintenance and substantial changes are documented in [NOTICE](NOTICE).
