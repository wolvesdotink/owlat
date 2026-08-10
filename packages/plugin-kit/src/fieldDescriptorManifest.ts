/**
 * THE HALF TWO FIELD VOCABULARIES SHARE.
 *
 * A plugin declares operator-facing fields in two places — the platform's
 * `settingsSchema` (`./settingsSchemaManifest`) and a send transport's credential
 * form (`./sendTransportCredentialsManifest`, the seams plan's D5) — and both are
 * "the same five kinds": `string`, `secret`, `number`, `boolean`, `select`. The
 * bounds a key, a label, a description, a numeric range and a select's options
 * are held to are therefore ONE rule, and it is stated here rather than twice.
 *
 * WHY IT IS EXTRACTED RATHER THAN COPIED. The two validators diverging is not a
 * failure anything catches: raising the label cap for a settings form would leave
 * a credential field refusing the same label with `must be a trimmed string of at
 * most 80 characters`, and every test in either suite would still pass. The
 * coherence rules are worse — a `select` whose `default` names no declared
 * option, or a `number` whose `min` exceeds its `max`, is a form an operator
 * cannot satisfy, and the copy that lacked the check accepted both.
 *
 * WHAT IS *NOT* HERE is each vocabulary's own delta, and that is the point of the
 * split: a settings `secret` names an `envVar` and a settings `string` carries
 * `maxLength`, while a credential field joins its `envVar` to the transport's
 * declared configuration and offers a `placeholder`. Those live with their
 * vocabulary, where the rule that makes them different is written down.
 */

import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateDescriptorSafeArray,
	validateKnownFields,
} from './manifestValue';
import { MAX_SETTINGS_OPTIONS, RESERVED_FIELD_KEYS } from './settingsSchema';

/** A field key is an identifier, not a path: no dots, no dashes, no digits first. */
const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9]*$/;

export const MAX_FIELD_KEY_LENGTH = 64;
export const MAX_FIELD_LABEL_LENGTH = 80;
export const MAX_FIELD_DESCRIPTION_LENGTH = 280;

/** Longest value a `select` option may carry. Labels use the label bound. */
const MAX_OPTION_VALUE_LENGTH = 128;

/**
 * One field's identifier, unique within its form.
 *
 * Reserved keys are refused because both vocabularies index their values by key
 * into a plain object, and `__proto__` there is not a key at all.
 */
export function validateDescriptorKey(
	field: Record<string, unknown>,
	path: string,
	seenKeys: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const key = readDataProperty(field, 'key', issues, true, path);
	if (key.kind !== 'value') return;
	if (
		typeof key.value !== 'string' ||
		key.value.length > MAX_FIELD_KEY_LENGTH ||
		!FIELD_KEY.test(key.value) ||
		RESERVED_FIELD_KEYS.has(key.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.key`,
			`must be a non-reserved alphanumeric identifier of at most ${MAX_FIELD_KEY_LENGTH} characters`
		);
		return;
	}
	if (seenKeys.has(key.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.key`, `duplicates field ${key.value}`);
		return;
	}
	seenKeys.add(key.value);
}

