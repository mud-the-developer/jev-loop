# JEV-assisted dynamic loops

## Change classification

This is an opt-in feature, not a reproduced upstream bug. Completion quality and
approval reduction are product hypotheses until live operator/model trials.
The first MVP reuses dynamic loops; workflows, TaskStore, monitors, and
pi-subagents remain separate owners. No new worker engine, daemon, or automatic
provider fallback is introduced.

## Acceptance expectations (before implementation)

1. `LoopCreate` accepts an optional `completion` policy for an idle/dynamic loop.
   The policy contains an English `goal`, English `criteria` (1–8 bounded items),
   and `verification` with a fixed executable `command`, literal `args`, and an
   English `description`. Require an explicit positive finite `maxFires`.
   Cron/event/hybrid, autoTask, taskBacklog, and non-recurring combinations are
   rejected without mutation. The original display prompt may be Korean.
2. Show one native confirmation of the exact goal, criteria, verifier, working
   directory, fire limit, expiry, and bounded English evidence disclosure before
   creating/activating the opted-in loop. Decline, missing UI/provider, invalid
   input, abort, or changed session creates no controller and starts no process.
   Existing mandatory tool/permission/transmission approvals are not bypassed.
3. Persist the policy as immutable LoopStore-owned controller intent, not an
   approval token. In-memory approval is bound to the controller creation,
   store, working directory, runtime/session generation, and exact policy.
   Never reconstruct execution authority from disk. After restart/switch,
   provider error, invalid execution, or cancellation, require fresh exact
   approval before further effects. A verifier's ordinary nonzero exit is an
   unmet check: bounded repair does not repeat setup approval.
4. For an opted-in loop, `LoopUpdate(status="completed")` requires a separate
   bounded English `completionEvidence` summary. Local state/metrics, user
   originals, source, filenames, command arguments, stdout/stderr, credentials,
   and transcript history are not automatically forwarded to JEV. Parent-owned
   prose must be prepared in English before approval/transmission; a script
   guard is not a semantic English-language detector. Non-Latin prose must not
   bypass the guard by appearing in quotes/code blocks.
5. Execute only the fixed, approved verifier, in the approved working directory,
   with a bounded timeout and cancellation. Use a direct Node child process with
   literal argv and POSIX process-group cleanup, never shell interpolation,
   another worker runtime, or a new scheduler. Pi 1.2.0's exec adapter loses
   signal exit information; the verifier must retain actual code/signal, abort
   the group, and escalate a resistant process to SIGKILL. The current bound is
   30 seconds, with a 250 ms termination grace; an entire review is bounded to
   120 seconds and the controller's remaining lifetime. Windows completion is
   rejected until equivalent cleanup is implemented and tested.
   A caller-provided success flag or worker self-report is not verification.
   Verifier stdout/stderr are ignored, not collected or sent to JEV. A failed
   check cannot complete a loop.
6. Consult the existing public `jev_decide` tool through Pi's nested-tool API,
   preserving tool-call/permission handlers. Send one bounded English packet:
   goal, all criteria, approved verifier coverage, actual exit outcome, and an
   explicitly untrusted parent progress summary. Ask whether ALL criteria are
   supported, with `met`, `unmet`, and `unknown` alternatives. Missing, conflicting,
   or inadequate evidence means unknown; exit zero alone proves no extra facts.
   The reply is advice, not proof or permission. Strictly validate the provider
   result, including the supported chosen candidate; never invent support.
7. `met` plus passed required verification completes through the existing
   locked dynamic-loop stop path, without another completion confirmation.
   `unmet` or a failed verifier permits continuation only within the original
   budget. `unknown` holds completion for permitted additional evidence/review;
   it is never converted to success. If `jev_decide` returns `needs_user`, retain
   its exact `askUser` handoff instead of overriding its decision contract.
   Provider failure/timeout/cancellation is a held/error outcome, not success,
   an automatic retry, a provider switch, or extra authorization.
8. Recheck session/generation, store, controller creation, policy, live status,
   iteration/update identity, and expiry after each awaited boundary and before
   any new effect or final CAS. A concurrent review cannot spawn duplicate
   checks/requests. Stale/rejected results cannot stop, resume, or wake work.
   Teardown aborts owned verification; no approval survives runtime invalidation.
