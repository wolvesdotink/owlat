import { BUNDLED_PLUGIN_DRAFT_STRATEGY_CATALOG } from './draftStrategyCatalog.generated';
import {
	defineHostedContributionCatalog,
	type HostedContributionDefinition,
} from './hostedContributionCatalog';

export const DEFAULT_DRAFT_STRATEGY_KIND = 'default' as const;

export interface HostedDraftStrategyDefinition extends HostedContributionDefinition<'draft:strategy'> {
	readonly label: string;
	readonly timeoutMs: number;
	readonly requiredEnvVars: readonly string[];
}

const CATALOG = defineHostedContributionCatalog<HostedDraftStrategyDefinition>(
	BUNDLED_PLUGIN_DRAFT_STRATEGY_CATALOG,
	'draft strategy'
);

export function pluginDraftStrategyDefinition(
	kind: string
): HostedDraftStrategyDefinition | undefined {
	return CATALOG.byKind(kind);
}

export function isRegisteredDraftStrategy(kind: string): boolean {
	return kind === DEFAULT_DRAFT_STRATEGY_KIND || CATALOG.byKind(kind) !== undefined;
}

export const DRAFT_STRATEGY_CATALOG = Object.freeze([
	Object.freeze({ kind: DEFAULT_DRAFT_STRATEGY_KIND, label: 'Default', tier: 'host' as const }),
	...CATALOG.all.map((definition) => Object.freeze({ ...definition, tier: 'bundled' as const })),
]);