/** A trimmed, non-empty, bounded string property — labels, descriptions, text defaults. */
export function validateDescriptorText(
	field: Record<string, unknown>,
	name: string,
	path: string,
	maxLength: number,
	required: boolean,
	issues: PluginManifestIssue[]
): void {
	const property = readDataProperty(field, name, issues, required, path);
	if (property.kind !== 'value') return;
	if (
		typeof property.value !== 'string' ||
		property.value.trim() !== property.value ||
		property.value.length < 1 ||
		property.value.length > maxLength
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.${name}`,
			`must be a trimmed string of at most ${maxLength} characters`
		);
	}
}

/**
 * The field's `required` flag: `true`/`false` as declared, `false` when absent,
 * and `null` when the manifest wrote something that is not a boolean.
 *
 * THE THREE-VALUED ANSWER EXISTS FOR THE CALLER THAT ACTS ON IT. A credential
 * field's `envVar` is joined to the list its `required` implies, so reading a
 * malformed `required` as `false` would emit a second issue telling the author to
 * move a variable that is already in the right list — advice that makes the
 * manifest wrong if followed. `null` says "you already have the only issue you can
 * act on"; a caller that merely reports discards it.
 */
export function readDescriptorRequired(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): boolean | null {
	const property = readDataProperty(field, 'required', issues, false, path);
	if (property.kind === 'missing') return false;
	if (property.kind !== 'value') return null;
	if (typeof property.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', `${path}.required`, 'must be a boolean');
		return null;
	}
	return property.value;
}

/**
 * A `number` field's `min`, `max` and `default`, INCLUDING their relationship.
 *
 * Each bound being a finite number is shape; `min <= max` and a default inside
 * the range are coherence, and a form failing either cannot be satisfied by the
 * operator it is drawn for — a numeric input whose declared bounds exclude its
 * own preselected value.
 */
export function validateDescriptorNumberField(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const min = readFiniteNumber(field, 'min', path, issues);
	const max = readFiniteNumber(field, 'max', path, issues);
	if (min !== undefined && max !== undefined && min > max) {
		addManifestIssue(issues, 'invalid_type', `${path}.min`, 'must not exceed max');
	}
	const value = readDataProperty(field, 'default', issues, false, path);
	if (value.kind !== 'value') return;
	if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
		addManifestIssue(issues, 'invalid_type', `${path}.default`, 'must be a finite number');
		return;
	}
	if ((min !== undefined && value.value < min) || (max !== undefined && value.value > max)) {
		addManifestIssue(issues, 'invalid_type', `${path}.default`, 'must fall within min and max');
	}
}

function readFiniteNumber(
	field: Record<string, unknown>,
	name: string,
	path: string,
	issues: PluginManifestIssue[]
): number | undefined {
	const property = readDataProperty(field, name, issues, false, path);
	if (property.kind !== 'value') return undefined;
	if (typeof property.value !== 'number' || !Number.isFinite(property.value)) {
		addManifestIssue(issues, 'invalid_type', `${path}.${name}`, 'must be a finite number');
		return undefined;
	}
	return property.value;
}

/** A `boolean` field's `default`. */
export function validateDescriptorBooleanDefault(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const value = readDataProperty(field, 'default', issues, false, path);
	if (value.kind === 'value' && typeof value.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', `${path}.default`, 'must be a boolean');
	}
}

/**
 * A `select` field's options and `default`, INCLUDING their relationship.
 *
 * Two option entries carrying one value make a control whose selection is
 * ambiguous, and a `default` naming no declared option preselects a value the
 * control cannot display — which is then written straight through on submit.
 * Both are refused here so neither vocabulary can accept a form that contradicts
 * itself.
 */
export function validateDescriptorSelectField(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const optionsValue = readDataProperty(field, 'options', issues, true, path);
	if (optionsValue.kind !== 'value') return;
	const items = validateDescriptorSafeArray(optionsValue.value, `${path}.options`, issues);
	if (!items) return;
	if (items.length < 1 || items.length > MAX_SETTINGS_OPTIONS) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.options`,
			`must contain 1 to ${MAX_SETTINGS_OPTIONS} options`
		);
		return;
	}
	const seenValues = new Set<string>();
	for (const [index, item] of items.entries()) {
		validateDescriptorSelectOption(item, `${path}.options[${index}]`, seenValues, issues);
	}
	const value = readDataProperty(field, 'default', issues, false, path);
	if (value.kind !== 'value') return;
	if (typeof value.value !== 'string' || !seenValues.has(value.value)) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.default`,
			'must match a declared option value'
		);
	}
}

function validateDescriptorSelectOption(
	item: DataProperty,
	path: string,
	seenValues: Set<string>,
	issues: PluginManifestIssue[]
): void {
	if (item.kind !== 'value') return;
	if (!isRecord(item.value)) {
		addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
		return;
	}
	validateKnownFields(item.value, path, new Set(['value', 'label']), issues);
	const value = readDataProperty(item.value, 'value', issues, true, path);
	if (value.kind === 'value') {
		if (
			typeof value.value !== 'string' ||
			value.value.length < 1 ||
			value.value.length > MAX_OPTION_VALUE_LENGTH
		) {
			addManifestIssue(
				issues,
				'invalid_format',
				`${path}.value`,
				`must be a string of 1 to ${MAX_OPTION_VALUE_LENGTH} characters`
			);
		} else if (seenValues.has(value.value)) {
			addManifestIssue(issues, 'duplicate', `${path}.value`, `duplicates option ${value.value}`);
		} else {
			seenValues.add(value.value);
		}
	}
	validateDescriptorText(item.value, 'label', path, MAX_FIELD_LABEL_LENGTH, true, issues);
}
