# Validation record

## Live acceptance — 2026-09-20

One real local Codex project task used ChatGPT Chat with visible 6 Pro.
After explicit OAuth consent, a fresh signed connection proof included
review.submit; a new local binding and real README/source-file reads succeeded.

Two consecutive review rounds each completed:
question sent → Codex turn ended → real complete_review notification →
new Codex turn → original Chat opened → full reply read and analyzed →
acknowledgement. The second round was an actual follow-up, not a replay.
The coordinator sent the initial kickoff only, not replacement wakeups.
Final session was DONE and its binding was removed.

The earlier attempt passed one round but hit a platform safety refusal on the
second. The specific classifier cause remains unknown. The later successful
test used explicit write scope and freshly authorized binding; this does not
prove a general exemption from safety checks.

## Separate evidence

- Automated tests cover local authorization, credential-field allowlisting,
  workspace/session isolation, conflicting owners, restart readback, duplicate
  delivery, stale rounds and uncertain dispatch.
- Four-lane routing tests are not proof of four concurrent live async loops.
- Two successful live rounds are not proof of sleep/wake, closed-App delivery,
  remote hosts, or every future platform version.
- No per-call confirmation click was observed in the successful test; that UI
  path remains unverified. Existing permissions allowed tool actions.

## Retrospective

1. Verify actual requested and granted scopes. Ordinary settings Reconnect
   retained the old read scopes; the tool-level OAuth prompt requested
   review.submit. Existing tests enforce the missing-scope rejection/challenge.
2. Rebind after scope expansion. The platform automatically retried the old
   request, which correctly failed with WORKSPACE_BINDING_MISMATCH.
3. Keep the deployable Skill in the repository. Personal runtime paths belong
   to installation configuration, not the shared workflow. The existing
   test/CI pipeline now checks local reference targets and path portability.
4. Keep notification, readback, advice disposition and authorized completion
   separate. A read-only consultation can finish without a code change.

Private local transcripts and credentials are not included in this document.
This is an acceptance summary, not a portable reproduction of an authenticated
browser session. Re-run the Skill's two-round procedure on each target setup.
