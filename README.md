<p align="center">
<h1 align="center">jev-loop</h1>
<h6 align="center">JEV-assisted completion on top of durable Pi loops, workflows, tasks, and monitoring.</h6>
</p>

An independent project derived from [pi-loop](https://github.com/trvon/pi-loop) 0.7.18, retaining its Git history, MIT license, and attribution. The package is `jev-loop@0.1.0-dev.0`, source-only and private to prevent npm publication. There is no automatic release workflow; the inherited CHANGELOG records upstream releases, not jev-loop releases.

This project focuses on English-only JEV inputs, minimal repeated approval within an authorized scope, and evidence-gated automatic completion. The inherited execution core is retained rather than rewritten.

## Install from source

```bash
git clone https://github.com/mud-the-developer/jev-loop.git
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

`/jev-loop` without arguments opens the native menu. The parent prepares the English criteria and a known fixed verifier; the exact setup is approved once before creation. Defaults proposed for approval are five fires and one hour, not unlimited execution. If the agent is busy, setup waits only in memory and `/jev-loop cancel` can revoke it before handoff. No backend is installed or configured automatically.

A sent setup request is not a created loop. Once handed to the parent, reject its setup approval or abort that agent turn if no controller exists yet; cancellation targets only observed JEV controllers. Ordered workflows are outside this entrypoint's completion support. [Detailed boundaries](./docs/JEV_LOOPS.md).

The inherited ordinary command remains available for scheduled, event-driven, or self-paced loops:

```text
/loop 5m check the deploy
/loop event tasks:created process the backlog
/loop finish the release
```

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

Approve the exact bounded setup once in the native dialog. When ready, call `LoopUpdate` with `id`, `status="completed"`, and a separate non-sensitive English `completionEvidence` summary. The fixed verifier must actually pass and JEV must recommend `met` before automatic completion. `unmet` permits bounded rework; `unknown` holds completion. Verifier output, original prompts, and local state/metrics are not forwarded to JEV. The parent must exclude secrets and private artifacts from its summaries.

No repeated setup approval for ordinary rework in the same live scope. Restart, cancellation, invalid execution, or a provider error requires fresh approval; existing mandatory permission/transmission gates remain. A fire-cap pause is not success and cannot extend its budget. [Contract, examples, evidence and limitations](./docs/JEV_LOOPS.md).

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

The operator-mediated JEV acceptance target is `npm run test:e2e:jev`; without an explicit human/UI client it reports SKIP, not a pass. It never auto-approves or reads backend credentials. Current live-model/physical-terminal acceptance remains unverified; see the [operator procedure](./docs/TESTING.md#operator-mediated-jev-acceptance).

See [testing](./docs/TESTING.md) for local, property, package, benchmark, and live E2E gates. Contributors and agents must also follow [AGENTS.md](./AGENTS.md).

## License

MIT — [LICENSE](./LICENSE)
