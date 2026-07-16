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

import type { PluginId } from '@owlat/plugin-kit';
import { INTEGRATION_PROVIDER_KINDS } from '../_common';
import { IMPORT_PROVIDER_CATALOG } from '../../plugins/importProviderCatalog';

export type ImportProviderKind = string;

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

export const IMPORT_PROVIDER_CATALOG_ALL: readonly ImportProviderCatalogEntry[] = Object.freeze([
	...CORE_IMPORT_PROVIDER_CATALOG,
	...IMPORT_PROVIDER_CATALOG.map((entry) => ({
		kind: entry.kind,
		label: entry.label,
		pluginId: entry.pluginId,
		requiredCapability: entry.requiredCapability,
	})),
]);

const catalogByKind = new Map(IMPORT_PROVIDER_CATALOG_ALL.map((entry) => [entry.kind, entry]));

if (catalogByKind.size !== IMPORT_PROVIDER_CATALOG_ALL.length) {
	throw new TypeError('Import provider kinds (core + bundled plugin) must be unique');
}

export const IMPORT_PROVIDER_KINDS = Object.freeze(
	IMPORT_PROVIDER_CATALOG_ALL.map((entry) => entry.kind)
);

export function isImportProviderKind(kind: string | null | undefined): boolean {
	return kind != null && catalogByKind.has(kind);
}

export function isPluginImportProviderKind(kind: string | null | undefined): boolean {
	return kind != null && catalogByKind.get(kind)?.pluginId !== undefined;
}

export function importProviderCatalogEntry(kind: string): ImportProviderCatalogEntry {
	const entry = catalogByKind.get(kind);
	if (!entry) throw new TypeError('Unknown import provider kind');
	return entry;
}
