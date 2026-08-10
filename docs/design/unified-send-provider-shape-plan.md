# Unified send-provider shape migration plan

**Date:** 2026-08-09

**Status:** Implemented and verified on `integration/seams-and-pluggability`

**Scope:** Owlat MTA, Amazon SES, Resend, generic SMTP relay, Mailchimp
Transactional (Mandrill), and the first external provider bundle

**Primary constraint:** no capability, wire contract, stored identity, operator
ceremony, or safety posture may be lost during the conversion.

## 1. Outcome

Every send provider is composed as one bundle with the same top-level slots:

```text
provider
├── descriptor              browser-safe identity, credentials, retry and semantics
├── transport               one outbound network attempt
├── feedback?               host-verified webhook plus normalized events
├── primaryDomainIdentity?  owns a domain's primary sending lifecycle
├── relayDomainIdentity?    proves a domain may use this provider as a relay
├── setup?                  credential probe and operator ceremony
└── platformHooks?          Owlat-owned extensions; never third-party
```

There is one composer, one composed catalog, one transport registry, one feedback
router, one domain-identity registry, and one setup renderer. A provider is added
by contributing a bundle, not by editing each consumer.

"One shape" does **not** mean "one trust level." The host assigns the source
trust (`own`, `first-party`, or `third-party`) from the registry that loaded the
bundle. A provider cannot self-declare or escalate its trust. All three sources
share the bundle shape, while the composer rejects capabilities that their trust
level cannot safely hold.

The conversion is complete when the old core catalog and the three hand-written
registries are compatibility exports over the composed bundles—or have no callers
and can be deleted—and every existing provider passes the same conformance suite.

### Explicitly out of scope

- Making provider packages installable at runtime. Composition remains
  deterministic and build-time.
- Replacing the frozen MTA/SES identity tables with a cosmetically uniform table.
- Renaming existing kinds, routes, variables or persisted fields.
- Introducing per-instance feedback endpoints or signing keys. The current
  deployment-wide feedback-channel scope is preserved; that can be generalized
  later without coupling it to this conversion.
- Granting third-party code MTA custody, routing or provenance privileges.
- Changing provider pricing, routing policy or the selected external ESP.

## Implementation result

- `@owlat/provider-kit` defines the source-neutral bundle and host-assigned trust model.
- One runtime composer now joins every incumbent and bundled plugin transport to feedback,
  domain-identity, setup, and platform-hook slots. Legacy registries are compatibility views.
- One generic feedback-status query and ceremony renderer replaced provider-specific status reads.
- A host-owned verifier registry authenticates HMAC, Svix, AWS SNS, and Mandrill form callbacks
  before parse-only provider semantics run.
- MTA, SES, Resend, SMTP, and Mandrill retain their existing kinds, env names, routes, storage,
  send semantics, feedback effects, domain roles, tracking posture, and return-path behavior.
- Emailit proves the final shape with an idempotent transport, first-party tracking preserved,
  signed feedback, generic status/setup, CLI/web configuration, and an honest `domainVerification:
  'none'` declaration until an Emailit identity persistence bridge exists.
- Third-party envelope control remains deliberately closed. This conversion does not grant a new
  module a VERP capability; it preserves the existing first-party SMTP path and explicit
  `no_envelope_control` outcomes without exposing signing material.

## 2. Non-negotiable invariants

1. Incumbent provider kinds remain `mta`, `ses`, `resend`, `smtp`, and `mandrill`;
   the conformance provider adds `emailit` without renaming any incumbent.
2. Existing named transport ids and `__<INSTANCEKEY>` credential suffixes remain
   valid.
3. Existing environment variables keep their names and meanings. Conversion
   never forces an operator to rename or re-enter a secret.
4. Existing webhook URLs remain live indefinitely:
   `/webhooks/mta`, `/webhooks/ses`, `/webhooks/resend`, and
   `/webhooks/mandrill`; Emailit adds `/webhooks/emailit` without moving them.
5. No send is shadowed by making a second provider request. Shadowing is allowed
   only for pure parsing, catalog composition, and outcome classification.
