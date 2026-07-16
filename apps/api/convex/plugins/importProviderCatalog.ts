import type { PluginId, PluginInboundSignatureContract } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_IMPORT_PROVIDER_CATALOG } from './importProviderCatalog.generated';

/**
 * Host view of a plugin-contributed import provider. Data-only metadata; the
 * executable module lives behind the generated Node-only module registry. The
 * mandatory inbound signature-verification contract travels with the entry so
 * the host can authenticate any plugin-sourced request before trusting it.
 */
export interface HostedImportProviderDefinition {
	readonly kind: string;
	readonly pluginId: PluginId;
	readonly label: string;
	readonly attestSource: string | null;
	readonly requiredEnvVars: readonly string[];
	readonly signature: PluginInboundSignatureContract;
	readonly requiredCapability: 'imports:provide';
}

export const IMPORT_PROVIDER_CATALOG =
	BUNDLED_PLUGIN_IMPORT_PROVIDER_CATALOG as readonly HostedImportProviderDefinition[];

export function pluginImportProviderDefinition(
	kind: string
): HostedImportProviderDefinition | undefined {
	return IMPORT_PROVIDER_CATALOG.find((definition) => definition.kind === kind);
}
