/**
 * Manifest-time validation of a bundled send transport's CREDENTIAL FORM (D5).
 *
 * Split from `./sendTransportManifest` the way `./settingsSchemaManifest` is
 * split from the manifest validator it serves, and for the same reason: a field
 * vocabulary's rules are their own body of work, and the transport bucket's own
 * rules (ids, modules, retry delays, capabilities, the webhook) read better
 * without them in between.
 *
 * The types being validated live in `./sendTransportCredentials`.
 */

import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	validateDescriptorSafeArray,
	validateKnownFields,
} from './manifestValue';
import {
	PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS,
	PLUGIN_SEND_TRANSPORT_MAX_CREDENTIAL_FIELDS,
	type PluginSendTransportCredentialFieldKind,
} from './sendTransportCredentials';
// TYPE-ONLY: the module that owns the configuration lists calls into this one,
// so a value import back would close a runtime cycle.
import type { ConfigEnvVarField, DeclaredConfigEnvVars } from './sendTransportManifest';
import { MAX_SETTINGS_OPTIONS, RESERVED_FIELD_KEYS } from './settingsSchema';

const MAX_LABEL_LENGTH = 80;

/**
 * The credential FORM (D5): descriptors, joined to the configuration above.
 *
 * The join is the rule worth enforcing here. Everything else is shape — the
 * field vocabulary is the platform's `settingsSchema` five, validated the same
 * way — but `envVar` is a promise about ANOTHER declaration in the same
 * contribution: a `required: true` field names a variable that gates the
 * transport, any other field names one that refines it. Break the join and the
 * rendered form asks for a variable no send reads, or omits the one that decides
 * whether the transport is configured at all; neither is visible to the operator
 * filling it in.
 *
 * It also means the namespace rule needs no restating: every accepted `envVar`
 * has already passed {@link isPluginSendTransportEnvVar} as a member of one of
 * the two lists.
 */
export function validateCredentialFields(
	transport: Record<string, unknown>,
	path: string,
	declared: DeclaredConfigEnvVars,
	issues: PluginManifestIssue[]
): void {
	const property = readDataProperty(transport, 'credentialFields', issues, false, path);
	if (property.kind !== 'value') return;
	const fieldsPath = `${path}.credentialFields`;
	const items = validateDescriptorSafeArray(property.value, fieldsPath, issues);
	if (!items) return;
	if (items.length > PLUGIN_SEND_TRANSPORT_MAX_CREDENTIAL_FIELDS) {
		addManifestIssue(
			issues,
			'too_many_items',
			fieldsPath,
			`must contain at most ${PLUGIN_SEND_TRANSPORT_MAX_CREDENTIAL_FIELDS} fields`
		);
		return;
	}
	const seenKeys = new Set<string>();
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		validateCredentialField(item.value, `${fieldsPath}[${index}]`, seenKeys, declared, issues);
	}
}

const CREDENTIAL_FIELD_COMMON = new Set([
	'kind',
	'key',
	'label',
	'description',
	'required',
	'envVar',
]);
const CREDENTIAL_FIELD_KIND_EXTRA: Record<
	PluginSendTransportCredentialFieldKind,
	readonly string[]
> = {
	string: ['default', 'placeholder'],
	secret: ['placeholder'],
	number: ['default', 'min', 'max'],
	boolean: ['default'],
	select: ['options', 'default'],
};
const CREDENTIAL_FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9]*$/;
const MAX_CREDENTIAL_KEY_LENGTH = 64;
const MAX_CREDENTIAL_DESCRIPTION_LENGTH = 280;

