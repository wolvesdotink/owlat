import { forEachContributionItem, validateContributionLocalId } from './contributionManifest';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import { readDataProperty, type DataProperty } from './manifestValue';

const FIELDS = new Set(['id', 'description', 'subscribable']);
const MAX_DESCRIPTION_LENGTH = 140;

export function validateWebhookEventContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	forEachContributionItem(items, 'webhookEvents', FIELDS, issues, (event, path) => {
		validateContributionLocalId(event, path, ids, 'webhook event', issues);
		validateDescription(event, path, issues);
		validateSubscribable(event, path, issues);
	});
}

function validateDescription(
	event: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const description = readDataProperty(event, 'description', issues, true, path);
	if (
		description.kind === 'value' &&
		(typeof description.value !== 'string' ||
			description.value.trim().length < 1 ||
			description.value.length > MAX_DESCRIPTION_LENGTH)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.description`,
			`must be a non-empty string of at most ${MAX_DESCRIPTION_LENGTH} characters`
		);
	}
}

function validateSubscribable(
	event: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const subscribable = readDataProperty(event, 'subscribable', issues, true, path);
	if (subscribable.kind === 'value' && typeof subscribable.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', `${path}.subscribable`, 'must be a boolean');
	}
}
