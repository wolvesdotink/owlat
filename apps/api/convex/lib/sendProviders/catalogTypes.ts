/**
 * Send-provider catalog — the DECLARATION vocabulary.
 *
 * PLAN NUMBERS: this file's comments cite THREE plans, so each citation names
 * its own — the seams plan (which owns the branch), the Mandrill provider plan,
 * and the deliverability plan that shipped the return-path probe. A bare `D2`
 * here would be ambiguous between at least two of them.
 *
 * Split out of `./catalog.ts` when the seams plan's P0.1 took it past the ~500
 * LOC ratchet `scripts/check-file-size.sh` enforces: `catalog.ts` was 253 lines
 * on `main` — `domainVerification` and its entries already among them — and
 * reached 536 through the acceptance/message-id semantics vocabulary below and
 * the PREREQUISITES note that came with it. A pure extraction, no behaviour,
 * made in P0.3 because the ratchet has to be green at the wave boundary rather
 * than because P0.3 is what grew the file. (Which matters if the vocabulary is
 * ever generalized away: the question "can the split be reverted?" is about
 * these types, not about `domainVerification`.)
 *
 * The seam is the one the file already had: the capability unions and the entry
 * shapes are the vocabulary a catalog entry is written in, `catalog.ts` is the
 * entries themselves plus the accessors that apply each field's fail-closed
 * default.
 *
 * IMPORT THROUGH `catalog.ts`, not through here: it re-exports every name this
 * module exports, so the import site stays `lib/sendProviders/catalog` and
 * `vi.mock` of that module still intercepts the accessors. Adding a type here
 * means adding it to that re-export block too.
 */

import type { PluginId, PluginSendTransportKind } from '@owlat/plugin-kit';
import type { CoreSendTransportKind } from '@owlat/shared';

export type CoreSendProviderKind = CoreSendTransportKind;
export type SendProviderKind = CoreSendProviderKind | PluginSendTransportKind;

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
 * from HERE rather than adding a second list somewhere else.
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

export interface SendProviderCatalogEntry {
	readonly kind: SendProviderKind;
	readonly label: string;
	readonly retryDelays: readonly number[];
	readonly requiredEnvVars: readonly string[];
	readonly pluginId?: PluginId;
	readonly requiredCapability?: 'send:transport';
	/** Declared envelope-sender control. Absent ⇒ `no` (fail closed). */
	readonly supportsCustomReturnPath?: DeclaredCustomReturnPathSupport;
	/**
	 * Does this transport report bounces/complaints back to us out of band
	 * (webhook / SNS)? Only used to grade MEASUREMENT confidence when we cannot
	 * stamp our own return path — it never gates a send.
	 */
	readonly hasProviderFeedback?: boolean;
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
}

/**
 * A CORE catalog entry — every kind that ships in this repo.
 *
 * `domainVerification`, `acceptanceSemantics`, `messageIdSource` and
 * `deduplicatesOnIdempotencyKey` are REQUIRED here while they stay optional on
 * the shared interface: a kind we write ourselves can always answer these
 * questions, and letting a new core kind coast on the fail-closed default is
 * exactly how an `api` transport silently loses its relay eligibility, how a
 * transport that takes custody of a message has that custody go unrecorded, or
 * how a transport that DOES dedup leaves every ambiguous system mail
 * unresendable. Bundled plugin transports keep
 * the optional fields — they are generated from plugin manifests, which have no
 * such surface to declare (plugin-tier parity is the SEAMS plan's P3.1 —
 * contract parity for capabilities, extras and instances, NOT the Mandrill
 * plan's P3.1, which is the domain-identity adapter that already shipped) — and
 * are held to
 * the same custody prerequisites at composition time by
 * `assertPluginDispatchSemanticsAreGeneral` in `./catalog.ts` instead.
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
export type CoreSendProviderCatalogEntry = SendProviderCatalogEntry & {
	readonly domainVerification: DomainVerificationSupport;
	/**
	 * NOT part of the pair below, on purpose. `accepted` implies it (custody is
	 * re-askable precisely because the intake dedups), but the converse is false —
	 * Resend dedups on a header and mints its own id — so folding it into the
	 * union would make a real transport undeclarable.
	 */
	readonly deduplicatesOnIdempotencyKey: IdempotencyKeyDeduplication;
} & (
		| { readonly acceptanceSemantics: 'accepted'; readonly messageIdSource: 'idempotency-key' }
		| {
				readonly acceptanceSemantics: 'unknown-on-timeout';
				readonly messageIdSource: 'provider' | 'composed';
		  }
	);
