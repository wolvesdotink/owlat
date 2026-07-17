import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateKnownFields,
} from './manifestValue';

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIELDS = new Set(['id', 'description', 'subscribable']);
const RESERVED_LOCAL_IDS = new Set(['constructor', 'prototype', '__proto__']);
const MAX_DESCRIPTION_LENGTH = 140;

export function validateWebhookEventContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.webhookEvents[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(item.value, path, FIELDS, issues);
		validateId(item.value, path, ids, issues);
		validateDescription(item.value, path, issues);
		validateSubscribable(item.value, path, issues);
	}
}

function validateId(
	event: Record<string, unknown>,
	path: string,
	ids: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(event, 'id', issues, true, path);
	if (id.kind !== 'value') return;
	if (
		typeof id.value !== 'string' ||
		id.value.length > 64 ||
		!ID.test(id.value) ||
		RESERVED_LOCAL_IDS.has(id.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.id`,
			'must be a non-reserved lowercase kebab-case id of at most 64 characters'
		);
	} else if (ids.has(id.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates webhook event ${id.value}`);
	} else {
		ids.add(id.value);
	}
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
