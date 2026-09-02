---
name: codex-with-chatgpt-run
description: >
  Execute a project task through the existing global Codex with ChatGPT
  connection. Use when the user says “使用 Codex with ChatGPT 完成…” or invokes
  codex-with-chatgpt-run.
---

# Run with Codex and ChatGPT

ChatGPT plans and reviews. Codex executes and tests. The same global Connector
serves the workspace that local doctor activates.

## Required reference

Before interpreting any doctor result, read `<checkout>/skill/DOCTOR-HANDOFF.md`
completely. It is the shared `outcome` / `reason` / `nextAction` contract for
this Skill and `codex-with-chatgpt`.

Completion criterion: every doctor result is dispatched only through that
reference; this Skill does not infer Bridge, Tunnel, endpoint, Connector, or
grant state.

## Boundary

- Begin every ChatGPT turn by activating the current workspace through doctor.
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
   built-in-browser tab and verify `workspace_info` before task work.
4. Read `c2c session -w <current-project-root> --json` and resume its checkpoint
   before creating a task id or sending INIT:
   - `EXECUTED_SENT` + `GPT_REVIEW`: wait for review; do not resend.
   - `EXECUTED_LOCAL`: record if needed, then send only EXECUTED.
   - `EXECUTING` or `PLAN_RECEIVED`: continue the accepted plan.
   - `INIT` + `GPT_PLAN`: wait for the plan; do not resend.
   - `DONE`: clear the checkpoint and finish.
   - `BLOCKED`: surface the one unresolved decision.

Completion criterion: the browser is on the verified conversation for this
workspace and checkpoint recovery has selected exactly one next protocol step.

## Plan

Generate `TASK_ID` as `c2c_` plus four random hexadecimal characters unless the
checkpoint already has one. Send:

```text
[C2C]
STATE: INIT
TASK_ID: <task-id>
ITERATION: 0

GOAL:
<user goal in one paragraph>

INSTRUCTION:
Call workspace_info with the exact returned Connector. If it names the expected
workspace, inspect the workspace and return a substantive C2C PLAN. Otherwise
reply BLOCKED.
```

Persist `INIT` / `GPT_PLAN`. A valid PLAN includes rationale, concrete actions,
likely files, tests, and success criteria. Persist `PLAN_RECEIVED` before execution.

## Execute and review

1. Persist `EXECUTING`; Codex executes the finite PLAN and runs relevant checks.
2. Record changed files, tests, and sanitized command output with `c2c record`;
   persist `EXECUTED_LOCAL` before sending the review message.
3. Rerun `c2c doctor -w <current-project-root> --json` and follow the shared
   handoff. Verify `workspace_info` again before sending EXECUTED.
4. Send the small `[C2C] STATE: EXECUTED` summary. ChatGPT independently reads
   the current diff and released test output, then replies PLAN, DONE, or BLOCKED.
5. Persist `EXECUTED_SENT` / `GPT_REVIEW`. On PLAN, run the next finite iteration.
   On DONE, persist DONE and clear the checkpoint. On BLOCKED, surface the one
   user decision after fixing everything safely in scope.
6. Respect `.c2c.json` `maxIterations` (default 12); ask before continuing beyond it.

Completion criterion: ChatGPT returns DONE after reviewing the verified
workspace, local checks pass, and no second Connector or conversation was invented.
