---
name: codex-with-chatgpt-run
description: >
  Execute a project task through the existing global Codex with ChatGPT
  connection. Use when the user says “使用 Codex with ChatGPT 完成…” or invokes
  codex-with-chatgpt-run.
---

# Run with Codex and ChatGPT

ChatGPT plans and reviews. Codex executes and tests. The same global Connector
routes each task through its locally authorized workspace binding.

## Required reference

Before interpreting any doctor result, read `<checkout>/skill/DOCTOR-HANDOFF.md`
completely. It is the shared `outcome` / `reason` / `nextAction` contract for
this Skill and `codex-with-chatgpt`.

Completion criterion: every doctor result is dispatched only through that
reference; this Skill does not infer Bridge, Tunnel, endpoint, Connector, or
grant state.

## Boundary

- Begin every ChatGPT turn by checking the global connection through doctor.
- Use the saved conversation disposition returned by doctor; a conversation is not a Connector.
- ChatGPT reads and reviews through the exact returned Connector. Codex owns edits, shell, git, and tests.
- Keep `[C2C]` control messages below 1 KB. Never paste files, diffs, or logs into ChatGPT.

## Locations

- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`
- Let `<checkout>` mean that path. CLI:
  `node "<checkout>/bin/c2c.js" <command>` or a globally linked `c2c`.
- Protocol: `<checkout>/docs/protocol.md`.
- Always pass `-w <current-project-root>`.

## Start and resume gate

1. Run `c2c sandbox-allow --json`.
2. Run `c2c doctor -w <current-project-root> --json` and follow its one action
   through `<checkout>/skill/DOCTOR-HANDOFF.md`. Resume every pause with that
   same workspace path. Do not send `[C2C]` while a local or HITL action remains.
3. For `open_conversation` or `create_conversation`, use the one foreground
   built-in-browser tab.
4. Read `c2c session -w <current-project-root> --json` and resume its checkpoint
   before creating a task id or sending INIT:
   - `EXECUTED_SENT` + `GPT_REVIEW`: wait for review; do not resend.
   - `EXECUTED_LOCAL`: record if needed, then send only EXECUTED.
   - `EXECUTING` or `PLAN_RECEIVED`: continue the accepted plan.
   - `INIT` + `GPT_PLAN`: wait for the plan; do not resend.
   - `DONE`: clear the checkpoint and finish.
   - `BLOCKED`: surface the one unresolved decision.

Completion criterion: the browser is on the selected conversation and
checkpoint recovery has selected exactly one next protocol step. The next
outbound C2C message must carry a fresh locally minted workspace bootstrap.

## Plan

Generate `TASK_ID` as `c2c_` plus four random hexadecimal characters unless the
checkpoint already has one. Run
`c2c binding bootstrap -w <current-project-root> --task <TASK_ID> --json`, then
send its raw `bootstrapToken` only in this control message:

```text
[C2C]
STATE: INIT
TASK_ID: <task-id>
ITERATION: 0
WORKSPACE_BOOTSTRAP: <bootstrap-token>

GOAL:
<user goal in one paragraph>

INSTRUCTION:
Call bind_workspace once with WORKSPACE_BOOTSTRAP. Keep its returned
binding_token private and include it in every workspace_info and read_file call.
If workspace_info names the expected workspace, inspect it and return a
substantive C2C PLAN. Otherwise reply BLOCKED. Never echo either credential.
```

Persist `INIT` / `GPT_PLAN`. A valid PLAN includes rationale, concrete actions,
likely files, tests, and success criteria. Persist `PLAN_RECEIVED` before execution.

## Execute and review

1. Persist `EXECUTING`; Codex executes the finite PLAN and runs relevant checks.
2. Record changed files, tests, and sanitized command output with `c2c record`;
   persist `EXECUTED_LOCAL` before sending the review message.
3. Rerun `c2c doctor -w <current-project-root> --json` and follow the shared
   handoff. Run `c2c binding bootstrap -w <current-project-root> --task <TASK_ID> --json`
   before sending EXECUTED.
4. Send the small `[C2C] STATE: EXECUTED` summary with
   `WORKSPACE_BOOTSTRAP: <bootstrapToken>`. ChatGPT calls `bind_workspace`, then
   independently reads the current diff and released test output with the
   returned `binding_token` on every routed request. Tools not yet migrated to
   the session entry fail closed until #14; never retry them through `/mcp`.
   It then replies PLAN, DONE, or BLOCKED.
5. Persist `EXECUTED_SENT` / `GPT_REVIEW`. On PLAN, run the next finite iteration.
   On DONE, run `c2c binding unbind --task <TASK_ID> --json`, persist DONE, and
   clear the checkpoint. On BLOCKED, surface the one user decision after fixing
   everything safely in scope.
6. Respect `.c2c.json` `maxIterations` (default 12); ask before continuing beyond it.

Completion criterion: ChatGPT returns DONE after reviewing the verified
workspace, local checks pass, and no second Connector or conversation was invented.
