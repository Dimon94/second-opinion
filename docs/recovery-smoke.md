# Recovery smoke record

Date: 2026-09-04

This is historical evidence for the recorded version. It is not acceptance for
the current SR04 candidate.

This record intentionally contains no endpoint URL, bearer/refresh token,
pairing code, cookie, password, browser credential, or user home path.

## Named Tunnel and ChatGPT

| Check | Result |
| --- | --- |
| Connector | `Second Opinion` created with OAuth |
| OAuth page | Occurred once during initial authorization; absent after restart |
| Endpoint identity before restart | `sha256:1e0a0c94e473c73c` |
| Endpoint identity after restart | `sha256:1e0a0c94e473c73c` |
| Grant after restart | Reused; protected-resource proof remained healthy |
| Conversation | Saved long chat reused (`existing-long-chat`) |
| Workspace identity | Expected name and `4e2618d06c4f`; `workspace_info` reported consistent before and after restart |
| Read-only call | Root listing and `README.md` read succeeded |

Named Tunnel recovery passed end to end: Bridge and Tunnel restarted at the
same endpoint, with no second pairing or OAuth authorization.

## Quick Tunnel rotation

The automated contract covers Quick Tunnel endpoint rotation, replacement
fingerprints, and the follow-on OAuth action. A real isolated Quick Tunnel
established an endpoint with fingerprint `sha256:08944c0b12e3f81e`, but later
fresh public-health probes ended as `probe_inconclusive` after the connection
was reset upstream. No second healthy fingerprint was accepted, so the real
rotation smoke remains **inconclusive**, not passed. The isolated Bridge,
Tunnel, and state directory were stopped and removed; the Named setup was not
changed.

## Scope boundary

The smoke uses the built-in browser, Cloudflare Named/Quick Tunnel, the public
doctor contract, OAuth, `workspace_info`, and read-only MCP calls. It does not
use OpenCLI, Secure MCP Tunnel, an unsupported ChatGPT Connector CRUD API, or
any write-capable MCP tool.

## Current SR04 acceptance procedure

Run this procedure only after the candidate is integrated, and record the exact
output of `git rev-parse HEAD`. First run `pnpm typecheck`, `pnpm build`, and the
full `pnpm test` suite at that SHA. These checks do not prove native Windows or
ChatGPT behavior.

Using real Codex tasks and redacted evidence, perform interleaved reads from two
different projects in the order A-B-A-B-A. Restart the Bridge and configured
Tunnel, repeat the sequence, and confirm each task still reads its own distinct
file. With two tasks in one project, confirm their conversation URL and
checkpoint progress remain independent before and after restart. For a stable
endpoint and valid grant, record that no new OAuth page appeared. Separately
verify that unpair/revocation and an endpoint identity change reject old
bindings rather than bypassing OAuth.

Reconcile the historical Quick Tunnel result with its original redacted source;
if that source cannot prove a completed rotation, rerun the controlled Quick
rotation at the same candidate SHA. Record only endpoint fingerprints, outcomes,
conversation disposition and workspace ids. Never record binding tokens, OAuth
credentials, pairing codes, cookies, browser storage or raw task histories.

Run the Windows process behavior on a Windows host before claiming native
Windows acceptance. Passing macOS unit tests only proves argument construction.
