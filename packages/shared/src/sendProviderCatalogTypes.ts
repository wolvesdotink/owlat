/**
 * Send-provider catalog — the DECLARATION vocabulary (the seams plan's D1).
 *
 * PLAN NUMBERS: this file's comments cite THREE plans, so each citation names
 * its own — the seams plan (which owns the branch), the Mandrill provider plan,
 * and the deliverability plan that shipped the return-path probe. A bare `D2`
 * here would be ambiguous between at least two of them.
 *
 * WHY IT LIVES IN packages/shared. D1 promotes the catalog to the single source
 * of truth for what a provider IS, needs and can do, and moves its DATA HALF out
 * of the Convex backend so web, setup-cli and docs generation consume the same
 * declaration instead of restating it — which is what the kind union, the
 * required-env tables and the credential forms each did in three to five places
 * before. The CODE half (adapter modules, client caches, the plugin-tier
 * composition) stays in `apps/api/convex/lib/sendProviders/`, keyed by this
 * vocabulary, with its completeness guards intact. `catalogTypes.ts` there is
 * now a re-export of this module plus the plugin-kit-typed fields, so every
 * backend import site is unchanged and `vi.mock` of `lib/sendProviders/catalog`
 * still intercepts the accessors.
 *
 * DATA ONLY, and that is a security boundary, not a preference: labels, field
 * descriptors and env NAMES — never env VALUES, never secrets, never adapter
 * code. This module reaches the web client bundle.
 *
 * The seam inside the shared half is the one the backend file already had: the
 * capability unions and the entry shapes are the vocabulary an entry is written
 * in, `./sendProviderCatalog` is the entries themselves plus the accessors that
 * apply each field's fail-closed default, and the descriptor vocabulary an entry
 * is written in sits beside it — `./sendProviderCredentialFields` (D5's form
 * fields) and `./sendProviderFeedback` (where a provider's feedback arrives).
 * IMPORT THROUGH `./sendProviderCatalog`: it re-exports every name this module
 * exports.
 */

import type { SendProviderCredentialField } from './sendProviderCredentialFields';
import type { SendProviderFeedbackChannel } from './sendProviderFeedback';

/**
 * A send transport contributed by a bundled plugin, namespaced by its plugin id
 * (`plugin.<pluginId>.<localId>`). Structural rather than enumerated because the
 * set is the composition's, not this repo's — the plugin platform's
 * `PluginSendTransportKind` is the same shape, declared where plugin ids are.
 */
export type HostedSendTransportKind = `plugin.${string}.${string}`;

/**
 * How a provider is INTEGRATED — the seams plan's D4 ("two relay tiers, one
 * contract").
 *
 *  - `own`    Owlat's own MTA. Special BY DEFINITION (D3) and by nothing else:
 *             it is the arm a deliverability fallback moves traffic away from,
 *             so "own vs. not-own" is the one identity question that legitimately
 *             exists. Exactly one entry may carry it.
 *  - `core`   an in-repo adapter folder (`lib/sendProviders/<kind>/`).
 *  - `plugin` a Tier-1 bundled package contributing a `sendTransports` entry.
 *             Generated entries do not declare the field; absent ⇒ `plugin`,
 *             which is the only tier a generated entry can have come from.
 *
 * `core` and `plugin` are an INTEGRATION difference, not a capability one: after
 * plugin parity (the seams plan's Wave 3) both satisfy the same contract, and
 * nothing may gate behaviour on the distinction.
 */
export type SendProviderTier = 'own' | 'core' | 'plugin';

