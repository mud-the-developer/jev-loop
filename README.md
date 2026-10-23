<p align="center">
<h1 align="center">jev-loop</h1>
<h6 align="center">JEV-assisted completion on top of durable Pi loops, workflows, tasks, and monitoring.</h6>
</p>

An independent project derived from [pi-loop](https://github.com/trvon/pi-loop) 0.7.18, retaining its Git history, MIT license, and attribution. The package is `jev-loop@0.1.1`, distributed through [GitHub releases](https://github.com/mud-the-developer/jev-loop/releases). The npm `private` guard remains enabled: this is not an npm publication. Releases are manual; the CHANGELOG separates jev-loop releases from inherited upstream history.

This project focuses on English-only JEV inputs, minimal repeated approval within an authorized scope, and evidence-gated automatic completion. The inherited execution core is retained rather than rewritten.

## Install the release package

Requires Node.js 22.19 or later and an existing Pi installation. Download and
validate the built package, then keep the extracted directory in a permanent
location because Pi registers its local path:

```bash
install_dir="$HOME/.local/share/pi-extensions/jev-loop-0.1.1"
mkdir -p "$install_dir"
cd "$install_dir"
curl --fail --location --remote-name https://github.com/mud-the-developer/jev-loop/releases/download/v0.1.1/jev-loop-0.1.1.tgz
curl --fail --location --remote-name https://github.com/mud-the-developer/jev-loop/releases/download/v0.1.1/SHA256SUMS
sha256sum -c SHA256SUMS
tar -xzf jev-loop-0.1.1.tgz --strip-components=1
pi install "$install_dir"
```

On macOS, use `shasum -a 256 -c SHA256SUMS` instead. The checksum detects
corruption or an unexpected artifact; it does not independently authenticate
the publisher. Only download from the intended release. Run `/reload` in an
existing Pi session, or start a new one, after installation. A local install
must not be deleted while its path remains registered.

## Install from tagged source

```bash
git clone --branch v0.1.1 https://github.com/mud-the-developer/jev-loop.git
cd jev-loop
npm ci
npm run build
pi install .
```

Load jev-loop **instead of**, not alongside, the upstream extension or pi-jev-loop fork: they register `/loop` and the same tool names. Existing `PI_LOOP_*` settings, store layouts, and RPC wire identifiers remain unchanged; sibling extensions import the public API from `jev-loop/api`. JEV completion also requires a configured extension exposing the public `jev_decide` tool and Pi 1.2.0's nested-tool API. This MVP's verifier requires POSIX (Linux/macOS); Windows completion fails closed.

jev-loop runs only while Pi is active. Persisted controller intent is not an always-on worker; ordinary pending wakes and monitor handles/output are memory-only. See the [runtime continuity matrix](./docs/RUNTIME_CONTINUITY.md) before relying on restart or unattended operation.

## Quick start

Start one self-paced JEV-assisted goal in your own language, then inspect or cancel it:

```text
/jev-loop 문서의 내부 링크가 모두 유효해질 때까지 개선해줘
/jev-loop status
/jev-loop status 1
/jev-loop cancel 1
```

`/jev-loop` without arguments opens the native goal dashboard in TUI mode (RPC keeps its native menu). The dashboard provides goal selection, observed review phases, criteria and recovery details: `↑↓` select, `Tab` focus details, `PgUp/PgDn` scroll, `g` prepare a goal, `x` request explicit cancellation, `m` toggle motion, `Esc` close. A compact goal summary stays above the editor. [Design and measurement contract](./docs/DASHBOARD_EVALUATION.md). The parent prepares the English criteria and a known fixed verifier; the exact setup is approved once before creation. The goal-first handoff proposes a finite adaptive range for one native approval, not unlimited execution; explicitly fixed limits remain supported. If the agent is busy, setup waits only in memory and `/jev-loop cancel` can revoke it before handoff. No backend is installed or configured automatically.

Moving within `/tree` cancels unfinished setup/dialog interactions from the old branch. Existing controllers stay session-wide with their original policy and budget; canceling a navigation does not cancel a valid dialog.

A sent setup request is not a created loop. Once handed to the parent, reject its setup approval or abort that agent turn if no controller exists yet; cancellation targets only observed JEV controllers. Ordered workflows are outside this entrypoint's completion support. [Detailed boundaries](./docs/JEV_LOOPS.md).

The inherited ordinary command remains available for scheduled, event-driven, or self-paced loops:

```text
/loop 5m check the deploy
/loop event tasks:created process the backlog
/loop finish the release
```

The ordinary native menus also discard late dialog replies after a committed branch/session/context change. Existing scheduled work is not canceled; reopen the menu in the current context to submit a new action.

Native fallback `/tasks` uses the same dialog boundary. Canceling its description prompt creates nothing; an intentionally blank description still defaults to the subject. Claimed tasks keep their existing token/lease checks, and task commands do not control workflow executions.

Or use the tools directly:

```text
LoopCreate trigger="5m" prompt="Check if the build passed" maxFires=12
LoopCreate trigger="tool_execution_start" prompt="Log the tool" triggerType="event" recurring=true
LoopCreate trigger="tasks:created" prompt="Process unfinished tasks" triggerType="event" recurring=true taskBacklog=true maxFires=25
LoopList
LoopDelete id="1"
```

`/loop event tasks:created ...` is treated as an explicit task-backlog worker: it adopts existing unfinished tasks, coalesces task-creation bursts, and re-wakes after each agent turn until the backlog drains. Tool callers opt into the same behavior with `taskBacklog=true`. Worker wakes are action-first: `TaskList`, claim/resume, concrete same-turn work, validation, then evidence—not a state report or promise to start on a later wake.

Run work in the background and wake the agent when it succeeds, fails, or becomes inactive:

```text
MonitorCreate command="python train.py" onDone="Analyze results and report best loss"
MonitorList
MonitorStop monitorId="1"
```

Run a finite batch of independent subagent work after the parent becomes idle:

```text
OrchestrationCreate goal="Review release readiness" work='[{"prompt":"Inspect API compatibility","agentType":"Explore"},{"prompt":"Review rollout risks","agentType":"Plan"}]' concurrency=2
OrchestrationGet id="1"
```

## JEV-assisted completion

Use `/jev-loop <goal>` for the guided entrypoint; ordinary `/loop` usage is unchanged. The parent prepares every JEV-bound natural-language field in English, even when the user's request is Korean. Advanced callers can supply the same policy directly through `LoopCreate`:

```json
{
  "trigger": "idle",
  "triggerType": "idle",
  "prompt": "필수 테스트가 통과하도록 수정하고 검증해",
  "maxFires": 5,
  "expiresIn": "1h",
  "completion": {
    "goal": "Make the required tests pass.",
    "criteria": ["The required automated tests pass."],
    "verification": {
      "command": "npm",
      "args": ["test"],
      "description": "The project's required automated test suite."
    }
  }
}
```

Approve the exact bounded setup once in the native dialog. When ready, call `LoopUpdate` with `id`, `status="completed"`, and a separate non-sensitive English `completionEvidence` summary. The fixed verifier must actually pass and JEV must recommend `met` before automatic completion. Completion has only `met`/`unmet`; missing evidence is `unmet`. An unmet review diagnoses deficient criteria and continues the same goal within its original bounds. Inspect the reported gaps, collect or repair real evidence, then request another review—not an uncertainty-only pause or unchanged repeat. Verifier output, original prompts, and local state/metrics are not forwarded to JEV. The parent must exclude secrets and private artifacts from its summaries.

No repeated setup approval for ordinary rework in the same live scope. Restart, cancellation, invalid execution, or a provider error requires fresh approval; existing mandatory permission/transmission gates remain. A fire-cap pause is not success and cannot extend its budget. [Contract, examples, evidence and limitations](./docs/JEV_LOOPS.md).

Explicit JEV pause/delete through `/loop` management or `LoopDelete` drains owned local review before acknowledgement. `LoopUpdate paused` does the same only after its progress update succeeds. Remote service quiescence is not inferred.

### Completion review diagnostics

A completion attempt returns bounded local observations in
`LoopUpdate.details.completionReview`, retained with that parent tool result in
Pi's session history. It records the actual verifier exit/coverage, assessment
scope (`"all"` or a one-based criterion), encoded context length and SHA-256,
and validated advice choice/confidence/probabilities/model. It contains no raw
question/context, progress summary, original goal, command/argv, cwd or verifier
output. It is not telemetry, new evidence, execution authority or proof of
completion; it does not change the public JEV request, candidates or threshold.

At most one overall assessment and eight focused diagnoses are recorded per
attempt. An absent verifier means it was not observed; `unobserved` advice
means no accepted response was recorded, not proof of non-delivery. Canceled,
stale or malformed responses cannot become accepted observations. Human
handoffs and existing errors remain unchanged. Old reviews are not reconstructed
from persisted intent, and a receipt alone never authorizes another review.

### Adaptive operating budgets

Opt in with `completion.budgetRange: { minFires, minExpiresIn }`; top-level
`maxFires` and explicit `expiresIn` are the immutable **total hard ceilings**.
The native dialog approves both ends once before JEV sees the budget request.
JEV chooses finite min/mid/max tiers through binary comparisons (at most four
initially and after a fire). A sole possible value needs no model request.

The hard lifetime starts once at genuine approval; initial waiting is separate.
`LoopUpdate` reviews the operating allocation after work, using optional
separate non-sensitive English `budgetEvidence` or safe numeric facts—not raw
state/metrics. Missing budget evidence never borrows `completionEvidence`,
including automatic continuation after an unmet completion review. An unchanged decision is not repeatedly queried in the same
fire. Completion `met` closes without a needless budget renewal.

Operating exhaustion is a `budget_limit` checkpoint, not authority to resume.
Only a valid in-envelope review can renew that checkpoint. It cannot reset the
original start, raise hard ceilings, resurrect an administrative/cancelled/
expired/hard-capped goal or renew a legacy fixed loop. Restarts require fresh
native range authority. `LoopList` and the dashboard distinguish operating
limits from total hard limits and stored intent from observed review. Dashboard
budgets use separate **Fires** and **Time** rows: `run` is the current operating
allocation and `hard` is the approved total ceiling. Fire counts are accounted
requests, not inferred delivered wakes; time values show remaining lifetime.

These are source features; examples and tests do not approve an actual run.

### When completion is held or fails

| Situation | Next action |
|---|---|
| Required check exits nonzero | Same-goal rework is recorded with the exit code; inspect and repair within the same approved budget |
| JEV says unmet, including missing evidence | Focused criterion checks identify gaps, then the same goal continues; resolve actual local causes before another review |
| Fixed verifier cannot start/finish | Inspect the command locally; cancel and recreate if the fixed scope is wrong |
| JEV advice is unavailable, blocked or malformed | Check the configured provider and tool permissions; do not retry automatically |
| Local storage/settlement error | Inspect current state first: a write may already have happened; never infer completion or rollback from an absent ID |
| Immutable policy alone exceeds JEV's encoded context bound | New setup is rejected before approval; cancel/recreate an older policy with shorter prose rather than repeatedly shortening evidence |

Malformed JEV persistence metadata follows previous-snapshot recovery or a visible corruption error, never guessed identity/cwd or restored approval.

## What it provides

- Cron, event, hybrid, dynamic goal, and opt-in workflow loops
- Idle-safe agent re-wakes with dynamic-loop restart/session-switch recovery
- Observable loop expiry with a seven-day default, configurable through `PI_LOOP_EXPIRES_IN` or per-creation `expiresIn`
- Background command monitoring with buffered output, `onDone` wakes, and renewable inactivity alerts
- Optional `pi-tasks` integration and a native task fallback
- Session-scoped, bounded async subagent orchestration through protocol-v2 `pi-subagents`
- Session-isolated persistence and a compact TUI status line

> **Research note:** These features are designed to benefit my research. The loop may drive this tool toward unexpected design choices, so treat those choices as experimental and review them before relying on them.

## Commands and tools

| Surface | Purpose |
|---|---|
| `/jev-loop` | Goal-first JEV setup, read-only status, and scoped cancellation |
| `/loop` | Create or manage ordinary scheduled, event, and dynamic goal loops |
| `/tasks` | Manage native fallback tasks when `pi-tasks` is absent |
| `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopDelete` | Create and control ordinary loops |
| `WorkflowCreate`, `WorkflowClaim`, `WorkflowRevise`, `WorkflowTransition` | Create, claim, revise, and advance workflows; paused terminals require trusted blocker admission |
| `OrchestrationCreate`, `OrchestrationGet` | Run and inspect a durable finite batch of independent async subagent work; distinct from provider-native `SubagentWorkflow`; cancel with `LoopDelete` |
| `MonitorCreate`, `MonitorList`, `MonitorStop` | Run and inspect background commands |
| `TaskCreate`, `TaskList`, `TaskClaim`, `TaskHeartbeat`, `TaskUpdate`, `TaskDelete` | Native fallback task management |

Choose one owner: workflows for one goal with ordered phases/outcomes/rework/handoff, standalone tasks for independently completable backlog items, and dynamic loops for a self-paced goal without phase routing. Persist unfinished task/loop progress or workflow plan changes in that owner, then continue while work remains actionable.

See the [usage guide](./docs/USAGE_GUIDE.md) for operator workflows and the [reference](./docs/REFERENCE.md) for authority, persistence, mutation, RPC, and recovery boundaries.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
# Opt-in real Pi/LLM workflow conformance
PI_LOOP_LIVE_MODEL="<provider/model[:thinking]>" npm run test:e2e:workflow
```

The operator-mediated JEV acceptance target is `npm run test:e2e:jev`; without an explicit human/UI client it reports SKIP, not a pass. It never auto-approves or reads backend credentials. A controlled-parent run has passed with real human approval, local verification, public JEV advice and guarded completion; this does not establish autonomous-parent, physical-terminal or population-level usability acceptance; see the [operator procedure](./docs/TESTING.md#operator-mediated-jev-acceptance).

See [testing](./docs/TESTING.md) for local, property, package, benchmark, and live E2E gates. Contributors and agents must also follow [AGENTS.md](https://github.com/mud-the-developer/jev-loop/blob/v0.1.1/AGENTS.md).

## License

MIT — [LICENSE](./LICENSE)
