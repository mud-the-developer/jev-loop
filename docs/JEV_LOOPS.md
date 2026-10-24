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
   TUI uses a scrollable exact-text review with fixed countdown and choices;
   RPC retains native confirmation. Neither path grants automatic consent.
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
   30 seconds, with a 250 ms termination grace. Initial approval and completion
   review are bounded by the controller's remaining lifetime and cancellation,
   not a separate 120-second cap. Waiting never extends expiry or fires.
   Windows completion is rejected until equivalent cleanup is implemented and
   tested.
   A caller-provided success flag or worker self-report is not verification.
   Verifier stdout/stderr are ignored, not collected or sent to JEV. A failed
   check cannot complete a loop.
6. Consult the existing public `jev_decide` tool through Pi's nested-tool API,
   preserving tool-call/permission handlers. Send one bounded English packet:
   goal, all criteria, approved verifier coverage, actual exit outcome, and an
   explicitly untrusted parent progress summary. Ask whether ALL criteria are
   supported, with only `met`/`unmet` alternatives. Missing, conflicting or
   inadequate evidence is `unmet`; exit zero alone proves no extra facts.
   For aggregate unmet, assess each criterion's support with a focused binary
   question and the same full context. Never drop other criteria to fit a
   packet. Setup discloses one aggregate and up to eight focused assessments.
   Replies and diagnoses are advice, not proof or permission; validate them.
7. `met` plus passed required verification completes through the existing
   locked dynamic-loop stop path, without another completion confirmation.
   `unmet` or a failed verifier records the diagnosed deficiency and
   automatically continues the same goal only within its original budget.
   The agent must inspect actual evidence, identify the missing fact or failing
   behavior, and collect or repair before another review. Mere uncertainty is
   not a pause instruction. Genuine authority, cancellation, expiry and cap
   blockers remain stops. `needs_user` retains its exact `askUser` handoff.
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

Cover binary met/unmet, rejection of legacy unknown replies, focused diagnoses,
automatic bounded continuation, failed/missing/malformed replies, failed and
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

## Goal-first MVP expectations

The `/jev-loop` command is an opt-in usability feature, not a replacement for
`/loop`. Before implementation, the observable expectations are:

- A natural-language goal is handed to the parent only when idle. The parent
  prepares English completion policy and a known fixed verifier, proposes a
  finite range-approved adaptive budget (or explicitly requested fixed limits), and uses existing LoopCreate
  plus its exact native approval. A setup request is not execution permission
  or proof that a controller was created. Ordered workflows remain a separate
  owner; this entrypoint must not invent JEV support for them.
- At most one setup waits in memory. Cancellation, abort, stale generation,
  session/store/cwd replacement, and missing/disabled JEV suppress its handoff.
  No early follow-up message, persistent approval, new timer or backend fallback.
  A committed `/tree` move also aborts old command dialogs and clears pending
  setup, even though the session ID stays the same. A vetoed move does not.
  Ordinary `/loop` dialogs share this same memory-only context guard, including
  scheduled/event creation and management actions; existing controllers and
  unchanged live completion approval are not revoked by dialog invalidation.
- `status` only inspects existing JEV controllers and pending setup. It must not
  claim work, start verification, call JEV, or imply a live review is running
  solely because a reservation exists.
- `cancel` revokes only an observed JEV controller using creation identity CAS,
  removes its trigger, and drains owned local verification/review before the
  acknowledgement. It does not assert remote model-service quiescence. Other
  loop/workflow/task/orchestration owners remain unchanged. JEV pause/delete
  from the legacy `/loop` manager and `LoopDelete` use the same creation-fenced
  lifecycle handler. `LoopUpdate paused` retains its progress CAS, then drains
  only after that CAS succeeds. An unavailable handler or stale selection must
  not fall back to raw store mutation.
- Missing/oversize goals and invalid control arguments fail without mutation.
  Normal `/loop` behavior and registered tool schemas remain stable. Native
  menu/input/status controls are used instead of a new terminal renderer.

Test these through registered commands, real file-backed peers and controlled
callbacks before implementation, with an unchanged `/loop` passing control.
Live checks use only non-sensitive English fixtures under their explicit finite
approved bounds, no paid workers and no automatic retry on failure. Historical
campaign call limits are not an account-wide limit or a budget-policy default. Synthetic SDK/UI tests are
not evidence of live-model quality or physical terminal usability.

