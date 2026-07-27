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
	},
	{
		kind: 'resend',
		label: 'Resend',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['RESEND_API_KEY'],
		supportsCustomReturnPath: 'no',
		hasProviderFeedback: true,
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
	},
] as const satisfies readonly SendProviderCatalogEntry[];

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
