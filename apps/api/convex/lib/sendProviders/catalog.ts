/** Isolate-safe catalog for built-in and statically bundled send transports. */

import type { PluginId, PluginSendTransportKind } from '@owlat/plugin-kit';
import { SEND_TRANSPORT_KINDS, type CoreSendTransportKind } from '@owlat/shared';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG } from '../../plugins/sendTransportCatalog.generated';

export type CoreSendProviderKind = CoreSendTransportKind;
export type SendProviderKind = CoreSendProviderKind | PluginSendTransportKind;

/**
 * Whether this transport lets us set the RFC5321.MailFrom (the VERP envelope
 * sender) on a send — the ONE capability the catalog did not express (plan D4:
 * a flag on the existing catalog, never a second credential model).
 *
 *  - `yes`   the transport is under our control or documented to honour it.
 *  - `no`    the transport owns the envelope sender; bounces land at the
 *            provider and reach us (if at all) through its own feedback.
 *  - `probe` unknowable statically — a bring-your-own SMTP relay. The verdict
 *            comes from a probe whose delivered bounce we actually observed;
 *            until then it resolves to `unknown`, which is treated exactly
 *            like `no` (never an error, never a blocker — plan D2).
 */
export type DeclaredCustomReturnPathSupport = 'yes' | 'no' | 'probe';

/**
 * How this transport's SENDING DOMAINS are verified (plan D6/D7).
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
 * AMBIGUOUS one may be answered with (plan D2 — capabilities, not identity).
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
 *                would double-deliver (plan D4). An ambiguous outcome parks
 *                awaiting provider feedback where the kind has a feedback
 *                channel, and fails where it has none.
 *
 * Absent ⇒ `unknown-on-timeout`, the fail-closed reading: claiming custody we
 * were never granted would leave a Send waiting `queued` for feedback that
 * never arrives, and claiming re-askability would double-deliver.
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
 * NOTE for a new kind declaring `idempotency-key`: the pre-dispatch binding
 * runs through `delivery/sendLifecycle.bindMtaProviderIdentity`, which stamps
 * the own-MTA provider type. That mutation must be generalized in the same
 * change — declaring the capability alone would mislabel the Send's transport.
 */
export type MessageIdSource = 'provider' | 'idempotency-key' | 'composed';

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
	 * {@link acceptanceSemanticsFor}.
	 */
	readonly acceptanceSemantics?: AcceptanceSemantics;
	/**
	 * Where this transport's provider message id comes from. Absent ⇒ `provider`
	 * (fail closed). Read it through {@link messageIdSourceFor}.
	 */
	readonly messageIdSource?: MessageIdSource;
}

/**
 * A CORE catalog entry — every kind that ships in this repo.
 *
 * `domainVerification`, `acceptanceSemantics` and `messageIdSource` are
 * REQUIRED here while they stay optional on the shared interface: a kind we
 * write ourselves can always answer these questions, and letting a new core
 * kind coast on the fail-closed default is exactly how an `api` transport
 * silently loses its relay eligibility, or how a transport that takes custody
 * of a message has that custody go unrecorded. Bundled plugin transports keep
 * the optional fields — they are generated from plugin manifests, which have no
 * such surface to declare (plugin-tier parity is plan P3.1).
 */
interface CoreSendProviderCatalogEntry extends SendProviderCatalogEntry {
	readonly domainVerification: DomainVerificationSupport;
	readonly acceptanceSemantics: AcceptanceSemantics;
	readonly messageIdSource: MessageIdSource;
}

