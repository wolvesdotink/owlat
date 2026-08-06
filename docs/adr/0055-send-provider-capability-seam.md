# ADR-0055: The send-provider capability seam

## Status

Accepted.

## Context

Owlat shipped four send-provider kinds (`mta`, `ses`, `resend`, `smtp`) behind a
real adapter interface, and adding a fifth still cost a twelve-file hunt. Two of
those files did not contain a seam at all, only a name: `routing.ts` threw unless
the deliverability-fallback relay was literally `'ses'`, and
`relayDomainVerification.ts` returned `false` for everything that was not SES.
Sending-domain identities were a closed `'mta' | 'ses'` union with a sibling
table per provider. A third provider meant a third table.

The forcing function was Mailchimp Transactional (Mandrill). Not because
Mandrill is special, but because of what a team arriving from it wants: keep
sending on the reputation they already have, and let the already-shipped ramp
controller move traffic onto Owlat's own MTA cell by cell as the measurements
allow. That is the adaptive-mix machinery working exactly as designed — the
controller already treats every non-`mta` kind as the reference arm — except
that three of the gates around it asked "is it SES?" rather than "can it do
this?", so the configuration the ramp exists to serve could never leave a zero
own-share.

This ADR records the decisions taken while adding Mandrill and, in the same
work, replacing those identity checks with declared capabilities. It is written
AS BUILT, including the two places the plan's intent and the shipped code differ.

## Decision

### The catalog answers capability questions; nothing names a kind

Six fields on `SendProviderCatalogEntry` carry everything the rest of the
system needs: `requiredEnvVars`, `hasProviderFeedback`,
`supportsCustomReturnPath`, `domainVerification: 'api' | 'none'`, and the two
dispatch semantics below.

Three former identity checks now read them:

- **Fallback eligibility** — a kind may be the deliverability-fallback relay iff
  it is configured and is not `mta`. The MTA is the arm a fallback moves traffic
  *away from*; routing it to itself would relieve a reputation problem through
  the transport that has it. One predicate
  (`lib/sendProviders/fallbackEligibility.ts`) serves both callers — the mutation
  that saves a route and the resolver that uses it — because two rules for one
  decision is how a route becomes unsaveable through the UI while resolution
  would have carried it perfectly well. Configured-ness is *injected*, not read
  inside the predicate: the resolver already carries a readiness source that
  includes mutable plugin grants, and the predicate must not disagree with it.
- **Relay domain verification** — a relay's From domain is verified iff a
  registered sending-domain provider for that kind says so. Kinds with no such
  provider keep an honest "unverifiable" posture and fail closed.
- **Governed dispatch** — see "What a dispatch means is declared, not
  recognized" below.

### Per-send extras belong to the adapter

`buildDispatchExtras` moved onto the module contract. Governed dispatch used to
carry a ternary chain of per-kind extras, which is a seam leak by construction:
every new kind edited a file that has nothing to do with it. The refactor was
behaviour-identical and gated on the existing dispatch integration suite running
unmodified.

### What a dispatch MEANS is declared, not recognized

Moving the extras left four behaviours in `delivery/governedDispatch.ts` still
spelled `providerKind === 'mta'`: the pre-dispatch identity binding, the
substitution of our own id for the one the response carried, the
`acceptedForDelivery` verdict, and the replay-reconciliation arm of an ambiguous
acceptance. Those are two questions, so they became two declared fields on the
catalog entry:

- `acceptanceSemantics: 'accepted' | 'unknown-on-timeout'` — does a successful
  send mean the transport took CUSTODY (delivery still pending, the Send stays
  `queued` for feedback), or is the send itself the handoff? `accepted` is also
  what makes an ambiguous outcome re-askable by replay.
- `messageIdSource: 'provider' | 'idempotency-key' | 'composed'` — where the
  recorded `providerMessageId` comes from, and therefore whether it exists
  *before* the network crossing. Only `idempotency-key` gets an identity bound
  pre-dispatch and gets our value substituted for whatever came back.

Both fail closed when absent (`unknown-on-timeout` / `provider`), because
claiming custody we were never granted parks a Send against feedback that never
arrives, and claiming re-askability double-delivers. After this,
`governedDispatch.ts` compares no provider kind to a literal at all — a test
reads the file and asserts it.