/**
 * Whether this transport lets us set the RFC5321.MailFrom (the VERP envelope
 * sender) on a send — the ONE capability the catalog did not express (the
 * DELIVERABILITY plan's D4: a flag on the existing catalog, never a second
 * credential model).
 *
 *  - `yes`   the transport is under our control or documented to honour it.
 *  - `no`    the transport owns the envelope sender; bounces land at the
 *            provider and reach us (if at all) through its own feedback.
 *  - `probe` unknowable statically — a bring-your-own SMTP relay. The verdict
 *            comes from a probe whose delivered bounce we actually observed;
 *            until then it resolves to `unknown`, which is treated exactly
 *            like `no` (never an error, never a blocker — the DELIVERABILITY
 *            plan's D2).
 */
export type DeclaredCustomReturnPathSupport = 'yes' | 'no' | 'probe';

/**
 * How this transport's SENDING DOMAINS are verified (Mandrill plan D6/D7 — the
 * seams plan adopts the field in its D1 and the registry it feeds in P0.3).
 *
 *  - `api`  the provider has a domain-identity API, so a registered sending
 *           domain provider (`domains/providers/<kind>/`) can report whether a
 *           domain is verified AT the provider. That report is what the
 *           relay-verification seam reads before handing a From domain to a
 *           relay.
 *  - `none` nothing provider-side to ask. Either the transport's domains are
 *           verified on a DNS path outside this seam (our own MTA) or the
 *           provider offers no identity surface at all (Resend, a
 *           bring-your-own SMTP relay) — the seam then keeps its honest
 *           "unverifiable" posture rather than inventing a proof.
 */
export type DomainVerificationSupport = 'api' | 'none';

/**
 * What a SUCCESSFUL dispatch means for this transport, and therefore what an
 * AMBIGUOUS one may be answered with (the SEAMS plan's D2 — capabilities, not
 * identity).
 *
 *  - `accepted`  the transport takes CUSTODY of the message. Success is an
 *                intake acceptance, not a delivery: the Send stays `queued`
 *                until the transport's own feedback terminalizes it, so the
 *                governed boundary reports `acceptedForDelivery`. Intake is
 *                idempotent under the key WE minted (such a kind declares
 *                `messageIdSource: 'idempotency-key'`), which is what makes an
 *                ambiguous outcome RE-ASKABLE: replaying the attempt either
 *                finds the existing work or creates it, and no recipient can be
 *                mailed twice.
 *  - `unknown-on-timeout` the send IS the handoff — there is no separate
 *                custody state to report — and a lost response CANNOT be
 *                re-asked: a replay on a transport with no idempotency surface
 *                would double-deliver (the MANDRILL plan's D4, which is where
 *                that posture was first argued). An ambiguous outcome parks
 *                awaiting provider feedback where the kind has a feedback
 *                channel, and fails where it has none.
 *
 * Absent ⇒ `unknown-on-timeout`, the fail-closed reading: claiming custody we
 * were never granted would leave a Send waiting `queued` for feedback that
 * never arrives, and claiming re-askability would double-deliver.
 *
 * PREREQUISITES OUTSIDE THE CATALOG — the canonical list; everything else that
 * mentions this constraint (ADR 0055, the provider docs page, the NOTE on
 * {@link MessageIdSource}) POINTS HERE rather than restating it, so generalizing
 * the three sites below is one edit plus three link targets rather than four
 * prose rewrites. Keep it that way, and when a site is generalized, strike it
 * from HERE rather than adding a second list somewhere else. The three paths are
 * `apps/api/convex/`-relative: the declaration is shared, the machinery that has
 * not caught up with it is the backend's.
 *
 * `accepted` IS NOT YET A GENERAL CAPABILITY. Only the own MTA declares it, and
 * three sites outside this file still spell the custody arm as that one kind. A
 * second kind declaring `accepted` — which, by the shape of
 * {@link CoreSendProviderCatalogEntry}, also declares
 * `messageIdSource: 'idempotency-key'` — must generalize ALL THREE in the same
 * change, or its ambiguous sends die on the delivery deadline and its rows
 * name the wrong transport:
 *
 *  1. `delivery/lastMileRouting.ts` — the replay this declaration arms travels
 *     as the `mtaReconciliation` input (that name is part of the work), and
 *     `withReconciliationSafety` DEFERS every `ready` result whose
 *     `providerKind !== 'mta'`, with a second pin on `baseProviderKind !==
 *     'mta'` and a third on the relay arm. The reconciliation attempt would
 *     therefore be deferred at 60s intervals until
 *     `GOVERNED_MTA_MAX_MESSAGE_AGE_MS` elapses and the Send is terminalized as
 *     a definite failure — for a message the transport may already have
 *     delivered.
 *  2. `delivery/sendLifecycle.ts` — the pre-dispatch identity binding runs
 *     through `bindMtaProviderIdentity`, which patches `providerType: 'mta'`
 *     onto the Send unconditionally, and `transitionMtaByProviderMessageId`
 *     reads that same stamp back for its `allowQueuedMtaTerminal` relaxation.
 *     Declaring the capability alone would mislabel the Send's transport in
 *     every arm-keyed measurement row. This one is triggered by
 *     `messageIdSource: 'idempotency-key'` ON ITS OWN, so it is also the
 *     prerequisite of any future kind that pre-assigns its id without claiming
 *     custody. It owns the operator-visible wording too: the governed
 *     boundary's `Unable to bind MTA provider identity` throw names that
 *     mutation on purpose (grep one, find the other), so the string is renamed
 *     WITH it rather than before it.
 *  3. `delivery/sendCompletion.ts` — the only consumer of the
 *     `acceptedForDelivery` verdict this declaration produces, and it is
 *     MTA-shaped in three ways: the arm comment calls it "MTA intake", the
 *     identity-conflict guard throws `MTA acceptance conflicts with the Send
 *     provider identity.` at whoever is on call, and the patch defaults
 *     `providerType: returnValue.providerType ?? 'mta'`. That default is DEAD
 *     as written — `dispatchGovernedEmail`'s success branch always carries a
 *     `providerType` — but a second custody kind that leaves it standing has
 *     one silent `'mta'` stamp waiting behind any future caller that omits it,
 *     on exactly the rows item 2 exists to keep honest. Generalize the wording
 *     and delete the default, or re-derive why it is safe.
 */
