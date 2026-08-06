/**
 * THE SEND-PROVIDER CATALOG — one declaration, many derivations (the seams
 * plan's D1).
 *
 * What a provider IS, needs and can do, declared exactly once. Everything that
 * used to restate a piece of it now derives from here:
 *
 *   `SEND_TRANSPORT_KINDS`     the kind union itself, and with it
 *                              `CoreSendTransportKind` (`./transportAlignment`)
 *   `DELIVERY_PROVIDER_KINDS`  the same list, under the setup surfaces' name
 *   `getSendPathRequiredEnv`   `requiredEnvVars`, per kind (`./featureFlags`)
 *   `PROVIDER_ENV_KEYS`        every env variable the transport form owns
 *                              (`./setupSendingPresets`)
 *   `SMTP_RELAY_PRESETS`       one field's data, attached to that field
 *   the backend catalog        `apps/api/convex/lib/sendProviders/catalog.ts`
 *                              joins these entries to adapters and to the
 *                              bundled plugin tier, keeping its compile-time
 *                              completeness guards
 *
 * Before this file those were five independent declarations, two of them in
 * THIS package without importing each other, plus an if-chain in the setup
 * wizard that re-encoded the env mapping as imperative code. A sixth provider
 * had to be remembered in each.
 *
 * DATA ONLY — labels, typed field descriptors, env NAMES. Never env values,
 * never secrets, never adapter code: this module is in the web client bundle.
 * The vocabulary it is written in lives in `./sendProviderCatalogTypes` and
 * `./sendProviderCredentialFields`, and the fail-closed default behind each
 * optional capability field lives in `./sendProviderCapabilities`. All three are
 * re-exported here so consumers import one module.
 *
 * ENTRY ORDER IS THE CANONICAL ORDER. `SEND_TRANSPORT_KINDS` and every table
 * derived from it follow it: our own MTA first, then the relays in the order
 * they shipped.
 */

import type { OutboundTlsMode } from './outboundTlsMode';
import {
	credentialFieldEnvVars,
	SMTP_RELAY_PRESETS,
	type CredentialFieldEnvVar,
} from './sendProviderCredentialFields';
import type {
	CoreSendProviderCatalogEntry,
	HostedSendTransportKind,
} from './sendProviderCatalogTypes';

export * from './sendProviderCapabilities';
export * from './sendProviderCatalogTypes';
export * from './sendProviderCredentialFields';

/**
 * The outbound-TLS floor, as the transport form's option list.
 *
 * `satisfies` against {@link OutboundTlsMode} rather than a free-text select, so
 * renaming a mode in `./outboundTlsMode` breaks this build instead of leaving
 * the form writing a value the backend rejects. That the list is COMPLETE is
 * pinned by the catalog suite, which compares it to `OUTBOUND_TLS_MODES`.
 *
 * EXPORTED because the wizard's selector derives from it. The label is a
 * descriptor's copy and has ONE home — `setupOutboundTls.ts` in `apps/web` maps
 * this list and adds only its own `hint` paragraph, so renaming a label here
 * renames it in the rendered form too. A second hand-written copy of the labels
 * would be exactly the duplication this catalog exists to collapse.
 */
export const OUTBOUND_TLS_MODE_OPTIONS = [
	{ value: 'opportunistic', label: 'Opportunistic (recommended)' },
	{ value: 'require', label: 'Always encrypt' },
	{ value: 'require-verified', label: 'Always encrypt and verify' },
] as const satisfies readonly { readonly value: OutboundTlsMode; readonly label: string }[];

/**
 * The kinds that ship in this repo. Bundled plugin transports are composed onto
 * this list by the backend at load time — they are not declared here, because
 * their declaration is their plugin manifest.
 */