For a core kind the pairing is a compile-time union rather than two independent
fields, constrained in both directions: `accepted` only with `idempotency-key`
(a replay is safe only when it carries the id we minted) and `idempotency-key`
only with `accepted`. Bundled plugin entries are untyped and may present a mixed
pairing, so the governed boundary reads the two fields independently — widening
the union is a type change, not a behaviour change.

What is NOT yet general is `accepted` itself: two sites outside the catalog still
spell the custody arm as the own MTA, and a second kind declaring custody must
generalize both in the same change. **Which two, and what breaks if one is
missed, is written out once** — in the PREREQUISITES note on
`AcceptanceSemantics` in `apps/api/convex/lib/sendProviders/catalog.ts`, the
declaration site. This ADR deliberately does not restate it, so generalizing
those sites stays a single-file edit.

### The sibling-table pattern stops at two

`sendingDomainMtaIdentities` and `sendingDomainSesIdentities` stay frozen
(post-launch immutability). Every relay kind after SES shares one org-scoped
table, `sendingDomainRelayIdentities`, discriminated by a `providerKind` string
— a string rather than a closed union, so a new kind is additive rather than a
schema change. Provider-specific state rides a versioned `providerDetails` JSON
blob, and a row written by a future version reads as "nothing known" rather than
being reinterpreted under today's shape. The `domains/providers` union became a
registry keyed by kind, with a mapped-type guard that fails the build if a kind
declares `domainVerification: 'api'` without registering one.

### Mandrill is a core kind, and Owlat composes its own mail

The plugin send-transport contract exists, but plugin kinds cannot have named
instances, get no typed per-send extras, and — decisively — the deliverability
machinery that makes this feature worth having reads core kinds. So Mandrill
joins `SEND_TRANSPORT_KINDS` and the core catalog.

The adapter composes the full MIME message with `@owlat/mail-message` and posts
it to `messages/send-raw` with Mandrill's open/click tracking, link rewriting,
auto-text and inline-CSS explicitly **off**; `open` and `click` webhook events
are dropped. This is not a preference. The engagement ramp gate compares the two
arms, and it can only do that because both are instrumented by the same
first-party pixel and redirects. A provider's own open counts would make the
reference arm look different for a reason that has nothing to do with
deliverability.

Credentials stay env-only. There is deliberately no transports table — the
catalog already answers "what configuration does a transport need", and a second
credential model would be a competing abstraction. Named instances
(`mandrill#eu`) come free from the existing `__<INSTANCEKEY>` suffix. The
in-app transport editor writes exactly one Mandrill variable,
`MANDRILL_API_KEY`: the webhook signing key is issued by Mandrill *after* the
webhook is created and is not part of sending, so putting it in the
cleared-then-set transport allowlist would let a routine key rotation silently
unset a working feedback loop.

### Feedback is a dedicated adapter over the shipped pipeline

`webhooks/adapters/mandrill.ts` verifies Mandrill's HMAC-SHA1 signature over the
exact webhook URL plus alphabetically-sorted POST params, fans the
`mandrill_events` batch out into one normalized event each, and joins on
`providerMessageId`. Mandrill's unsigned HEAD/GET URL-validation probe is
answered out of band; the *signed* empty-batch probe deliberately goes through
the pipeline, because it is a real signed request and must prove the configured
key works.

`reject` events mirror Mandrill's own blacklist into `blockedEmails`. This is
part of the measurement, not a courtesy: during a migration the two arms must
send to the same population, or the own arm inherits bounces the reference arm
was silently spared and the controller reads that as "our MTA is worse". The
mirror is bounded in the other direction too — a reject reason that describes
*our account* (`invalid-sender`, `unsigned`, `test-mode-limit`) suppresses
nobody, or a misconfigured sending domain would blocklist a whole audience one
send at a time.

Suppression provenance is recorded as an audit entry
(`blocklist.provider_suppressed`), not a column. Provenance is an event:
re-blocking an already-blocked address writes nothing, so a column would record
only whichever cause happened to arrive first.

### The migration is configuration, not construction

