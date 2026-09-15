---
name: codex-with-chatgpt
description: >
  Configure, repair, or disconnect the single global Codex with
  ChatGPT connection. Use for first setup, connection repair, or disconnect.
  Project execution belongs to codex-with-chatgpt-run.
---

# Codex with ChatGPT setup

Configure one machine-global `Second Opinion` Connector, then verify it from
the current Codex project task with a task-scoped read-only workspace binding.

## Required reference

Before interpreting doctor output, read `<checkout>/skill/DOCTOR-HANDOFF.md`.
Dispatch only its `nextAction`; do not infer recovery state from other fields.

## Locations

- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`
- Let `<checkout>` mean that path. CLI:
  `node "<checkout>/bin/c2c.js" <command>` or a globally linked `c2c`.
- Run workspace binding commands from `<current-project-root>`.

## First setup

1. Run `c2c update-check --json` and `c2c sandbox-allow --json`.
2. Ensure Node.js >= 20, Git, and `cloudflared`; build with
   `corepack pnpm install && corepack pnpm build` when dependencies or `dist/`
   are absent.
3. Run `c2c tunnel status -w <current-project-root> --json`. If `needsChoice`
   is true, show one user choice: temporary address or their existing
   Cloudflare domain. For a named choice, use `c2c tunnel login --json` and the
   built-in browser, pausing for the visible user gate before `c2c tunnel choose`.
4. Run `c2c doctor -w <current-project-root> --direct --json`. Follow its one
   `nextAction` through `skill/DOCTOR-HANDOFF.md`, rerunning with the same path
   after every action until `nextAction.type` is `none`.
5. Confirm this is a Codex project task and `CODEX_THREAD_ID` exists. Inspect
   the current task's `@Second Opinion` schemas for `bind_workspace` with
   `bootstrap_token`, plus `workspace_info` and `read_file` with
   `binding_token`. If any is absent, stop with
   `SECOND_OPINION_BINDING_TOOLS_UNAVAILABLE` and report that the Connector
   candidate must be deployed or refreshed. Do not use a browser conversation
   or legacy `/mcp` as a substitute.
6. From `<current-project-root>`, run `c2c binding bootstrap --json`. Pass its
   raw `bootstrapToken` only to `@Second Opinion.bind_workspace`, then pass the
   returned private `binding_token` to `@Second Opinion.workspace_info` and one
   top-level `@Second Opinion.read_file` call. Require the canonical root to
   equal `<current-project-root>` and include the token in every routed read.
7. Run `c2c binding unbind --json` from the same task and cwd.

Completion criterion: doctor has no unfinished action, the current Codex task
directly verifies its canonical workspace and one file read through
`@Second Opinion`, and the task binding is removed.

## Repair

Run `c2c doctor -w <current-project-root> --direct --json` and follow only the
shared handoff. Do not pre-emptively start a Bridge, restart a Tunnel, generate
pairing, or edit a Connector.

## Browser C2C compatibility

Legacy ChatGPT Web conversations remain available only when explicitly
requested. Run doctor without `--direct` and follow its conversation action and
`docs/protocol.md`. This path is not #13 direct-host acceptance. Its random C2C
`TASK_ID` never owns a local binding; binding commands always use the current
host `CODEX_THREAD_ID` and cwd implicitly.

## Disconnect

Run `c2c unpair`. Remove the named Connector only when the user explicitly asks;
the removal remains a visible built-in-browser action. Do not alter saved conversations.

## Completion report

```text
Codex with ChatGPT

✓ 全局连接已建立
✓ 当前 Codex 任务已绑定项目
✓ @Second Opinion 已连接
✓ 文件读取测试通过

Ready.
```
