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
only with `accepted`. The governed boundary still reads the two fields
INDEPENDENTLY rather than deriving one from the other, so widening that union
later is a type change, not a behaviour change.

Bundled plugin entries are generated and reach the catalog through a cast, so
the union does not constrain them. The half of the rule that is about safety
rather than tidiness is enforced for that tier at COMPOSITION time instead:
building a catalog whose plugin entry declares `accepted` or `idempotency-key`
throws, naming the entry. A prose note is not a control, and the failure mode it
would otherwise guard is silent — a plugin's sends attributed to the own arm in
every measurement row, or its ambiguous outcomes deferred until the delivery
deadline calls them failures. Plugin parity (P3.1) gave plugin transports the
capability fields and deliberately did NOT relax this — see "Parity did not
relax the custody refusal" below.

What is NOT yet general is `accepted` itself: three sites outside the catalog
still spell the custody arm as the own MTA, and a second kind declaring custody
must generalize all three in the same change. **Which three, and what breaks if
one is missed, is written out once** — in the PREREQUISITES note on
`AcceptanceSemantics` in `packages/shared/src/sendProviderCatalogTypes.ts`, the
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

## Decisions added after Mandrill (waves 2–3 of the seams plan)

The four sections above were written while Mandrill was the forcing function.
Three more decisions were taken in the same seam afterwards, and they are
recorded here rather than in a second ADR because they answer the same question
this document exists to answer — what a provider is, and what the rest of the
system may ask it.

### The feedback plane is a registry; its ROUTES deliberately are not

D6 asked for the hand-registered webhook wiring to become a registry keyed by
kind. Half of that shipped, and the other half was refused on purpose.

What became a registry is the **handler**. `webhooks/adapters/index.ts` maps kind
→ adapter with two completeness guards in opposite directions: a mapped type
requiring an adapter for every core kind declaring `hasProviderFeedback: true`
*and* requiring that adapter to identify itself by that key, and a second guard
refusing an adapter registered for a kind that declares no feedback. Both
mistakes are silent otherwise. `adapter.source` is the per-provider rate-limit
bucket and the label on every retained payload, so a registry entry keyed
`resend` holding the SES adapter would serve one provider's traffic out of
another's bucket while every per-adapter suite stayed green — they test adapters,
not wiring. And an adapter registered for a silent kind produces events the
measurement plane grades against the wrong tolerance, because
`hasProviderFeedback` is what tells it whether that arm's bounces arrive out of
band at all. Registering is not the decision; declaring in the catalog is.

What did NOT become a registry is the **route**. Each core kind keeps its own
`http.route({ path: '/webhooks/<kind>' })` literal, never a loop over the
registry and never a path derived from a kind. Those URLs are pasted into
provider consoles we do not own. A derived route is a route that can move
itself, and a moved webhook URL is silent on our side and total on theirs —
events simply stop, with no error anywhere. The four thin per-kind `httpAction`
files that each did nothing but name an adapter are gone; one dispatcher
(`providerFeedbackWebhook(kind)`) serves them all, and a test walks the real
router so a declared-but-unrouted kind fails CI.

A plugin transport's feedback arrives on **one** generated surface,
`POST /webhooks/plugin/<pluginId>`, contributed as a second module export on the
same `sendTransports` bundle rather than as a new contribution bucket — the
bundle is the unit, and a second bucket would let a plugin declare feedback it
has no send path for. It is the most exposed surface the platform has:
unauthenticated and internet-facing by design, because the caller is a
third-party ESP that will never hold a session. So it is a sequence of gates
that each fail closed, ordered so that nothing but a rate-limit token is spent
on behalf of a caller who has not proved possession of the secret — no audit
row, no delivery claim, no retained payload. A signature verifier is mandatory
in the contract: a webhook export without one fails manifest validation, so
"unverified plugin webhook" is not a state a composition can reach. Verification
is the HOST's, never the plugin's; the plugin's half is parse-only and its
output is revalidated before anything is trusted.

The reserved `inboundAdapters` bucket stays reserved for genuine inbound-MAIL
sources. It is not the webhook seam, and conflating the two is exactly the
mistake that would make a provider's bounce feed and a customer's inbound mail
share a contract.

### A plugin transport is the same bundle, and provider N+1 is one

After parity, `core` and `plugin` are an INTEGRATION difference and nothing else
(D4). A plugin kind declares the same capability fields, builds the same typed
per-send extras, registers a sending-domain identity into the same registry, and
gets named instances. Named instances follow the CONFIGURATION, not the tier: a
transport can have `#eu` when it has variables of its own to scope, which for a
plugin kind is its declared `instanceEnvVars`. The own MTA is the one kind that
cannot, and for the original reason — its module reads deployment-wide MTA
settings, so a named instance would resolve and then send with the default
instance's credentials.