6. Existing timeout and retry semantics are byte-for-byte equivalent. In
   particular, SES and Mandrill ambiguous timeouts are never blindly retried.
7. Existing tables and stored values are not renamed or rewritten. The frozen
   `sendingDomainMtaIdentities` and `sendingDomainSesIdentities` tables stay
   frozen; later relays continue using `sendingDomainRelayIdentities`.
8. The host verifies authenticity before provider semantic code runs. Provider
   code never decides whether an internet-facing request is trusted.
9. First-party tracking remains the only engagement instrument. A converted
   provider cannot turn on its own open/click rewriting.
10. The MTA remains the only `own` provider and the only provider initially
    permitted to claim custody, pre-dispatch identity, host-attested feedback
    provenance, or privileged routing handles.
11. Missing declarations fail closed: unknown acceptance, provider-minted id,
    no feedback, no relay proof, no envelope control, and no setup probe.
12. Each provider cutover is independently revertible without a data migration
    or provider-console change.

## 3. Current state and the gaps a direct move would hide

The runtime is already mostly unified. The shared catalog supplies capability
data; core and hosted transports meet at `providerFor`; routing, health, retries,
fallback and measurement operate on capabilities instead of provider names.
What remains split is the contribution and trust boundary.

| Surface | Core providers today | Bundled providers today | Gap to close |
| --- | --- | --- | --- |
| Catalog | Static shared literal | Generated plugin artifact | Compose both from bundles |
| Transport | `SendProviderModule` registry | Hosted wrapper around plugin module | One normalized module/result contract |
| Credentials | Core env names and fields | `PLUGIN_`-scoped declared fields | Source-aware namespace policy, one renderer |
| Feedback auth | Provider-specific adapter code | HMAC over `<timestamp>.<rawBody>` only | Host-owned verifier registry |
| Feedback facts | Full `InboundEvent` subset | Delivered/bounced/complained/deferred | Add accepted, failed, unsubscribed and safe suppression facts |
| Routes | Static per-kind routes | `/webhooks/plugin/<pluginId>` | One route resolver while preserving all old paths |
| Domain identity | Primary and relay registries | Generic relay observations only | Explicit primary and relay bundle slots |
| Return path | `yes`, `probe`, or `no`; core probe wire | Third-party forced to `no` | Hand modules a host-built envelope address, never a signing key |
| Setup probe | Shared validator named by core catalog | Not declarable | Bounded setup module contribution |
| Feedback UI | SES/Mandrill-specific status reads | Catalog entry can render no truthful status | Generic status query keyed by transport |
| Platform hooks | MTA postmaster, inbound, TLS and re-entry controls | Not available | Own-only extension, separate from portable provider facts |

A folder move before closing these gaps would compile only by dropping features
or by teaching provider code to authenticate itself. Both are rejected.

## 4. Target contract

### 4.1 Universal contract package

Introduce `@owlat/provider-kit` as a runtime-neutral public package. It contains
only data types, validators, normalized result vocabularies and `define…`
helpers—no Convex imports, environment reads, network calls or host state.

`@owlat/plugin-kit` re-exports the third-party-safe provider contracts so current
plugin authors keep one entry point. Existing plugin names remain source
compatible during a deprecation window; codegen accepts the old manifest shape
and normalizes it into the universal bundle.

The important types are conceptually:

```ts
interface SendProviderBundle<K extends string> {
  descriptor: SendProviderDescriptor<K>;
  transport: ProviderModuleExport;
  feedback?: ProviderFeedbackContribution;
  primaryDomainIdentity?: PrimaryDomainIdentityContribution;
  relayDomainIdentity?: RelayDomainIdentityContribution;
  setup?: ProviderSetupContribution;
  platformHooks?: ProviderPlatformHooksContribution;
}
```

The executable exports remain separated by runtime. Transport and setup probes
are Node-capable. Feedback parsing and relay identity observation are
isolate-safe. Codegen proves the export graph without executing a module.

### 4.2 Trust is host-assigned

The composer receives a bundle together with provenance:

