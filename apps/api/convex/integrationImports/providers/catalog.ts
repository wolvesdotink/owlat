/**
 * Host-composed integration import provider catalog — the single resolver that
 * unifies the built-in providers (Mailchimp, Stripe) with the statically
 * bundled plugin import providers.
 *
 * Built-in providers keep their flat kinds; every plugin provider is namespaced
 * `plugin.<id>.<provider>`. The import **walker** stays provider-agnostic — it
 * never branches on kind — and its per-provider config validation and page
 * dispatch for built-ins are unchanged. This catalog only routes kind
 * resolution and ownership through the host.
 */

import type { PluginId, PluginImportProviderKind } from '@owlat/plugin-kit';
import { composeHostedCatalog } from '../../lib/hostedCatalog';
import { INTEGRATION_PROVIDER_KINDS, type IntegrationProviderKind } from '../_common';
import { IMPORT_PROVIDER_CATALOG } from '../../plugins/importProviderCatalog';

export type ImportProviderKind = IntegrationProviderKind | PluginImportProviderKind;

export interface ImportProviderCatalogEntry {
	readonly kind: ImportProviderKind;
	readonly label: string;
	/** Present only for plugin-contributed providers. */
	readonly pluginId?: PluginId;
	readonly requiredCapability?: 'imports:provide';
}

const CORE_LABELS: Record<(typeof INTEGRATION_PROVIDER_KINDS)[number], string> = {
	mailchimp: 'Mailchimp',
	stripe: 'Stripe',
};

const CORE_IMPORT_PROVIDER_CATALOG: readonly ImportProviderCatalogEntry[] =
	INTEGRATION_PROVIDER_KINDS.map((kind) => ({ kind, label: CORE_LABELS[kind] }));

const catalog = composeHostedCatalog<ImportProviderCatalogEntry>(
	CORE_IMPORT_PROVIDER_CATALOG,
	IMPORT_PROVIDER_CATALOG.map((entry) => ({
		kind: entry.kind,
		label: entry.label,
		pluginId: entry.pluginId,
		requiredCapability: entry.requiredCapability,
	})),
	'import provider'
);

export const IMPORT_PROVIDER_CATALOG_ALL: readonly ImportProviderCatalogEntry[] = catalog.all;

export const IMPORT_PROVIDER_KINDS = catalog.kinds;

export function isImportProviderKind(kind: string | null | undefined): kind is ImportProviderKind {
	return catalog.has(kind);
}

export function isPluginImportProviderKind(
	kind: string | null | undefined
): kind is PluginImportProviderKind {
	return catalog.get(kind)?.pluginId !== undefined;
}

export function importProviderCatalogEntry(kind: string): ImportProviderCatalogEntry {
	return catalog.entryFor(kind);
}