export type AcceptanceSemantics = 'accepted' | 'unknown-on-timeout';

/**
 * Where the `providerMessageId` recorded against the durable Send comes from —
 * and, decisively, WHEN it exists.
 *
 *  - `provider`        the transport mints it and we learn it from the send
 *                      response (SES `MessageId`, Resend/Mandrill ids).
 *  - `composed`        we mint it as the message's RFC 5322 `Message-ID` while
 *                      composing, and the transport echoes that back — the
 *                      relay never assigns an id of its own.
 *  - `idempotency-key` the id IS the stable per-Send idempotency key the
 *                      governed boundary derived from the durable row, so it is
 *                      known BEFORE the network crossing. Only such a kind gets
 *                      its identity bound pre-dispatch (a webhook that races the
 *                      send response can then still be attributed), and only
 *                      such a kind has the value substituted for whatever the
 *                      response carried — the MTA answers a dedup sentinel on a
 *                      deduplicated intake.
 *
 * Absent ⇒ `provider`: an id we cannot predict, which is the fail-closed
 * reading (never pre-bind an identity we do not actually control).
 *
 * NOTE for a new kind declaring `idempotency-key`: the pre-dispatch binding it
 * turns on runs through `delivery/sendLifecycle.bindMtaProviderIdentity`, which
 * is not yet kind-agnostic and must be generalized in the same change — item 2
 * of the PREREQUISITES list on {@link AcceptanceSemantics}, which is the one
 * place that constraint is written out.
 */
export type MessageIdSource = 'provider' | 'idempotency-key' | 'composed';

