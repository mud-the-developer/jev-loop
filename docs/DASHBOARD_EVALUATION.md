# Goal dashboard validation

## Contract

- Default view: concise goal, state, separate fire/time rows and an explicit
  operating-versus-hard limit distinction. No invented work percentage.
- Tab/Enter opens details; arrows and PageUp/PageDown read criteria, verifier
  coverage and recovery without resizing. Paging must not skip unseen lines.
- Selection, inspection, scrolling and rejecting cancellation never mutate a
  controller or grant execution. Cancellation still requires an explicit choice.
- Escape remains reachable. Stale context, close and abort dispose view timers.
  Reduced motion, no-color output and terminal-control sanitization remain intact.
- Reuse Pi's native TUI, theme and controls; no new renderer, backend, dependency
  or persisted permission. Development does not silently update installed code.

## Current source checks

The post-0.1.2 working-source candidate was inspected in actual isolated Pi
terminals, not only through component render strings:

| Dimension | Cases |
| --- | --- |
| Terminal | 48×16, 80×24, 120×40 |
| Native TUI mode | regular, fullscreen |
| Theme | dark, light |
| Total | 12 explicitly identified combinations |

Each case opened the dashboard, read budget and criterion information, scrolled,
selected another goal, closed with Escape, rejected a cancellation confirmation
and verified that status inspection remained responsive. All required checks
passed, including contiguous detail-page coverage. Controller-file hashes and
host global settings were unchanged. Fixtures were synthetic paused goals in
private workspaces; no model, verifier, JEV request or affirmative approval was
executed. This is automated native-TUI evidence with zero human participants,
not a human satisfaction or population usability score.

The native review first exposed ignored detail focus at 48×16, with 120×40 as a
passing control. Small detail pages also skipped unseen lines with a fixed
five-line PageDown step. Deterministic regression tests cover both boundaries,
minimum reading space, viewport bounds and state preservation. The candidate
uses the existing focus state for short-window details and a viewport-sized,
one-line-overlap page step. Budgets remain available in the summary.

The component evaluator separately measures 27 layout fixtures, six fixed tasks
and 2,700 render samples. Every task records elapsed time, attempts, logical
keys, approval requests and blocking errors. The criteria task includes its
actual Tab action; do not hide an added interaction cost. Render p95 ≤16ms is an
engineering target measured per run, not an assumed result or human time.

## Operator feedback and agent review

One operator reported visible but difficult-to-read fire/time values, then an
acceptable overall result with excessive prose. Those reports motivated the
separate budget rows and concise-default/detail split. Canceled questionnaires
left task times, raw input counts and ratings unknown; they are not refusals of
goal execution, successes or zero-error measurements.

Routine readiness review is owned by the agent: inspect current native frames,
exercise controls and report concrete defects and measured engineering results.
Do not repeatedly offload ordinary layout judgment to the operator or block
engineering work on optional questionnaires. Expert inspection must still be
identified as expert inspection, not a fabricated human study.

## Measurement basis and limits

- [ISO 9241-11 / NIST](https://csrc.nist.gov/glossary/term/usability): declare
  users, tasks and context; report success, errors, actions and measured time.
  Separate automated latency, end-to-end handoff time and human-only time.
- [UMUX-Lite](https://doi.org/10.1145/2470654.2481287): optional human study only.
  Without actual responses, respondent count is zero and score is null.
- [VisAWI-S](https://www.uni-muenster.de/OWMS/uploads/drafts_thielsch/pdf/moshagen_thielsch_2013.pdf):
  a TUI adaptation is exploratory, not a validated terminal rating. Never infer
  human aesthetics scores from a script or screenshot heuristic.
- [WCAG2ICT](https://www.w3.org/TR/wcag2ict/) and
  [animation guidance](https://www.w3.org/TR/WCAG21/#animation-from-interactions):
  check keyboard reachability, visible focus, text cues, exit and motion-off
  behavior. These checks are not an automatic accessibility certification.

Keep source hashes, exact case conditions, current captures and bounded results
outside committed fixtures. Do not commit user transcripts, credentials,
original goals or private terminal recordings. Older observations are retained
in the [versioned evaluation history](https://github.com/mud-the-developer/jev-loop/blob/v0.1.2/docs/DASHBOARD_EVALUATION.md);
old captures are not evidence for changed source. Human-only measurements remain
unknown unless actually supplied; no population efficiency benefit is claimed.
