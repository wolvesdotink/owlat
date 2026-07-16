/** Isolate-safe catalog for built-in and statically bundled send transports. */

import type { PluginId, PluginSendTransportKind } from '@owlat/plugin-kit';
import { SEND_TRANSPORT_KINDS, type CoreSendTransportKind } from '@owlat/shared';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG } from '../../plugins/sendTransportCatalog.generated';

export type CoreSendProviderKind = CoreSendTransportKind;
export type SendProviderKind = CoreSendProviderKind | PluginSendTransportKind;

export interface SendProviderCatalogEntry {
	readonly kind: SendProviderKind;
	readonly label: string;
	readonly retryDelays: readonly number[];
	readonly requiredEnvVars: readonly string[];
	readonly pluginId?: PluginId;
	readonly requiredCapability?: 'send:transport';
}

const CORE_SEND_PROVIDER_CATALOG = [
	{
		kind: 'mta',
		label: 'Owlat MTA',
		retryDelays: [1_000, 5_000],
		requiredEnvVars: ['MTA_API_URL', 'MTA_API_KEY'],
	},
	{
		kind: 'ses',
		label: 'Amazon SES',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
	},
	{
		kind: 'resend',
		label: 'Resend',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['RESEND_API_KEY'],
	},
	{
		kind: 'smtp',
		label: 'SMTP relay',
		retryDelays: [1_000, 5_000, 30_000],
		requiredEnvVars: ['SMTP_RELAY_HOST', 'SMTP_RELAY_USERNAME', 'SMTP_RELAY_PASSWORD'],
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