const CORE_SEND_PROVIDER_CATALOG = [
	{
		kind: 'mta',
		label: 'Owlat MTA',
		// The one `own` entry — D3's "own MTA is special by definition", as a
		// declaration rather than as a comparison somebody writes again.
		tier: 'own',
		retryDelays: [1_000, 5_000],
		requiredEnvVars: ['MTA_API_URL', 'MTA_API_KEY'],
		// `MTA_WEBHOOK_SECRET` for the same reason `resend` declares
		// `RESEND_WEBHOOK_SECRET` and `mandrill` declares `MANDRILL_WEBHOOK_KEY`:
		// the MTA's feedback path (`webhooks/adapters/mta.ts`, the TLS-report
		// endpoint, the checklist loopback) reads it, but a deployment that has not
		// issued it still sends perfectly well — so it belongs beside the required
		// list, not in it. It is not a credential FIELD either: the installer
		// writes it alongside `MTA_API_KEY`.
		optionalEnvVars: ['OUTBOUND_TLS_MODE', 'MTA_WEBHOOK_SECRET'],
		// NOT a credential form field, deliberately: `MTA_API_URL` / `MTA_API_KEY`
		// are written by the installer when it stands the MTA up, not typed by an
		// operator — which is why `PROVIDER_ENV_KEYS` (derived from the FIELDS
		// below) has never contained them, and must not start to: that list is
		// cleared and re-set on every transport swap, so including them would
		// unset a working MTA the moment someone rotated a Resend key.
		credentialFields: [
			{
				kind: 'select',
				key: 'outboundTlsMode',
				label: 'Outbound TLS',
				envVar: 'OUTBOUND_TLS_MODE',
				options: OUTBOUND_TLS_MODE_OPTIONS,
				default: 'opportunistic',
			},
		],
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
		// Its intake dedups on that same id, which is what makes the replay above
		// safe — and what lets an ambiguous system/auth mail be sent again.
		deduplicatesOnIdempotencyKey: true,
		// The ONE transport whose feedback we stamp ourselves: mail leaving our own
		// infrastructure is VERP-attributed on the way out, and the bounce/FBL
		// processor writes `deliveryDomain` onto the event it emits.
		tagsFeedbackProvenance: true,
	},
	{
		kind: 'ses',
		label: 'Amazon SES',
		tier: 'core',
		retryDelays: [1_000, 5_000, 30_000],
		// Every variable the adapter requires, region included: `ses/index.ts`
		// reads AWS_SES_REGION through `transportEnvRequired`, so omitting it here
		// would let a named instance resolve as configured and then fail on every
		// send.
		requiredEnvVars: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
		credentialFields: [
			{
				kind: 'region-select',
				key: 'region',
				label: 'Region',
				envVar: 'AWS_SES_REGION',
				// No `options`: AWS adds regions on its own schedule, and a list
				// pinned here would lock an operator out of a region that exists.
				default: 'us-east-1',
				placeholder: 'us-east-1',
				required: true,
			},
			{
				kind: 'string',
				key: 'accessKeyId',
				label: 'Access key ID',
				envVar: 'AWS_SES_ACCESS_KEY_ID',
				required: true,
			},
			{
				kind: 'secret',
				key: 'secretAccessKey',
				label: 'Secret access key',
				envVar: 'AWS_SES_SECRET_ACCESS_KEY',
				required: true,
			},
		],
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
		// No dedup header, no dedup id: a repeat request after a lost response
		// delivers a second copy.
		deduplicatesOnIdempotencyKey: false,
		// SNS notifications are SES's own report about a message we handed it;
		// nothing of ours annotates them, so there is no provenance tag to read.
		tagsFeedbackProvenance: false,
		// No `setupProbe`: SES has no cheap pre-apply check, and the shipped
		// endpoints refuse to pretend otherwise — the live send test after
		// applying is its proof.
	},
	{
		kind: 'resend',
		label: 'Resend',
		tier: 'core',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['RESEND_API_KEY'],
		// The webhook signing secret is issued when the operator creates the
		// webhook — later than, and independently of, connecting the transport.
		optionalEnvVars: ['RESEND_WEBHOOK_SECRET'],
		credentialFields: [
			{
				kind: 'secret',
				key: 'apiKey',
				label: 'Resend API key',
				envVar: 'RESEND_API_KEY',
				placeholder: 're_...',
				required: true,
			},
		],
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
		// That header is exactly the dedup surface the system/auth mail path asks
		// about. Custody is a different question, and this kind answers only one of
		// the two yes — which is why the two fields are not one declaration.
		deduplicatesOnIdempotencyKey: true,
		// A third-party ESP's webhook, unannotated by us.
		tagsFeedbackProvenance: false,
		setupProbe: { validator: 'validateResendKey', label: 'Test API key' },
	},
	{
		kind: 'smtp',
		label: 'SMTP relay',
		tier: 'core',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['SMTP_RELAY_HOST', 'SMTP_RELAY_USERNAME', 'SMTP_RELAY_PASSWORD'],
		// Port and TLS have safe defaults (587 / STARTTLS), so they are not
		// required to send — but the form still writes them, which is why they are
		// declared as part of the endpoint field below.
		optionalEnvVars: ['SMTP_RELAY_PORT', 'SMTP_RELAY_SECURE'],
		credentialFields: [
			{
				kind: 'host-port',
				key: 'relay',
				label: 'Server host',
				envVar: 'SMTP_RELAY_HOST',
				portEnvVar: 'SMTP_RELAY_PORT',
				secureEnvVar: 'SMTP_RELAY_SECURE',
				portDefault: '587',
				secureDefault: false,
				presets: SMTP_RELAY_PRESETS,
				required: true,
			},
			{
				kind: 'string',
				key: 'username',
				label: 'Username',
				envVar: 'SMTP_RELAY_USERNAME',
				required: true,
			},
			{
				kind: 'secret',
				key: 'password',
				label: 'Password',
				envVar: 'SMTP_RELAY_PASSWORD',
				required: true,
			},
		],
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
		// No dedup surface at all: once the message is on the wire, a repeat is a
		// second message.
		deduplicatesOnIdempotencyKey: false,
		// `hasProviderFeedback: false` — there is no feedback to tag.
		tagsFeedbackProvenance: false,
		setupProbe: { validator: 'validateSmtpRelay', label: 'Test connection' },
	},
	{
		kind: 'mandrill',
		label: 'Mailchimp Transactional (Mandrill)',
		tier: 'core',
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
		optionalEnvVars: ['MANDRILL_WEBHOOK_KEY', 'MANDRILL_SUBACCOUNT', 'MANDRILL_IP_POOL'],
		credentialFields: [
			{
				kind: 'secret',
				key: 'apiKey',
				label: 'Mailchimp Transactional API key',
				envVar: 'MANDRILL_API_KEY',
				placeholder: 'md-...',
				description:
					'Mailchimp Transactional → Settings → API keys. Feedback (bounces, complaints, rejects) needs a second variable, MANDRILL_WEBHOOK_KEY, which Mandrill issues when you create the webhook.',
				required: true,
			},
		],
		// Mandrill accepts a per-message `return_path_domain`, but only for a
		// domain SPF'd to Mandrill in the account — and whether VERP-style
		// envelope senders survive is deployment-specific. Only an observed
		// delivered bounce settles it (Mandrill plan D5).
		supportsCustomReturnPath: 'probe',
		// Mandrill webhooks report send/deferral/bounce/spam/unsub/reject
		// (Mandrill plan D10).
		hasProviderFeedback: true,
		// Mandrill's sender-domain API (`senders/add-domain` / `check-domain`) is
		// read by `domains/providers/mandrill` (the MANDRILL plan's P3.1), which
		// registers the kind in `SENDING_DOMAIN_PROVIDERS` and answers the
		// relay-verification seam from `sendingDomainRelayIdentities`. Declaring
		// 'api' without that provider is a compile error (the
		// `ApiVerifiedSendProviderKind` completeness guard), so this line and that
		// registration can only move together.
		domainVerification: 'api',
		// `send-raw` has no idempotency surface (Mandrill plan D4): a lost response
		// may sit on top of an accepted and delivered message, so the ambiguity
		// parks on Mandrill's webhook feedback instead of being replayed.
		acceptanceSemantics: 'unknown-on-timeout',
		messageIdSource: 'provider',
		// `send-raw` has no idempotency surface either (Mandrill plan D4), so a
		// repeat under the same key is a second delivery.
		deduplicatesOnIdempotencyKey: false,
		// A third-party ESP's webhook, unannotated by us.
		tagsFeedbackProvenance: false,
	},
] as const satisfies readonly CoreSendProviderCatalogEntry[];

