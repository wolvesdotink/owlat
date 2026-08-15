/**
 * The raw core send-provider table. Split from `sendProviderCatalog.ts` along
 * the data/logic seam (that module derives every type, freeze and lookup from
 * this array and re-exports it), so each file stays under the size cap.
 */
import { OUTBOUND_TLS_MODE_OPTIONS, SMTP_RELAY_PRESETS } from './sendProviderCredentialFields';
import type { CoreSendProviderCatalogEntry } from './sendProviderCatalogTypes';

/**
 * The kinds that ship in this repo. Bundled plugin transports are composed onto
 * this list by the backend at load time — they are not declared here, because
 * their declaration is their plugin manifest.
 */
export const CORE_SEND_PROVIDER_CATALOG = [
	{
		kind: 'mta',
		label: 'Owlat MTA',
		tier: 'own',
		retryDelays: [1_000, 5_000],
		requiredEnvVars: ['MTA_API_URL', 'MTA_API_KEY'],
		optionalEnvVars: ['OUTBOUND_TLS_MODE', 'MTA_WEBHOOK_SECRET'],
		credentialFields: [
			{
				kind: 'select',
				key: 'outboundTlsMode',
				label: 'sharedPkg.sendProviderCatalog.credentialFields.mta.outboundTlsMode.label',
				envVar: 'OUTBOUND_TLS_MODE',
				options: OUTBOUND_TLS_MODE_OPTIONS,
				default: 'opportunistic',
			},
		],
		supportsCustomReturnPath: 'yes',
		hasProviderFeedback: true,
		providerFeedback: { webhookPath: '/webhooks/mta', signingKeyEnvVar: 'MTA_WEBHOOK_SECRET' },
		domainVerification: 'none',
		acceptanceSemantics: 'accepted',
		messageIdSource: 'idempotency-key',
		deduplicatesOnIdempotencyKey: true,
		tagsFeedbackProvenance: true,
	},
	{
		kind: 'ses',
		label: 'Amazon SES',
		tier: 'core',
		retryDelays: [1_000, 5_000, 30_000],
		// Every variable the adapter requires, region included: `ses/index.ts` reads AWS_SES_REGION
		// through `transportEnvRequired`, so omitting it here would let a named instance resolve as
		// configured and then fail on every send.
		requiredEnvVars: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
		// READ BY THE TRANSPORT, on every send: `ses/index.ts` stamps `ConfigurationSetName` on the
		// command so SES event publishing can attribute the feedback — but a send without it works,
		// so it sits beside the gate rather than in it, like `mta`'s `MTA_WEBHOOK_SECRET`. Its
		// neighbour `SES_SNS_TOPIC_ARN` stays undeclared: the feedback verifier alone reads it.
		optionalEnvVars: ['SES_CONFIGURATION_SET'],
		credentialFields: [
			{
				kind: 'region-select',
				key: 'region',
				label: 'sharedPkg.sendProviderCatalog.credentialFields.ses.region.label',
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
				label: 'sharedPkg.sendProviderCatalog.credentialFields.ses.accessKeyId.label',
				envVar: 'AWS_SES_ACCESS_KEY_ID',
				required: true,
			},
			{
				kind: 'secret',
				key: 'secretAccessKey',
				label: 'sharedPkg.sendProviderCatalog.credentialFields.ses.secretAccessKey.label',
				envVar: 'AWS_SES_SECRET_ACCESS_KEY',
				required: true,
			},
		],
		// SES derives MAIL FROM from the verified identity's configured custom MAIL FROM domain, not
		// from a per-send address — but it reports every bounce and complaint back to us.
		supportsCustomReturnPath: 'no',
		hasProviderFeedback: true,
		// SNS delivers the notifications, so the operator's job is a SUBSCRIPTION
		// rather than a key: SES signs with a certificate the verifier fetches.
		providerFeedback: { webhookPath: '/webhooks/ses', setupPanel: 'sns-topic' },
		// SES identity APIs (`getVerificationStatus` + the DKIM/MAIL FROM proof
		// on `sendingDomainSesIdentities`) — the shipped relay-verification path.
		domainVerification: 'api',
		// SES has no idempotency surface: a replayed request after a lost response would
		// double-deliver, which is why its adapter answers AMBIGUOUS_TIMEOUT, not a retryable code.
		acceptanceSemantics: 'unknown-on-timeout',
		messageIdSource: 'provider',
		// No dedup header, no dedup id: a repeat request after a lost response delivers a second copy.
		deduplicatesOnIdempotencyKey: false,
		// SNS notifications are SES's own report about a message we handed it;
		// nothing of ours annotates them, so there is no provenance tag to read.
		tagsFeedbackProvenance: false,
		// No `setupProbe`: SES has no cheap pre-apply check, and the shipped endpoints refuse to
		// pretend otherwise — the live send test after applying is its proof.
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
				label: 'sharedPkg.sendProviderCatalog.credentialFields.resend.apiKey.label',
				envVar: 'RESEND_API_KEY',
				placeholder: 're_...',
				required: true,
			},
		],
		supportsCustomReturnPath: 'no',
		hasProviderFeedback: true,
		// No `setupPanel`: the webhook is optional and Resend keeps working without
		// it. The generic feedback-status query still reports the signing-key state
		// whenever a surface chooses to draw the ceremony.
		providerFeedback: {
			webhookPath: '/webhooks/resend',
			signingKeyEnvVar: 'RESEND_WEBHOOK_SECRET',
		},
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
				label: 'sharedPkg.sendProviderCatalog.credentialFields.smtp.relay.label',
				envVar: 'SMTP_RELAY_HOST',
				portEnvVar: 'SMTP_RELAY_PORT',
				secureEnvVar: 'SMTP_RELAY_SECURE',
				portDefault: '587',
				secureDefault: false,
				// The example the shipped form has always shown in an empty host
				// box, beside the port's own `587` hint.
				placeholder: 'smtp.mailgun.org',
				presets: SMTP_RELAY_PRESETS,
				required: true,
			},
			{
				kind: 'string',
				key: 'username',
				label: 'sharedPkg.sendProviderCatalog.credentialFields.smtp.username.label',
				envVar: 'SMTP_RELAY_USERNAME',
				required: true,
			},
			{
				kind: 'secret',
				key: 'password',
				label: 'sharedPkg.sendProviderCatalog.credentialFields.smtp.password.label',
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
				label: 'sharedPkg.sendProviderCatalog.credentialFields.mandrill.apiKey.label',
				envVar: 'MANDRILL_API_KEY',
				placeholder: 'md-...',
				// ONE SENTENCE FOR TWO SURFACES, both of which closed by POINTING AT THE
				// CARD that issues the second variable (ratified in the allowlist).
				description: 'sharedPkg.sendProviderCatalog.credentialFields.mandrill.apiKey.description',
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
		// The operator creates the webhook in Mandrill's console and copies the key
		// it issues in — which is why the panel reports that variable's PRESENCE.
		providerFeedback: {
			webhookPath: '/webhooks/mandrill',
			signingKeyEnvVar: 'MANDRILL_WEBHOOK_KEY',
			setupPanel: 'signed-webhook',
		},
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
	{
		kind: 'emailit',
		label: 'Emailit',
		tier: 'core',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['EMAILIT_API_KEY'],
		optionalEnvVars: ['EMAILIT_WEBHOOK_SECRET'],
		credentialFields: [
			{
				kind: 'secret',
				key: 'apiKey',
				label: 'sharedPkg.sendProviderCatalog.credentialFields.emailit.apiKey.label',
				envVar: 'EMAILIT_API_KEY',
				placeholder: 'em_...',
				required: true,
			},
		],
		supportsCustomReturnPath: 'no',
		hasProviderFeedback: true,
		providerFeedback: {
			webhookPath: '/webhooks/emailit',
			signingKeyEnvVar: 'EMAILIT_WEBHOOK_SECRET',
			setupPanel: 'signed-webhook',
		},
		// Keep this honest until Owlat persists Emailit domain identities.
		domainVerification: 'none',
		acceptanceSemantics: 'unknown-on-timeout',
		messageIdSource: 'provider',
		// Fail-closed until the vendor documents Idempotency-Key dedup: `true`
		// would let `systemMailRetryDisposition` auto-retry an ambiguous
		// system/auth send, double-delivering a password reset if Emailit does
		// not in fact dedup. The adapter still threads the header, so flipping
		// this to `true` once proven is a one-line change.
		deduplicatesOnIdempotencyKey: false,
		tagsFeedbackProvenance: false,
		setupProbe: { validator: 'validateEmailitKey', label: 'Test API key' },
	},
] as const satisfies readonly CoreSendProviderCatalogEntry[];