function validateCredentialField(
	value: unknown,
	path: string,
	seenKeys: Set<string>,
	declared: DeclaredConfigEnvVars,
	issues: PluginManifestIssue[]
): void {
	if (!isRecord(value)) {
		addManifestIssue(issues, 'invalid_type', path, 'must be a plain object');
		return;
	}
	const kind = readDataProperty(value, 'kind', issues, true, path);
	if (kind.kind !== 'value') return;
	if (
		typeof kind.value !== 'string' ||
		!(PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS as readonly string[]).includes(kind.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.kind`,
			`must be one of ${PLUGIN_SEND_TRANSPORT_CREDENTIAL_FIELD_KINDS.join(', ')}`
		);
		return;
	}
	const fieldKind = kind.value as PluginSendTransportCredentialFieldKind;
	validateKnownFields(
		value,
		path,
		new Set([...CREDENTIAL_FIELD_COMMON, ...CREDENTIAL_FIELD_KIND_EXTRA[fieldKind]]),
		issues
	);
	validateCredentialKey(value, path, seenKeys, issues);
	validateCredentialText(value, 'label', path, MAX_LABEL_LENGTH, true, issues);
	validateCredentialText(
		value,
		'description',
		path,
		MAX_CREDENTIAL_DESCRIPTION_LENGTH,
		false,
		issues
	);
	const required = readCredentialRequired(value, path, issues);
	validateCredentialEnvVar(value, path, required, declared, issues);
	validateCredentialKindFields(fieldKind, value, path, issues);
}

function validateCredentialKey(
	field: Record<string, unknown>,
	path: string,
	seenKeys: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const key = readDataProperty(field, 'key', issues, true, path);
	if (key.kind !== 'value') return;
	if (
		typeof key.value !== 'string' ||
		key.value.length > MAX_CREDENTIAL_KEY_LENGTH ||
		!CREDENTIAL_FIELD_KEY.test(key.value) ||
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

function validateCredentialText(
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

/** `true` only when the manifest said so in a well-formed way. */
function readCredentialRequired(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): boolean {
	const property = readDataProperty(field, 'required', issues, false, path);
	if (property.kind !== 'value') return false;
	if (typeof property.value !== 'boolean') {
		addManifestIssue(issues, 'invalid_type', `${path}.required`, 'must be a boolean');
		return false;
	}
	return property.value;
}

function validateCredentialEnvVar(
	field: Record<string, unknown>,
	path: string,
	required: boolean,
	declared: DeclaredConfigEnvVars,
	issues: PluginManifestIssue[]
): void {
	const envVar = readDataProperty(field, 'envVar', issues, true, path);
	if (envVar.kind !== 'value') return;
	const list: ConfigEnvVarField = required ? 'requiredEnvVars' : 'optionalEnvVars';
	if (typeof envVar.value !== 'string' || !declared[list].has(envVar.value)) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.envVar`,
			`must name one of this transport's ${list}`
		);
	}
}

function validateCredentialKindFields(
	fieldKind: PluginSendTransportCredentialFieldKind,
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	if (fieldKind === 'string' || fieldKind === 'secret') {
		validateCredentialText(field, 'placeholder', path, MAX_LABEL_LENGTH, false, issues);
		if (fieldKind === 'string') {
			validateCredentialText(field, 'default', path, MAX_LABEL_LENGTH, false, issues);
		}
		return;
	}
	if (fieldKind === 'number') {
		for (const name of ['default', 'min', 'max'] as const) {
			const property = readDataProperty(field, name, issues, false, path);
			if (property.kind !== 'value') continue;
			if (typeof property.value !== 'number' || !Number.isFinite(property.value)) {
				addManifestIssue(issues, 'invalid_type', `${path}.${name}`, 'must be a finite number');
			}
		}
		return;
	}
	if (fieldKind === 'boolean') {
		const property = readDataProperty(field, 'default', issues, false, path);
		if (property.kind === 'value' && typeof property.value !== 'boolean') {
			addManifestIssue(issues, 'invalid_type', `${path}.default`, 'must be a boolean');
		}
		return;
	}
	validateCredentialOptions(field, path, issues);
	validateCredentialText(field, 'default', path, MAX_LABEL_LENGTH, false, issues);
}

function validateCredentialOptions(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const options = readDataProperty(field, 'options', issues, true, path);
	if (options.kind !== 'value') return;
	const items = validateDescriptorSafeArray(options.value, `${path}.options`, issues);
	if (!items) return;
	if (items.length < 1 || items.length > MAX_SETTINGS_OPTIONS) {
		addManifestIssue(
			issues,
			'too_many_items',
			`${path}.options`,
			`must contain between 1 and ${MAX_SETTINGS_OPTIONS} options`
		);
		return;
	}
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		const optionPath = `${path}.options[${index}]`;
		if (!isRecord(item.value)) {
			addManifestIssue(issues, 'invalid_type', optionPath, 'must be a plain object');
			continue;
		}
		validateKnownFields(item.value, optionPath, new Set(['value', 'label']), issues);
		validateCredentialText(item.value, 'value', optionPath, MAX_LABEL_LENGTH, true, issues);
		validateCredentialText(item.value, 'label', optionPath, MAX_LABEL_LENGTH, true, issues);
	}
}
