import { PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS } from './autonomyGate';
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
const FIELDS = new Set(['id', 'label', 'module', 'timeoutMs']);

export function validateAutonomyGateContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.sendGates[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(item.value, path, FIELDS, issues);
		validateId(item.value, path, ids, issues);
		validateLabel(item.value, path, issues);
		validateModule(item.value, path, issues);
		validateTimeout(item.value, path, issues);
	}
}

function validateId(
	gate: Record<string, unknown>,
	path: string,
	ids: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(gate, 'id', issues, true, path);
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
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates autonomy gate ${id.value}`);
	} else ids.add(id.value);
}

function validateLabel(
	gate: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const label = readDataProperty(gate, 'label', issues, true, path);
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
	gate: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const module = readDataProperty(gate, 'module', issues, true, path);
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

function validateTimeout(
	gate: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const timeout = readDataProperty(gate, 'timeoutMs', issues, true, path);
	if (
		timeout.kind === 'value' &&
		(!Number.isSafeInteger(timeout.value) ||
			(timeout.value as number) < 100 ||
			(timeout.value as number) > PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.timeoutMs`,
			`must be an integer from 100 to ${PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS}`
		);
	}
}