| Source | Assigned trust | Permitted privileged behavior |
| --- | --- | --- |
| Owlat MTA registry | `own` | Custody, idempotency-key identity, host feedback provenance, privileged routing context, platform hooks |
| Built-in registry | `first-party` | Host verifier schemes, primary identity bridges, setup modules, return-path probes |
| `plugins.config.ts` | `third-party` | Send, verified feedback, relay identity, safe setup and host-built envelope sender |

The manifest contains no writable `trust` field. Generated artifacts carry
provenance assigned by codegen and reasserted by the API and web hosts. A hand
edited artifact that grants a third-party provider an own-only capability stops
the deployment at composition.

### 4.3 Descriptor and derived capabilities

The descriptor carries stable data:

- kind, label and retry delays;
- required and optional credential variables plus field descriptors;
- acceptance semantics and message-id source;
- idempotency support;
- envelope-control mode;
- stable webhook route metadata and setup copy.

Capabilities with executable halves are derived rather than repeated:

- a `feedback` contribution means provider feedback exists;
- a `relayDomainIdentity` contribution means API domain verification exists;
- a setup probe export means the credential can be tested;
- a return-path probe export means envelope behavior is probed;
- a system-mail extras builder is required when idempotency is declared.

The composer rejects a descriptor/module disagreement before the app starts.

### 4.4 Transport contract

The normalized transport keeps the current one-attempt rule:

- `send(params, extras, config)` performs one provider crossing;
- the host owns retry timing, health and durable send lifecycle;
- the module maps provider responses into the existing normalized success and
  failure vocabulary;
- `buildDispatchExtras` and `buildSystemMailExtras` remain pure and synchronous;
- configuration is resolved for the selected named instance and handed to the
  module—modules do not read deployment-default credentials directly.

Extend normalized message input with a host-built optional `envelopeFrom`.
The host constructs and signs the complete VERP address only after the stored
return-path proof and SPF authorization pass. No provider receives the VERP
secret. This safely allows a third-party SMTP-style transport to preserve the
same envelope behavior as the core SMTP adapter.

The source-aware capability guard remains:

- only `own` may declare custody or `messageIdSource: 'idempotency-key'` until
  all custody prerequisites are generalized;
- `first-party` and `third-party` default to unknown-on-timeout;
- any provider declaring idempotency must export both extras builders that carry
  the key;
- a provider unable to set the complete envelope address resolves to
  `no_envelope_control`, not to a guessed success.

### 4.5 Host-owned webhook verifier registry

Replace the fixed plugin HMAC shape with a tagged verifier specification. The
host owns every implementation and every SSRF, freshness, replay and secret
rule. Provider semantic modules remain parse-only.

The initial verifier registry contains only schemes required by accepted
providers:

| Scheme | Provider | Verification and replay rule |
| --- | --- | --- |
| `hmac-timestamp-body` | MTA, Emailit, existing plugin contracts | Parameterized HMAC-SHA256/SHA1 and hex/base64 encoding over `<timestamp>.<rawBody>`, bounded timestamp, digest dedupe |
| `svix` | Resend | Base64 HMAC over `<messageId>.<timestamp>.<rawBody>`, bounded timestamp, message-id/digest dedupe, key-prefix decoding |
| `aws-sns` | SES | Canonical SNS envelope, allowed AWS certificate host, RSA signature version, exact topic ARN, timestamp bound, message-id dedupe |
| `mandrill-form` | Mandrill | HMAC-SHA1 over exact accepted URL plus sorted decoded parameters, signature/delivery dedupe |

Freshness is mandatory where the provider supplies a signed timestamp. Where a
provider scheme has no timestamp, replay prevention is mandatory through a
stable provider delivery id or durable signature digest. A scheme with neither
is not accepted.

Replay state is committed only after the complete delivery has dispatched
successfully. A partially failed batch remains retryable. A timestamp-free
scheme must document its durable dedupe horizon and the idempotency of every host
effect; trust provenance cannot substitute for replay handling.

The SNS verifier owns subscription confirmation as a constrained control flow:
only a verified SNS `SubscriptionConfirmation` with an allowlisted SNS URL can
trigger the confirmation fetch. Provider parsing code is never handed an
arbitrary URL to fetch.

