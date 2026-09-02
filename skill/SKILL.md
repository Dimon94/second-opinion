---
name: codex-with-chatgpt
description: >
  Configure, repair, or disconnect the single global Codex with
  ChatGPT connection. Use for first setup, connection repair, or disconnect.
  Project execution belongs to codex-with-chatgpt-run.
---

# Codex with ChatGPT setup

Create and repair one reusable ChatGPT connection for this computer. Codex
selects the active local workspace; ChatGPT cannot select a filesystem path.

## Required reference

Before interpreting any doctor result, read `<checkout>/skill/DOCTOR-HANDOFF.md`
completely. It is the shared `outcome` / `reason` / `nextAction` contract for
this Skill and `codex-with-chatgpt-run`.

Completion criterion: every doctor result is dispatched only through that
reference; this Skill does not infer Bridge, Tunnel, endpoint, Connector, or
grant state.

## Boundary

- This Skill owns first connection, connection repair, and disconnect.
- The Connector name comes from `nextAction.connectorName`; never invent a second one.
- Keep account, consent, and control-plane changes visible to the user.
- Finish setup after the selected workspace passes `workspace_info` and one read-only file call.
- Task planning and review belong to `codex-with-chatgpt-run`.

## Locations

- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`
- Let `<checkout>` mean that path. CLI:
  `node "<checkout>/bin/c2c.js" <command>` or a globally linked `c2c`.
- Protocol: `<checkout>/docs/protocol.md`.
- Always pass `-w <current-project-root>`.

## Browser

Use `control-in-app-browser` and only the built-in browser. Reuse one foreground
ChatGPT tab, mark it for handoff, and leave it open. The shared doctor handoff
defines every permitted page and pause. Never use Computer Use, Chrome, Safari,
Edge, `open <url>`, cookies, browser storage, or account credentials.

## First setup

1. Run `c2c update-check --json` and `c2c sandbox-allow --json`.
2. Ensure Node.js >= 20, Git, and `cloudflared`; build with
   `corepack pnpm install && corepack pnpm build` when dependencies or `dist/` are absent.
3. Run `c2c tunnel status -w <current-project-root> --json`. If `needsChoice`
   is true, show exactly one user choice: temporary address, or their existing
   Cloudflare domain. For a named choice, run `c2c tunnel login --json`, open
   its emitted page in the built-in browser, pause for the user, and wait for
   success before `c2c tunnel choose`. Persist only the selected CLI mode;
   later account repair remains a doctor HITL action.
4. Run `c2c doctor -w <current-project-root> --json` and dispatch its one
   `nextAction` through `<checkout>/skill/DOCTOR-HANDOFF.md`. After every HITL
   action, rerun doctor with the identical workspace path.
5. For the returned conversation action, send the Boot Prompt from
   `docs/protocol.md`, require the exact Connector to call `workspace_info` and
   read a top-level file, and verify the reported workspace before saving the URL.

Completion criterion: doctor has no unfinished local or HITL stage,
`workspace_info` names the requested workspace, and the read-only file check passes.

## Repair

Run `c2c doctor -w <current-project-root> --json` and follow only the shared
handoff. Do not pre-emptively start a Bridge, restart a Tunnel, generate pairing,
or edit a Connector. Repeat from the same workspace after each completed action.

Completion criterion: doctor reaches the conversation action and
`workspace_info` confirms the requested workspace.

## Disconnect

Run `c2c unpair`. Remove the named Connector only when the user explicitly asks;
the removal remains a visible browser action. Do not alter saved conversations.

## Completion report

```text
Codex with ChatGPT

✓ 全局连接已建立
✓ 当前项目已识别
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```