/**
 * Does handing this transport the SAME idempotency key twice deliver the message
 * once? (the SEAMS plan's D2 — capabilities, not identity.)
 *
 * A narrower question than {@link AcceptanceSemantics}, and deliberately a
 * separate field rather than a derivation of it. Acceptance semantics answer what
 * the GOVERNED boundary may do with an ambiguous outcome — replay the attempt, or
 * park it for feedback — and only the own MTA takes custody. This answers
 * whether a repeat of the request is safe at all, which is true of every
 * transport with a dedup surface, custody or not: our MTA dedups its intake on
 * the message id we mint, and Resend dedups on the `Idempotency-Key` header
 * while still minting the id it reports back.
 *
 * Its consumer is the SYSTEM/AUTH mail path (`lib/systemMailOutcome.ts`), which
 * has no durable Send row, no governed re-entry and no measurement plane — just a
 * caller-supplied key and one question: after an AMBIGUOUS_TIMEOUT, may the
 * caller send this password reset again? A transport with no dedup surface must
 * answer no, because the timeout may sit on top of a delivered message.
 *
 * A kind declaring `true` must ALSO carry the key into its request — the two
 * halves are the same promise, and a declaration without the wiring turns a
 * double delivery into a "safe" retry. Both halves are the adapter's:
 * `buildSystemMailExtras` is where the key becomes this provider's dedup token,
 * and `lib/sendProviders/__tests__/systemMailExtras.test.ts` pins the pair in
 * both directions for every core kind.
 *
 * Absent ⇒ `false`, the fail-closed reading: crediting a dedup surface a
 * transport does not have re-sends real mail to a real person.
 */
export type IdempotencyKeyDeduplication = boolean;

/**
 * Does the feedback this transport sends us carry OUR OWN provenance tag —
 * `deliveryDomain` on the inbound event? (the SEAMS plan's D2 — capabilities,
 * not identity.)
 *
 * `deliveryDomain` is not a provider field. It has exactly one writer,
 * `applyFeedbackProvenancePolicy` in `apps/mta/src/bounce/outcome.ts`, which
 * stamps `production` only on a report it attributed by VERP exactly and drops
 * the effect list entirely when the provenance is `unknown`. So on an event
 * that carries it, `production` IS "exactly attributed, and not member-preview
 * mail"; on an event from a third-party ESP's webhook it is simply absent,
 * because nothing of ours touched that report.
 *
 * Its consumer is the recipient-only complaint (RFC 5965 §3.2 — the FBL
 * redacted the Message-ID, so there is no send to transition and the address is
 * all we have). A tagged source must show `production` before we blocklist the
 * address; an UNtagged source has no tag to show, so requiring one would drop
 * every redacted complaint it ever sends — a complainer who stays mailable,
 * which is the outcome an FBL exists to prevent. That is what the shipped
 * `providerType === 'ses'` special case bought, for one provider, by name.
 *
 * Absent ⇒ `false` — "we do not stamp this transport's feedback" — which is
 * both the fail-closed reading and simply true of every transport that is not
 * ours: the tag is written by our own MTA, on the way out of our own
 * infrastructure. A handler that cannot identify the SOURCE at all is a
 * different question and is not answered here (see
 * `webhooks/complaintDispatch.ts`, which requires the tag in that case).
 */
export type FeedbackProvenanceTagging = boolean;

/**
 * A REACHABILITY CHECK an operator can run against entered credentials before
 * committing them — the "Test" button on the transport editor and the setup
 * wizard's pre-apply handshake.
 *
 * A descriptor, not a function: this module is data, and the probes themselves
 * (a Resend API call, a real SMTP submission handshake with AUTH) are network
 * code living in `./setupValidators`. `validator` names the exported function
 * there, so the two cannot drift silently — the seams plan's P1.3 pins the name
 * against that module's surface.
 *
 * ABSENCE IS A DECLARATION. A kind with no `setupProbe` cannot be checked before
 * applying, which is the honest answer for SES, Mandrill and our own MTA: their
 * real proof is the live send test after applying, and the shipped endpoints
 * already refuse those kinds rather than pretend to test them.
 */
