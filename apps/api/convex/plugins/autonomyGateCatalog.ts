import { BUNDLED_PLUGIN_AUTONOMY_GATE_CATALOG } from './autonomyGateCatalog.generated';
import {
	defineHostedContributionCatalog,
	type HostedContributionDefinition,
} from './hostedContributionCatalog';

export interface HostedAutonomyGateDefinition extends HostedContributionDefinition<'send:gate'> {
	readonly label: string;
	readonly timeoutMs: number;
	readonly requiredEnvVars: readonly string[];
}

const CATALOG = defineHostedContributionCatalog<HostedAutonomyGateDefinition>(
	BUNDLED_PLUGIN_AUTONOMY_GATE_CATALOG,
	'autonomy gate'
);

export const AUTONOMY_GATE_CATALOG = CATALOG.all;

export function pluginAutonomyGateDefinition(
	kind: string
): HostedAutonomyGateDefinition | undefined {
	return CATALOG.byKind(kind);
}
