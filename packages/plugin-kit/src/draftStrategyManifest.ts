import { PLUGIN_DRAFT_STRATEGY_TIMEOUT_MAX_MS } from './draftStrategy';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateKnownFields,
} from './manifestValue';
import { isSafeStaticExportPath } from './staticExportPath';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIELDS = new Set(['id', 'label', 'module', 'timeoutMs']);

export function validateDraftStrategyContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	for (let index = 0; index < items.length; index += 1) {
		const path = `$.contributes.draftStrategies[${index}]`;
		const item = items[index];
		if (item?.kind !== 'value') continue;
		const value = item.value;
		if (!isRecord(value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(value, path, FIELDS, issues);
		const id = readDataProperty(value, 'id', issues, true, path);
		if (id.kind === 'value') {
			if (typeof id.value !== 'string' || id.value.length > 64 || !ID.test(id.value)) {
				addManifestIssue(
					issues,
					'invalid_format',
					`${path}.id`,
					'must be a lowercase kebab-case id'
				);
			} else if (ids.has(id.value)) {
				addManifestIssue(issues, 'duplicate', `${path}.id`, 'must be unique');
			} else ids.add(id.value);
		}
		const label = readDataProperty(value, 'label', issues, true, path);
		if (
			label.kind === 'value' &&
			(typeof label.value !== 'string' || label.value.trim().length < 1 || label.value.length > 100)
		) {
			addManifestIssue(
				issues,
				'invalid_type',
				`${path}.label`,
				'must be a non-empty string of at most 100 characters'
			);
		}
		const timeout = readDataProperty(value, 'timeoutMs', issues, true, path);
		if (
			timeout.kind === 'value' &&
			(!Number.isSafeInteger(timeout.value) ||
				(timeout.value as number) < 100 ||
				(timeout.value as number) > PLUGIN_DRAFT_STRATEGY_TIMEOUT_MAX_MS)
		) {
			addManifestIssue(
				issues,
				'invalid_type',
				`${path}.timeoutMs`,
				`must be an integer from 100 to ${PLUGIN_DRAFT_STRATEGY_TIMEOUT_MAX_MS}`
			);
		}
		validateModule(value, path, issues);
	}
}

function validateModule(
	value: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const module = readDataProperty(value, 'module', issues, true, path);
	if (module.kind !== 'value') return;
	if (!isRecord(module.value)) {
		addManifestIssue(issues, 'invalid_type', `${path}.module`, 'must be a plain object');
		return;
	}
	validateKnownFields(module.value, `${path}.module`, new Set(['exportPath']), issues);
	const exportPath = readDataProperty(module.value, 'exportPath', issues, true, `${path}.module`);
	if (
		exportPath.kind === 'value' &&
		(typeof exportPath.value !== 'string' || !isSafeStaticExportPath(exportPath.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.module.exportPath`,
			'must be a safe relative package export path'
		);
	}
}