export interface SendProviderSetupProbe {
	/** Exported validator in `@owlat/shared/setupValidators`. */
	readonly validator: string;
	/** What the operator-facing action says it does. */
	readonly label: string;
}

/**
 * ONE CATALOG ENTRY — the declaration shape, with every capability optional and
 * a fail-closed default behind each.
 *
 * `kind` is a plain `string` HERE and a narrowed union everywhere else. It has
 * to be: the union is DERIVED from the entries (`SendProviderKind =
 * (typeof CATALOG)[number]['kind']`, D1), so a vocabulary that named the union
 * would be defined in terms of the literal that is defined in terms of it.
 * Once the literal exists, `./sendProviderCatalog` derives the narrowed union
 * from it (`CoreSendProviderKind`) and the backend's `SendProviderCatalogEntry`
 * (`apps/api/convex/lib/sendProviders/catalogTypes.ts`) is this shape with
 * `kind` narrowed to the COMPOSED union and widened by its plugin-kit-typed
 * fields — so no consumer outside the declaration itself sees the loose form.
 */
export interface SendProviderCatalogEntryShape {
	readonly kind: string;
	readonly label: string;
	/** How the provider is integrated. Absent ⇒ `plugin` — see {@link SendProviderTier}. */
	readonly tier?: SendProviderTier;
	readonly retryDelays: readonly number[];
	/**
	 * The PRESENCE GATE: every variable that must be set for this kind to be
	 * considered configured (and therefore routable, and fallback-eligible).
	 * Deliberately not "every variable the kind reads" — see `optionalEnvVars`.
	 */
	readonly requiredEnvVars: readonly string[];
	/**
	 * Variables the kind READS but does not need: refinements a deployment may
	 * never set (a webhook signing key issued later, a dedicated IP pool, a port
	 * that has a safe default). Listing them here and NOT in `requiredEnvVars` is
	 * what keeps the presence gate honest — a deployment that has not created a
	 * webhook still sends perfectly well.
	 */
	readonly optionalEnvVars?: readonly string[];
	/**
	 * The credential FORM, as typed descriptors (D5). Absent for generated plugin
	 * entries, which have no form surface to declare until plugin-tier parity
	 * (the seams plan's P3.1).
	 */
	readonly credentialFields?: readonly SendProviderCredentialField[];
	/** Declared envelope-sender control. Absent ⇒ `no` (fail closed). */
	readonly supportsCustomReturnPath?: DeclaredCustomReturnPathSupport;
	/**
	 * Does this transport report bounces/complaints back to us out of band
	 * (webhook / SNS)? Only used to grade MEASUREMENT confidence when we cannot
	 * stamp our own return path — it never gates a send.
	 *
	 * A PAIR with {@link SendProviderCatalogEntryShape.providerFeedback}, not two
	 * independent facts — see {@link CoreSendProviderCatalogEntry}, which is where
	 * the pairing is enforced. Both stay optional and independent HERE because a
	 * generated plugin entry declares neither and must still satisfy this shape.
	 */
	readonly hasProviderFeedback?: boolean;
	/**
	 * WHERE that feedback arrives and what the operator has to do to turn it on —
	 * see {@link SendProviderFeedbackChannel}. Absent ⇒ nothing declared, which is
	 * the only honest reading for a kind that has no feedback at all.
	 */
	readonly providerFeedback?: SendProviderFeedbackChannel;
	/**
	 * Declared sending-domain verification path. Absent ⇒ `none` (fail closed):
	 * a transport that never declared an identity API cannot be credited with
	 * one. Core kinds must declare it explicitly — see
	 * {@link CoreSendProviderCatalogEntry}.
	 */
	readonly domainVerification?: DomainVerificationSupport;
	/**
	 * What a successful — and an ambiguous — dispatch means for this transport.
	 * Absent ⇒ `unknown-on-timeout` (fail closed). Read it through
	 * `acceptanceSemanticsFor`.
	 */
	readonly acceptanceSemantics?: AcceptanceSemantics;
	/**
	 * Where this transport's provider message id comes from. Absent ⇒ `provider`
	 * (fail closed). Read it through `messageIdSourceFor`.
	 */
	readonly messageIdSource?: MessageIdSource;
	/**
	 * Does a repeat request under the same idempotency key deliver once? Absent ⇒
	 * `false` (fail closed). Read it through `deduplicatesOnIdempotencyKeyFor` —
	 * see {@link IdempotencyKeyDeduplication}.
	 */
	readonly deduplicatesOnIdempotencyKey?: IdempotencyKeyDeduplication;
	/**
	 * Does this transport's inbound feedback carry our own `deliveryDomain`
	 * provenance tag? Absent ⇒ `false` (fail closed). Read it through
	 * `tagsFeedbackProvenanceFor` — see {@link FeedbackProvenanceTagging}.
	 */
	readonly tagsFeedbackProvenance?: FeedbackProvenanceTagging;
	/** Pre-apply reachability check, when one exists — see {@link SendProviderSetupProbe}. */
	readonly setupProbe?: SendProviderSetupProbe;
}