/**
 * The entries themselves, frozen.
 *
 * CORE, and the name says so: the backend composes bundled plugin entries onto
 * this list at load time and exports the union as `SEND_PROVIDER_CATALOG`. A
 * consumer in this package (or in web / setup-cli) has no plugin composition to
 * consult, so it must not be handed a name that implies it sees both tiers.
 */
export const CORE_SEND_PROVIDER_CATALOG_ENTRIES = Object.freeze(CORE_SEND_PROVIDER_CATALOG);

/**
 * A core send-transport kind — DERIVED from the catalog, per D1, so declaring an
 * entry widens the union and every consumer of it at once. This is the union
 * five separate literals used to spell.
 */
export type CoreSendProviderKind = (typeof CORE_SEND_PROVIDER_CATALOG)[number]['kind'];

/** A core kind or a bundled plugin's namespaced kind. */
export type SendTransportKind = CoreSendProviderKind | HostedSendTransportKind;

/**
 * The send-transport kinds Owlat supports, in catalog order. THE canonical list:
 * the backend's `SEND_PROVIDER_KINDS`, the setup surfaces'
 * `DELIVERY_PROVIDER_KINDS` and the outbound-alignment guard's
 * `CoreSendTransportKind` all read it, so a new provider kind cannot be added on
 * one side and silently drift past the others.
 */
