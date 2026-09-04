# Recovery smoke record

Date: 2026-09-04

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