/**
 * A CORE catalog entry — every kind that ships in this repo.
 *
 * `tier`, `credentialFields`, `domainVerification`, `acceptanceSemantics`,
 * `messageIdSource` and `deduplicatesOnIdempotencyKey` are REQUIRED here while
 * they stay optional on the shared shape: a kind we write ourselves can always
 * answer these questions, and letting a new core kind coast on the fail-closed
 * default is exactly how an `api` transport silently loses its relay
 * eligibility, how a transport that takes custody of a message has that custody
 * go unrecorded, or how a transport that DOES dedup leaves every ambiguous
 * system mail unresendable. Bundled plugin transports keep the optional fields —
 * they are generated from plugin manifests, which have no such surface to
 * declare (plugin-tier parity is the SEAMS plan's P3.1 — contract parity for
 * capabilities, extras and instances, NOT the Mandrill plan's P3.1, which is the
 * domain-identity adapter that already shipped) — and are held to the same
 * custody prerequisites at composition time by
 * `assertPluginDispatchSemanticsAreGeneral` in the backend's `catalog.ts`
 * instead.
 *
 * For a CORE kind the two dispatch semantics are a PAIR, not two independent
 * fields, so they are declared as a union rather than side by side — and the
 * union constrains BOTH directions:
 *
 *  - `accepted` ⇒ `idempotency-key`, because an ambiguous outcome is resolved by
 *    REPLAYING the attempt, which is only safe when the replay carries the id WE
 *    minted. An entry pairing `accepted` with a provider-minted id would (a)
 *    report `acceptedForDelivery` under an identity nothing pre-bound, parking
 *    the Send `queued` against a report that can never match it, and (b) answer
 *    an ambiguity with an idempotency key the provider never saw and re-dispatch
 *    to a transport with no idempotency surface — a double delivery.
 *  - `idempotency-key` ⇒ `accepted`, because a core kind whose message id we
 *    mint ourselves has, by construction, an intake that can be re-asked under
 *    it. Declaring the id without the custody would take the pre-dispatch
 *    identity binding — and with it every prerequisite in item 2 of the
 *    PREREQUISITES list on {@link AcceptanceSemantics} — while still refusing to
 *    reconcile an ambiguous send: all of the generalization cost, none of the
 *    safety it buys. If a real transport ever needs that mixed shape, widen this
 *    union deliberately; the governed boundary already reads the two fields
 *    INDEPENDENTLY, which `delivery/__tests__/governedDispatch.test.ts` →
 *    `describe('a transport whose declarations are MIXED')` proves, so widening
 *    it is a type change rather than a behaviour change.
 *
 * An illegal pairing is a build break here rather than a CI failure. Untyped
 * (bundled plugin) entries never reach this type, so the half of the rule that
 * is about SAFETY rather than about tidiness is enforced for them at composition
 * time by `assertPluginDispatchSemanticsAreGeneral`; their fail-closed
 * defaults are pinned by `__tests__/undeclaredSemanticsFailClosed.test.ts`,
 * which mocks a generated catalog entry that declares neither field.
 */
