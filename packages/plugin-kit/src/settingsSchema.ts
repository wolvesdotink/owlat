import type { JsonPrimitive, JsonValue } from './json';
import { isRecord } from './manifestValue';

/**
 * Declarative settings schema a plugin exposes so the host can render a generic
 * operator settings form — capabilities and grants aside — without shipping any
 * custom UI or arbitrary client code. Every field is a plain data descriptor;
 * the host validates operator input against it and redacts secret values so they
 * never round-trip to the browser.
 *
 * Manifest-time validation of a schema lives in `./settingsSchemaManifest`; this
 * module owns the types plus the host/client-safe runtime helpers that operate on
 * an already-validated schema.
 */
export type PluginSettingsFieldKind = 'string' | 'secret' | 'number' | 'boolean' | 'select';

interface PluginSettingsFieldCommon {
	readonly key: string;
	readonly label: string;
	readonly description?: string;
	readonly required?: boolean;
}

/** A single-line free-text value. */
export interface PluginSettingsStringField extends PluginSettingsFieldCommon {
	readonly kind: 'string';
	readonly default?: string;
	readonly maxLength?: number;
}

/**
 * A sensitive credential. Secrets carry no compiled-in default, are stored only
 * server-side, and are never returned to the client — the overview reports only
 * whether one is set.
 */
export interface PluginSettingsSecretField extends PluginSettingsFieldCommon {
	readonly kind: 'secret';
	readonly maxLength?: number;
}

export interface PluginSettingsNumberField extends PluginSettingsFieldCommon {
	readonly kind: 'number';
	readonly default?: number;
	readonly min?: number;
	readonly max?: number;
}

export interface PluginSettingsBooleanField extends PluginSettingsFieldCommon {
	readonly kind: 'boolean';
	readonly default?: boolean;
}

export interface PluginSettingsSelectOption {
	readonly value: string;
	readonly label: string;
}

export interface PluginSettingsSelectField extends PluginSettingsFieldCommon {
	readonly kind: 'select';
	readonly options: readonly PluginSettingsSelectOption[];
	readonly default?: string;
}

export type PluginSettingsField =
	| PluginSettingsStringField
	| PluginSettingsSecretField
	| PluginSettingsNumberField
	| PluginSettingsBooleanField
	| PluginSettingsSelectField;

export type PluginSettingsSchema = readonly PluginSettingsField[];

export const SETTINGS_FIELD_KINDS: readonly PluginSettingsFieldKind[] = [
	'string',
	'secret',
	'number',
	'boolean',
	'select',
];

/** Field keys that would collide with object internals; rejected everywhere. */
export const RESERVED_FIELD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Upper bound on any text/secret field's length, shared by both validators. */
export const MAX_TEXT_LENGTH = 8_192;

// ─── Runtime helpers (host + client safe; operate on validated schemas) ──────

/** Whether a field holds a sensitive value that must never reach the client. */
export function isSecretSettingsField(field: PluginSettingsField): boolean {
	return field.kind === 'secret';
}

/**
 * The compiled-in defaults for a schema, keyed by field. Secret fields never
 * carry a default, and fields without one are omitted.
 */
export function defaultPluginSettingsValues(
	schema: PluginSettingsSchema
): Record<string, JsonValue> {
	const defaults: Record<string, JsonValue> = {};
	for (const field of schema) {
		if (field.kind === 'secret') continue;
		if (field.default !== undefined) defaults[field.key] = field.default;
	}
	return defaults;
}

export interface RedactedPluginSettings {
	/** Every non-secret value known for the plugin. Secret plaintext is dropped. */
	readonly values: Record<string, JsonValue>;
	/** For each secret field, whether a value is currently stored. */
	readonly secretsSet: Record<string, boolean>;
}

/**
 * Split stored settings into the safe subset the client may see and a per-secret
 * "is it set" map. Secret plaintext is never included in the result, so a leak
 * of the redacted object cannot expose a credential.
 */
export function redactPluginSettingsValues(
	schema: PluginSettingsSchema,
	stored: Readonly<Record<string, JsonValue>>
): RedactedPluginSettings {
	const values: Record<string, JsonValue> = {};
	const secretsSet: Record<string, boolean> = {};
	for (const field of schema) {
		const has = Object.prototype.hasOwnProperty.call(stored, field.key);
		if (field.kind === 'secret') {
			secretsSet[field.key] =
				has && typeof stored[field.key] === 'string' && stored[field.key] !== '';
			continue;
		}
		if (has) values[field.key] = stored[field.key] as JsonValue;
		else if (field.default !== undefined) values[field.key] = field.default;
	}
	return { values, secretsSet };
}

export interface PluginSettingsInputIssue {
	readonly key: string;
	readonly message: string;
}

export type PluginSettingsInputValidation =
	| { readonly ok: true; readonly values: Record<string, JsonPrimitive> }
	| { readonly ok: false; readonly issues: readonly PluginSettingsInputIssue[] };

/**
 * Validate a partial operator update against the schema. Only supplied keys are
 * checked (an omitted secret keeps the stored one); unknown keys, wrong types,
 * out-of-range numbers, unlisted select values, and empty secrets are rejected.
 */
export function validatePluginSettingsInput(
	schema: PluginSettingsSchema,
	input: unknown
): PluginSettingsInputValidation {
	const issues: PluginSettingsInputIssue[] = [];
	if (!isRecord(input)) {
		return { ok: false, issues: [{ key: '$', message: 'must be a plain object' }] };
	}
	const byKey = new Map(schema.map((field) => [field.key, field]));
	const values: Record<string, JsonPrimitive> = {};
	for (const key of Object.keys(input)) {
		const field = byKey.get(key);
		if (!field || RESERVED_FIELD_KEYS.has(key)) {
			issues.push({ key, message: 'is not a known setting' });
			continue;
		}
		const raw = input[key];
		const checked = checkFieldValue(field, raw, issues);
		if (checked !== undefined) values[key] = checked;
	}
	return issues.length === 0 ? { ok: true, values } : { ok: false, issues };
}

function checkFieldValue(
	field: PluginSettingsField,
	raw: unknown,
	issues: PluginSettingsInputIssue[]
): JsonPrimitive | undefined {
	switch (field.kind) {
		case 'string':
		case 'secret': {
			if (typeof raw !== 'string') {
				issues.push({ key: field.key, message: 'must be a string' });
				return undefined;
			}
			if (field.kind === 'secret' && raw === '') {
				issues.push({ key: field.key, message: 'must not be empty' });
				return undefined;
			}
			const max = field.maxLength ?? MAX_TEXT_LENGTH;
			if (raw.length > max) {
				issues.push({ key: field.key, message: `must be at most ${max} characters` });
				return undefined;
			}
			return raw;
		}
		case 'number': {
			if (typeof raw !== 'number' || !Number.isFinite(raw)) {
				issues.push({ key: field.key, message: 'must be a finite number' });
				return undefined;
			}
			if (
				(field.min !== undefined && raw < field.min) ||
				(field.max !== undefined && raw > field.max)
			) {
				issues.push({ key: field.key, message: 'is out of range' });
				return undefined;
			}
			return raw;
		}
		case 'boolean': {
			if (typeof raw !== 'boolean') {
				issues.push({ key: field.key, message: 'must be a boolean' });
				return undefined;
			}
			return raw;
		}
		case 'select': {
			if (typeof raw !== 'string' || !field.options.some((option) => option.value === raw)) {
				issues.push({ key: field.key, message: 'must match a declared option' });
				return undefined;
			}
			return raw;
		}
	}
}
