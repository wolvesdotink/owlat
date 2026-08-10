/**
 * Manifest-time validation of a bundled send transport's CREDENTIAL FORM (D5).
 *
 * Split from `./sendTransportManifest` the way `./settingsSchemaManifest` is
 * split from the manifest validator it serves, and for the same reason: a field
 * vocabulary's rules are their own body of work, and the transport bucket's own
 * rules (ids, modules, retry delays, capabilities, the webhook) read better
 * without them in between.
 *
 * The types being validated live in `./sendTransportCredentials`. The five kinds'
 * SHARED rules — key, label, description, `required`, numeric range, select
 * options — live in `./fieldDescriptorManifest`, because they are the platform's
 * `settingsSchema` five and "validated the same way" has to be true of the code
 * and not only of the sentence.
 */

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

/**
 * The credential FORM (D5): descriptors, joined to the configuration above.
 *
 * The join is the rule this module owns. The rest of a field is the platform's
 * `settingsSchema` vocabulary, validated through the same functions it is — but
 * `envVar` is a promise about ANOTHER declaration in the same contribution: a
 * `required: true` field names a variable that gates the transport, any other
 * field names one that refines it. Break the join and the rendered form asks for
 * a variable no send reads, or omits the one that decides whether the transport
 * is configured at all; neither is visible to the operator filling it in.
 *
 * It also means the namespace rule needs no restating: every accepted `envVar`
 * has already passed {@link isPluginSendTransportEnvVar} as a member of one of
 * the two lists.
 *
 * ONE VARIABLE, ONE FIELD. `envVar` is deduplicated across the form as well as
 * `key`, because the mirror of "a field no send reads" is two fields writing one
 * variable: a setup surface renders both, and whichever is applied last silently
 * discards the other entry.
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
	const seen: CredentialFormIdentities = { keys: new Set(), envVars: new Set() };
	for (const [index, item] of items.entries()) {
		if (item.kind !== 'value') continue;
		validateCredentialField(item.value, `${fieldsPath}[${index}]`, seen, declared, issues);
	}
}

/** What must be unique across one transport's form: the id, and the write target. */
interface CredentialFormIdentities {
	readonly keys: Set<string>;
	readonly envVars: Set<string>;
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

function validateCredentialField(
	value: unknown,
	path: string,
	seen: CredentialFormIdentities,
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
	validateDescriptorKey(value, path, seen.keys, issues);
	validateDescriptorText(value, 'label', path, MAX_FIELD_LABEL_LENGTH, true, issues);
	validateDescriptorText(value, 'description', path, MAX_FIELD_DESCRIPTION_LENGTH, false, issues);
	const required = readDescriptorRequired(value, path, issues);
	validateCredentialEnvVar(value, path, required, declared, seen.envVars, issues);
	validateCredentialKindFields(fieldKind, value, path, issues);
}

/**
 * The join, plus the uniqueness of the write target.
 *
 * `required` ARRIVES TRI-STATE and a `null` suppresses the join. Reading a
 * malformed `required` as `false` would report a second issue — "envVar must name
 * one of this transport's optionalEnvVars" — about a variable that may already be
 * in `requiredEnvVars`, so an author who followed it would move a correct
 * declaration into the wrong list. The one issue they can act on is the boolean.
 */
function validateCredentialEnvVar(
	field: Record<string, unknown>,
	path: string,
	required: boolean | null,
	declared: DeclaredConfigEnvVars,
	seenEnvVars: Set<string>,
	issues: PluginManifestIssue[]
): void {
	const envVar = readDataProperty(field, 'envVar', issues, true, path);
	if (envVar.kind !== 'value') return;
	if (typeof envVar.value !== 'string') {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.envVar`,
			"must be a string naming one of this transport's declared variables"
		);
		return;
	}
	if (seenEnvVars.has(envVar.value)) {
		addManifestIssue(
			issues,
			'duplicate',
			`${path}.envVar`,
			`duplicates the variable ${envVar.value}, which another field already writes`
		);
		return;
	}
	seenEnvVars.add(envVar.value);
	if (required === null) return;
	const list: ConfigEnvVarField = required ? 'requiredEnvVars' : 'optionalEnvVars';
	if (!declared[list].has(envVar.value)) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.envVar`,
			`must name one of this transport's ${list}`
		);
	}
}

/**
 * The per-kind extras. Three of the five are the settings vocabulary's own
 * validators verbatim — a `number`'s range and a `select`'s options carry
 * coherence rules (`min <= max`, a default inside the range, no duplicate option
 * value, a default that names a declared option) that an operator-facing form has
 * to satisfy whichever bucket declared it.
 *
 * WHAT IS THIS VOCABULARY'S OWN: `placeholder`, which a settings field has no
 * concept of, and a `string` default bounded like a label rather than like a body
 * of text — this is a deployment variable's value, not free-form prose.
 */
function validateCredentialKindFields(
	fieldKind: PluginSendTransportCredentialFieldKind,
	field: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	switch (fieldKind) {
		case 'secret':
			validateDescriptorText(field, 'placeholder', path, MAX_FIELD_LABEL_LENGTH, false, issues);
			return;
		case 'string':
			validateDescriptorText(field, 'placeholder', path, MAX_FIELD_LABEL_LENGTH, false, issues);
			validateDescriptorText(field, 'default', path, MAX_FIELD_LABEL_LENGTH, false, issues);
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