The policy that follows is the one D4 names: **new providers ship as plugins**
unless they need something only core can give. The four incumbents plus Mandrill
stay core; migrating them would be churn without benefit. What makes the policy
honest rather than aspirational is that the claim is executed in CI — a fixture
ESP built entirely through the plugin contract sends under every strategy,
serves as the reference arm with correct arm attribution, receives feedback on
its plugin route, verifies a sending domain and resolves a named instance, with
no core edits.

One clause of that claim is NOT yet true, and the conformance suite proves it
false rather than skipping it: a plugin kind's **credential form does not
render**. The descriptors exist — the fixture declares `credentialFields` in the
shared vocabulary and the composed catalog carries them — but every `apps/web`
surface resolves through `coreSendProviderCatalogEntry`, the core-only half in
`packages/shared`, because the composed catalog is built from generated code in
`apps/api` and `packages/` may not import app code. The gap is therefore
structural, not an oversight, and it is pinned by a failing-if-fixed suite
(`apps/web/app/composables/__tests__/pluginTransportCredentialGap.test.ts`) so
the day someone closes it, the test that documents the gap is what tells them.
Until then, a bundled plugin transport is configured by environment variables,
exactly as a core kind's named instances are.

### Parity did not relax the custody refusal

`acceptanceSemantics: 'accepted'` and `messageIdSource: 'idempotency-key'` are
still refused for a plugin entry, and that is deliberate rather than unfinished.
The prerequisites those values have are three BACKEND sites (listed once, at the
declaration in `packages/shared/src/sendProviderCatalogTypes.ts`), not contract
surface — so generalizing them is its own change with its own gates, and parity
was not it.

What parity added is a second, EARLIER enforcement of the same rule: the plugin
tier's own `messageIdSource` union does not contain the word, so an author is
told at `definePlugin` rather than at deployment boot. The composition-time
throw stays as the artifact-level backstop, because a generated entry reaches
the catalog through a cast and the manifest is not the only way bytes get there.
The same shape applies to `supportsCustomReturnPath`: only `no` is true of a
bundled transport, because the other two values need an envelope sender signed
with a deployment secret and a bundled module is handed configuration, never
signing keys. It is refused rather than ignored — ignoring it is invisible,
and `yes` read as "supported" hands the ramp controller the comparable bounce
tolerance for an arm whose bounces we cannot attribute.

### Persisted kind fields stay strings (D10)

Every place a provider kind is STORED is a plain `v.string()` with the union in
a comment: `providerRoutes.providers[].providerType` and
`providerHealth.providerType` (`schema/delivery.ts`), `domains.providerType`
(`schema/domains.ts`), the transport kind on the plugin-feedback tables
(`schema/webhooks.ts`), `sendAssignments.transport` and
`sendingDomainRelayIdentities.providerKind`. This is recorded here as policy so
those comments stop being the only witness.

A new kind must be **rows, not columns**. A closed validator union would make
adding a provider a schema migration, and — worse — would make a row written by
a newer deployment unreadable by an older one during a rolling update, which is
precisely when a delivery row must still be readable. The cost is real and
accepted: nothing at the database boundary rejects a kind that no longer exists.
So the readers fail closed on an unrecognised kind instead (the registry lookups
throw by name rather than returning an inherited member; the catalog accessors
apply the conservative default), which is where the check belongs anyway,
because that is the layer that knows what the kind was going to be used for.

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
  documented in `apps/docs/content/3.developer/15.providers.md`, and its plugin
  column in `apps/docs/content/3.developer/49.plugin-send-providers.md`.
- The webhook seam is now claimed AND wired, which is a single fact in CI: the
  plugin platform's reachability suite fails if a declared contribution has no
  production consumer, so the contract change and the wiring had to land
  together. The price is that a core kind's feedback URL is still a literal a
  human writes — one line in `http.ts`, enforced by a test that walks the real
  router rather than by a type.
- No shipped code branches on `tier === 'plugin'`, which means the failure mode
  to watch for is a new one that reintroduces the distinction. `lint:providers`
  catches kind literals, not tier comparisons, so this one stays a review
  obligation. (The `tier === 'own'` reads are the D3 identity — own vs. not-own
  — and are exactly the comparisons that are meant to exist.)
- The custody/message-id declaration widened what a catalog entry is responsible
  for, and one of its values has prerequisites outside the catalog. Until those
  are met, `acceptanceSemantics: 'accepted'` is the own MTA's alone — declared
  honestly rather than hidden, so the next author reads the constraint at the
  field (the PREREQUISITES note in `packages/shared/src/sendProviderCatalogTypes.ts`, which is where it lives) instead
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
