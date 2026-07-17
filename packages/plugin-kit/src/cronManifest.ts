import {
	PLUGIN_CRON_MAX_INTERVAL_MINUTES,
	PLUGIN_CRON_MIN_INTERVAL_MINUTES,
	PLUGIN_CRON_TIMEOUT_MAX_MS,
	PLUGIN_CRON_TIMEOUT_MIN_MS,
} from './cron';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateKnownFields,
} from './manifestValue';
import { isSafeStaticExportPath } from './staticExportPath';

const LOCAL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_LOCAL_IDS = new Set(['constructor', 'prototype', '__proto__']);
const MAX_LABEL_LENGTH = 100;
const FIELDS = new Set(['id', 'label', 'module', 'schedule', 'timeoutMs']);

export function validateCronContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.crons[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(item.value, path, FIELDS, issues);
		validateId(item.value, path, ids, issues);
		validateLabel(item.value, path, issues);
		validateModule(item.value, path, issues);
		validateSchedule(item.value, path, issues);
		validateTimeout(item.value, path, issues);
	}
}

function validateId(
	cron: Record<string, unknown>,
	path: string,
	ids: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(cron, 'id', issues, true, path);
	if (id.kind !== 'value') return;
	if (
		typeof id.value !== 'string' ||
		id.value.length > 64 ||
		!LOCAL_ID.test(id.value) ||
		RESERVED_LOCAL_IDS.has(id.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.id`,
			'must be a non-reserved lowercase kebab-case id of at most 64 characters'
		);
	} else if (ids.has(id.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates cron ${id.value}`);
	} else ids.add(id.value);
}

function validateLabel(
	cron: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const label = readDataProperty(cron, 'label', issues, true, path);
	if (
		label.kind === 'value' &&
		(typeof label.value !== 'string' ||
			label.value.trim() !== label.value ||
			label.value.length < 1 ||
			label.value.length > MAX_LABEL_LENGTH)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.label`,
			`must be a trimmed label of at most ${MAX_LABEL_LENGTH} characters`
		);
	}
}

function validateModule(
	cron: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const module = readDataProperty(cron, 'module', issues, true, path);
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
	validateKnownFields(schedule.value, `${path}.schedule`, new Set(['intervalMinutes']), issues);
	const intervalMinutes = readDataProperty(
		schedule.value,
		'intervalMinutes',
		issues,
		true,
		`${path}.schedule`
	);
	if (
		intervalMinutes.kind === 'value' &&
		(!Number.isSafeInteger(intervalMinutes.value) ||
			(intervalMinutes.value as number) < PLUGIN_CRON_MIN_INTERVAL_MINUTES ||
			(intervalMinutes.value as number) > PLUGIN_CRON_MAX_INTERVAL_MINUTES)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.schedule.intervalMinutes`,
			`must be an integer from ${PLUGIN_CRON_MIN_INTERVAL_MINUTES} to ${PLUGIN_CRON_MAX_INTERVAL_MINUTES}`
		);
	}
}

function validateTimeout(
	cron: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const timeout = readDataProperty(cron, 'timeoutMs', issues, true, path);
	if (
		timeout.kind === 'value' &&
		(!Number.isSafeInteger(timeout.value) ||
			(timeout.value as number) < PLUGIN_CRON_TIMEOUT_MIN_MS ||
			(timeout.value as number) > PLUGIN_CRON_TIMEOUT_MAX_MS)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.timeoutMs`,
			`must be an integer from ${PLUGIN_CRON_TIMEOUT_MIN_MS} to ${PLUGIN_CRON_TIMEOUT_MAX_MS}`
		);
	}
}