The Mandrill route keeps its unsigned `HEAD`/`GET` URL-validation response as a
route-level probe. It never dispatches an event or proves the signing key.

### 4.6 Normalized feedback vocabulary

Widen the portable provider-feedback facts to the complete behavior already
used by the incumbents:

- `sent` (`email.sent`, meaning the provider reported its accepted/sent lifecycle fact);
- `delivered`;
- `deferred`;
- `bounced` with hard/soft classification;
- `complained`;
- `failed` with structured provider failure code;
- `unsubscribed` keyed by recipient, optionally by message id;
- `provider_suppressed` with a host-recognized suppression reason.

The host validates every event and decides effects. A provider cannot emit an
arbitrary internal event or audit action. In particular, a suppression fact is
actionable only when it identifies a recipient and maps to an allowlisted
recipient-specific cause. Account, sender-domain, unsigned-message and test-mode
failures never block a recipient.

The MTA's additional postmaster, inbound-mail, queue, TLS and routing-re-entry
events remain in `platformHooks`, available only to the `own` source. Its normal
send lifecycle facts travel through the portable feedback vocabulary.

### 4.7 Domain identity has two explicit roles

The bundle separates domain roles that the current code already treats
differently:

- `primaryDomainIdentity` owns a domain's registration/deletion lifecycle and
  primary identity row. MTA and SES use it. It is first-party/own only initially.
- `relayDomainIdentity` registers/checks provider observations used by fallback,
  reference-arm description and ramp alignment. SES, Mandrill and future
  full-provider plugins use it.

Relay modules return observations—ownership, SPF verdict, DKIM verdict,
selectors and SPF mechanisms. The host derives status, freshness, retry timing
and persistence. The existing generic `sendingDomainRelayIdentities` table
continues to store new relay kinds.

MTA and SES keep adapters over their frozen sibling tables. Their bundle slots
use the same external contract, while host persistence bridges retain the
existing tables and indexes. No backfill or dual-write is introduced merely to
make storage look uniform.

### 4.8 Setup and operator ceremony

`setup` may contribute:

- a bounded credential probe module;
- mechanism-based feedback instructions;
- a generic status reader contract;
- optional provider-specific guidance text.

Replace `getLastSesEventAt` and `getMandrillFeedbackStatus` as UI inputs with one
query that accepts the active transport id, resolves its provider bundle, and
reads that bundle's deployment-wide feedback channel. It returns only generic
facts:

```text
configured | missing_configuration | awaiting_event | healthy | stale
lastEventAt?
missingVariables[]
ceremony
```

The web and setup CLI render the composed catalog, not the core-only catalog.
Curated ordering remains an explicit UI descriptor so moving declarations does
not reorder a shipped form. Secret mutation allowlists are derived from the
same descriptor the selected transport reads. This conversion does not invent
per-instance webhook secrets: incumbent feedback keys remain unsuffixed and
channel-scoped exactly as they are today.

### 4.9 One composition pipeline

The host composes in this order:

1. the `own` MTA bundle;
2. first-party bundles in their established order: SES, Resend, SMTP, Mandrill;
3. bundled third-party provider contributions.

Composition emits deterministic, checked artifacts for:

- browser-safe catalog and credential fields;
- API transport modules;
- webhook verifier/parser definitions and route bindings;
- primary and relay domain modules;
- setup probes and feedback ceremonies.

Temporary compatibility exports preserve `CORE_SEND_PROVIDER_CATALOG_ENTRIES`,
`SEND_TRANSPORT_KINDS`, `SEND_PROVIDERS`, and the existing feedback/domain
lookup functions. They are derived views, not competing declarations.

## 5. Capability preservation matrix

### 5.1 Owlat MTA

The MTA moves last because it has the widest surface.

Must preserve:

- `/send/decision` routing preflight and `/send` intake protocol;
- routing lease, re-entry token, work-attempt identity, pool, warm-up and
  engagement extras;
