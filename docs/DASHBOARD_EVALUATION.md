# Native goal dashboard: design and evaluation contract

## Classification and decision

This is a requested presentation/usability feature, not a claim of an execution
engine defect. The operator selected a native dashboard plus compact status
summary. Existing goal handoff, native setup approval, cancellation CAS, tools,
workflow/task/orchestration ownership and budgets remain authoritative.

## Observable acceptance (before implementation)

- Blank `/jev-loop` opens a themed native dashboard in TUI mode; direct goal,
  `status` and `cancel` controls remain compatible. RPC retains its native menu.
- Show goal cards, a selected-goal state tree, policy criteria, verifier coverage,
  accounted fires/expiry and recovery guidance. No invented work percentages.
- Local approval/check/advice phases may be shown only when this runtime actually
  owns and observes them. A persisted reservation is not proof of execution.
- Keyboard supports selection, detail scrolling, start, explicit cancel
  confirmation, refresh, motion toggle and exit. Selection/focus has text cues.
- A compact native widget is visible only for existing JEV goals. Existing
  general status counts stay intact. Inspection never claims/schedules work.
- Committed tree/session/store/cwd changes close stale UI and prevent late
  actions. Motion/data timers exist only while the dashboard is visible and are
  disposed on close/abort. Reduced-motion mode must not animate status.
- Goal text is untrusted: ANSI/control/bidi input cannot inject terminal actions.
  Critical IDs, status and action help remain accessible at 48/80/120 columns.
- No new renderer, dependency, backend, persisted grant or configuration file.
  The installed pinned snapshot is not silently updated by development work.

## Readability revision for 0.1.1

One operator reported that time and fire counts were visible but hard to read.
The task questionnaire was canceled, so task success, elapsed time, action/error
counts and questionnaire scores remain unknown, not inferred successes.
The earlier automated no-overflow result did not establish readability.

A minimized regression also exposed a distinct hard fire ceiling being clipped
from the 48-column editor summary while an ordinary fixed budget stayed visible.
The revised presentation gives fires and remaining time separate labeled rows,
bolds numeric values, and keeps operating versus hard values visible in the
summary, details and short-terminal view. State, exit controls, accounting and
read-only ownership are unchanged. Narrow-width and no-color checks remain
engineering checks; a successful human recheck must be collected separately.

A later qualitative operator report described the result as acceptable overall
but still too text-heavy. No task time, action count or rating was supplied.
The next revision keeps the default dashboard to a concise policy goal, state
and the two budget rows. Tab/Enter reveals criteria, verifier and recovery
information using the existing focus control. The editor widget uses three rows
and never flattens the full local instruction prompt into the default view.
The scripted criteria task now records its added Tab action rather than hiding
the interaction cost; human acceptance of this denser-to-detail revision is not
inferred from the report about the previous view.

## Sources and chosen measures

