# Scoped Loop access contract — v1 candidate

Classification: feature expectations and authority/lifetime hardening. This
source candidate registers a static native `LoopAccess` tool and explicit new-
goal Full admission. It is not a claim that an installed extension was reloaded,
that a user activated Full, or that live worker/provider acceptance passed.

## Public entry points

`LoopAccess` uses a closed action schema:

- `{ action: "status" }` inspects local mode/applicability/finite ceilings only.
- `{ action: "full", maxFires, expiresIn }` requests native session activation.
  Both limits are finite **per-goal hard ceilings**, not a renewed session quota.
- `{ action: "reviewed" }` revokes this owner's Full authority and waits for its
  pending admission, verification/advice and controller cleanup. It does not
  revoke JEV delegation access or cancel unrelated Reviewed goals.
- `{ action: "review_goal", id }` explicitly requests a fresh **Reviewed** review
  of retained Full intent. It preserves the saved hard deadline, fire cap,
  policy and adaptive start. It does not restore a mode grant or resume work.
  Use normal `LoopUpdate continue` afterward when eligible. Expired/exhausted
  goals and unknown/draining work are not renewed. An exhausted operating
  allocation still follows its existing bounded checkpoint path.

`LoopCreate.requestedAccess` is optional: missing/`reviewed` keeps the original
native per-goal Reviewed path. `full` applies only to a **new** recurring idle
completion goal with explicit finite lifetime/fire bounds and matching live
activation. Cron/event/hybrid, workflows, TaskStore, backlog and orchestration
are not widened. An argument, command handoff, status, history or persisted flag
cannot issue authority, silently fall back or adopt an existing controller.

The tool set/schemas remain static across mode changes. Native command contexts
do not expose nested public-tool execution in the supported SDK; activation uses
the supported `ExtensionToolContext`, not an old context or a private API cast.
The existing `/jev-loop` dashboard displays local mode observations without
querying a provider or changing grants. Its goal preparation remains Reviewed
by default; choosing Full requires the explicit argument and live activation.

## Separate owners and public recipient protocol

Loop owns its process-local native access and controller admission. LoopStore
continues owning loops, snapshots, pauses and CAS. JEV owns decision transport
and its independent delegation/profile/model/tool/file/job policies. Neither
owner copies another owner's private lease or reconstructs authority from it.
No new worker engine, cross-store transaction, account-wide grant or OS sandbox
is introduced.

Full requires `jev_capabilities` **protocol 2** with a configured opaque
recipient, `fencedDecision: true`, literal
`recipientInvalidationEvent: "jev:recipient:invalidated"`, and explicit
`grantsAuthority: false`, `liveVerified: false`, `delegationFencing: false`.
The bounded single-text/details metadata must agree. Old/unknown versions,
extra, conflicting or authority/live-check claims fail closed. Availability is
local configuration information, never backend health or permission. Native
provider commands are discovered from the current supported installation,
not an old alias. Companion source review is not a product release or reload.

Protocol 2 publishes deny-only native event-bus information:
`{ kind: "jev_recipient_invalidated", protocolVersion: 2, recipient }` on the
named channel. The only variable is the discarded opaque token. The provider
invalidates metadata before publication. Loop validates the closed bounded
payload, matches its current binding and invalidates its epoch/signals before
awaiting cleanup. Wrong tokens/versions, malformed data and authority-shaped
packets cannot issue or refresh access. This is not acknowledged delivery,
remote quiescence or exactly-once execution.

Each actual Full authorization still reads/compares public metadata. Ordinary
Full decision requests attach only `expectedRecipient` through the existing
nested-tool handler; the peer strips it before original decision state/external
questions and fences its actual HTTP sink after progress/observer/response
boundaries. No refresh, alternate recipient, automatic retry or fallback occurs.
Reviewed decision inputs remain unchanged. Worker fencing remains unsupported;
`delegationFencing: false` is not worker admission evidence.

## Native scope and finite admission

