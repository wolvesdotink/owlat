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
}

/**
 * A CORE catalog entry — every kind that ships in this repo.
 *
 * `domainVerification` is REQUIRED here while it stays optional on the shared
 * interface: a kind we write ourselves can always answer the question, and
 * letting a new core kind coast on the fail-closed default is exactly how an
 * `api` transport silently loses its relay eligibility. Bundled plugin
 * transports keep the optional field — they are generated from plugin
 * manifests, which have no domain-identity surface to declare.
 */
interface CoreSendProviderCatalogEntry extends SendProviderCatalogEntry {
	readonly domainVerification: DomainVerificationSupport;
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
		// Mandrill HAS a domain-identity API (`senders/domains`), but nothing in
		// this repo reads it yet: P3.1 registers `domains/providers/mandrill` and
		// flips this to 'api'. Declaring 'api' before that provider exists is a
		// compile error (the `ApiVerifiedSendProviderKind` completeness guard), and
		// would in any case credit the seam with a proof it never fetched.
		domainVerification: 'none' /* flipped to 'api' by P3.1 */,
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