- `accepted` custody semantics, pre-dispatch id binding and intake dedupe;
- system-mail idempotency;
- declared custom return path and host-signed VERP behavior;
- MTA primary-domain registration and the frozen identity table;
- HMAC-signed feedback and privacy-sensitive raw-payload rules;
- delivery, bounce and complaint lifecycle;
- postmaster, reputation, queue, IP, inbound and agent events;
- special success response behavior;
- `/webhooks/mta-mailbox`, `/webhooks/mta-verify-credential`,
  `/webhooks/mta-tls-report`, and the `@owlat/mta-protocol` wire boundary.

Target bundle: portable transport/feedback/domain slots plus an own-only
`platformHooks` export. The ancillary MTA endpoints remain platform routes; they
are not mislabeled as portable ESP capabilities.

### 5.2 Amazon SES

Must preserve:

- per-instance region/access-key/secret resolution and client caching;
- structured SES send when possible and raw MIME when headers/attachments need
  it, including header-injection and filename hardening;
- `SES_CONFIGURATION_SET` on every applicable send;
- 30-second timeout and `AMBIGUOUS_TIMEOUT` behavior;
- provider message id and no idempotency claim;
- SNS certificate-host restriction, canonical signing string, signature versions,
  exact `SES_SNS_TOPIC_ARN`, five-minute freshness and certificate cache;
- verified subscription confirmation and delivery/bounce/complaint mapping;
- `/webhooks/ses` and the SNS setup panel;
- primary SES domain identity, DKIM tokens, verification status, custom MAIL
  FROM records, relay proof and reference-arm description;
- frozen `sendingDomainSesIdentities` reads/writes.

Target bundle: first-party transport, `aws-sns` feedback, primary identity,
relay identity and `sns-topic` setup ceremony. The host bridge keeps SES's frozen
table; the provider module owns only AWS conversations and response parsing.

### 5.3 Resend

Must preserve:

- per-instance API key and client cache;
- idempotency key on governed and system mail;
- existing retry/error classification and timeout behavior;
- provider message id;
- Svix multi-signature verification, secret decoding, timestamp tolerance and
  all current event mappings;
- `/webhooks/resend` and raw-payload behavior;
- `validateResendKey` setup probe;
- current honest `domainVerification: 'none'` posture until a separately tested
  Resend identity module exists.

Target bundle: first-party transport, `svix` feedback and credential probe. This
is the first provider cutover because it exercises send, idempotency, feedback
and setup without legacy domain persistence or return-path probing.

### 5.4 Generic SMTP relay

Must preserve:

- host/port/STARTTLS/auth instance configuration and presets;
- full MIME composition, headers, attachments, inline content and SMTPUTF8
  behavior;
- the composed RFC 5322 message id;
- exact SMTP reply classification, rate-limit detection and timeout behavior;
- complete VERP envelope sender when a fresh probe proves support;
- active connection probe and return-path probe state machine;
- `no feedback` and `no domain API` declarations;
- `validateSmtpRelay` in web and CLI setup.

Target bundle: first-party transport plus connection and return-path probes.
The host passes the complete `envelopeFrom`; the SMTP module never receives the
VERP secret. Existing provider presets remain data on the credential field.

### 5.5 Mailchimp Transactional (Mandrill)

Must preserve:

- full raw MIME submission;
- provider tracking/link rewriting/auto-text/inline-CSS disabled;
- subaccount and IP-pool instance configuration;
- `return_path_domain` wiring while the settled capability remains honest;
- no idempotency and ambiguous timeout handling;
- response status/error mapping and API-key redaction;
- URL-plus-form HMAC-SHA1, accepted URL candidates, form decoding and batches;
- unsigned URL-validation probe and signed empty-batch acknowledgement;
- accepted, deferred, bounce, complaint, unsubscribe and reject mappings;
- recipient-safe reject-list mirroring and suppression audit entries;
- `/webhooks/mandrill` and signing-key setup status;
- sender-domain registration/check, DKIM/SPF/ownership observations, generic
  relay identity persistence and reference-arm description;
- deterministic `no_envelope_control` return-path verdict without manufacturing
  a hard bounce.

Target bundle: first-party transport, `mandrill-form` feedback, relay identity,
signed-webhook setup and an explicit no-envelope-control probe result.

## 6. Migration pieces

Every piece below is a shippable commit/PR boundary. Later pieces may be split,
but two pieces must not be combined when doing so would remove the stated
rollback boundary.

