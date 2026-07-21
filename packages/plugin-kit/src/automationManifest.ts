import { isPluginLocalId } from './namespacedKind';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateKnownFields,
} from './manifestValue';
import { isSafeStaticExportPath } from './staticExportPath';

const RESERVED_LOCAL_IDS = new Set(['constructor', 'prototype', '__proto__']);
const ICON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 64;
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
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.${bucket}[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(item.value, path, FIELDS, issues);
		validateId(item.value, path, seenIds, issues);
		validateBoundedString(item.value, 'label', path, 1, MAX_LABEL_LENGTH, issues);
		validateBoundedString(item.value, 'description', path, 1, MAX_DESCRIPTION_LENGTH, issues);
		validateIcon(item.value, path, issues);
		validateModule(item.value, path, issues);
	}
}

function validateId(
	value: Record<string, unknown>,
	path: string,
	seenIds: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(value, 'id', issues, true, path);
	if (id.kind !== 'value') return;
	if (
		typeof id.value !== 'string' ||
		id.value.length > MAX_ID_LENGTH ||
		!isPluginLocalId(id.value) ||
		RESERVED_LOCAL_IDS.has(id.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.id`,
			`must be a non-reserved lowercase kebab-case id of at most ${MAX_ID_LENGTH} characters`
		);
	} else if (seenIds.has(id.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates contribution ${id.value}`);
	} else {
		seenIds.add(id.value);
	}
}

function validateBoundedString(
	value: Record<string, unknown>,
	field: string,
	path: string,
	min: number,
	max: number,
	issues: PluginManifestIssue[]
): void {
	const property = readDataProperty(value, field, issues, true, path);
	if (
		property.kind === 'value' &&
		(typeof property.value !== 'string' ||
			property.value.trim() !== property.value ||
			property.value.length < min ||
			property.value.length > max)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.${field}`,
			`must be a trimmed string of ${min} to ${max} characters`
		);
	}
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
