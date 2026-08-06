/** Isolate-safe catalog for built-in and statically bundled send transports. */

import type { PluginId } from '@owlat/plugin-kit';
import { SEND_TRANSPORT_KINDS } from '@owlat/shared';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG } from '../../plugins/sendTransportCatalog.generated';
import type {
	AcceptanceSemantics,
	CoreSendProviderCatalogEntry,
	CoreSendProviderKind,
	DomainVerificationSupport,
	MessageIdSource,
	SendProviderCatalogEntry,
	SendProviderKind,
} from './catalogTypes';

/**
 * The declaration vocabulary — the capability unions and the entry shapes — was
 * split into `./catalogTypes.ts` when this file crossed the ~500 LOC ratchet
 * (`scripts/check-file-size.sh`). It is re-exported here, so every consumer
 * keeps importing `lib/sendProviders/catalog` and nothing had to move; the
 * PREREQUISITES note on `AcceptanceSemantics` travelled with the type.
 */
export type {
	AcceptanceSemantics,
	CoreSendProviderKind,
	DeclaredCustomReturnPathSupport,
	DomainVerificationSupport,
	MessageIdSource,
	SendProviderCatalogEntry,
	SendProviderKind,
} from './catalogTypes';

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
 * for (Mandrill plan D7 = the seams plan's P0.3).
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

/**
 * THE UNTYPED TIER FAILS CLOSED TOO (plan P0.1 / D2).
 *
 * {@link CoreSendProviderCatalogEntry} makes the two dangerous declarations a
 * BUILD BREAK for the five kinds that ship in this repo, but bundled plugin
 * entries are generated and reach the catalog through a cast, so the type says
 * nothing about them. Today they cannot carry either field at all — the plugin
 * codegen emits a fixed shape with no semantics — but plan P3.1 gives the plugin
 * `sendTransport` contract the capability fields, and at that moment the
 * PREREQUISITES note on {@link AcceptanceSemantics} would be the only thing
 * standing between a manifest and a mislabelled measurement plane: a bundled
 * plugin declaring `idempotency-key` gets `bindMtaProviderIdentity` stamping
 * `providerType: 'mta'` onto its Sends, and one declaring `accepted` gets its
 * ambiguous outcomes replayed down an arm `withReconciliationSafety` defers
 * until the delivery deadline terminalizes them as definite failures.
 *
 * A note is not a control. This is: composing a catalog with either declaration
 * on a plugin entry throws at module load — a boot/codegen failure the author of
 * the manifest sees immediately, rather than a wrong number in a ramp decision
 * nobody attributes to a plugin. It is deliberately NOT the full core union: a
 * plugin may pair `unknown-on-timeout` with any id source, because reading the
 * two fields independently is a property the governed boundary keeps (see the
 * pairing discussion on {@link CoreSendProviderCatalogEntry}). Only the values
 * whose prerequisites live outside the catalog are refused.
 *
 * P3.1 relaxes this by generalizing the three sites in that note and deleting
 * the check — in that order, deliberately, in one change.
 */
function assertPluginDispatchSemanticsAreGeneral(
	entries: readonly GeneratedSendTransportCatalogEntry[]
): void {
	for (const entry of entries) {
		const custody = entry.acceptanceSemantics === 'accepted';
		const ownId = entry.messageIdSource === 'idempotency-key';
		if (!custody && !ownId) continue;
		throw new TypeError(
			`Bundled plugin send transport '${entry.kind}' declares ${
				custody ? 'acceptanceSemantics: accepted' : 'messageIdSource: idempotency-key'
			}, which is not yet available outside the own MTA: the custody arm and the ` +
				'pre-dispatch identity binding are still MTA-shaped. See the PREREQUISITES note ' +
				'on AcceptanceSemantics in lib/sendProviders/catalogTypes.ts before enabling it.'
		);
	}
}

assertPluginDispatchSemanticsAreGeneral(pluginCatalog);

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
 * Is this transport's provider message id known BEFORE the send — i.e. is it the
 * idempotency key the governed boundary derived from the durable Send row?
 *
 * ONE definition, because two sites must agree or a Send is bound to an id it
 * will never be reported under: the pre-dispatch identity binding and the
 * recorded `providerMessageId` after a successful attempt.
 *
 * Takes the DECLARATION, not the kind — `preassignsProviderMessageId(
 * messageIdSourceFor(kind))` — so that the lookup and the derivation are
 * separable. A test that steers what a kind declares then still runs THIS rule
 * rather than a copy of it, which is the only way a later tightening here
 * cannot silently pass a suite that restated the old rule.
 */
export function preassignsProviderMessageId(source: MessageIdSource): boolean {
	return source === 'idempotency-key';
}

/**
 * Does a successful dispatch mean the transport took CUSTODY of the message
 * (delivery still pending, its own feedback still to come) rather than the
 * handoff itself — and is an ambiguous outcome therefore RE-ASKABLE by replay?
 *
 * The twin of {@link preassignsProviderMessageId}, and named for the same
 * reason: the acceptance half of the pair has three consumers already (the
 * `acceptedForDelivery` verdict and the reconciliation arm in
 * `delivery/governedDispatch.ts`, plus the pins that check them), and a raw
 * `=== 'accepted'` at each is how one of them drifts. Takes the declaration:
 * `takesCustodyOnAcceptance(acceptanceSemanticsFor(kind))`.
 */
export function takesCustodyOnAcceptance(semantics: AcceptanceSemantics): boolean {
	return semantics === 'accepted';
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
