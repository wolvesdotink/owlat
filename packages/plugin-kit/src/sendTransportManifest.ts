import { isPluginLocalId } from './namespacedKind';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateDescriptorSafeArray,
	validateKnownFields,
} from './manifestValue';
import { isSafeStaticExportPath } from './staticExportPath';

const RESERVED_LOCAL_IDS = new Set(['constructor', 'prototype', '__proto__']);
const MAX_LABEL_LENGTH = 80;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_TOTAL_DELAY_MS = 120_000;

export function validateSendTransportContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const seenIds = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.sendTransports[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(
			item.value,
			path,
			new Set(['id', 'label', 'module', 'retryDelays']),
			issues
		);
		validateId(item.value, path, seenIds, issues);
		validateLabel(item.value, path, issues);
		validateModule(item.value, path, issues);
		validateRetryDelays(item.value, path, issues);
	}
}

function validateId(
	transport: Record<string, unknown>,
	path: string,
	seenIds: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(transport, 'id', issues, true, path);
	if (id.kind !== 'value') return;
	if (
		typeof id.value !== 'string' ||
		!isPluginLocalId(id.value) ||
		RESERVED_LOCAL_IDS.has(id.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.id`,
			'must be a non-reserved lowercase kebab-case id of at most 64 characters'
		);
	} else if (seenIds.has(id.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates transport ${id.value}`);
	} else {
		seenIds.add(id.value);
	}
}

function validateLabel(
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const label = readDataProperty(transport, 'label', issues, true, path);
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
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const module = readDataProperty(transport, 'module', issues, true, path);
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

function validateRetryDelays(
	transport: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const retryDelays = readDataProperty(transport, 'retryDelays', issues, true, path);
	if (retryDelays.kind !== 'value') return;
	const items = validateDescriptorSafeArray(retryDelays.value, `${path}.retryDelays`, issues);
	if (!items) return;
	if (items.length > MAX_RETRIES) {
		addManifestIssue(
			issues,
			'too_many_items',
			`${path}.retryDelays`,
			`must contain at most ${MAX_RETRIES} delays`
		);
		return;
	}
	let total = 0;
	for (const [index, item] of items.entries()) {
		if (
			item.kind !== 'value' ||
			!Number.isSafeInteger(item.value) ||
			(item.value as number) < 0 ||
			(item.value as number) > MAX_RETRY_DELAY_MS
		) {
			if (item.kind === 'value') {
				addManifestIssue(
					issues,
					'invalid_type',
					`${path}.retryDelays[${index}]`,
					`must be an integer from 0 to ${MAX_RETRY_DELAY_MS}`
				);
			}
			continue;
		}
		total += item.value as number;
	}
	if (total > MAX_TOTAL_DELAY_MS) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.retryDelays`,
			`must total at most ${MAX_TOTAL_DELAY_MS} milliseconds`
		);
	}
}