export const SEND_TRANSPORT_KINDS: readonly CoreSendProviderKind[] = Object.freeze(
	CORE_SEND_PROVIDER_CATALOG.map((entry) => entry.kind)
);

const catalogByKind = new Map<string, (typeof CORE_SEND_PROVIDER_CATALOG)[number]>(
	CORE_SEND_PROVIDER_CATALOG.map((entry) => [entry.kind, entry])
);

if (catalogByKind.size !== CORE_SEND_PROVIDER_CATALOG.length) {
	throw new TypeError('Send provider kinds must be unique');
}

/** True iff `value` names a core send-provider kind. */
export function isCoreSendProviderKind(value: string | undefined): value is CoreSendProviderKind {
	return value !== undefined && catalogByKind.has(value);
}

/**
 * This kind's entry, or `undefined` for anything the catalog does not declare.
 *
 * Answers for CORE kinds only — bundled plugin entries are composed onto the
 * catalog by the backend at load time, so the backend's
 * `sendProviderCatalogEntry` is the lookup that sees both tiers. A caller in
 * this package (or in web/setup-cli) has no plugin composition to consult and
 * would get a wrong "unknown" rather than a right one; saying so in the name is
 * cheaper than the bug.
 */
export function coreSendProviderCatalogEntry(
	kind: string | undefined
): CoreSendProviderCatalogEntry | undefined {
	return kind === undefined ? undefined : catalogByKind.get(kind);
}

/** The entry declaring `tier: 'own'`, as a type. */
type OwnCatalogEntry = Extract<(typeof CORE_SEND_PROVIDER_CATALOG)[number], { tier: 'own' }>;

