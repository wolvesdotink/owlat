import { BUNDLED_PLUGIN_AUTONOMY_GATE_CATALOG } from './autonomyGateCatalog.generated';

export interface HostedAutonomyGateDefinition {
	readonly kind: string;
	readonly pluginId: string;
	readonly label: string;
	readonly timeoutMs: number;
	readonly requiredEnvVars: readonly string[];
	readonly requiredCapability: 'send:gate';
}

export const AUTONOMY_GATE_CATALOG =
	BUNDLED_PLUGIN_AUTONOMY_GATE_CATALOG as readonly HostedAutonomyGateDefinition[];

export function pluginAutonomyGateDefinition(
	kind: string
): HostedAutonomyGateDefinition | undefined {
	return AUTONOMY_GATE_CATALOG.find((definition) => definition.kind === kind);
}