9. An opted-in controller reaching its fire cap remains inspectable as a
   controller-limit pause, not a successful completion. Permit its final fired
   iteration to submit a verified completion, but never generic resume/continue
   past the cap. Expiry, cancellation, and inspection grant no budget renewal.
10. Ordinary loops retain existing behavior and schemas remain stable across
    requests. Workflow and orchestration updates remain rejected by LoopUpdate.
    Read-only presentation neither claims work nor starts verification or JEV.

## Required evidence

Add tool-level expectations first and run them against the unchanged feature
implementation, preserving the behavioral failures outside committed fixtures.
Keep a nearby ordinary-loop passing control. Then implement and rerun the same
expectations. This is feature red/green evidence, not proof of an upstream bug.

Cover met/unmet/unknown, failed/missing/malformed provider replies, failed and
cancelled verification, no repeated approval within one live scope, rejection of
Korean input (including quoted/code-fenced prose), absent policy/provider/UI,
changed policy/goal attempts, concurrent calls, file-backed peer mutation,
restart, generation switch during approval/verification/JEV, final fire cap,
expiry, and cleanup. Retain generated reducer/property coverage. Use fake JEV
and verifier effects for deterministic tests; they do not establish live JEV
quality, shell safety, or unattended operation.

Run the repository gate from `TESTING.md` and an isolated public/nested-tool
integration check. Live model/provider trials require the configured provider
and their ordinary approvals; missing configuration is not a pass. Do not add
new dependencies, send credentials, auto-install/start a JEV backend, change the
vendored RPC protocol, or publish a release as part of this MVP.

## Using the MVP

See the [README's LoopCreate example](../README.md#jev-assisted-completion).
`completion` is optional and available only to recurring idle loops with an
explicit positive `maxFires`. `/loop` shorthand remains unchanged. The setup is
immutable; cancel and recreate explicitly if its goal, criteria, or verifier
must change. Inspect `LoopList` for the frozen English criteria and coverage.

When work appears ready, submit these `LoopUpdate` arguments (using its actual ID):

```json
{
  "id": "1",
  "status": "completed",
  "completionEvidence": "The requested behavior was exercised and the required automated checks pass."
}
```

The parent must author that semantic summary in English. Non-Latin letters are
rejected even inside quotes and code fences; Latin-script text still relies on
the caller's English-language contract. A summary is untrusted, not proof.

`met` plus actual verifier success deletes the controller through its locked
completion path. `unmet`/nonzero verification retains it: repair permitted work
and call `LoopUpdate` with `status="continue"` within the remaining fire budget.
`unknown` retains it for permitted additional evidence; identical advice is not
polled repeatedly. `needs_user` preserves the exact existing tool handoff.
Provider failures/cancellation do not retry, fall back, or claim success.
Deletion via `LoopDelete` is explicit cancellation, not verified completion.

`maxFires` bounds wakes, not the total price of main-model or review calls.
There is no claimed dollar cap. Ordinary permission gates can still block a
nested JEV call. Persisted intent survives only according to the normal storage
contract; approval is process-local and is never restored from disk.

## Verification scope

Deterministic tests cover public tool acceptance, actual executable exit/signal
and cancellation behavior, final-fire wake delivery, file-backed peer races,
restart approval, generated budget/ABA invariants, and the real Pi SDK's nested
permission hooks. The SDK integration uses synthetic assistant messages and a
fake JEV tool; it makes no external model request. Tests do not prove live JEV
accuracy, actual terminal-dialog usability, Windows cleanup, unattended
execution, or containment of a command that deliberately escapes its process
group. See [TESTING.md](./TESTING.md) for the full gate.

## Operator notes

The parent translates semantic summaries, not identifiers or executable args.
Keep user originals local. The verifier is an approved local command, not a
sandbox: commands can have side effects and inherit the Pi process environment.
Do not use secrets in the policy or evidence summary. Ordinary mandatory
permissions can still request approval. Pi must be running for loops to execute.

The original pi-loop extension, the pi-jev-loop fork, and jev-loop must not
register `/loop` and the same tool names together. jev-loop is an independent
repository/package, retaining upstream Git history and MIT attribution. The
source-only development package is private; no npm release is authorized.
