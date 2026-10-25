# Loop access foundation contract

Classification: **feature expectations and integration hardening**, not a claim
of a reproduced defect in existing Reviewed operation.

This foundation is internal and unexposed. It adds no command, public tool
parameter, active Full grant or persisted approval. Controlled reducer tests
are not native consent or live acceptance.

## P0 findings

The configured JEV extension has existing public decision/delegation tools and
a session-only native delegation Full Access owner. That owner does not grant
permission to Loop or other extensions. No supported public read-only
capability/recipient-lifetime interface was found in the inspected source.

The current Loop runtime discovers the public decision tool by name. Its
controller fingerprint does not bind an opaque JEV recipient generation.
Therefore a Loop Full runtime must not be enabled on that check alone.

JEV connection objects contain credentials and stay effect-local. The existing
private delegation `lease`/authorize path may revoke stale access and cancel
work, so it is not a read-only capability getter and must not be used as one.

Before runtime integration, agree a supported owner-enforced recipient fence:

- Read-only capability metadata is bounded, non-secret information, not a
  grant. Inspection must not enable, revoke, claim or execute work.
- An opaque random revision must not be a credential hash or expose endpoints,
  keys, original prompts or workspace contents.
- The owner must revalidate an expected recipient at its actual request sink,
  after awaited/progress boundaries; a Loop preflight alone is insufficient.
- Fencing metadata stays outside external JEV questions/state. Legacy calls
  retain their existing schema behavior; supported fenced calls fail closed
  before any request when stale or unsupported.
- A missing interface blocks the unsupported Full path. It is not permission
  to copy private grants, change providers or downgrade to a surprise review.

## Candidate protocol client (not active mode support)

The companion source review now defines `jev_capabilities` protocol version1
and optional `expectedRecipient` on ordinary `jev_decide` questions. This is a
source candidate, not proof that an installed toolset has been reloaded or has
any Full authorization. The provider's native command/name must be discovered
from the current supported installation rather than an old alias.

The internal Loop client validates a bounded matching text/details envelope,
protocol version, configured recipient and explicit no-authority/no-live-check
flags. Unknown, contradictory, error or extra fields fail closed. Capability
inspection calls only the public empty-input tool; it does not issue a grant.

A recipient decision attaches only that bound opaque value, without refreshing
it or changing the supplied packet or mandatory-human flag. It goes through
Pi's existing `executeTool` and scoped signal. Current-context checks run before
and after awaits; stale/failed operations produce sanitized errors without
retry, another recipient, fallback or raw provider-data echo. Advice validation
and actual native access remain independent owner responsibilities.

Reviewed runtime registration is unchanged. This client is not wired into a
Full UI/admission path yet. `delegationFencing: false` cannot be advertised as
fenced worker admission, and unsupported installed metadata cannot enable Full.

## Volatile state and native ownership

The pure `loop-access` reducer receives only owner-created events. Future native
UI/effects must validate the current context before supplying a reply. Neither
its serialized state nor an `authorized` effect is accepted from public input.

Binding consists of session ID, working directory, store identity, runtime
generation and the supported judge fence. The working directory is an authority
binding, not an OS sandbox. The same OS-user permissions and host gates remain.

```text
reviewed -> awaiting_ack -> full -> revoking -> reviewed
                                  revoking -> closed
reviewed ---------------------------------> closed
```

- A valid request creates only a native-confirmation effect with independently
  copied scope/finite goal ceilings. It does not become Full.
- Only literal `true` for the matching native request, epoch and binding moves
  awaiting acknowledgement to Full. Old replies and malformed scope do not.
- Goal creation, verification and advice require the matching live scope and a
  positive safe-integer budget within both approved per-goal ceilings.
- Actual binding drift revokes before another effect. Invalid/out-of-envelope
  requests cannot alter or extend an otherwise valid grant.
- Revocation advances an epoch and requests owned cancellation/draining. New
  activation/authorization is denied until that specific drain completes.
- Old drain completions cannot settle a later revocation. Closing during drain
  preserves its identity and waits; closed state never reopens.

The runtime adapter must additionally enforce current controller creation,
policy/snapshot/CAS, status, eligibility and hard expiry at every awaited
boundary. The reducer is not a substitute for those existing guards.

## Goal lifetime origin under Full

A future Full activation authorizes a stated rule for new goals. Each new goal
captures its trusted live admission time once, before initial operating-budget
advice, as its immutable hard-window origin. No caller timestamp supplies it.
The native mode acknowledgement must disclose this rule and the finite
per-goal ceilings. Budget selection or extension never restarts that origin.

Existing Reviewed goals retain their genuine goal-approval origin and exact
policy. Enabling Full must not migrate an existing controller, silently renew a
fixed goal, adopt an expired goal or change a running development controller.

## Preserved boundaries

- LoopStore continues owning controller state and persistence. Access authority
  is process-local, never a stored flag, task lease or peer claim.
- Reviewed remains the default. Runtime Full UI/admission is deliberately not
  exposed by this foundation before the public fencing contract is supported.
- Existing fixed/adaptive envelopes, evidence novelty, finite expiry, verifier
  cleanup and host tool/transmission handlers remain unchanged.
- JEV owns worker/profile/model/tool/file admission and global concurrency.
  Loop does not gain delegation authority from its own activation.
- No raw source, paths, arguments, original goals, logs, history or credentials
  are collected for JEV. Local binding data never becomes external evidence.
- Regression/property tests use controlled events, not fabricated live grants.
  Actual native activation and live execution require their exact current
  approvals; no skipped or fake-provider trial is reported as a pass.

## Required evidence

Deterministic cases cover native request/reply identity, literal acceptance,
all binding fields, malformed/extra input, finite ceiling boundaries,
state-preserving denial, copied payloads, epoch revocation and stale drain
completion. Generated traces independently assert no authority outside Full,
no reopening of closed state, no premature exit from draining and no scope or
budget growth. Existing Reviewed/runtime and adaptive-budget controls remain
independent. Red/green observations stay outside committed fixtures.
