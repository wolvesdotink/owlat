/**
 * THE FIELDS EVERY CONTRIBUTION BUCKET SHARES.
 *
 * Each `contributes.<bucket>[]` entry is a plain object whose `id` becomes the
 * local half of `plugin.<pluginId>.<localId>`, and most carry a `label` and a
 * static `module` export. Those rules used to be restated in every bucket's
 * validator, and the copies drifted: one bucket accepted `constructor` as an id,
 * two accepted untrimmed labels, and the duplicate-id wording differed. A
 * `*Manifest.ts` file now states only the fields that are its own and calls
 * these for the rest.
 *
 * Internal to the package: nothing here is exported from `./index`.
 */

import { validateDescriptorText } from './fieldDescriptorManifest';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateKnownFields,
} from './manifestValue';
import { isPluginLocalId, MAX_LOCAL_ID_LENGTH, RESERVED_LOCAL_IDS } from './namespacedKind';
import { isSafeStaticExportPath } from './staticExportPath';

const MODULE_FIELDS: ReadonlySet<string> = new Set(['exportPath']);

/**
 * The loop header every bucket shares: skip entries whose read already failed,
 * require a plain object, reject unknown fields, then hand the entry to `visit`.
 */
export function forEachContributionItem(
	items: readonly DataProperty[],
	bucket: string,
	fields: ReadonlySet<string>,
	issues: PluginManifestIssue[],
	visit: (entry: Record<string, unknown>, path: string, index: number) => void
): void {
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const path = `$.contributes.${bucket}[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
			continue;
		}
		validateKnownFields(item.value, path, fields, issues);
		visit(item.value, path, index);
	}
}

/**
 * The entry's required `id`: the local-id grammar, minus the reserved words,
 * unique within its bucket. `noun` names the bucket in the duplicate message.
 */
export function validateContributionLocalId(
	entry: Record<string, unknown>,
	path: string,
	seen: Set<string>,
	noun: string,
	issues: PluginManifestIssue[]
): void {
	const id = readDataProperty(entry, 'id', issues, true, path);
	if (id.kind !== 'value') return;
	if (!isPluginLocalId(id.value) || RESERVED_LOCAL_IDS.has(id.value)) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.id`,
			`must be a non-reserved lowercase kebab-case id of at most ${MAX_LOCAL_ID_LENGTH} characters`
		);
	} else if (seen.has(id.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.id`, `duplicates ${noun} ${id.value}`);
	} else {
		seen.add(id.value);
	}
}

/** The entry's required `label`: trimmed, non-empty, at most `maxLength` characters. */
export function validateContributionLabel(
	entry: Record<string, unknown>,
	path: string,
	maxLength: number,
	issues: PluginManifestIssue[]
): void {
	validateDescriptorText(entry, 'label', path, maxLength, true, issues);
}

/**
 * A module reference: a plain object holding only a safe, statically importable
 * `exportPath`. Takes the already-read value so the top-level `component` shares
 * the rule with every contribution's `module`.
 */
export function validateModuleExportPath(
	value: unknown,
	path: string,
	issues: PluginManifestIssue[]
): void {
	if (!isRecord(value)) {
		addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
		return;
	}
	validateKnownFields(value, path, MODULE_FIELDS, issues);
	const exportPath = readDataProperty(value, 'exportPath', issues, true, path);
	if (
		exportPath.kind === 'value' &&
		(typeof exportPath.value !== 'string' || !isSafeStaticExportPath(exportPath.value))
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.exportPath`,
			'must be a safe relative package export path'
		);
	}
}

/** The required `module` property of `record`, checked by {@link validateModuleExportPath}. */
export function validateContributionModule(
	record: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const module = readDataProperty(record, 'module', issues, true, path);
	if (module.kind === 'value') validateModuleExportPath(module.value, `${path}.module`, issues);
}

/** A required integer property within `[min, max]` — timeouts and intervals. */
export function validateIntegerRange(
	record: Record<string, unknown>,
	field: string,
	path: string,
	min: number,
	max: number,
	issues: PluginManifestIssue[]
): void {
	const property = readDataProperty(record, field, issues, true, path);
	if (
		property.kind === 'value' &&
		(!Number.isSafeInteger(property.value) ||
			(property.value as number) < min ||
			(property.value as number) > max)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.${field}`,
			`must be an integer from ${min} to ${max}`
		);
	}
}