| Source | Applied measure | Boundary |
|---|---|---|
| [ISO 9241-11 / NIST usability](https://csrc.nist.gov/glossary/term/usability) | Effectiveness: task success/errors; efficiency: steps/time; satisfaction | Specify users, tasks and context; no universal success threshold |
| [UMUX-Lite, Lewis et al. (2013)](https://doi.org/10.1145/2470654.2481287) and [Test Science](https://testscience.org/measuring-usability/) | Two human ratings: capabilities meet needs; easy to use | Raw score `(item1 + item2 - 2) * 100 / 12` for 1–7 responses; not an actual SUS score |
| [VisAWI-S, Moshagen & Thielsch (2013)](https://www.uni-muenster.de/OWMS/uploads/drafts_thielsch/pdf/moshagen_thielsch_2013.pdf) | Human visual review: simplicity, diversity, colourfulness, craftsmanship | Validated for websites; a TUI-adapted use is exploratory, not a validated terminal score or four reliable subscales |
| [W3C WCAG2ICT](https://www.w3.org/TR/wcag2ict/) | Keyboard reachability, focus/escape, text not color-only | Non-web guidance, not an automatic WCAG certification |
| [W3C animation guidance](https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions) | Visible motion-off control, nonessential animation removable | Terminal has no browser prefers-reduced-motion contract |

## Automated engineering checks

The same owned synthetic goal fixtures and tasks are used for baseline and
candidate. These are scripted UI proxies, not measured human usability.

1. Read selected goal status and accounted budget.
2. Find its criteria, verifier coverage and recovery action.
3. Select another goal without changing controller state.
4. Scroll long detail content with keyboard only.
5. Request a new goal through the existing handoff (not execution approval).
6. Cancel an observed goal only after explicit confirmation; preserve others.

Targets: all six fixture tasks succeed; zero unintended mutations, false
execution labels, width overflows, inaccessible exit controls or surviving
view timers. Record logical key presses, fixture count, terminal sizes and
actual timings. Compare matching tasks rather than claiming a universal
percentage improvement. Render p95 <=16ms is an engineering budget to measure
on this PC, not an already-observed result or proof of human efficiency.

Width matrix: 48/80/120 columns, empty/paused/capped/long CJK/emoji goals,
reservation-only versus observed review phases, NO_COLOR/TERM=dumb and motion
off. Native renderer/key smoke uses the installed Pi version in an owned PTY;
it is not a human visual review. Baseline is pinned pre-feature main0506ce5.

## Human questionnaire measures (not yet collected)

After real use, record participant count/context, per-task success, time,
errors/assistance and both UMUX-Lite responses. Use the same task instructions
and starting state for comparisons. Do not fill answers from an assistant,
script, live-model judge or screenshot heuristic. Until a person completes these questionnaire items,
questionnaire respondents=0 and satisfaction score=null, not a pass. Add four 1–7 visual
aesthetics ratings guided by VisAWI-S; report their mean only with actual
complete responses, note the TUI adaptation, and do not infer subscale scores. Any small-sample result
must retain its sample size and cannot establish general population quality.

## Current development observations

Before release, automated component evaluation covered 27 width/height/goal-count
fixtures, six scripted component tasks and 2,700 render samples. A local run
observed p95 about 0.63ms against the 16ms engineering budget. These synthetic
fixtures are not all possible policies or a population usability study.

An actual Pi 1.3 PTY comparison with identical paused goals measured first-goal
criteria lookup at 31 baseline versus 10 candidate logical keys, and another
goal lookup at 19 versus 2 additional keys. The candidate capture uses a resize
to force a complete terminal frame; that capture operation is not counted as a
user key. Both cases preserved the controller file. These are two read-only
lookup proxies, not a general efficiency percentage or measured human time.

Native TUI startup, goal/tree/criteria rendering, Escape close with responsive
status inspection, task-menu cancellation and orderly quit were also observed.
No model, verifier or JEV call was made. That controlled renderer/key smoke
involved no human participants; UMUX-Lite and TUI-adapted visual-aesthetics
scores remain null. Bounded results/previews
live under `.artifacts/dashboard/`; actual values must come from each run.

## Readiness recheck (2026-10-21)

A fresh unchanged-source evaluation again passed 27 layout fixtures and all six
scripted tasks, with logical key counts `[0, 0, 2, 2, 1, 1]`. Its 2,700 render
samples observed p95 0.684162 ms, below the stated 16 ms engineering budget.
This is synthetic component evidence, not a human efficiency claim.

A separate real-host scoped setup was observed to create its controller after
one recorded native approval in 23.911 seconds of total request wall time.
That value includes system/reading/response time and is not controlled human
time-on-task. Raw key/pointer counts and operator-reported blocking errors
remain unknown because the feedback question was unanswered. Human survey
respondents remain zero, and satisfaction/aesthetics scores remain null.
The separately requested live completion fixture stayed unapproved, with zero
verification and JEV calls; neither that hold nor the setup receipt is a
positive end-to-end completion result.

## Current scoped-run observation

A later operator-created run received one native approval and created its
controller in 49.424 seconds of request wall time, with no returned setup
runtime error. This establishes at least one logical affirmative selection,
not the total number of key, pointer or scroll actions. Its feedback question
was unanswered; perceived difficulty and human ratings remain unknown. Do not
infer a satisfaction score or a general human efficiency benefit from it.

The unchanged dashboard evaluation passed the same 27 layouts and six scripted
tasks with logical keys `[0, 0, 2, 2, 1, 1]`. In 2,700 render samples, p95 was
0.640706 ms against the 16 ms engineering budget. These remain synthetic
component measures and are not retroactively labelled as human inputs. A
live goal-completion attempt must separately record actual verification,
advice and guarded closure outcomes; preparing that attempt is not a pass.

## Complete fixed-task metrics and current native views

The fixed-task report previously recorded success and logical keys but omitted
per-task elapsed time, attempts, approval requests and errors. New expectations
first failed with `Each fixed task must report measured elapsed time`, while
the six existing task controls passed. The evaluator now measures each task
from its ready fixture, retains explicit zero approval/error counts for these
read-only intents, and independently asserts no controller mutation.

One bounded run recorded the following **scripted component** values, not human
execution times or satisfaction:

| Task | Elapsed ms | Logical keys | Attempts | Approvals | Blocking errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Selected status/budget | 0.836400 | 0 | 1 | 0 | 0 |
| Selected criteria | 0.812788 | 0 | 1 | 0 | 0 |
| Select third goal | 2.332342 | 2 | 1 | 0 | 0 |
| Scroll detail | 1.218627 | 2 | 1 | 0 | 0 |
| Prepare start intent | 0.432581 | 1 | 1 | 0 | 0 |
| Request cancel intent | 0.418122 | 1 | 1 | 0 | 0 |

All six succeeded; 27 layout fixtures and 2,700 renders passed with p95
0.666904 ms. These zero approvals concern read-only intents, not automatic
consent. A separate actual operator setup succeeded once after one scoped
native approval and one observed semantic approval decision in 352.882 seconds
of request wall time, with no returned setup runtime error. Physical key,
pointer and scroll totals and subjective ratings remain unmeasured.

A fresh current four-criterion approval probe used Pi 1.3.0 / Bun 1.4.3 in
fullscreen and regular PTYs at 90×45, 100×30, 48×16 and 160×60. All eight
captures showed heading, positive countdown and both choices; keyboard Escape
at about 3.716 seconds closed both sessions with zero controller, verifier,
advisory, model or network effects. Inputs were controlled negative test
inputs, not human visual acceptance or affirmative approval. In the actual
approved goal, fixed verification then real aggregate/focused JEV assessments
returned unmet and continued the same controller instead of claiming success.
That is observed negative gating, not a positive completed end-to-end result.

For the current actual operator setup task, one operator subsequently reported
that the content and choices were readable and that one keyboard selection
followed by one Enter completed approval, with no display/input problem.
These are two operator-reported approval key actions, not intercepted raw-input
telemetry or an inferred scroll count. Together with the runtime's one success,
one scoped approval, 352.882-second operation wall time and zero returned setup
errors, this is one bounded task observation (n=1). It is not an efficiency
comparison, population result, UMUX-Lite score or aesthetics rating.

## Evidence

Store bounded benchmark/result metadata outside committed fixtures. Do not add
user transcripts, credentials, raw source, original goals or a private terminal
recording to the repository. Final evidence must distinguish observed values,
acceptance targets, unavailable checks and subjective judgments.
