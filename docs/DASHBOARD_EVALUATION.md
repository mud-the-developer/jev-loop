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

## Human evaluation (not yet collected)

After real use, record participant count/context, per-task success, time,
errors/assistance and both UMUX-Lite responses. Use the same task instructions
and starting state for comparisons. Do not fill answers from an assistant,
script, live-model judge or screenshot heuristic. Until a person responds,
respondents=0 and satisfaction score=null, not a pass. Add four 1–7 visual
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
No model, verifier or JEV call was made. Human participants remain zero; UMUX-Lite
and TUI-adapted visual-aesthetics scores remain null. Bounded results/previews
live under `.artifacts/dashboard/`; actual values must come from each run.

## Evidence

Store bounded benchmark/result metadata outside committed fixtures. Do not add
user transcripts, credentials, raw source, original goals or a private terminal
recording to the repository. Final evidence must distinguish observed values,
acceptance targets, unavailable checks and subjective judgments.
