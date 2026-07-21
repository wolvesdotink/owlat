import type { PluginImportProviderKind, PluginInboundSignatureContract } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_IMPORT_PROVIDER_CATALOG } from './importProviderCatalog.generated';
import {
	defineHostedContributionCatalog,
	type HostedContributionDefinition,
} from './hostedContributionCatalog';

/**
 * Host view of a plugin-contributed import provider. Data-only metadata; the
 * executable module lives behind the generated Node-only module registry. The
 * mandatory inbound signature-verification contract travels with the entry so
 * the host can authenticate any plugin-sourced request before trusting it.
 */
export interface HostedImportProviderDefinition extends HostedContributionDefinition<'imports:provide'> {
	readonly kind: PluginImportProviderKind;
	readonly label: string;
	readonly attestSource: string | null;
	readonly requiredEnvVars: readonly string[];
	readonly signature: PluginInboundSignatureContract;
}

const CATALOG = defineHostedContributionCatalog<HostedImportProviderDefinition>(
	BUNDLED_PLUGIN_IMPORT_PROVIDER_CATALOG,
	'import provider'
);

export const IMPORT_PROVIDER_CATALOG = CATALOG.all;

export function pluginImportProviderDefinition(
	kind: string
): HostedImportProviderDefinition | undefined {
	return CATALOG.byKind(kind);
}
