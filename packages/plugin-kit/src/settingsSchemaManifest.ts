import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateDescriptorSafeArray,
	validateKnownFields,
} from './manifestValue';
import {
	MAX_TEXT_LENGTH,
	RESERVED_FIELD_KEYS,
	SETTINGS_FIELD_KINDS,
	type PluginSettingsFieldKind,
} from './settingsSchema';

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9]*$/;
const MAX_FIELDS = 64;
const MAX_KEY_LENGTH = 64;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 280;
const MAX_OPTIONS = 64;

const COMMON_FIELDS = new Set(['kind', 'key', 'label', 'description', 'required']);
const KIND_EXTRA_FIELDS: Record<PluginSettingsFieldKind, readonly string[]> = {
	string: ['default', 'maxLength'],
	secret: ['maxLength'],
	number: ['default', 'min', 'max'],
	boolean: ['default'],
	select: ['options', 'default'],
};

/** Manifest-time validation of the optional `settingsSchema` top-level field. */
export function validateSettingsSchema(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	const items = validateDescriptorSafeArray(value, '$.settingsSchema', issues);
	if (!items) return;
	if (items.length > MAX_FIELDS) {
		addManifestIssue(
			issues,
			'too_many_items',
			'$.settingsSchema',
			`must contain at most ${MAX_FIELDS} fields`
		);
		return;
	}
	const seenKeys = new Set<string>();
	for (const [index, item] of items.entries()) {
		validateField(item, index, seenKeys, issues);
	}
}

function validateField(
	item: DataProperty,
	index: number,
	seenKeys: Set<string>,
	issues: PluginManifestIssue[]
): void {
	if (item.kind !== 'value') return;
	const path = `$.settingsSchema[${index}]`;
	if (!isRecord(item.value)) {
		addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
		return;
	}

	const kind = readDataProperty(item.value, 'kind', issues, true, path);
	if (kind.kind !== 'value') return;
	if (
		typeof kind.value !== 'string' ||
		!SETTINGS_FIELD_KINDS.includes(kind.value as PluginSettingsFieldKind)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.kind`,
			`must be one of ${SETTINGS_FIELD_KINDS.join(', ')}`
		);
		return;
	}
	const fieldKind = kind.value as PluginSettingsFieldKind;

	validateKnownFields(
		item.value,
		path,
		new Set([...COMMON_FIELDS, ...KIND_EXTRA_FIELDS[fieldKind]]),
		issues
	);

	validateKey(item.value, path, seenKeys, issues);
	validateBoundedString(item.value, 'label', path, MAX_LABEL_LENGTH, true, issues);
	validateBoundedString(item.value, 'description', path, MAX_DESCRIPTION_LENGTH, false, issues);
	validateRequired(item.value, path, issues);
	validateKindSpecific(fieldKind, item.value, path, issues);
}

function validateKey(
	field: Record<string, unknown>,
	path: string,
	seenKeys: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const key = readDataProperty(field, 'key', issues, true, path);
	if (key.kind !== 'value') return;
	if (
		typeof key.value !== 'string' ||
		key.value.length > MAX_KEY_LENGTH ||
		!FIELD_KEY.test(key.value) ||
		RESERVED_FIELD_KEYS.has(key.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.key`,
			'must be a non-reserved alphanumeric identifier of at most 64 characters'
		);
		return;
	}
	if (seenKeys.has(key.value)) {
		addManifestIssue(issues, 'duplicate', `${path}.key`, `duplicates field ${key.value}`);
		return;
	}
	seenKeys.add(key.value);
}

function validateBoundedString(
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

function validateRequired(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const required = readDataProperty(field, 'required', issues, false, path);
	if (required.kind === 'value' && typeof required.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', `${path}.required`, 'must be a boolean');
	}
}

function validateKindSpecific(
	kind: PluginSettingsFieldKind,
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	switch (kind) {
		case 'string':
			validateMaxLength(field, path, issues);
			validateStringDefault(field, path, issues);
			return;
		case 'secret':
			validateMaxLength(field, path, issues);
			return;
		case 'number':
			validateNumberField(field, path, issues);
			return;
		case 'boolean':
			validateBooleanDefault(field, path, issues);
			return;
		case 'select':
			validateSelectField(field, path, issues);
			return;
	}
}

function validateMaxLength(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const maxLength = readDataProperty(field, 'maxLength', issues, false, path);
	if (maxLength.kind !== 'value') return;
	if (
		!Number.isSafeInteger(maxLength.value) ||
		(maxLength.value as number) < 1 ||
		(maxLength.value as number) > MAX_TEXT_LENGTH
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.maxLength`,
			`must be an integer from 1 to ${MAX_TEXT_LENGTH}`
		);
	}
}

function validateStringDefault(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const value = readDataProperty(field, 'default', issues, false, path);
	if (value.kind !== 'value') return;
	if (typeof value.value !== 'string' || value.value.length > MAX_TEXT_LENGTH) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.default`,
			`must be a string of at most ${MAX_TEXT_LENGTH} characters`
		);
	}
}

function validateNumberField(
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

function validateBooleanDefault(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const value = readDataProperty(field, 'default', issues, false, path);
	if (value.kind === 'value' && typeof value.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', `${path}.default`, 'must be a boolean');
	}
}

function validateSelectField(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const optionsValue = readDataProperty(field, 'options', issues, true, path);
	if (optionsValue.kind !== 'value') return;
	const items = validateDescriptorSafeArray(optionsValue.value, `${path}.options`, issues);
	if (!items) return;
	if (items.length < 1 || items.length > MAX_OPTIONS) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.options`,
			`must contain 1 to ${MAX_OPTIONS} options`
		);
		return;
	}
	const seenValues = new Set<string>();
	for (const [index, item] of items.entries()) {
		validateSelectOption(item, `${path}.options[${index}]`, seenValues, issues);
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

function validateSelectOption(
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
		if (typeof value.value !== 'string' || value.value.length < 1 || value.value.length > 128) {
			addManifestIssue(
				issues,
				'invalid_format',
				`${path}.value`,
				'must be a string of 1 to 128 characters'
			);
		} else if (seenValues.has(value.value)) {
			addManifestIssue(issues, 'duplicate', `${path}.value`, `duplicates option ${value.value}`);
		} else {
			seenValues.add(value.value);
		}
	}
	validateBoundedString(item.value, 'label', path, MAX_LABEL_LENGTH, true, issues);
}
