import {
	MAX_FIELD_DESCRIPTION_LENGTH,
	MAX_FIELD_LABEL_LENGTH,
	readDescriptorRequired,
	validateDescriptorBooleanDefault,
	validateDescriptorKey,
	validateDescriptorNumberField,
	validateDescriptorSelectField,
	validateDescriptorText,
} from './fieldDescriptorManifest';
import { isPluginSecretEnvVar } from './inboundSignature';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import {
	isRecord,
	readDataProperty,
	type DataProperty,
	validateDescriptorSafeArray,
	validateKnownFields,
} from './manifestValue';
import {
	MAX_SETTINGS_FIELDS,
	MAX_TEXT_LENGTH,
	SETTINGS_FIELD_KINDS,
	type PluginSettingsFieldKind,
} from './settingsSchema';

/**
 * Manifest-time validation of the optional `settingsSchema` top-level field.
 *
 * The five kinds' SHARED rules — key, label, description, `required`, numeric
 * range, select options — live in `./fieldDescriptorManifest`, because a send
 * transport's credential form is the same five and the two must not drift. What
 * stays here is this vocabulary's own delta: a `secret` names an environment
 * variable instead of holding a value, and a `string` carries `maxLength`.
 */
const COMMON_FIELDS = new Set(['kind', 'key', 'label', 'description', 'required']);
const KIND_EXTRA_FIELDS: Record<PluginSettingsFieldKind, readonly string[]> = {
	string: ['default', 'maxLength'],
	secret: ['envVar'],
	number: ['default', 'min', 'max'],
	boolean: ['default'],
	select: ['options', 'default'],
};

export function validateSettingsSchema(value: unknown, issues: PluginManifestIssue[]): void {
	if (value === undefined) return;
	const items = validateDescriptorSafeArray(value, '$.settingsSchema', issues);
	if (!items) return;
	if (items.length > MAX_SETTINGS_FIELDS) {
		addManifestIssue(
			issues,
			'too_many_items',
			'$.settingsSchema',
			`must contain at most ${MAX_SETTINGS_FIELDS} fields`
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

	validateDescriptorKey(item.value, path, seenKeys, issues);
	validateDescriptorText(item.value, 'label', path, MAX_FIELD_LABEL_LENGTH, true, issues);
	validateDescriptorText(
		item.value,
		'description',
		path,
		MAX_FIELD_DESCRIPTION_LENGTH,
		false,
		issues
	);
	// The tri-state answer is for the credential form, which JOINS `envVar` to the
	// list `required` implies. A settings field has nothing to join, so reporting
	// a malformed value is all this vocabulary needs.
	readDescriptorRequired(item.value, path, issues);
	validateKindSpecific(fieldKind, item.value, path, issues);
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
			validateSecretEnvVar(field, path, issues);
			return;
		case 'number':
			validateDescriptorNumberField(field, path, issues);
			return;
		case 'boolean':
			validateDescriptorBooleanDefault(field, path, issues);
			return;
		case 'select':
			validateDescriptorSelectField(field, path, issues);
			return;
	}
}

/**
 * A `secret` field stores nothing: it names the deployment environment variable
 * that supplies the credential. The name must be `PLUGIN_`-prefixed so a plugin
 * can only ever point at a plugin-scoped variable and never at a core deployment
 * secret — the same fence, through the same predicate, that an inbound signature
 * contract's `secretEnvVar` passes, because it is the same rule about the same
 * namespace and the host reads the VALUE in both cases.
 */
function validateSecretEnvVar(
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const envVar = readDataProperty(field, 'envVar', issues, true, path);
	if (envVar.kind !== 'value') return;
	if (!isPluginSecretEnvVar(envVar.value)) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.envVar`,
			'must be a PLUGIN_-prefixed uppercase environment variable name'
		);
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
		return;
	}
	// Mirror validateDescriptorNumberField's min/max default check: the default
	// must also satisfy the field's own declared maxLength (already validated by
	// validateMaxLength), otherwise the field ships a default that its own
	// `:maxlength` input constraint and any re-save could never reproduce.
	const maxLength = readDataProperty(field, 'maxLength', issues, false, path);
	if (
		maxLength.kind === 'value' &&
		typeof maxLength.value === 'number' &&
		Number.isSafeInteger(maxLength.value) &&
		value.value.length > maxLength.value
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.default`,
			`must be at most ${maxLength.value} characters (the field's maxLength)`
		);
	}
}