### U0 — Ratify the contract and freeze parity fixtures

Changes:

- Add an ADR for the universal bundle, host-assigned trust and verifier registry.
- Add a capability snapshot covering every field and executable slot for all
  five incumbents.
- Freeze environment-name, route-path, catalog-order and stored-kind fixtures.
- Freeze representative success/failure/send payloads and webhook fixtures.
- Add a ratchet that rejects provider-kind comparisons outside provider bundles,
  composition/compatibility code, migrations and tests.

Done when:

- the fixtures describe current behavior and require no production changes;
- a changed retry, route, env name, message-id source or capability fails a test;
- the full repository gate remains green.

Rollback: delete fixtures and ADR; no runtime path changed.

### U1 — Introduce the universal bundle contract

Changes:

- Add `@owlat/provider-kit` with common descriptor, transport, feedback, domain
  and setup contracts.
- Re-export compatible third-party names from `@owlat/plugin-kit`.
- Add source-specific composition validators for own/first-party/third-party.
- Keep current plugin generated artifacts unchanged through a normalization
  adapter.

Done when:

- the existing mock provider scaffold composes without source changes;
- package, tarball, clean-checkout and Convex graph smokes pass;
- a third-party fixture claiming custody/provenance/platform hooks is rejected.

Rollback: remove the new package and normalization adapter; no provider uses it.

### U2 — Build one composer behind compatibility exports

Changes:

- Add first-party bundle discovery in established provider order.
- Normalize core catalog entries and plugin contributions into one composed
  `ProviderBundleRecord`.
- Emit deterministic API and web artifacts from that record.
- Make existing catalog and registry exports derive from the record while still
  pointing to the old modules.

Done when:

- old and new catalog JSON are deeply equal for every incumbent;
- every existing conformance suite runs against the composed view;
- duplicate kinds, missing modules and descriptor/module disagreement fail at
  composition;
- production still dispatches through the old modules.

Rollback: restore compatibility exports to their old literals.

### U3 — Generalize setup and feedback status

Changes:

- Add the bounded setup-probe contribution and host runner.
- Replace kind-specific web status inputs with the generic transport-keyed
  feedback status query.
- Render feedback ceremony and credential probes from the composed descriptor.
- Move curated provider order/copy into data and make web/setup CLI share it.

Done when:

- SES and Mandrill cards show the same values and copy as before;
- Resend gains a truthful signed-webhook status without borrowing Mandrill data;
- SMTP and Resend probes call the same validators and return the same outcomes;
- secret allowlist and credential replacement tests remain unchanged.

Rollback: keep the generic query unused and restore the two current reads.

### U4 — Add the verifier registry and unified feedback shell

Changes:

- Implement the four accepted verifier schemes.
- Add route bindings that can point an existing static path or a plugin path at
  one bundle definition.
- Move body caps, rate limiting, audit retention, batch limits, replay records
  and success responses into the common shell.
- Expand portable feedback facts and host validation/effect mapping.

Done when:

- every incumbent webhook fixture passes both its old adapter and the new shell;
- invalid, stale, replayed, wrong-topic, wrong-URL and malformed deliveries fail
  with the same status class;
- Mandrill suppression/unsubscribe behavior is covered end to end;
- no provider semantic module can access its verifier secret;
- no live route has cut over yet.

Rollback: delete the unused new shell and verifier registry.

### U5 — Generalize domain roles and return-path input

Changes:

- Add explicit primary and relay identity slots.
- Add persistence bridges for the frozen MTA and SES sibling tables.
- Make the generic relay host serve both first-party and third-party bundles.
- Preserve the first-party SMTP return-path wire and explicit no-envelope-control outcomes;
  third-party bundles remain unable to claim envelope control.
- Run the return-path state machine by capability/module, never by provider kind.

Done when:

- existing SES/Mandrill relay fixtures produce identical rows and reference arms;
- MTA/SES primary registration fixtures produce identical DNS and identity rows;
- SMTP probe fixtures prove the signed address is built by the host;
- a third-party module cannot receive signing material or claim envelope control;
- no existing provider has cut over yet.