const CORE_SEND_PROVIDER_CATALOG = [
	{
		kind: 'mta',
		label: 'Owlat MTA',
		retryDelays: [1_000, 5_000],
		requiredEnvVars: ['MTA_API_URL', 'MTA_API_KEY'],
		// Our own MTA stamps the VERP envelope sender itself (smtp/sender.ts).
		supportsCustomReturnPath: 'yes',
		hasProviderFeedback: true,
		// Our MTA's sending domains ARE verified — through `domains/providers/mta`
		// and the generic DNS verifier — but never through this seam: the MTA is
		// the arm a deliverability fallback moves traffic AWAY from, never the
		// relay it moves traffic to, so it has no relay identity to report.
		domainVerification: 'none',
		// `POST /send` is an INTAKE: it enqueues the work and answers; the message
		// is delivered (or not) later and reported over the MTA's own webhook. So a
		// success here is custody, not delivery, and the Send stays `queued`.
		acceptanceSemantics: 'accepted',
		// The id the MTA correlates work by IS the idempotency key we minted, so it
		// exists before the request does — which is what lets the durable Send be
		// bound to it pre-dispatch, and what makes a lost response replayable.
		messageIdSource: 'idempotency-key',
	},
	{
		kind: 'ses',
		label: 'Amazon SES',
		retryDelays: [1_000, 5_000, 30_000],
		// Every variable the adapter requires, region included: `ses/index.ts`
		// reads AWS_SES_REGION through `transportEnvRequired`, so omitting it here
		// would let a named instance resolve as configured and then fail on every
		// send.
		requiredEnvVars: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
		// SES derives MAIL FROM from the verified identity's configured custom
		// MAIL FROM domain, not from a per-send address — but it reports every
		// bounce and complaint back to us.
		supportsCustomReturnPath: 'no',
		hasProviderFeedback: true,
		// SES identity APIs (`getVerificationStatus` + the DKIM/MAIL FROM proof
		// on `sendingDomainSesIdentities`) — the shipped relay-verification path.
		domainVerification: 'api',
		// SES has no idempotency surface: a replayed request after a lost response
		// would double-deliver, which is why its adapter answers AMBIGUOUS_TIMEOUT
		// rather than a retryable code.
		acceptanceSemantics: 'unknown-on-timeout',
		messageIdSource: 'provider',
	},
	{
		kind: 'resend',
		label: 'Resend',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['RESEND_API_KEY'],
		supportsCustomReturnPath: 'no',
		hasProviderFeedback: true,
		// Resend has a domains API, but nothing in this repo reads it: no
		// `domains/providers/resend` adapter exists, so the seam must keep saying
		// "unverifiable" rather than claim a proof we never fetched.
		domainVerification: 'none',
		// Resend threads our `Idempotency-Key` header, so a RETRY inside the
		// dispatch loop is safe — but the id Resend returns is its own, and the
		// governed boundary has no acceptance state to reconcile against.
		acceptanceSemantics: 'unknown-on-timeout',
		messageIdSource: 'provider',
	},
	{
		kind: 'smtp',
		label: 'SMTP relay',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['SMTP_RELAY_HOST', 'SMTP_RELAY_USERNAME', 'SMTP_RELAY_PASSWORD'],
		// A bring-your-own relay MAY honour our MAIL FROM and MAY silently
		// rewrite it. Only an observed delivered bounce settles it.
		supportsCustomReturnPath: 'probe',
		hasProviderFeedback: false,
		// A bring-your-own relay has no identity API at all.
		domainVerification: 'none',
		acceptanceSemantics: 'unknown-on-timeout',
		// A relay hands back no id of its own: the adapter reports the RFC 5322
		// `Message-ID` we minted while composing the message.
		messageIdSource: 'composed',
	},
	{
		kind: 'mandrill',
		label: 'Mailchimp Transactional (Mandrill)',
		// Mirrors Resend's schedule: another HTTP-API ESP whose retryable
		// failures are the same two shapes (an hourly-quota RATE_LIMIT and a
		// 5xx SERVER_ERROR), so the same backoff applies.
		retryDelays: [1_000, 5_000, 30_000],
		// The API key ALONE. `MANDRILL_WEBHOOK_KEY`, `MANDRILL_SUBACCOUNT` and
		// `MANDRILL_IP_POOL` are deliberately absent: this list is the presence
		// gate that decides whether the kind is configured (and therefore
		// fallback-eligible), and a deployment that has not created a webhook or
		// bought a dedicated IP still sends perfectly well.
		requiredEnvVars: ['MANDRILL_API_KEY'],
		// Mandrill accepts a per-message `return_path_domain`, but only for a
		// domain SPF'd to Mandrill in the account — and whether VERP-style
		// envelope senders survive is deployment-specific. Only an observed
		// delivered bounce settles it (D5).
		supportsCustomReturnPath: 'probe',
		// Mandrill webhooks report send/deferral/bounce/spam/unsub/reject (D10).
		hasProviderFeedback: true,
		// Mandrill's sender-domain API (`senders/add-domain` / `check-domain`) is
		// read by `domains/providers/mandrill` (P3.1), which registers the kind in
		// `SENDING_DOMAIN_PROVIDERS` and answers the relay-verification seam from
		// `sendingDomainRelayIdentities`. Declaring 'api' without that provider is
		// a compile error (the `ApiVerifiedSendProviderKind` completeness guard),
		// so this line and that registration can only move together.
		domainVerification: 'api',
		// `send-raw` has no idempotency surface (D4): a lost response may sit on
		// top of an accepted and delivered message, so the ambiguity parks on
		// Mandrill's webhook feedback instead of being replayed.
		acceptanceSemantics: 'unknown-on-timeout',
		messageIdSource: 'provider',
	},
] as const satisfies readonly CoreSendProviderCatalogEntry[];

/**
 * The core kinds whose sending domains are verified through a provider API —
 * exactly the kinds `domains/providers` must register a domain-identity adapter
 * for (D7).
 *
 * DERIVED from the catalog literal rather than restated beside it, so declaring
 * `domainVerification: 'api'` on a new kind without registering its domain
 * provider is a compile error in `domains/providers/index.ts` instead of a
 * relay that silently reports every domain unverified.
 */
