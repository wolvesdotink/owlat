import {
	forEachContributionItem,
	validateContributionLabel,
	validateContributionLocalId,
	validateContributionModule,
} from './contributionManifest';
import { validateDescriptorText } from './fieldDescriptorManifest';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import { readDataProperty, type DataProperty } from './manifestValue';

/** An icon-name slug; the same shape as a local id, but a different grammar. */
const ICON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_ICON_LENGTH = 64;
const FIELDS = new Set(['id', 'label', 'description', 'icon', 'module']);

/** One automation registry bucket, used to build stable manifest issue paths. */
export type AutomationContributionBucket =
	| 'automationTriggers'
	| 'automationSteps'
	| 'automationConditions';

/**
 * Shared validator for the three automation contribution buckets. Each entry is
 * an editor-metadata descriptor (`id`, `label`, `description`, `icon`) plus a
 * static `module` export. The three buckets have identical shapes today, so one
 * validator keeps them consistent; per-bucket module contracts diverge only at
 * runtime, not in the manifest.
 */
export function validateAutomationContributions(
	bucket: AutomationContributionBucket,
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const seenIds = new Set<string>();
	forEachContributionItem(items, bucket, FIELDS, issues, (entry, path) => {
		validateContributionLocalId(entry, path, seenIds, 'contribution', issues);
		validateContributionLabel(entry, path, MAX_LABEL_LENGTH, issues);
		validateDescriptorText(entry, 'description', path, MAX_DESCRIPTION_LENGTH, true, issues);
		validateIcon(entry, path, issues);
		validateContributionModule(entry, path, issues);
	});
}

function validateIcon(
	value: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const icon = readDataProperty(value, 'icon', issues, true, path);
	if (
		icon.kind === 'value' &&
		(typeof icon.value !== 'string' ||
			icon.value.length > MAX_ICON_LENGTH ||
			!ICON.test(icon.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.icon`,
			`must be a lowercase kebab-case icon slug of at most ${MAX_ICON_LENGTH} characters`
		);
	}
}
