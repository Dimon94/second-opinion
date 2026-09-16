# Doctor handoff

This is the single recovery contract for both C2C Skills. For the current Codex
task run `c2c doctor -w <workspace> --direct --json`; browser C2C compatibility
omits `--direct`. Then read only `version`, `outcome`,
`reason`, `nextAction`, and the payload of that one action. Bridge, Tunnel,
endpoint, Connector, grant, and conversation recovery decisions belong to the
CLI. Never reconstruct them from `report`, legacy compatibility fields, browser
state, or remembered runs.

A green local outcome does not cancel nextAction. Connector or OAuth actions
can remain before direct use, and browser compatibility can still require a
conversation action. Conversely, exit status 2 is a planned HITL pause, not a
failed recovery.

The Connector endpoint returned by doctor is the session-routed `/mcp/session`
entry. Before current-task `@Second Opinion` or a compatibility conversation
calls it, the invoking Skill must mint a local bootstrap from the host
`CODEX_THREAD_ID` and cwd. The caller consumes that value once with
`bind_workspace`, keeps the returned `binding_token` private, and
includes it in every later `workspace_info` or `read_file` call. Missing or
mismatched binding errors stop the flow; never retry through the legacy `/mcp`
entry. Do not record, log, or echo either credential.

## Action policy

The table is normative. There is one `nextAction` per doctor result.

| action | browser | pause | pairing | after |
| --- | --- | --- | --- | --- |
| `none` | `none` | `no` | `no` | `continue` |
| `retry_wait` | `none` | `no` | `no` | `rerun` |
| `cloudflare_login` | `built-in` | `user` | `no` | `rerun` |
| `replace_connector` | `built-in` | `user` | `no` | `rerun` |
| `authorize_oauth` | `built-in` | `user` | `create` | `rerun` |
| `chatgpt_login` | `built-in` | `user` | `no` | `rerun` |
| `open_conversation` | `built-in` | `no` | `no` | `verify` |
| `create_conversation` | `built-in` | `no` | `no` | `verify` |
| `administrator_approval` | `built-in` | `user` | `no` | `rerun` |
| `manual_recovery` | `none` | `user` | `no` | `stop` |

- `none`: in direct mode, run `c2c workspace --json` from the task cwd, verify
  the current task's `@Second Opinion` schemas, then bind and require its
  `workspace_info.workspaceId` to equal the locally computed `workspaceId`.
- `retry_wait`: keep local and browser state untouched, wait as directed, then rerun doctor.
- `cloudflare_login`: run `c2c tunnel login --force --json` and keep it running. Open
  the emitted `nextAction.page` in the built-in browser only, stop for the user,
  then wait for the command's success result before rerunning doctor.
- `replace_connector`: open the Connector hub at `nextAction.page`. If the exact
  Connector is absent, continue to `nextAction.createPage`. If replacement is
  required, stop before deleting the named Connector, then continue to
  `nextAction.createPage` and recreate that same name with `nextAction.endpoint`.
  Never use Reconnect or click an old endpoint. After the named Connector with
  that endpoint is visibly present, rerun Doctor with
  `--browser-gate connector_replaced --browser-page <current-url>`.
- `authorize_oauth`: run `c2c pair -w <same-workspace> --json` only in this branch.
  The CLI retains the one-time, short-TTL, attempt-limited, memory-only session.
  Open `nextAction.page`, then pause at OAuth consent. The pairing code is the
  only credential Codex may type.
- `chatgpt_login`: open `nextAction.page` and stop. The user completes login,
  MFA, CAPTCHA, or account selection.
- `open_conversation`: browser compatibility only. Open `nextAction.page` in the existing C2C tab. If it is
  already open, do not navigate again. Verify `workspace_info` before task work.
- `create_conversation`: browser compatibility only. Create one conversation in the returned Project when
  `nextAction.page` is present, otherwise use a new Chat conversation. Send the
  Boot Prompt, verify `workspace_info`, then persist the verified URL with
  `c2c session set -w <same-workspace> --url <url>`.
- `administrator_approval`: explain the requested approval and stop. The user or
  administrator completes it visibly.
- `manual_recovery`: if `reason` is `legacy_session_ambiguous`, ask whether the
  current Codex task owns that legacy chat. On yes, run
  `c2c session claim-legacy -w <same-workspace> --json`; on no, run
  `c2c session start-new -w <same-workspace> --json`. Rerun doctor afterward.
  For every other reason, report it and stop without browser or account mutation.

## Browser and resume gates

Use one foreground C2C tab in the built-in browser only; keep it open across
pauses. There is no external browser fallback. Connector create/delete,
ChatGPT or Cloudflare login, MFA, CAPTCHA, OAuth consent, and administrator
approval are visible HITL gates. Navigate and fill non-sensitive fields when
the action permits, then stop before the gate and wait for the user.

When the user says the gate is complete, do not infer success from that message
or from the page. Run `c2c doctor -w <same-workspace> --json` with the exact
workspace path from the interrupted run and follow only its new `nextAction`.
Completed local stages are owned by doctor and are not replayed by the Skill.

If ChatGPT interrupts an action with login, MFA, CAPTCHA, account selection, or
administrator approval, rerun that same doctor seam with the visible page:
`--browser-gate chatgpt_login --browser-page <current-url>` or
`--browser-gate administrator_approval --browser-page <current-url>`. Follow
the returned action, then rerun doctor without the observation flags after the
user completes it. Doctor rejects non-ChatGPT pages from these payloads.

If the page, login state, Connector identity, or success state cannot be
verified, doctor returns `manual_recovery`; fail closed and keep the user at
one visible action. There is no
supported Connector CRUD API: do not invent one, reverse-engineer one, or claim
an account mutation succeeded. Never inspect cookies, tokens, browser storage,
passwords, or authentication codes.

Treat a collection or chat page that shows only Retry as a navigation failure,
not generation or authorization evidence. Retry once in the same tab. If it
remains Retry-only, return to the last working chat and use its on-page Project
link before creating a replacement. Do not save a waiting checkpoint until the
INIT, EXECUTED, or HANDOFF message is visibly present in the target chat.

For a missing or deleted saved conversation, keep its saved URL, Project and
checkpoint while opening a replacement in the retained Project (or a new Chat
for long-chat mode). Send Boot Prompt plus HANDOFF, bind and verify
`workspace_info`, then replace the current task's URL with `c2c session set`.
Never clear or overwrite the previous pointer before that verification.
