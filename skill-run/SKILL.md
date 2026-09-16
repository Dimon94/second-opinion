---
name: codex-with-chatgpt-run
description: >
  Execute a project task through the existing global Codex with ChatGPT
  connection. Use when the user says “使用 Codex with ChatGPT 完成…” or invokes
  codex-with-chatgpt-run.
---

# Run with Codex and ChatGPT

Use `@Second Opinion` inside the current Codex project task. The host task and
its current working directory own the local read-only workspace binding.

## Required reference

Before interpreting doctor output, read `<checkout>/skill/DOCTOR-HANDOFF.md`.
Dispatch only its `nextAction`; do not infer recovery state from other fields.

## Locations

- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`
- Let `<checkout>` mean that path. CLI:
  `node "<checkout>/bin/c2c.js" <command>` or a globally linked `c2c`.
- Run workspace binding commands from `<current-project-root>`.

## Direct Codex task flow

1. Confirm this is a Codex project task and `CODEX_THREAD_ID` exists. The CLI
   rejects a missing host identity; never substitute a generated or user-supplied id.
2. Run `c2c sandbox-allow --json`, then
   `c2c doctor -w <current-project-root> --direct --json`. Follow its one action
   through `skill/DOCTOR-HANDOFF.md` until `nextAction.type` is `none`.
3. Inspect the current task's `@Second Opinion` tool schemas. They must expose:
   - `bind_workspace` with `bootstrap_token`;
   - `workspace_info` with `binding_token`;
   - `read_file` with `binding_token` and `path`.
   If any is absent, stop with `SECOND_OPINION_BINDING_TOOLS_UNAVAILABLE` and
   report that the Connector candidate must be deployed or refreshed. Do not
   use browser ChatGPT or legacy `/mcp` as a substitute.
4. From `<current-project-root>`, run `c2c workspace --json` and keep its
   locally computed `workspaceId` as the expected identity. This command
   canonicalizes the current cwd; do not accept a name or `rootAlias` as proof.
   Then run `c2c binding bootstrap --json`, send the raw `bootstrapToken` only
   to `@Second Opinion.bind_workspace`, and keep the returned `binding_token` private.
5. Call `@Second Opinion.workspace_info` with that `binding_token`. Require the
   returned `workspaceId` to exactly equal the locally computed `workspaceId`.
   Then call `@Second Opinion.read_file` with the same token and one relevant
   relative path. Include the token in every later `workspace_info` and
   `read_file` call.
6. Codex executes and tests the user's task. Issue #13 only establishes the
   direct workspace binding and read path; do not claim a separate advisor plan
   or review unless the host actually returns one.
7. On completion, run `c2c binding unbind --json` from the same task and cwd.

Completion criterion: the current Codex task directly calls `@Second Opinion`,
the canonical workspace and one file read match, relevant local checks pass,
and the task binding is removed.

## Browser C2C compatibility

Use this only when the user explicitly requests the legacy ChatGPT Web planning
and review loop. It is preserved for compatibility and is not #13 acceptance.

Run `c2c doctor -w <current-project-root> --json` without `--direct`, follow the
conversation action, then use `<checkout>/docs/protocol.md`. Its random `TASK_ID`
is only a C2C message correlation id. The local binding owner remains the host
`CODEX_THREAD_ID`; therefore bootstrap and cleanup still use
`c2c binding bootstrap --json` and `c2c binding unbind --json` from the current
task cwd. Never pass the protocol `TASK_ID` to either binding command.
The `session get/set/clear` commands also derive ownership from
`CODEX_THREAD_ID`. If doctor reports `legacy_session_ambiguous`, follow the
explicit claim-or-start-new action in `skill/DOCTOR-HANDOFF.md`; never assign an
old workspace checkpoint to a new or forked task by cwd alone.
