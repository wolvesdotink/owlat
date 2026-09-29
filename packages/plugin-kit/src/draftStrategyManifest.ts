import {
	forEachContributionItem,
	validateContributionLabel,
	validateContributionLocalId,
	validateContributionModule,
	validateIntegerRange,
} from './contributionManifest';
import { PLUGIN_DRAFT_STRATEGY_TIMEOUT_MAX_MS } from './draftStrategy';
import type { PluginManifestIssue } from './manifestIssues';
import type { DataProperty } from './manifestValue';

const MAX_LABEL_LENGTH = 100;
const MIN_TIMEOUT_MS = 100;
const FIELDS = new Set(['id', 'label', 'module', 'timeoutMs']);

export function validateDraftStrategyContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	forEachContributionItem(items, 'draftStrategies', FIELDS, issues, (strategy, path) => {
		validateContributionLocalId(strategy, path, ids, 'draft strategy', issues);
		validateContributionLabel(strategy, path, MAX_LABEL_LENGTH, issues);
		validateIntegerRange(
			strategy,
			'timeoutMs',
			path,
			MIN_TIMEOUT_MS,
			PLUGIN_DRAFT_STRATEGY_TIMEOUT_MAX_MS,
			issues
		);
		validateContributionModule(strategy, path, issues);
	});
}