## Using the MVP

Start with `/jev-loop <goal>` (or its blank native menu), inspect with
`/jev-loop status [id]`, and explicitly cancel with `/jev-loop cancel [id]`.
Setup proposes finite upper hard limits and lower adaptive bounds for native
approval; JEV selects operating allocations only after that approval. Fixed
limits are retained when explicitly requested. The command hands the goal to
the parent only when idle; it does not itself create
or approve a controller. Before handoff, cancel revokes the memory-only pending
request. After handoff but before creation, reject the native setup approval or
abort the agent turn; the command does not claim to cancel unobserved work.

Tree navigation revokes only unfinished command interactions: already-created
controllers remain session-wide with the same frozen policy and expiry. A new
branch is not a budget renewal. Existing live approval for that unchanged scope
is not needlessly requested again; restart and scope replacement still require
fresh approval.

For advanced tools, see the [README's LoopCreate example](../README.md#jev-assisted-completion).
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
completion path. `unmet`, including evidence gaps, diagnoses criteria and
persists same-goal rework with an idle-safe wake inside the original bounds.
Nonzero verification is diagnosed from its exit code without speculative JEV
calls. Inspect/repair or collect genuine new observations, then persist actual
progress or submit updated English evidence. Scheduling rework alone is not
new evidence: an immediate unchanged review is rejected. `needs_user` preserves
the exact existing tool handoff. Legacy unknown replies are malformed, not an
implicit approval or an automatic continuation.
Provider failures/cancellation do not retry, fall back, or claim success.
Deletion via `LoopDelete` is explicit cancellation, not verified completion.

`maxFires` bounds wakes, not the total price of main-model or review calls.
There is no claimed dollar cap. Ordinary permission gates can still block a
nested JEV call. Persisted intent survives only according to the normal storage
contract; approval is process-local and is never restored from disk.

## Completion packet admission

English goal, all criteria, verifier coverage, exit outcome and evidence share
the public JEV context bound of 4,000 encoded JSON characters. Individual schema
limits do not guarantee their escaped combination fits. New setup is rejected
before approval or creation if even one evidence character cannot fit; no
criterion or approved text is truncated. A larger actual evidence summary can
still require shortening within the same total bound.

Existing oversized stored policies remain inspectable/cancellable rather than
being reclassified as corrupt storage. Their review is held with an explicit
cancel-and-recreate action because their immutable policy cannot be repaired by
shortening evidence alone. No approval or verifier/JEV effect is started.

## Persistence and failure diagnostics

Stored JEV controller identity, working directory, completion-version counter,
identity timestamps and review reservations are validated on reload. JEV fire
counts must be recorded safe integers in `0..maxFires`; required dynamic progress
and its iteration/optional field types must also be intact. Malformed current state uses the
existing previous-snapshot recovery; if neither snapshot is valid, corruption
remains visible and the bad files are not silently replaced with guessed
identity, cwd or approval. Ordinary legacy controllers remain readable.
Expired, structurally valid reservations are still readable, not authority to
retry; restart requires the existing fresh approval rules. A bad counter is not
clamped/reset and missing progress is not guessed: recovery uses only the prior
valid snapshot and retains its normal continuity limitations. The ordinary
legacy missing-counter convention remains separate. An intact exhausted JEV
cap stays paused without renewal, while recovered final progress can still be
submitted for verified completion before expiry.

Verifier-start failures and rejected/unavailable/malformed JEV advice identify
the failed phase with safe next actions, without copying raw provider errors or
verifier output. A declined setup requires a fresh explicit user request, not
auto-resubmission. Trusted storage corruption and settlement I/O errors stay
visible. A settlement error can occur after a write: inspect the current store
and external effects before deciding what, if anything, to retry. An error or
missing ID does not prove rollback, completion, or permission for another run.

## Verification scope

Deterministic tests cover public tool acceptance, actual executable exit/signal
and cancellation behavior, final-fire wake delivery, file-backed peer races,
restart approval, generated budget/ABA invariants, and the real Pi SDK's nested
permission hooks. The SDK integration uses synthetic assistant messages and a
fake JEV tool; it makes no external model request. Tests do not prove live JEV
accuracy, actual terminal-dialog usability, Windows cleanup, unattended
execution, or containment of a command that deliberately escapes its process
group. The goal-first SDK tests also use a synthetic parent and JEV; they do
not measure natural-language planning accuracy. They exercise actual process
exits `[7,0]` during repair, one setup approval, and a permission-blocked JEV
call. Real SDK `navigateTree` cases fence stale input/cancel dialogs, preserve
vetoed navigation, and retain the unchanged session-wide goal scope. An operator-mediated live
attempt reached the SDK setup approval, but approval was canceled/expired:
no JEV request was relayed and no positive product end-to-end result is claimed.
Before the binary policy change, a direct public-tool check observed
`jev-1.13.0` return `met`, `unmet` and `unknown` for three distinct non-sensitive
English fixtures. Those responses passed the then-current three-way parser;
they do not certify the new binary/diagnostic policy, which rejects unknown. This is public-tool conformance,
not a native-approved controller auto-completion or model-accuracy benchmark. See
[TESTING.md](./TESTING.md) for the full gate and operator procedure.

## Bounded approval viewport

A real Pi 1.3.0 / Bun 1.4.3 terminal probe reproduced clipped native approval
choices and countdown at 100×30. This fix preserves every exact setup and
disclosure field but scrolls that body separately from the fixed controls.
Up/Down, PageUp/PageDown, Home/End and the mouse wheel scroll; Tab/Left/Right
changes No/Yes, Enter selects, and Escape/Ctrl+C cancels. No is the initial
choice. An unreadable terminal cannot grant approval; resize or cancel.

The TUI uses Pi's custom surface and existing Text, ScrollView, Container and
SelectList components with the host theme. RPC retains native confirmation.
Both use the controller's original expiry as their absolute deadline.
Resize/scroll does not reset it. The earlier 120-second timing observations
below describe the policy before the explicit expiry-bound policy change. Timers and
abort listeners are cleaned up; custom UI failure never grants consent or
starts a fallback. Interruption messages distinguish timeout, lifetime expiry,
caller/context cancellation, session shutdown and declined/dismissed consent,
without exposing arbitrary abort reasons.

The patch was ported onto installed-source base `2f118c5` on a separate branch.
Its pre-change bundle SHA-256 matched the installed snapshot byte for byte.
Packet-fit admission, stale-scope error classification, review/cancel phase
tracking, storage error visibility, native goal/dashboard commands, monitor
readiness, RPC identifiers and package branding were retained rather than
replaced by the older fork.

Regression-first command:

```bash
npm test -- test/jev-approval-ui.test.ts test/jev-loop-tools.test.ts
```

The unchanged installed-source runtime produced 23 failed presentation/diagnostic
expectations, alongside 69 passing controls and one Windows-only skip. In
particular, approval timeout returned `Review cancelled` instead of its cause,
and the bounded TUI path was never invoked. Earlier real PTY evidence establishes
actual clipping; missing custom calls alone are not that rendering evidence.
After repair, all 23 new cases passed. Focused validation passed 117 tests, with
one Windows-only skip:

```bash
npm test -- test/jev-approval-ui.test.ts test/jev-loop-tools.test.ts \
  test/jev-loop-runtime.test.ts test/jev-loop-sdk.test.ts \
  test/property/jev-completion.property.test.ts test/goal-dashboard.test.ts \
  test/tool-copy-budget.test.ts
```

The full local gate passed: lint, typecheck, 99 test files / 1,585 passing tests,
build, package smoke (82 files), audit (zero vulnerabilities), and diff checks.
Three existing Windows-only tests were skipped, not passed; the terminal
completion suite is POSIX-only, matching the current verifier boundary. The
two existing lint warnings and one information diagnostic were unchanged.

Real installed-host PTYs then tested this exact source in fullscreen and
regular modes. All 18 captures across 160×60, 100×30 and 48×16 showed the
countdown and both choices. Fullscreen timings were 120.004 s timeout, 6.001 s
expiry and 3.214 s scripted Escape; regular timings were 120.004 s, 6.006 s and
3.216 s. All controller, verification, advisory, activation, trigger, fetch
and agent-run sentinel counts remained zero. Both hosts and probes exited 0.
Probe commands and receipts remain in private temporary storage rather than
being shipped as machine-specific paths or replay commands.

Red/green logs and captures remain outside committed fixtures. Temporary
retention is not permanent archival. Synthetic unit consent uses fake effects;
real PTY probes never send Yes. This evidence is not a live approved
setup-to-verifier-to-JEV completion, physical operator study, universal terminal
compatibility, or release authorization. Package activation still requires
loading the reviewed snapshot; modifying checkout files alone cannot update an
already running extension. Reload invalidates process-local consent and
resources, never restoring approval from disk or retrying a cancelled goal.

## Herdr attention during model-tool approval

The viewport-only PTY tests invoked the tool through a test command. They did
not establish that the operator host noticed an approval requested during an
actual model tool call. In the reported session the new bundle was loaded,
but approval still expired at 120 seconds and the operator reported no visible
dialog. The physical terminal was 90×45 and the session had no image content.

The host was Herdr with its enabled, managed Pi integration (version 9).
That integration consumes `herdr:blocked` to distinguish waiting on a human
from ordinary model work. The working `ask_user` tool already pairs this event
around its UI; the JEV approval path did not. The fix reuses that existing
attention protocol for TUI approval only, before requesting the dialog, and
releases its own wait in `finally` on every outcome. RPC keeps its native
confirmation path. The managed host integration is not modified, and no new
host dependency or automatic UI fallback is introduced.

Only a constant generic label is announced; the exact policy, goal, cwd,
command/args and user input are not sent through this status event. It is not
an approval channel: observer return values and host delivery acknowledgements
cannot authorize work. Native consent, deadline/scope checks, and all existing
verifier/JEV permission boundaries remain required. Overlapping human waits
are balanced rather than globally cleared.

Regression-first command:

```bash
npm test -- test/jev-approval-host.test.ts test/jev-approval-ui.test.ts
```

Before the change, nine attention assertions failed while 27 controls passed:
there was no waiting event before the custom UI, and no owned wait to release.
The 13 host cases cover ordering, privacy, ignored observer approval, normal
accept/decline, UI error, caller cancellation, deadline, expiry, shutdown,
overlapping waits, RPC and pre-display rejection. Geometry coverage also
includes the observed 90×45 terminal, separately from host attention.

A separate local probe used the installed Pi SDK 1.3.0's normal model-tool
execution path (not the command shortcut), its permission hook, and the actual
unmodified managed Herdr bridge over a test-owned Unix socket. Its parent
messages and UI decision were scripted; it never selected Yes. Before the
fix, UI was requested once but host states were `idle → working → idle`, with
no waiting event. After the fix they were `idle → working → blocked → idle`,
with exactly one active/inactive pair. Both runs created zero controllers and
made zero verifier, advisory and external fetch calls. Probe commands and
receipts remain outside committed fixtures in private temporary storage.

An initial probe import used a CommonJS resolver for an import-only SDK export;
that bootstrap failure is retained separately and is not the behavioral red.
The successful probe uses the installed SDK's published ESM entry. No live
model, JEV service or original user goal was executed. Host-state delivery and
scripted rendering tests do not prove that this particular operator saw the
window: visual confirmation in the running client is still required after
loading the new snapshot. A canceled setup is never retried automatically.

## Expiry-bound approval and review

The operator explicitly requested removal of **both** the initial-approval and
completion-review 120-second caps. This is a requested policy change, not a
claim that a repository setting was an immutable platform limitation. The
runtime no longer has `REVIEW_TIMEOUT_MS`: approval, verification/advice review
and the persisted review reservation use the existing loop expiry instead.
The displayed approval explains the new bound. Verifier execution still has
its separate 30-second bound and process-group cleanup.

Loop lifetime, fire limits, caller/session cancellation, scope/identity/CAS
checks, fresh consent rules and supported-platform boundaries are unchanged.
Waiting does not reset the original expiry. A caller, test client, host or JEV
provider may retain its own earlier cancellation/timeout; this change does not
silently modify another component. The operator acceptance fixture separately
bounds approval waiting by its original one-hour deadline, then execution by
fifteen minutes after genuine approval clamped to that unchanged deadline. This
fixture policy does not change runtime approval, verifier or goal budgets.

A review reservation now lasts to loop expiry, so another process cannot
steal it merely because 120 seconds elapsed. After a crash, persisted intent
or reservation does not restore execution authority or prove work is running.
Inspect actual state/effects; an abandoned reservation may require explicit
cancellation and a newly approved controller rather than automatic replay.
Expiry/cancellation also does not prove remote-service quiescence.

Long lifetimes use chunked Node/Bun expiry timers rather than overflowing the
native timer range. RPC native dialog timeouts beyond that range are omitted;
the same scoped cancellation signal still enforces the actual expiry. TUI
continues to show the remaining loop lifetime. Neither path auto-approves.

Expectations were added before implementation in
`test/jev-review-lifetime.test.ts`. The unchanged implementation failed five
lifetime-policy assertions while 72 controls passed and one Windows-only case
was skipped. Approval after 121 seconds returned the old timeout, a 121-second
expiry was misreported, live advice/fresh-approval reservations disappeared at
120 seconds, and long native deadlines did not follow the new policy.
The same eight cases passed after the change, covering late met rejection,
exact expiry, file-backed peer exclusion, 30-day timers and the unchanged
30-second verifier bound. Older timeout assertions were updated to the newly
requested loop-expiry policy, not removed to manufacture a pass.

The full gate passed with 101 files / 1,607 passing tests and three existing
Windows-only skips. Lint retained its two existing warnings and one information
diagnostic; typecheck, build, package smoke (82 files), audit (zero
vulnerabilities) and diff checks passed. Focused conformance passed 131 tests
with one Windows-only skip.

Real wall-clock negative probes also crossed the former boundary. In a Pi 1.3.0
/ Bun 1.4.3 90×45 PTY, both choices and the loop-lifetime countdown remained
visible after 120 seconds; scripted Escape at 121.520 seconds closed the
request with no controller or effects. A separate installed-SDK 1.3.0 model-tool
/ managed-host bridge probe kept attention blocked for 121.506 seconds before
its scripted decline. Both exited 0 and made zero verifier/JEV/external fetch
calls. These are controlled negative tests, not a positive live completion or
human usability result. Local probe sources and receipts remain outside
committed fixtures in private temporary storage; their own 150-second safety
bounds were not changed into an execution permission.

## Binary diagnosis and same-goal continuation

The operator requested two completion outcomes rather than a separate
uncertainty destination. `met` requires adequate evidence and passed fixed
verification. `unmet` includes known failures and missing/conflicting evidence.
It is a work result, not an instruction to pause. This is a project policy
choice, not a mandatory provider or platform enum.

A nonzero verifier exit identifies the failed approved check locally, with no
speculative JEV call. When the aggregate classifier says unmet, the runtime
asks which individual criteria are unsupported. Each focused binary question
still carries the same full goal, every criterion, verifier coverage, exit
outcome and bounded English summary. Only the question focus changes; criteria
are not removed to make a packet fit. Setup discloses one aggregate and at most
one focused check per criterion. These are distinct assessments, not retries
of an unchanged question or an account-wide call budget.

The deficient criterion numbers/text are recorded as the current goal's next
work state. The agent must inspect authorized local observations, identify the
actual missing fact or failing behavior, then collect or repair real evidence
in that same goal. A classifier diagnosis is not causal proof, permission to
run another command, or permission to fabricate human observations. If every
focused assessment says met while the aggregate says unmet, reconcile the
combined evidence; never override the aggregate with a fabricated success.

Within the existing lifetime and fire budget, LoopUpdate persists continuation
through the existing store/reducer path and queues its normal idle-safe wake.
A full completion snapshot CAS rejects peer changes and same-time ABA before
continuation. Automatic scheduling is not new evidence: the same summary is
still rejected through an idle re-wake or interval-only update. Only an explicit
change in declared work state/metrics or a new English summary renews it;
the caller must describe actual work, not invent progress. Controller/CAS
versions are not evidence versions.
Fire-cap exhaustion, expiry, cancellation, stale scope, provider failure and
required human authority are not automatically resumed, retried or bypassed.
Post-write errors remain visible and never imply rollback.

The new core expectations failed behaviorally against the unchanged runtime
(11 failures alongside 69 passing controls and one Windows-only skip), before
implementation. The deterministic and generated tests retain immutable policy,
expiry, fire counts, one live setup approval, permission hooks and state-
preserving rejection. No new controller, worker engine, backend or configuration
was added. Existing stored goals/grants are not rewritten or resumed by this
source change; activation and fresh scope remain separate decisions. A real
index/session/scheduler integration regression also checks no delivery while
busy, an idle re-wake containing the criterion diagnosis, and rejection of the
same evidence after that wake. It first reproduced an erroneous completion
because wake-driven control-version changes were mistaken for new evidence;
the fixed guard remains stable across control-only transitions. Synthetic UI
and advice do not establish live diagnostic accuracy or product v1 completion.

The completed local gate passed 102 files / 1,627 tests with three existing
Windows-only skips, plus all 34 generated property tests. Typecheck, build,
package smoke (82 files), audit (zero vulnerabilities) and diff checks passed.
Lint retained only its two existing warnings and one information diagnostic.
The binary/focused permission routes use the real SDK with controlled replies;
no live provider, affirmative operator acceptance or original goal was executed
for this policy change. Source verification does not activate the old snapshot
or authorize a stored goal to resume.

## Opt-in range-approved adaptive budgets

A fixed goal keeps its original exact limits and waiting-time behavior. An
adaptive goal adds `completion.budgetRange` with positive `minFires` and
`minExpiresIn`; existing explicit `maxFires`/`expiresIn` are the upper total
envelope, not duplicated fields or a rolling renewal window. Range examples
are proposals only. Native approval is still mandatory before initial JEV
selection or execution.

The range dialog discloses lower/upper values, approval-request waiting expiry,
execution lifetime anchored once at genuine approval, and budget-data/call
policy. Initial JEV selection and each fire's update compare finite min/mid/max
tiers for fires and lifetime using at most two binary comparisons per axis.
This preserves the public decision handoff/support contract without treating a
nine-way low-confidence answer as permission. One possible value is chosen
deterministically, not reported as an observed JEV recommendation.

Only translated English goal/criteria, approved numeric bounds, allocation,
fire/elapsed counts and optional separate English `budgetEvidence` are sent.
Local progress strings, original goals, verifier paths/argv/output, history and
secrets are excluded. More budget is advice inside consent, not new authority.
Existing nested-tool permission handlers run for every comparison.

LoopStore owns persisted operating allocation, original start, revision and
last-reviewed fire; hard `maxFires` and `expiresAt` remain stable. An exact
snapshot and live review reservation fence allocation commits under lock.
Selections are monotonic inside the envelope, never lower a current allocation
or move the original hard boundary. The same fire and unchanged evidence do
not repeat budget advice. Genuine new English budget observations can support
another checkpoint review; changed private state alone is not budget evidence.

Operating exhaustion parks at `budget_limit`; generic resume is rejected.
A current approved review may renew only that checkpoint. Administrative
pause, cancellation, hard expiry and hard fire exhaustion never renew. An
initial operating time that elapsed while selection was pending creates a
checkpoint, not an initial work wake. Existing scheduling/heartbeat is reused;
there is no new timer, worker or controller engine. If an operating time elapses
while idle, the existing wake instructs a budget-only review before more work.
Final verified completion can settle an operating checkpoint without resuming
work, and `met` completion does not ask for more budget.

Provider failure, malformed replies, stale context, cancellation and conflicting
file-backed peers are state preserving before allocation commit and grant no
automatic retry or fallback. Persistence is intent, not restored authority:
a restart needs current native range approval even for a skipped same-fire
assessment. Acknowledged allocation/progress writes and later UI or scheduling
errors must not be mistaken for rollback. UI reports operating versus hard
limits and historical revision without inferring unobserved provider activity.

The new feature expectations ran first against the old implementation, with
four missing-feature failures and 76 passing controls plus one Windows-only
skip. Focused range, fixed-mode, soft/hard, restart, peer, privacy and property
checks use controlled UI/advice; they are not live-provider accuracy or v1
completion evidence. The pre-existing function-coverage threshold remains 96%
and is not waived by this feature.

## Operator notes
The parent translates semantic summaries, not identifiers or executable args.
Keep user originals local. The verifier is an approved local command, not a
sandbox: commands can have side effects and inherit the Pi process environment.
Do not use secrets in the policy or evidence summary. Ordinary mandatory
permissions can still request approval. Pi must be running for loops to execute.

The original pi-loop extension, the pi-jev-loop fork, and jev-loop must not
register `/loop` and the same tool names together. jev-loop is an independent
repository/package, retaining upstream Git history and MIT attribution. The
GitHub release package retains the npm private guard; npm publication is not
part of this distribution. Source builds must be completed before installation.
