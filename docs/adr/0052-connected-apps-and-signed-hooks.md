# ADR-0052: Connected apps and signed synchronous hooks

## Status

Accepted.

## Context

ADR-0049 fixed the platform's outer boundary and named three execution tiers,
deferring "execution-specific registration" for Tier 2 to a later decision. That
tier is now implemented: connected apps, plugin-bound API keys, signed
synchronous draft/gate/score hooks, and redacted hook delivery logs.

Tier 1 requires a rebuild to install and runs with the operator's own trust.
Many integrations need neither: they are external services that want to observe
Owlat, be asked a question at a decision point, and be installable instantly. The
platform therefore needs a tier whose code never enters Convex or Nuxt, whose
authority is still bounded by a plugin manifest, and whose every answer is
treated as attacker-controlled input.

Two failure modes must be impossible by construction rather than by review. An
external service must never be able to approve a send or unblock a safety
control, and a captured request or response must never be replayable.

## Decision

### A connected app is a plugin-bound external endpoint

A connected app row carries an organization, a bound `pluginId`, a display name,
an endpoint URL, a status, the operator-granted capability subset, and a sealed
shared secret. Endpoint validation requires an absolute `https` URL with a
hostname and no embedded credentials; network-level SSRF enforcement is applied
where the request is actually made.

The bound plugin's manifest is the capability ceiling: registration rejects any
requested capability the manifest does not declare, so an app can only ever hold
a subset. The operator grant is rechecked at runtime, so the registration-time
list can only narrow further.

Statuses are `enabled`, `disabled`, and the terminal `revoked`. Every read path
returns one projection that omits the sealed secret columns by construction, so
a new query cannot surface the ciphertext.

### The shared secret is minted once and sealed

Registration and rotation mint a 256-bit prefixed secret and seal it as an
AES-256-GCM envelope under a key derived by HKDF-SHA256 from `INSTANCE_SECRET`
with connected-app-specific, version-pinned salt and info labels. The labels are
distinct from every other consumer, so a connected-app secret cannot be opened
under another consumer's context. The plaintext is returned to the caller
exactly once and is never stored, logged, or returned by any query. Sealing and
opening live in `'use node'` action files; the persistence mutations stay V8-safe
and only ever see the envelope.

### API scopes double as connected-app capabilities

The API-key scope vocabulary is partitioned. `ENDPOINT_SCOPES` back a real v1
HTTP endpoint and are the only scopes a standalone operator key may carry.
`TIER2_ONLY_SCOPES` are the expanded connected-app surface and have no
standalone meaning; minting them on an unbound key fails closed.

A key bound to a plugin may carry a scope only when the plugin's manifest
declares it and the operator has granted it. The effective scope set is
re-derived on every request, so disabling the plugin or revoking a grant
neutralizes the key immediately without touching the key row.

### Three hooks, two fail directions, no approval result

A connected app may serve `draft`, `gate`, and `score`. `draft` and `score` are
advisory and fail **open** — to the built-in default strategy and to "no score".
`gate` is restrict-only and fails **closed** to a caution objection.

The gate response schema has no accept value. A connected app can add caution or
work; it is structurally incapable of approving, unblocking, or forcing a send.
This is a schema property, not a runtime check, so it cannot be regressed by a
later transport or runtime change.

### The wire contract binds direction, body, freshness, and the request nonce

Protocol version `v1` is part of every signing string, so an upgraded receiver
can distinguish versions and an old captured signature can never be
reinterpreted under a new scheme.

Both directions are HMAC-SHA256 over a newline-joined canonical string with a
fixed field order and a direction-specific domain tag (`owlat.hook.request.v1`
vs `owlat.hook.response.v1`). The body is bound by its SHA-256. The request
carries a Unix-seconds timestamp and a fresh 128-bit nonce, both signed. The
**response** signing string folds in the request nonce, so a captured response
cannot be replayed against a different request. Directions are separated inside
the signing string, never by header name, so a request signature can never be
reused as a response signature. Verification is constant-time.

### The envelope is bounded on every axis

One resolution: resolve the tenant-scoped app and circuit state; short-circuit
to the declared fallback for a missing, disabled, or revoked app, an ungranted
hook kind, or an open breaker — without opening the secret or making a network
call; otherwise open the secret and perform exactly one signed round trip
through the SSRF guard (https only, private/internal blocklist applied up front
and at connect time, redirects refused) with a hard deadline and byte caps on
both bodies; strictly validate the response for its kind; scrub and clamp every
accepted string through the host untrusted-text policy bound to the app's
plugin; fold the outcome into the circuit breaker; write a redacted delivery-log
row; return the app's value or the declared fallback.

The transport never throws: every failure maps to a typed code that the runtime
converts into the declared fallback. Strict validation rejects extra keys, wrong
types, and empty strings.

A per-(app, kind) circuit breaker opens after a fixed number of consecutive
failures and allows one half-open trial after a cooldown, so a broken endpoint
degrades to its fallback instead of paying the deadline on every call.

### Delivery logs are redacted by construction

Each resolution writes a tenant-scoped row recording the hook kind, whether a
network call was attempted, whether the app value or the fallback won, the fixed
fallback reason, and the network duration. There is no column for the payload,
the app's returned text, the secret, or either signature, so no read path can
leak them, and a logged delivery cannot be replayed from the log. The fallback
reason is a fixed taxonomy covering exactly the codes the runtime can produce;
compile-time exhaustiveness checks in both directions keep the validator and the
runtime taxonomy in lock step. Reads are org-scoped, index-selective, bounded by
a scan cap and a clamped page limit, and rows age out at the audit-log retention.

## Consequences

- An integration can be installed and revoked instantly, with no rebuild.
- The blast radius of a hostile or compromised connected app is bounded by the
  manifest ceiling, the operator grant, the restrict-only gate schema, the
  transport's SSRF/size/deadline limits, and the untrusted-text policy.
- Operators get a diagnostic trail of hook behavior that is safe to read and
  safe to retain, because it contains no sensitive bytes at all.
- Debugging a failing hook relies on the fixed reason taxonomy rather than the
  app's own error text. That is a deliberate trade: the log stays redacted.
- Rotating `INSTANCE_SECRET` invalidates sealed hook secrets and requires
  rotating each app's secret.

## Non-goals

- Executing connected-app code inside Convex or Nuxt.
- Asynchronous hook delivery, retries of a synchronous hook, or a queue in front
  of it. A synchronous decision point either answers inside its deadline or the
  declared fallback applies.
- An approval or "force send" result in any direction.
- A marketplace, OAuth authorization-code flows, or per-app rate plans.