Rollback: leave the new slots and bridges unused.

### U6 — Convert Resend

Sequence:

1. Create `apps/api/convex/providers/resend/` with descriptor, transport,
   feedback, setup and tests, initially delegating to current pure helpers.
2. Compose its descriptor while asserting exact equality with the old catalog row.
3. Point transport lookup at the bundle; do not duplicate a send.
4. Point `/webhooks/resend` at the bundle's `svix` verifier/parser.
5. Point setup probing/status at the bundle.
6. Remove the old registry rows and adapter wrappers once imports reach zero.

Gates:

- existing Resend tests move without weakened assertions;
- idempotency is present on governed and system mail;
- webhook replay/multi-signature tests pass through the real router;
- route/env/catalog snapshots are unchanged;
- full CI is green.

Rollback: restore lookup and route binding to the old adapter; data/config stay
valid.

### U7 — Convert Amazon SES

Sequence:

1. Create the SES bundle around existing transport and domain helpers.
2. Cut over transport lookup.
3. Cut over `/webhooks/ses` to `aws-sns` verification and the SES parser.
4. Cut over primary/relay identity through the frozen-table bridge.
5. Cut over generic setup/status.
6. Remove old registry rows after the compatibility suite is green.

Gates:

- structured/raw MIME golden payloads and header hardening remain unchanged;
- ambiguous timeouts remain non-retryable;
- SNS cert host/topic/freshness/subscription tests pass through the real route;
- existing SES identity rows require no migration and reference-arm output is
  deeply equal;
- full CI is green.

Rollback: switch composition bindings back; old routes/tables/env remain.

### U8 — Convert generic SMTP

Sequence:

1. Create the SMTP bundle around the existing composer/client/classifier.
2. Cut over connection setup probing.
3. Cut over return-path probes using host-built `envelopeFrom`.
4. Cut over transport lookup and remove the old registry row.

Gates:

- MIME and SMTP wire fixtures are unchanged;
- SMTPUTF8, TLS, auth and reply-code matrices remain green;
- accepted/rejected/silent return-path probe outcomes are identical;
- message id remains `composed`, feedback/domain capabilities remain absent;
- full MTA suite also stays green because it consumes the resulting VERP stream.

Rollback: restore old SMTP module binding; probe rows remain valid because their
transport id and semantics never changed.

### U9 — Convert Mandrill

Sequence:

1. Create the Mandrill bundle around raw send, error and domain helpers.
2. Cut over transport lookup.
3. Cut over `/webhooks/mandrill`, including `HEAD`/`GET`, batching and suppression.
4. Cut over relay identity through generic persistence.
5. Cut over signing-key setup/status.
6. Remove old registry rows and provider-adjacent wrapper files.

Gates:

- raw MIME proves all provider tracking remains disabled;
- timeout/API-key-redaction fixtures remain exact;
- signed URL candidates and form canonicalization remain exact;
- every event in a mixed batch dispatches in order;
- account/sender failures never suppress a recipient, while recipient blacklist
  hits still do;
- `no_envelope_control` settles without sending a manufactured bounce;
- full CI is green.

Rollback: restore old bindings; generic relay rows and existing config are the
same data the old code uses.

### U10 — Convert the Owlat MTA

Sequence:

1. Create the MTA bundle with portable transport/lifecycle feedback plus
   own-only platform hooks.
2. Cut over the catalog/transport lookup while retaining `@owlat/mta-protocol`.
3. Cut over standard lifecycle events to the common feedback shell.
4. Keep or move ancillary MTA routes only when their protocol-specific suites
   prove exact equivalence; they remain platform hooks, not generic feedback.
5. Cut over primary identity through the frozen-table bridge.
6. Remove the old MTA registry row, never the own-tier guards.

Gates:

- frozen MTA wire fixtures are unchanged;
- routing decision, lease, re-entry and custody reconciliation suites pass;
- ambiguous intake replay remains safe and idempotent;
- postmaster privacy/raw-retention behavior is unchanged;
- mailbox auth, TLS reporting and inbound agent events remain live;
- MTA/domain/VERP integration suites and full CI are green.

