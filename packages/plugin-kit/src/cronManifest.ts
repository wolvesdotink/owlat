import {
	PLUGIN_CRON_MAX_INTERVAL_MINUTES,
	PLUGIN_CRON_MIN_INTERVAL_MINUTES,
	PLUGIN_CRON_TIMEOUT_MAX_MS,
	PLUGIN_CRON_TIMEOUT_MIN_MS,
} from './cron';
import {
	forEachContributionItem,
	validateContributionLabel,
	validateContributionLocalId,
	validateContributionModule,
	validateIntegerRange,
} from './contributionManifest';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateKnownFields,
} from './manifestValue';

const MAX_LABEL_LENGTH = 100;
const FIELDS = new Set(['id', 'label', 'module', 'schedule', 'timeoutMs']);
const SCHEDULE_FIELDS = new Set(['intervalMinutes']);

export function validateCronContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	forEachContributionItem(items, 'crons', FIELDS, issues, (cron, path) => {
		validateContributionLocalId(cron, path, ids, 'cron', issues);
		validateContributionLabel(cron, path, MAX_LABEL_LENGTH, issues);
		validateContributionModule(cron, path, issues);
		validateSchedule(cron, path, issues);
		validateIntegerRange(
			cron,
			'timeoutMs',
			path,
			PLUGIN_CRON_TIMEOUT_MIN_MS,
			PLUGIN_CRON_TIMEOUT_MAX_MS,
			issues
		);
	});
}

function validateSchedule(
	cron: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const schedule = readDataProperty(cron, 'schedule', issues, true, path);
	if (schedule.kind !== 'value') return;
	if (!isRecord(schedule.value)) {
		addManifestIssue(issues, 'invalid_type', `${path}.schedule`, 'must be a plain object');
		return;
	}
	validateKnownFields(schedule.value, `${path}.schedule`, SCHEDULE_FIELDS, issues);
	validateIntegerRange(
		schedule.value,
		'intervalMinutes',
		`${path}.schedule`,
		PLUGIN_CRON_MIN_INTERVAL_MINUTES,
		PLUGIN_CRON_MAX_INTERVAL_MINUTES,
		issues
	);
}