`providerRoutes` with `strategy: 'adaptive_mix'` and providers `[mta, mandrill]`
makes Mandrill the reference arm, `ownShare` starts at 0, and the shipped
controller walks it up per cell. One rule the machinery cannot enforce for the
operator: the alignment pre-flight wants **exactly one** reference relay, because
with two there is no single second arm to compare against. That case reports
`unknown` (a hold), and the UI surfaces it as its own warning naming the enabled
relays — not as a fourth DNS finding, because the remedy is "pick one", not
"verify something".

## Deviations from the plan, as built

Two decisions changed shape during implementation. Both are recorded here rather
than quietly absorbed, because in each case the plan's stated reasoning no longer
matches the code.

### D5 — `'probe'` was the right declaration, `unsupported` is the right answer

The plan expected the return-path probe to *resolve* Mandrill's per-message
`return_path_domain` support empirically. It does not need to: Mandrill mints its
own bounce local part, so an Owlat VERP envelope sender cannot survive whatever
domain is declared. The catalog still declares `'probe'` — uniformity with the
other kinds, and the probe table is where the verdict belongs — but the adapter
declines the probe outright and it settles at `unsupported` with reason
`no_envelope_control`.

The honest consequence, stated plainly because a "not supported" line invites a
worse guess: bounces that arrive *only* at the SMTP envelope cannot be attributed
to a specific send by us. Mandrill's webhook feedback covers the rest. The cell's
measurement is marked **degraded**, never blocked, and nothing about sending
changes.

### D4 — ambiguous timeouts park and age rather than failing immediately

Mandrill's API has no idempotency key, so a timed-out request may or may not have
been accepted, and the adapter returns `AMBIGUOUS_TIMEOUT` with
`acceptanceUnknown` rather than retrying — as planned. What the plan did not
settle is what the *send row* does next.

Failing it immediately would be a lie in the common case (the message usually was
accepted, and a `send` webhook is about to prove it), and retrying would risk a
double delivery. So for a feedback-capable relay the outcome is non-terminal: the
send parks, waits for the webhook to resolve the ambiguity, and only ages into a
new terminal code — `PROVIDER_ACCEPTANCE_UNCONFIRMED` — at the delivery deadline
if no event ever arrives. The deadline is what makes it terminal; the provider's
own feedback is what usually makes it moot.

## Consequences

- Adding provider N+1 is a bounded checklist: kind literal, env keys, catalog
  entry, adapter, plus a webhook adapter and a domain-identity provider only if
  the declared capabilities say so. Five of those steps are compile-time
  enforced and the rest are covered by conformance suites that iterate every
  catalog kind, so a new kind joins them by existing. The checklist is
  documented in `apps/docs/content/3.developer/15.providers.md`.
- The custody/message-id declaration widened what a catalog entry is responsible
  for, and one of its values has prerequisites outside the catalog. Until those
  are met, `acceptanceSemantics: 'accepted'` is the own MTA's alone — declared
  honestly rather than hidden, so the next author reads the constraint at the
  field (the PREREQUISITES note in `catalog.ts`, which is where it lives) instead
  of discovering it from a deferred send.
- `sendingDomainRelayIdentities` is now the growth point for provider identity
  state. Its `providerKind` is a string and its `providerDetails` blob is
  versioned, so the next kind adds rows rather than columns — but that also
  means the table has no per-provider validation, and each provider owns the
  correctness of its own blob.
- The alignment pre-flight's `unknown` state now carries two genuinely different
  meanings (an undescribable relay, and more than one relay) with two different
  remedies. They are distinguished by a shared detail prefix rather than by a
  discriminated union, which is the smallest thing that works and the first
  thing to revisit if a third `unknown` cause appears.
- A migration's suppression carry-over depends on the reject mirror staying
  bounded to recipient-caused reasons. That mapping is the one place where an
  over-broad reading permanently damages a customer's audience, so it is pinned
  by tests in both directions.

## Non-goals

- Using a provider's own tracking, templates or merge tags. Owlat composes and
  instruments its own mail; that is what makes the two arms comparable.
- A credential model beyond environment variables, or exposing named instances
  in the UI wizard (env-only, at parity with `smtp#backup`).
- Multi-organization support. "Per-tenant" here means org-scoped rows under the
  existing singleton-org invariant.
- Bidirectional suppression sync. Owlat is the system of record during a
  migration, and the reference arm re-checks `blockedEmails` at dispatch anyway.
