/**
 * Browser/server-safe send-provider catalog for this concrete plugin build.
 *
 * Core entries live in `@owlat/shared`; bundled-plugin entries are emitted into
 * this package by plugin codegen from the same rendered value the Convex backend
 * receives. Keeping the generated data on both sides avoids a forbidden
 * web-to-api source import while making credential forms and their server-side
 * allowlist see exactly the transports dispatch can see.
 */

import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	credentialFieldEnvVars,
	type SendProviderCatalogEntryShape,
	type SendTransportKind,
} from '@owlat/shared/sendProviderCatalog';
import { isPluginNamespacedKind, isPluginSendTransportEnvVar } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG } from '~/generated/sendTransportCatalog.generated';

const pluginEntries =
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG as readonly SendProviderCatalogEntryShape[];

const pluginCredentialEnvKeys: string[] = [];
for (const entry of pluginEntries) {
	if (!isPluginNamespacedKind(entry.kind)) {
		throw new TypeError(`Bundled plugin send transport kind '${entry.kind}' is not namespaced`);
	}
	for (const name of entry.credentialFields?.flatMap((field) => credentialFieldEnvVars(field)) ??
		[]) {
		if (!isPluginSendTransportEnvVar(name)) {
			throw new TypeError(
				`Bundled plugin send transport '${entry.kind}' declares credential variable ` +
					`'${name}' outside the plugin transport namespace`
			);
		}
		pluginCredentialEnvKeys.push(name);
	}
}

export const COMPOSED_SEND_PROVIDER_CATALOG_ENTRIES: readonly SendProviderCatalogEntryShape[] =
	Object.freeze([...CORE_SEND_PROVIDER_CATALOG_ENTRIES, ...pluginEntries]);

const catalogByKind = new Map(
	COMPOSED_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => [entry.kind, entry] as const)
);

if (catalogByKind.size !== COMPOSED_SEND_PROVIDER_CATALOG_ENTRIES.length) {
	throw new TypeError('Composed send provider kinds must be unique');
}

export const COMPOSED_SEND_TRANSPORT_KINDS: readonly SendTransportKind[] = Object.freeze(
	COMPOSED_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind as SendTransportKind)
);

/** Credential variables this build's transport editor owns and may replace. */
export const COMPOSED_TRANSPORT_CREDENTIAL_ENV_KEYS: readonly string[] = Object.freeze([
	...new Set([
		...CORE_SEND_PROVIDER_CATALOG_ENTRIES.flatMap((entry) =>
			entry.credentialFields.flatMap((field) => credentialFieldEnvVars(field))
		),
		...pluginCredentialEnvKeys,
	]),
]);

export function isComposedSendProviderKind(value: string | undefined): value is SendTransportKind {
	return value !== undefined && catalogByKind.has(value);
}

export function composedSendProviderCatalogEntry(
	kind: string | undefined
): SendProviderCatalogEntryShape | undefined {
	return kind === undefined ? undefined : catalogByKind.get(kind);
}
