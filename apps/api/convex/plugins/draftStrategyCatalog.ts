import { BUNDLED_PLUGIN_DRAFT_STRATEGY_CATALOG } from './draftStrategyCatalog.generated';

export const DEFAULT_DRAFT_STRATEGY_KIND = 'default' as const;

export interface HostedDraftStrategyDefinition {
	readonly kind: string;
	readonly pluginId: string;
	readonly label: string;
	readonly timeoutMs: number;
	readonly requiredEnvVars: readonly string[];
	readonly requiredCapability: 'draft:strategy';
}

const PLUGIN_STRATEGIES =
	BUNDLED_PLUGIN_DRAFT_STRATEGY_CATALOG as readonly HostedDraftStrategyDefinition[];

export function pluginDraftStrategyDefinition(
	kind: string
): HostedDraftStrategyDefinition | undefined {
	return PLUGIN_STRATEGIES.find((definition) => definition.kind === kind);
}

export function isRegisteredDraftStrategy(kind: string): boolean {
	return kind === DEFAULT_DRAFT_STRATEGY_KIND || pluginDraftStrategyDefinition(kind) !== undefined;
}

export const DRAFT_STRATEGY_CATALOG = Object.freeze([
	Object.freeze({ kind: DEFAULT_DRAFT_STRATEGY_KIND, label: 'Default', tier: 'host' as const }),
	...PLUGIN_STRATEGIES.map((definition) =>
		Object.freeze({ ...definition, tier: 'bundled' as const })
	),
]);
