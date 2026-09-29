import { PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS } from './autonomyGate';
import {
	forEachContributionItem,
	validateContributionLabel,
	validateContributionLocalId,
	validateContributionModule,
	validateIntegerRange,
} from './contributionManifest';
import type { PluginManifestIssue } from './manifestIssues';
import type { DataProperty } from './manifestValue';

const MAX_LABEL_LENGTH = 100;
const MIN_TIMEOUT_MS = 100;
const FIELDS = new Set(['id', 'label', 'module', 'timeoutMs']);

export function validateAutonomyGateContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	forEachContributionItem(items, 'sendGates', FIELDS, issues, (gate, path) => {
		validateContributionLocalId(gate, path, ids, 'autonomy gate', issues);
		validateContributionLabel(gate, path, MAX_LABEL_LENGTH, issues);
		validateContributionModule(gate, path, issues);
		validateIntegerRange(
			gate,
			'timeoutMs',
			path,
			MIN_TIMEOUT_MS,
			PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS,
			issues
		);
	});
}