The native owner starts Reviewed and accepts session storage only. Before UI
it captures the native session, directory, live store object identity, runtime
generation and recipient. Finite positive safe-integer ceilings are validated.
The existing scrollable No-first TUI/RPC review is reused. Full waiting follows
its scoped cancellation rather than an invented infinite countdown or separate
120-second limit. Reviewed goal deadlines and approval timing are unchanged.

The exact local disclosure names those bindings, finite ceilings and the rule
for goal lifetime origin. It discloses goal-selected fixed verifier programs and
arguments, inherited process environment and possible effects outside the cwd
under the same OS user. It is not a filesystem/tool sandbox or a semantic
command-safety checker. Existing host/nested-tool/transmission gates remain;
unapproved destructive/release/global operations and secrets are not granted.

Only a literal matching native acknowledgement can activate Full. Recipient and
context are checked again after the reply; drift denies rather than rebinding.
The accepted live grant has its own signal, not the finished dialog's signal.
Private leases bind epoch/context/action/budget. Local `matches`/`current`
observations are not remote health probes or serialized bearer permission.

A new Full goal captures trusted admission time **once, before capability and
initial budget awaits**. Fixed hard expiry and adaptive `startedAt` retain that
origin even if advice is slow. Caller timestamps are not authority. The hard
fire cap/deadline never reset on progress, extension, restart or recovery.
Existing Reviewed goals preserve their original genuine approval timing.

## Memory provenance, cancellation and recovery

Private records distinguish genuine per-goal Reviewed approval from scoped
session Full admission. Full records bind their originating activation ID,
epoch and immutable hard envelope. A later mode activation cannot adopt them.
Only inert `requestedAccess: "full"` intent is persisted; native grants are not.
No Full timestamp or receipt is forged as a Reviewed acknowledgement.

Every awaited effect retains session/store/generation/epoch, original expiry,
controller snapshot/review reservation and final CAS checks. Verification and
advice inherit the live Full signal. Nonzero fixed-verifier exits allow scoped
repair within the same envelope; malformed/provider failures, cancellation,
expiry and missing authority do not grant retry, fallback or extra budget.

Revocation aborts before awaiting anything, waits for its own pending native and
authorization queries, cancels only owned Full reviews and pauses unfinished
owned controllers using existing snapshot/CAS paths. Verification is awaited
through physical process settlement. Unknown cleanup or failed CAS stays
revoking and blocks reactivation. Reviewed work and JEV's separate grant remain
unchanged. Global shutdown invalidates existing Reviewed work synchronously
before waiting for mode cleanup; its ordering regression has deterministic
passing controls.

If revocation races controller creation after the write, the matching created
work is retained/held, not silently deleted or reported as never created. No
activation is authorized. Scheduled idle dispatch checks local authority before
consuming a fire. Buffered notifications recheck authority even during the gap
before asynchronous pause persistence. Native resume menus neither offer nor
honor unapproved Full resumption. Read-only inspection cannot claim/pause work,
send wakes, issue/revoke access or infer unobserved delivery.

Closing never reopens the same owner. Session replacement starts a new Reviewed
owner; restart never restores access. Explicit Reviewed recovery verifies the
original cwd, current snapshot and remaining hard envelope and uses genuine
native confirmation. It cannot clear another live review or certify unknown
process cleanup. Recovery does not reset a budget or silently switch policy.

## Privacy and evidence

Only separately authored bounded non-sensitive English policy/evidence and safe
numeric outcomes are prepared for JEV. Original goals, source, paths, argv,
logs, history, local state/metrics, raw verifier output and credentials never
become decision evidence. Local native disclosure is separate. Budget evidence
is independently authored, not copied completion evidence or raw local state.
JEV advice, status and metadata are neither permission nor proof.

Tests cover closed schemas, genuine-callback requirements, field/budget drift,
ABA/epochs, metadata events, copied payloads, hard origins, post-write holding,
physical drain, replay/refusal, explicit recovery and native root idle/pending-
wake fencing. Generated traces retain independent scope/closed-state invariants.
File-backed controlled SDK/UI/mock transport tests are **not actual user consent
or real-provider/worker acceptance**. Live native authorization, host-deny,
current native UI and release evidence require their exact applicable approvals;
SKIP, unavailable providers and synthetic Yes are never reported as live passes.
