# Abstraction Surface

Single source of truth for the provider/adapter interfaces in Owlat. Every
external dependency we want to keep swappable lives behind one of these.
When adding a new backend (Bedrock, Twilio, Mailgun, …), write an adapter
file alongside the existing one — never reach for the SDK directly from a
feature module.

## Pattern

Each abstraction follows the same shape:

```
lib/<providers>/
├── types.ts        — interface, type aliases, shared helpers
├── <name>.ts       — concrete implementations (one per backend)
└── index.ts        — factory that reads an env var and returns the cached instance
```

Factories cache the resolved provider per-process. Tests can call
`clear*ProviderCache()` between cases to swap env.

---

## Providers in apps/api (`apps/api/convex/lib/`)

| Interface                                                               | Env var                 | Implementations                                                             | Files                                                                                    |
| ----------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `EmailProvider` (domain identity/verification) — **legacy, superseded** | `EMAIL_PROVIDER` (mta)  | see `domains/providers/` below                                              | `emailProviders/{sesIdentity,mtaIdentity,domainVerification}.ts`                         |
| Send providers (delivery dispatch + health + routing)                   | per-org config          | `mta`, `ses`, `resend`, `smtp`, `mandrill`, `emailit`                        | `sendProviders/` (adapters) + `packages/shared/src/sendProviderCatalog.ts` (the catalog) |
| `LLMProvider`                                                           | `LLM_PROVIDER` (openai) | OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, Claude-via-compat) | `llmProvider.ts`                                                                         |