/**
 * THE OWN ARM's kind, at the TYPE level — the literal, derived.
 *
 * `Extract<…, { tier: 'own' }>['kind']` reads the same declaration
 * {@link OWN_SEND_PROVIDER_KIND} reads at runtime, so the compile-time guards
 * that need a literal (the backend's `OWN_ARM_TRANSPORT_KIND` and the
 * `_OwnInfrastructureKindsAgree` pin against the domain-provider registry's
 * `mtaProvider.kind`) can key off the catalog instead of off a second literal
 * somebody has to keep equal to it. Moving `tier: 'own'` to another entry moves
 * this type with it, and those guards then fail at BUILD time rather than
 * waiting for the runtime assertion in the backend's registry suite.
 *
 * Deliberately narrower than {@link CoreSendProviderKind}: a consumer that wants
 * "some send kind" wants that union; a consumer that wants "ours" wants this.
 */
export type OwnSendProviderKind = OwnCatalogEntry['kind'];

/**
 * THE OWN ARM, as a declaration — D3's "the own MTA is special by definition,
 * and by nothing else".
 *
 * Derived from `tier: 'own'` rather than written out, so the one identity
 * question that legitimately exists has exactly one answer in the repo. It used
 * to be `OWN_ARM_TRANSPORT_KIND` inside
 * `apps/api/convex/lib/sendProviders/strategies/adaptive_mix` — unreachable from
 * this package, from `apps/web` and from `apps/setup-cli`, all three of which
 * ask the same question, so all three restated it as `=== 'mta'`. It lives here
 * now because this is the leaf every one of them may import, and the backend
 * constant re-exports THIS rather than restating the literal.
 *
 * The catalog suite pins that exactly one entry carries `tier: 'own'`, which is
 * what makes the filter below total; the type is {@link OwnSendProviderKind},
 * derived from the same tier, so nothing downstream loses the literal by reading
 * the constant instead of writing the string.
 */
export const OWN_SEND_PROVIDER_KIND: OwnSendProviderKind = (() => {
	const own = CORE_SEND_PROVIDER_CATALOG.filter(
		(entry): entry is OwnCatalogEntry => entry.tier === 'own'
	);
	if (own.length !== 1) {
		throw new TypeError('Exactly one send provider entry may declare tier: own');
	}
	return own[0]!.kind;
})();

/**
 * Is this the OWN arm — our own MTA — rather than a relay?
 *
 * The one capability-shaped reading of a kind's identity, per D3: the own MTA is
 * the arm a deliverability fallback moves traffic AWAY from, so "ours vs. not
 * ours" is a real question rather than a vendor special case. Ask it here
 * instead of comparing to a literal, so the answer moves with the catalog.
 *
 * Takes `string | undefined` because most callers hold an env value or a stored
 * provider name: an unset or unknown provider is not the own arm, which is both
 * the true and the fail-closed answer.
 */
export function isOwnSendProviderKind(kind: string | undefined | null): boolean {
	return kind != null && kind === OWN_SEND_PROVIDER_KIND;
}

/** Every credential field declared by any core kind, as a type. */
type CoreCredentialField = (typeof CORE_SEND_PROVIDER_CATALOG)[number]['credentialFields'][number];

/**
 * Every env variable the transport FORM owns, across all kinds — the derivation
 * `PROVIDER_ENV_KEYS` (`./setupSendingPresets`) is built from.
 *
 * The FORM, not the kind: a variable an installer writes (`MTA_API_URL`) is
 * required to send but is not a field, and must stay out of a list that is
 * cleared and re-set on every transport swap. The entries say which is which by
 * declaring one and not the other.
 */
export type TransportCredentialEnvKey = CredentialFieldEnvVar<CoreCredentialField>;

/** {@link TransportCredentialEnvKey}, at runtime, in catalog × field order. */
export const TRANSPORT_CREDENTIAL_ENV_KEYS: readonly TransportCredentialEnvKey[] = Object.freeze(
	CORE_SEND_PROVIDER_CATALOG.flatMap((entry) =>
		entry.credentialFields.flatMap((field) => credentialFieldEnvVars(field))
	)
);