Rollback: restore old MTA bundle binding. Its routes, protocol package, tables
and credentials never moved.

### U11 — Remove the parallel core tier and prove provider N+1

Changes:

- Delete old hand-maintained core catalog and registry declarations after all
  compatibility imports are zero.
- Rename compatibility exports only in a separately reviewable cleanup; retain
  aliases for public/shared imports through one release if needed.
- Make the provider identity ratchet allow literals only inside bundle folders,
  migrations and composition tests.
- Update provider authoring docs and scaffold to the universal shape.
- Implement Emailit as the first external bundle and run it through the same
  conformance suite used by all incumbents.

Done when:

- adding a provider means bundle + config only;
- no routing, dispatch, measurement, UI or setup file names a new provider;
- Emailit needs no host special case and uses `hmac-timestamp-body`;
- `bun run ci:verify` and all plugin clean/deploy/Convex graph smokes pass.

Rollback: the cleanup is revertible independently; provider bundles remain
usable through restored compatibility exports.

## 7. Required test architecture

### Universal conformance

Every composed provider runs applicable tests derived from its slots:

- descriptor/configuration validation and named-instance isolation;
- one-attempt send success, retryable failure, terminal failure and timeout;
- idempotency declaration/builder pairing;
- message-id source and acceptance semantics;
- feedback auth rejection, replay rejection, parse bounds and event validation;
- domain registration/check result validation and proof freshness;
- setup probe timeout, auth failure and secret redaction;
- return-path declaration/probe/envelope pairing;
- route, credential, feedback and domain registry completeness.

### Provider compatibility

Each migrated provider keeps its existing unit/integration suite. Tests are moved
with code before assertions are refactored. New universal conformance augments
those suites; it does not replace vendor-specific wire fixtures.

### Repository gates

At each cutover:

1. provider-focused Vitest suites;
2. API typecheck and tests;
3. web/setup/plugin-codegen tests affected by the descriptor;
4. plugin clean-checkout, API graph, Convex bundle and deploy graph smokes;
5. `bun run ci:verify`.

No piece advances with a flaky or skipped parity assertion.

## 8. Data, wire and operator compatibility

### No data migration for the conversion

Provider kinds and transport ids stay stable, so `providerRoutes`,
`providerHealth`, send rows, assignments, return-path probes and generic relay
identities remain readable. MTA/SES sibling identities stay in their existing
tables. A future storage unification would be a separate product migration with
no bearing on this shape.

### No webhook-console migration

Static incumbent paths remain canonical. The common router resolves those paths
to bundle contributions. New third-party paths may remain plugin-namespaced.
Changing a route is never inferred from a package or provider rename.

### No credential migration

First-party bundles are allowed their existing env names because host provenance
assigns that privilege. Third-party bundles remain fenced to `PLUGIN_` variables.
Named-instance suffix resolution happens before every module call for both.

### No silent UI change

Catalog order, labels, descriptions, placeholders, defaults, presets and setup
copy are snapshotted. Rendering from a different source may not change what the
operator sees unless that change is separately approved.

## 9. Review and stop rules

Stop a piece and reopen the design if it would:

- require a stored provider-kind or webhook URL rename;
- require dual-sending a real message to compare implementations;
- let provider code verify its own authenticity;
- hand a third-party module a VERP, routing-lease, admin or deployment secret;
- broaden custody or feedback provenance beyond the own MTA;
- turn an ambiguous timeout into a retryable outcome;
- enable provider-side open/click tracking;
- discard a current feedback event or suppression effect;
- replace a frozen identity table merely for aesthetic uniformity;
- add a provider-specific branch to routing, dispatch, measurement or generic UI;
- weaken or delete an existing provider test to make the bundle pass.

## 10. Delivery record

The work followed the recommended dependency order: U0–U5 established additive
contracts and compatibility views, then the composer wrapped Resend → SES →
SMTP → Mandrill → MTA without changing their wire or storage contracts. Each
stage remains an independent commit-level rollback boundary inside the branch.

Emailit was added only after every incumbent used the composer, so it validates
the final architecture rather than a temporary second shape.

Per the final delivery request, these boundaries ship as one PR against `main`.