The first row is **history, not a seam to implement**: there is no `EmailProvider`
interface left in the tree. Its job moved to the sending-domain provider registry
([below](#sending-domain-identity-providers)), so write a
`domains/providers/<kind>/` adapter, never an implementation of that row. What
survives under `emailProviders/` is what those adapters call:
`sesIdentity.ts` / `mtaIdentity.ts` are the two provider identity API clients,
and `domainVerification.ts` holds the From-address helpers **and** the
`domains`-table verification gate (`isDomainVerified`,
`isDomainVerificationFresh`, `validateDomainForSending`,
`getDomainVerificationStatus`) that the send path checks before a campaign goes
out. `EMAIL_PROVIDER` stays on the row because it is still what picks a newly
created domain's `providerType` — see the section below.

The send-provider seam is deliberately **two halves**. The DATA half — what each
kind is, needs and can do (`kind`, `label`, `tier`, `requiredEnvVars`,
`optionalEnvVars`, `credentialFields`, `supportsCustomReturnPath`,
`hasProviderFeedback`, `providerFeedback`, `domainVerification`, `retryDelays`,
the dispatch semantics, `setupProbe`) — is `packages/shared/src/sendProviderCatalog.ts`, a
leaf module with no adapter code and no secrets, so `apps/web`, `apps/setup-cli`
and the docs suite read the same declaration the backend does. The kind union
(`SEND_TRANSPORT_KINDS`), the setup surfaces' `DELIVERY_PROVIDER_KINDS`,
`getSendPathRequiredEnv`, `PROVIDER_ENV_KEYS` and the SMTP relay presets are all
derived from it rather than restated — before the seams plan's P1.1 they were
five independent declarations. The CODE half —
`apps/api/convex/lib/sendProviders/catalog.ts` — joins those entries to the
adapter modules and to the bundled plugin tier, and owns the kind-keyed
accessors that resolve against the COMPOSED catalog. Those accessors are a
lookup plus a rule, and only the lookup is the backend's: each field's
fail-closed default (`hasProviderFeedback` absent ⇒ `false`,
`acceptanceSemantics` absent ⇒ `unknown-on-timeout`, …) is applied by the shared
module's `…Of(entry)` functions, so web and the CLI get the same reading from
their own core-only lookup. `tier: 'own'` is likewise read through
`isOwnSendProviderKind` rather than compared to a literal — the one identity
question D3 sanctions, asked in the one place that declares the answer. Adding a
provider means adding an entry, not editing a table somewhere else; the
accompanying `bun run lint:providers` ratchet parses its kinds out of that same
literal.

Send providers additionally take **operator-installed** implementations: a
bundled plugin contributing a `sendTransports` entry appears as the kind
`plugin.<pluginId>.<localId>`, catalogued at
`convex/plugins/sendTransportCatalog.generated.ts` and adapted to the same
`SendProviderModule` interface by `sendProviders/pluginProvider.ts`. Dispatch,
retries, health and routing stay host-owned; see the [plugin contribution
reference](../apps/docs/content/3.developer/42.plugin-contributions.md).

Since the seams plan's P3.1 that contribution declares the SAME capability
vocabulary a core entry does — `supportsCustomReturnPath`, `messageIdSource`,
`deduplicatesOnIdempotencyKey`, the variables its configuration lives in and the
`credentialFields` descriptors that describe how to ask for them — and
its module may build per-send extras on both the governed and the system-mail
paths, so the capability accessors answer for a plugin kind exactly as they do
for a core one. Three things are still declared differently, on purpose:
`hasProviderFeedback` and `domainVerification` are DERIVED, from whether the
contribution carries a `webhook` and a `domainIdentity` respectively (one fact
each, not two fields that could disagree — the identity half is the seams plan's
P3.2, and the derivation is why this tier can now verify a sending domain
without the word being declarable); the values whose prerequisites live in
backend code — `acceptanceSemantics: 'accepted'` and
`messageIdSource: 'idempotency-key'` — are not in this tier's unions at all; and
`supportsCustomReturnPath` narrows to `no`,
because both other values claim that our own bounce processor can attribute this
transport's bounces and the envelope sender that would make that true carries a
VERP local part the HOST signs. A claim graded `supported` on an arm whose
bounces land at the provider is a measurement bias with no symptom, so the kit,
the manifest validator and the catalog composition each refuse the word. A
declared configuration variable is `PLUGIN_`-prefixed and may not contain `__`:
the prefix fences the plugin namespace off from the host's own deployment
credentials (it does not partition it between plugins), and the suffix is what
separates one named instance's credential from another's. Both halves of that
rule are ONE predicate, `isPluginSendTransportEnvVar`, which composes onto
`isPluginSecretEnvVar` — the single statement of the `PLUGIN_` namespace, shared
with settings `secret` fields, webhook signing keys and the host's own read fence
(`getPluginTransportEnv` in `apps/api/convex/lib/env.ts`, which delegates to it
rather than keeping a copy) — rather than restating it. A `credentialFields`
descriptor is DESCRIPTIVE (no surface renders a plugin's form yet; that is the
plan's P3.3) and is validated by the same field-descriptor validator the
platform's `settingsSchema` uses, so "the settings five" is a shared
implementation and not a shared sentence. What makes a plugin kind CONFIGURED is
the union of the contributing plugin's `flag.requiredEnvVars` and the transport's
own — the same two facts the authoritative dispatch path checks — while only the
transport's own take an instance suffix. The two lists may not name the same
variable: one of them takes the suffix and the other does not, so an overlap
would grade a named instance configured on the suffixed copy while the
deployment-wide switch went unchecked.

Speculative single-implementation seams (auth, storage, analytics,
notifications, vector stores) have been **deleted**, per the project's
deletion-over-seams rule: a provider directory exists only once a second
real implementation (or a real caller) does. Re-introduce one by following
the Pattern above when that day comes — don't keep empty sockets around.

### Sending-domain identity providers

`SendingDomainProviderModule` (`apps/api/convex/domains/providers/`) — a
registry keyed by `domains.providerType`, one adapter folder per kind (`mta`,
`ses`, `mandrill`). It owns everything provider-specific about a _sending
domain_: registering the identity at the provider, the DNS records to publish,
the provider-side verification check, and — for relays — the proof the
deliverability fallback reads before handing a From domain over. Every piece of
that work is dispatched through `providerFor(kind)`.

Which kind a _newly created_ domain gets is still an env decision:
`domains/lifecycle.ts` reads `EMAIL_PROVIDER`, narrows it through
`isSendingDomainProviderKind` (the registry's own guard, so an unrecognized
value is not a crash) and falls back to `mta`. Registering an adapter therefore
makes a kind _reachable_; naming it in `EMAIL_PROVIDER` is what makes new
domains use it.

**But registering an adapter is not yet the whole wiring.** Relay-identity
provisioning is: both the forward path (a domain reaching `verified`) and the
catch-up drain walk this registry and ask `ensureRelayIdentity`, so a newly
registered kind is on both the moment it registers (the seams plan's P0.4).
What `domains/lifecycle.ts` still carries `providerType` branches for is the
RETURN-PATH family — which `mailFrom` bundle a custom return-path host
publishes, and which reflection action pushes it to the provider — and a new
kind silently gets neither. That capability has no home on the adapter
interface yet. It is one of the surviving families of kind literals, and the
families are DATA rather than prose, split by what the literal is. A kind
_declaration_ (`const X = 'ses'`) is enumerated by `SURVIVING_KIND_LITERALS` in
`apps/api/convex/lib/sendProviders/__tests__/kindLiteralCustody.test.ts`, with
its family and its owner; a _comparison_ — the return-path branches included —
is enumerated by the ratchet's allowlist below. Both fail in both directions:
an unenumerated literal fails, and an entry whose literal has been swept fails
until it is deleted.

The comparison half is `bun run lint:providers`
(`scripts/check-provider-identity.sh`), the CI gate that carries the rule across
`apps/`, `packages/` and `examples/`: no comparison against a kind literal —
`===`, `==`, `case`, or membership (`kinds.includes('ses')`,
`kinds.indexOf('ses') !== -1`, `['ses', 'resend'].some(…)`) — outside an
adapter bundle. `examples/` is in scope because it is a workspace root and the
home of the plugin tier, whose whole promise is that a provider ships without
host edits. An "adapter bundle" is a kind-named directory directly under
`lib/sendProviders/`, `domains/providers/`, `integrationImports/providers/` or
`webhooks/adapters/` — anchored to those roots rather than to any path segment
that spells a kind, so a per-vendor folder of UI panels still fails. Also out of
reach on purpose: `apps/mta` (its `'mta' | 'relay' | 'defer'` routing decisions
are its own alphabet, not the catalog's), `migrations/` (frozen replays, pinned
to the kinds of their date), tests (`__tests__/`, `*.test.*`, `*.spec.*` and the
Playwright tree `e2e/`, whose page objects are scaffolding for specs that are
already exempt), and generated code. A module merely _named_ `fixtures.ts` ships,
so it is scanned like any other source. Matching runs over a three-line window,
so reformatting a long condition or a long membership array does not de-fang it,
and the comment stripper tracks string literals — a `//` in a doc link or a `*/`
in a glob is not a comment, and reading one as a comment is how a text gate goes
quietly blind.

Two checked-in files license the rest, both strict in both directions so they
can only shrink: `scripts/provider-identity-allowlist.txt` is debt, written once
per entry under a family header naming the piece that deletes it, and its entry
count is what "zero identity checks" is measured against;
`scripts/provider-identity-collisions.txt` is the permanent set where the
spelling belongs to a different vocabulary (the MTA routing API's answer, a
docker compose profile, the contact-import registry) and there is no coupling to
remove. Entries in both files are qualified `path:literal` (the script still
parses bare `path`, but the debt list no longer uses it), because a whole-file
licence would excuse a real kind branch added to that file later — the exact
blindness bare entries showed when `emailit` arrived.

The two checks are disjoint, not overlapping: declarations in the backend belong
to the vitest one, comparisons everywhere belong to the ratchet, and neither
list is derived from or restated in the other.

Which seams a kind must implement is declared, not assumed: the send-provider
catalog's `domainVerification: 'api' | 'none'` field is the promise. For a
**core** kind, declaring `api` must both register an adapter here and implement
the three relay seams (`RelayProvingProviderModule`) — both are compile errors
otherwise. A **bundled plugin** transport declares neither word: its
`domainVerification` is DERIVED from whether it contributes a `domainIdentity`
module, so the promise and the code that keeps it are one declaration and cannot
disagree (the seams plan's P3.2).

**Two registries, two questions** (P3.2). `SENDING_DOMAIN_PROVIDERS` above
answers "is this a PRIMARY sending-domain provider kind?" — the value a `domains`
row records in `providerType`, whose adapter owns registration, the DNS bundle,
the sibling identity and the return path. It stays a closed core union.
`relayIdentityProviderFor(kind)` answers the smaller question "can this RELAY
kind prove a domain?", asked by the routing gate, the identity backfill and the
alignment pre-flight about a relay that COEXISTS on a domain our own MTA hosts.
That one is composed at build time: every core adapter implementing all three
relay seams, plus one `RelayIdentityProviderModule` per bundled plugin transport
that declared a `domainIdentity`. Conflating them is what the split prevents —
widening the primary union would make `EMAIL_PROVIDER=plugin.<id>.<local>` run a
domain's whole lifecycle through code this repository does not contain.

For the plugin tier the host keeps everything that decides anything: the proof
rule and its freshness bound (`PLUGIN_RELAY_PROOF_MAX_AGE_MS`, a host constant a
manifest may not weaken), the derived `status`, the row, and the write rules for
the three call outcomes. The rule and the write rules are stated ONCE for the
shared table, in `providers/relayIdentityProof.ts` and
`providers/relayIdentityPersistence.ts`, and every kind that writes
`sendingDomainRelayIdentities` calls them: two tiers reading one table under two
definitions of "proven" is how one relay ends up handed a From domain another
would refuse, with both suites green. What a kind still owns is its cadence, its
`providerDetails` blob and its freshness bound — facts about a provider, not
about the row. The due-check sweep dispatches the same way: it asks the relay
registry for the arm that re-asks a row's provider rather than comparing the
kind, so a new kind joins the sweep by registering. The plugin's module owns only the provider
conversation — `registerDomain` / `checkDomain`, called from
`domains/pluginRelay.ts` under a re-checked `send:transport` grant and audited as
`transport.domain_identity`. Same split as the feedback webhook's.

Where a kind's identity row lives depends on when the kind arrived. Anything
added after MTA and SES writes to the generic, org-scoped
`sendingDomainRelayIdentities` table — Mandrill does, and so does every bundled
plugin identity, keyed by its namespaced `plugin.<id>.<local>` kind (a plain
string field: rows, not columns). The two per-provider
sibling tables (`sendingDomainMtaIdentities`, `sendingDomainSesIdentities`) are
frozen: no third sibling is ever added, no new kind gets rows there, and they
keep the MTA's and SES's.

**The WRITE half is not encapsulated yet.** Each adapter has `writeIdentity` /
`clearIdentity`, but the SES relay provisioning does not go through them:
`sesRelay.provision` (the action the SES adapter's own `ensureRelayIdentity`
schedules) calls `sesRelayMutations.storeProvisioning`, which inserts into
`sendingDomainSesIdentities` from outside `domains/providers/` — so the pattern
to mirror for relay kind #4 is an out-of-adapter `<kind>RelayMutations.ts` plus a
scheduled `provision` action, not an adapter method. `sendingDomainMtaIdentities`
has out-of-adapter writers too (`devShortcuts/forceVerifyDomain.ts`, the demo
seed). P0.4 routed the SCHEDULING of that write through the adapter but left the
insert where it is; folding it in is unclaimed by any piece.

**The READ half is.** `describeRelayIdentity` (optional on both module
contracts, carried through `relaySurface.ts` into the relay-identity registry) is
how a kind says what it can tell an operator about one sending domain, in the one
shape every kind answers in: `RelayDomainIdentityFacts` —
`providers/relayIdentityView.ts`. `providerRoutes.listRelayDomainIdentities`
walks `relayIdentityProviders()` and returns one row per (domain, relay kind),
labelled from the catalog, and a kind that implements no describe seam is still
answered for by the generic read of its shared row. So registering a kind is what
makes it visible, and implementing the seam only adds detail — SES's frozen
sibling and its remembered DNS bundle, Mandrill's derived records and its
ownership token, the plugin tier's selectors and its host-owned proof bound.

That replaced the surface's per-vendor shape, which is worth stating because it
is the failure the seam prevents: an SES-shaped query that point-read the frozen
sibling, a second `providerKind === 'mandrill'` query beside it, one Vue panel
above each, and `ANSWERS_FOR_KINDS = ['ses']` in the panel to keep the pair from
lying about each other. The bundled plugin relay tier wrote rows into the shared
table that **no surface could render**, so its operators were told provisioning
was queued forever, about a run that had already finished. One panel
(`components/delivery/RelayDomainStatus.vue`) now renders every kind.

### Provider feedback (webhook) adapters

`AnyInboundAdapter` (`apps/api/convex/webhooks/adapters/`) — the third provider
seam: where a send transport's own bounces, complaints and deliveries come back
to us. A registry keyed by send-provider kind, one adapter file per kind (`mta`,
`ses`, `resend`, `mandrill`, `emailit`), each owning provider-specific parsing
into the canonical `InboundEvent`. Signature verification is a host-owned
contract composed in `providers/feedback.ts`; rate limiting per source,
raw-payload audit, ordered dispatch, and the HTTP response remain shared in
`webhooks/pipeline.ts`.

Which kinds must be here is declared, not assumed: `hasProviderFeedback: true`
in the catalog is the promise, and `FeedbackReportingSendProviderKind` turns it
into a compile error in `webhooks/adapters/index.ts` when the adapter is
missing — in both directions, so an adapter registered for a kind the catalog
calls silent fails too. The registry key must equal the adapter's own `source`,
which is the rate-limit bucket and the audit label, so keying and sourcing
cannot drift apart. The `channels.ts` adapters in the same folder (`twilio`,
`meta`, `generic`) are inbound SMS/WhatsApp/webhook channels, not send
transports; they have no catalog entry, no kind and no place in this registry.

The **routes stay static and per kind**: `http.ts` registers
`POST /webhooks/<kind>` one literal at a time, and `providerFeedbackWebhook(kind)`
is only the handler they share. A route derived from the registry would be a URL
that can move itself, and these URLs are already pasted into provider consoles we
do not own — a moved webhook URL is silent on our side and total on theirs. The
declared side of the pair is the catalog's `providerFeedback.webhookPath` (what
the delivery page tells an operator to paste); the two are cross-checked against
the real router by `lib/sendProviders/__tests__/feedbackRoutes.test.ts`.

A bundled plugin transport's feedback does **not** arrive here. It gets its own
route surface keyed by plugin id — the next section.

### Bundled-plugin feedback webhooks

`pluginSendTransportWebhookFor`
(`apps/api/convex/plugins/sendTransportWebhookCatalog.ts`) — the plugin tier's
half of the same seam (the seams plan's D6, wired by P2.2). A plugin transport
may declare a `webhook` on its `sendTransports` contribution: a parse-only module
export plus the signature contract the HOST verifies it with. One route serves
all of them, `POST /webhooks/plugin/<pluginId>`
(`webhooks/pluginFeedbackHttp.ts`), keyed by plugin id rather than by kind —
which is why the manifest validator refuses a second webhook per plugin.

**The tiers differ in who verifies.** A core adapter owns its provider's
signature ceremony because we wrote it. A plugin's authenticity is never a
plugin's decision: the host recomputes the declared HMAC over
`<timestamp>.<rawBody>` in constant time, enforces the contract's timestamp
tolerance, and applies a delivery digest it has already claimed exactly zero
further times (`pluginWebhookDeliveries`, released again when a delivery does not
complete; a repeat is answered `200 { duplicate: true }`, because the ordinary
cause is our own lost acknowledgement and a `4xx` run is what makes a provider
deactivate an endpoint). The plugin module only turns verified bytes into the
four feedback facts (`delivered` / `bounced` / `complained` / `deferred`), and
the host revalidates every field of its output before dispatching, stamping
`providerType` from the registry rather than from the plugin and refusing a
provider message id in a namespace Owlat reserves for its own messages (`pb-`,
`rp-probe.` — `delivery/messageIdRouting.ts`), since the id is what chooses the
dispatcher's lane. A webhook declared without a signature contract, or with one
carrying no replay provisions, fails MANIFEST VALIDATION — so an unverifiable
webhook cannot be bundled at all; the host re-asserts the parts of that it
depends on (the `PLUGIN_` secret namespace, bounded replay provisions) when it
loads the generated artifact, which is where a validator's guarantee can have
gone stale.

Two more gates sit on the request path that the core route has no notion of: the
hosted-contribution authorization seam (`plugins/sendTransportWebhookAuthorization.ts`,
audited as `transport.feedback`) rechecks flag, operator grant, env and singleton
scope on every delivery, so disabling a plugin stops its inbound events as surely
as its outbound sends; and raw-payload retention is OPT-IN per adapter rather
than the pipeline default — but where it is opted into it keeps the pipeline's
verify → store → parse order, so the delivery an operator most needs the bytes of
(the one a drifted parse half rejected) is retained rather than lost. The
adversarial suite is `webhooks/__tests__/pluginFeedbackRoute.test.ts`.

**One confusion this route does not close.** `transitionByProviderMessageId`
resolves a provider message id with no `providerType` scoping, so any feedback
source that can name another provider's id can move that provider's Send — a
property the core adapters already have against each other, now also reachable
from a third-party-fed route. The reserved-prefix refusal above closes the arms
that are not Sends at all (Postbox, return-path probes); scoping the lookup by
provider is dispatcher-wide work and belongs with P3.1's parity pass, not to one
caller.

**The capability declaration has not caught up.** The route delivers the events,
but a bundled plugin's catalog entry still carries no `hasProviderFeedback`
field, so `hasProviderFeedbackFor('plugin.…')` reads the whole plugin tier as
feedback-less (fail-closed, per that function's docstring). Its two consumers
act on that today: the measurement grading does not widen a bounce tolerance for
a plugin arm, and `governedDispatch` still terminalizes an ambiguous-acceptance
send on one rather than waiting for feedback that does now arrive. Declaring it
is P3.1's parity work, not this seam's.

### Deliverability signal sources

`SignalSource` (`apps/api/convex/delivery/signals/`) — the fourth provider seam,
and the only one that is about EVIDENCE rather than about dispatch: where a
deployment's readings about its own deliverability come from. Every source
declares three things — its `key` in the shared deliverability vocabulary, its
`kind`, and what happens when it is **not configured** — and the registry
(`registry.ts`) is keyed by the vocabulary, so a new source is a compile error
until it is registered and a registered source that names an unknown key does not
compile either.

| Key                 | Kind             | Absence      | Implementation                                        |
| ------------------- | ---------------- | ------------ | ----------------------------------------------------- |
| `bounce_rate`       | `outcome`        | `hold`       | `signals/rampGateSources.ts` (ramp gate 1)            |
| `persistent_defers` | `infrastructure` | `hold`       | `signals/rampGateSources.ts` (ramp gate 2)            |
| `complaint_rate`    | `outcome`        | `hold`       | `signals/rampGateSources.ts` (ramp gate 3)            |
| `engagement_ratio`  | `outcome`        | `omit`       | `signals/rampGateSources.ts` (ramp gate 4)            |
| `seed_placement`    | `outcome`        | `hold`       | `signals/rampGateSources.ts` (ramp gate 5)            |
| `yahoo_cfl`         | `advisory`       | `substitute` | `signals/yahooCfl.ts` (Yahoo Complaint Feedback Loop) |
| `google_postmaster` | `advisory`       | `omit`       | `signals/postmaster.ts` (Google Postmaster Tools)     |

**`kind` says what a reading is allowed to do**, in the sense
`packages/shared/src/deliverabilityRouting.ts` gives the three families:
infrastructure flips the shipped relay fallback, outcome moves the ramp
controller's share, advisory is recorded and readable and moves nothing on its
own. It is not a taxonomy of how the evidence was gathered — the two provider
feeds are advisory because no decision path consults them today, not because a
complaint band is advice. Wiring one into a gate changes what the ramp does and
is its own piece. The five ramp keys are pinned against the shared classifier by
`signals/__tests__/signalRegistry.test.ts`, so the ramp cannot come to measure a
signal the routing vocabulary spells differently.

**Absence is the point of the seam.** "Not configured" is a supported verdict
(the deliverability plan's D2): every absence carries `isBlocking: false` BY TYPE,
so a source that blocked on its own absence could not be declared, and the
registry suite drives each source with its evidence removed to check that what it
declared is what it does — `substitute` hands back the stand-in it names,
`hold` still answers `insufficient_data`, `omit` contributes nothing at all.
The substitution sentences are READ from the substitution the cell actually
applies (`yahooComplaintSubstitution`), never
restated here or in the registry, and a stand-in is NAMED in the one
`RAMP_SUBSTITUTE_SOURCES` vocabulary the degradation table and the dashboard use.

**The `Absence` column is the collection plane, and only that.** It says what a
source's own `collect()` hands its caller with no reading — no cards, a holding
`insufficient_data`, or the stand-in it fell to. It is deliberately NOT the
ramp-level price of an absent integration: how much longer a cell dwells, how
many clean windows it needs and how far its ceiling drops live in
`RAMP_DEGRADATION_MATRIX` (`apps/api/convex/delivery/ramp/degradationMatrix.ts`)
and nowhere else. So `google_postmaster` reads `omit` here — a domain Google has
said nothing about produces no cards — while the matrix's `google_postmaster`
entry doubles the Gmail cell's dwell and drops it to medium confidence. Two
questions, two homes, no second copy of either. A source whose stand-in depends
on what else is configured (`yahoo_cfl` falls to the CFBL feed when a send
carried one, otherwise to the unsubscribe proxy) declares the WORST case here
and answers per-cell from `collect()`.

**Gate evaluation folds the registry, not a list of modules.**
`ramp/gateEvaluation.ts` asks `collectRampGateSignals(arm, input)`; each source
declares one evaluator per arm (the concurrent two-armed one and the standalone
trailing-baseline twin), which is the one thing the two implementations differ
about. The ARRAY ORDER is a contract: the aggregator names the first result at
the winning rank, so the sources are declared in the plan's gate numbering.

**Two things are deliberately absent.** The shipped relay-fallback triggers
(`ip_quarantined`, `dnsbl_*`) are declared in the shared routing vocabulary and
recorded by the routing plane; nothing collects them through this contract, and a
registry row with no collector would promise a reader there is not. And there is
**no plugin bucket**: third-party signal sources are deferred — the registry is
the seam, and opening it is a one-piece follow-up on the day someone wants it.

The durable halves stay outside this directory, because their Convex function
paths are addressed by pollers, crons, the webhook dispatcher and the delivery
screens: `delivery/snds.ts` (ingest and retention) and
`delivery/postmaster.ts` (the two ingest mutations, the sweep, and
`getPostmasterStatus`, which now reads its cards through the registered source
rather than calling the derivation around it — `connected` is deliberately left
on the stored period timestamps, because "an observation was stored" and "the
stored observation has something readable in it" are different questions and
only the first is what the screen's connect affordance asks).

---

## Outbound channel adapters (`apps/api/convex/channels/adapters/`)

The three non-email channels an operator can configure credentials for and send
through. One consumer: the sibling `channels/outbound.ts` action, which decrypts
those credentials and builds an adapter per dispatch, per delivery-status poll
and per health probe.

| Adapter           | Outbound provider                          | Delivery status       | Health probe         |
| ----------------- | ------------------------------------------ | --------------------- | -------------------- |
| `SmsAdapter`      | Twilio REST `Messages.json`                | Twilio message lookup | Twilio account fetch |
| `WhatsAppAdapter` | Meta Cloud API `/{phoneNumberId}/messages` | webhook-driven        | Meta graph fetch     |
| `WebhookAdapter`  | HTTP POST to the configured endpoint       | none (`sent`)         | config presence only |

Not adapters here, on purpose. **Email** is the send-provider seam above —
`sendEmail` on a catalog kind, not a channel. **Chat** is native: the mutation
persists the row and there is no provider to adapt. Until the D10 honesty pass
both had a class in this set anyway, and each faked its answers — a `send` that
hard-returned failure or a fabricated id, a `healthCheck` that hard-returned
healthy without probing, a `validateSignature` that hard-returned `true`. They
are deleted, not reimplemented — and the exclusion is now typed, not merely
documented: `ChannelAdapter.id` is `OutboundChannel` (`sms | whatsapp |
generic`), the dispatchable subset declared beside `UnifiedMessageChannel` in
`lib/convexValidators.ts`, so an adapter claiming `email` or `chat` does not
compile.

The same honesty applies inside the contract. `ChannelHealth` reports `status`
and `lastError` and nothing else, because those are exactly the arguments its
only consumer (`updateChannelHealth`, reached via `probeChannelHealth`) can
persist. It previously also declared `lastSuccessfulSend` and
`rateLimitRemaining`, which no adapter ever set, and `latencyMs`, which the
Twilio and Meta probes measured on every five-minute run and then dropped —
`channelConfigs` has no column for it. (`channelConfigs.lastSuccessfulSend` is
real, but `unifiedMessages.recordOutbound` stamps it off an actual send, never
a probe.) Persisting probe latency is a schema change; a member nothing reads
is not a substitute for one.

**Nothing here verifies or parses an inbound webhook, and the contract has no
member for it.** Verification and payload normalization for these same three
channels live in `webhooks/adapters/{twilio,meta,generic}.ts` — the only
implementation — where they run against real secrets on the real inbound route.
The `ChannelAdapter` interface used to declare a `validateSignature` and a
`parseInbound` that nothing ever called and that had already drifted from the
shipped verifiers (the generic one accepted a bare `Authorization` value where
the route strips `Bearer ` first). D10 deleted the pair rather than keep two
expressions of one rule. A new inbound source is a new `webhooks/adapters/`
module, never a method here.

## Inbound mail normalization (`packages/channels/`)

`@owlat/channels` is exactly one thing, whatever its name still suggests, and
this is its only row: the source-keyed registry in
`packages/channels/src/inboundRegistry.ts` that turns a vendor's inbound
envelope into the canonical `InboundEmailMessage`. The package holds nothing
else — the stub outbound `ChannelAdapter` classes that used to live beside it
were deleted by the D10 honesty pass, and the three real ones moved to
`apps/api/convex/channels/adapters/` (the section above).

| `InboundSource` key | Adapter                                                     |
| ------------------- | ----------------------------------------------------------- |
| `mta`               | `MtaInboundAdapter` — the `inbound.received` event envelope |
| `resend`            | `ResendInboundAdapter` — flat inbound-mail payload          |
| `ses`               | declared, **not registered** — lookup throws                |
| `postmark`          | declared, **not registered** — lookup throws                |
| `mailgun`           | declared, **not registered** — lookup throws                |

The last three are keys in the `InboundSource` union with no adapter behind
them, on purpose: `getInboundChannelAdapter` throws a named error for them, so a
caller can tell "source registered but not implemented" from "unknown source"
instead of silently parsing nothing. Consumers reach an adapter through
`getInboundChannelAdapter(source)` — today the MTA feedback adapter (for
`inbound.received`). **A new inbound vendor is a new adapter module plus a
`registerInboundChannelAdapter()` call**; no handler and no other row in this
file needs editing for it.

Not to be confused with `webhooks/adapters/` in apps/api, which verifies and
parses _channel_ (SMS/WhatsApp/generic) webhooks — a different seam with a
different job. This registry only ever sees mail.

---

## Feature flags & packs (`packages/shared/src/featureFlags.ts`)

The pluggability story isn't just providers — it's also product surfaces.
Every toggleable feature is declared in one place with dependency rules,
docker profile mappings, and required env vars.

### Atomic flags

- 26 flags across categories: sending, receiving, ai, integrations,
  security, deliverability, hosted-only.
- `resolveFlags()` does fixed-point dependency resolution.
- `applyToggle()` cascades on/off through the requirement graph.

### Feature packs

UI grouping over atomic flags. Toggling a pack flips every member.

- `emailClient` = `inbox`, `chat`, `mail.compose`
- `marketing` = `campaigns`, `automations`, `transactional`
- `ai` = `ai`, `ai.agent`, `ai.autonomy`, `ai.knowledge`, `ai.visualizations`

### Where flags are enforced

- **Backend gates** — `assertFeatureEnabled(ctx, flag)` at the top of public
  Convex functions. Implementation: `apps/api/convex/lib/featureFlags.ts`.
- **Frontend nav** — `apps/web/app/layouts/dashboard.vue` reads
  `useFeatureFlag().isEnabled(flag)` to conditionally render sections.
- **Route gates** — pages declare `definePageMeta({ requiresFeature: '…' })`
  and `apps/web/app/middleware/feature.global.ts` redirects to the dashboard
  when the flag is off. Closes the deep-link hole.
- **Docker profiles** — `getActiveProfiles(flags)` maps active flags to
  compose profiles so disabled features don't even start their containers.
- **Setup CLI** — `owlat-setup pack <key> <on|off>` and
  `owlat-setup feature <key> <on|off>` are the operator-facing toggles.

---

## Adding a new backend

1. Read the existing `types.ts` for the abstraction.
2. Create `<name>.ts` next to the current implementations. Export
   `create<Name>Provider()` and a class implementing the interface.
3. Add the new type to the union in `types.ts`.
4. Add a `case` in `index.ts`'s factory switch.
5. If the new backend introduces config — env vars or a feature flag — add
   them to `packages/shared/src/featureFlags.ts` so the setup wizard / CLI
   surface them.
6. Run the package's vitest suite to confirm the factory dispatches.

## Migrating legacy callers

Some modules historically reached for the SDK directly. Each migration is a
mechanical search-and-replace:

```ts
- import { Resend } from 'resend';
- const r = new Resend(process.env.RESEND_API_KEY);
- await r.emails.send({ ... });
+ import { getEmailProvider } from './lib/emailProviders';
+ await getEmailProvider().sendEmail({ ... });
```

Already done:

- `automationStepExecutor.ts` → `getEmailProvider()`