export type CoreSendProviderCatalogEntry = SendProviderCatalogEntryShape & {
	readonly tier: SendProviderTier;
	readonly credentialFields: readonly SendProviderCredentialField[];
	readonly domainVerification: DomainVerificationSupport;
	/**
	 * NOT part of the pair below, on purpose. `accepted` implies it (custody is
	 * re-askable precisely because the intake dedups), but the converse is false —
	 * Resend dedups on a header and mints its own id — so folding it into the
	 * union would make a real transport undeclarable.
	 */
	readonly deduplicatesOnIdempotencyKey: IdempotencyKeyDeduplication;
	/**
	 * Also required here, and also not part of the pair: a kind we write
	 * ourselves knows whether we stamp its feedback. A core kind coasting on the
	 * `false` default would have every redacted complaint it reports suppressed
	 * without provenance — or, if it IS ours and declares nothing, every such
	 * complaint dropped.
	 */
	readonly tagsFeedbackProvenance: FeedbackProvenanceTagging;
} & (
		| { readonly acceptanceSemantics: 'accepted'; readonly messageIdSource: 'idempotency-key' }
		| {
				readonly acceptanceSemantics: 'unknown-on-timeout';
				readonly messageIdSource: 'provider' | 'composed';
		  }
	) &
	SendProviderFeedbackDeclaration;

/**
 * THE SECOND PAIR a core entry declares as one decision: is there feedback, and
 * where does it arrive?
 *
 * `hasProviderFeedback` and `providerFeedback` are two halves of one fact, and
 * side by side as independent optional fields they were kept in agreement only
 * by a test in another package. Both omissions are silent and both are bad: an
 * author who follows the N+1 checklist to `providerFeedback` and forgets the
 * boolean gets a transport whose measurement confidence is graded as if it
 * reported nothing; one who sets the boolean and declares no channel gets a kind
 * with feedback and no panel, no endpoint and no route — the exact gap the
 * descriptor was added to close.
 *
 * So the two are a union, exactly like the custody pair above:
 *
 *  - `true` ⇒ a channel, because "we receive feedback" that names no route is a
 *    claim with nothing behind it. The route also has to EXIST — that half is
 *    `lib/sendProviders/__tests__/feedbackRoutes.test.ts`, which walks the real
 *    `httpRouter`, because a path is not checkable from this package.
 *  - a channel ⇒ `true`, because a declared webhook path IS out-of-band feedback
 *    arriving; the grading and the panel then agree by construction.
 *
 * `false` takes `providerFeedback?: never`, so the two cannot be written in
 * disagreement in either direction. Absent-on-`false` rather than forbidden
 * outright keeps `smtp`'s explicit `hasProviderFeedback: false` legal, which is
 * the honest declaration for a bring-your-own relay.
 *
 * NOT on {@link SendProviderCatalogEntryShape}: a bundled plugin entry is
 * generated from a manifest that declares neither field, and widening this rule
 * to the shared shape would make every such entry unassignable. Their
 * fail-closed reading (`hasProviderFeedbackOf` ⇒ `false`) is what covers them.
 */
export type SendProviderFeedbackDeclaration =
	| {
			readonly hasProviderFeedback: true;
			readonly providerFeedback: SendProviderFeedbackChannel;
	  }
	| {
			readonly hasProviderFeedback: false;
			readonly providerFeedback?: never;
	  };