export type ApiVerifiedSendProviderKind = Extract<
	(typeof CORE_SEND_PROVIDER_CATALOG)[number],
	{ domainVerification: 'api' }
>['kind'];

interface GeneratedSendTransportCatalogEntry extends SendProviderCatalogEntry {
	readonly pluginId: PluginId;
	readonly requiredCapability: 'send:transport';
}

const pluginCatalog =
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG as readonly GeneratedSendTransportCatalogEntry[];

export const SEND_PROVIDER_CATALOG: readonly SendProviderCatalogEntry[] = Object.freeze([
	...CORE_SEND_PROVIDER_CATALOG,
	...pluginCatalog,
]);

const catalogByKind = new Map(SEND_PROVIDER_CATALOG.map((entry) => [entry.kind, entry]));

if (catalogByKind.size !== SEND_PROVIDER_CATALOG.length) {
	throw new TypeError('Bundled send transport kinds must be unique');
}

export const SEND_PROVIDER_KINDS = Object.freeze(SEND_PROVIDER_CATALOG.map((entry) => entry.kind));

export function isCoreSendProviderKind(kind: string): kind is CoreSendProviderKind {
	return (SEND_TRANSPORT_KINDS as readonly string[]).includes(kind);
}

export function isSendProviderKind(kind: string | null | undefined): kind is SendProviderKind {
	return kind != null && catalogByKind.has(kind as SendProviderKind);
}

export function sendProviderCatalogEntry(kind: SendProviderKind): SendProviderCatalogEntry {
	const entry = catalogByKind.get(kind);
	if (!entry) throw new TypeError('Unknown send provider kind');
	return entry;
}

/**
 * This kind's declared sending-domain verification path, with the fail-closed
 * default applied. Read it instead of the raw field so an absent declaration
 * can never be mistaken for `api`.
 */
export function domainVerificationFor(kind: SendProviderKind): DomainVerificationSupport {
	return sendProviderCatalogEntry(kind).domainVerification ?? 'none';
}

/**
 * Does this kind report delivery outcomes back to us out of band (webhook /
 * SNS)? Read it instead of the raw field so an absent declaration can never be
 * mistaken for a feedback channel that does not exist (fail closed).
 *
 * Two consumers, and they must agree: the measurement grading widens a bounce
 * tolerance for an arm whose bounces arrive over provider feedback rather than
 * our own VERP stream, and the governed dispatch boundary keeps an
 * ambiguous-acceptance send NON-TERMINAL only for a kind whose feedback could
 * still speak to it. A kind with no feedback at all has nothing to wait for.
 */
export function hasProviderFeedbackFor(kind: SendProviderKind): boolean {
	return sendProviderCatalogEntry(kind).hasProviderFeedback === true;
}

/**
 * What a dispatch outcome MEANS for this kind — see {@link AcceptanceSemantics}.
 * Read it instead of the raw field so an absent declaration can never be
 * mistaken for custody the transport never took.
 *
 * This is the capability that replaced `providerKind === 'mta'` at the two
 * acceptance sites in `delivery/governedDispatch.ts` (plan D2).
 */
export function acceptanceSemanticsFor(kind: SendProviderKind): AcceptanceSemantics {
	return sendProviderCatalogEntry(kind).acceptanceSemantics ?? 'unknown-on-timeout';
}

/**
 * Where this kind's provider message id comes from — see
 * {@link MessageIdSource}. Read it instead of the raw field so an absent
 * declaration can never be mistaken for an id we control.
 */
export function messageIdSourceFor(kind: SendProviderKind): MessageIdSource {
	return sendProviderCatalogEntry(kind).messageIdSource ?? 'provider';
}

/**
 * Is this kind's provider message id known BEFORE the send — i.e. is it the
 * idempotency key the governed boundary derived from the durable Send row?
 *
 * ONE definition, because two sites must agree or a Send is bound to an id it
 * will never be reported under: the pre-dispatch identity binding and the
 * recorded `providerMessageId` after a successful attempt.
 */
export function preassignsProviderMessageId(kind: SendProviderKind): boolean {
	return messageIdSourceFor(kind) === 'idempotency-key';
}

/**
 * Is this kind's envelope-sender control decided by a PROBE rather than by the
 * catalog? `yes` and `no` are settled declarations, so probing them would prove
 * nothing and — since every probe deliberately manufactures a bounce on the
 * operator's relay — would spend real sender reputation doing it.
 *
 * ONE definition, because two consumers must agree or the feature silently
 * half-works: the sweep decides what is worth PROVING and the routing gate
 * decides what a proof is worth READING. If they disagreed, the sweep would go
 * on proving a capability the routing gate never consults.
 */
export function isProbeDecidedReturnPathKind(kind: SendProviderKind): boolean {
	return catalogByKind.get(kind)?.supportsCustomReturnPath === 'probe';
}
