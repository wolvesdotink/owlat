/**
 * Pure helpers for the schema-rendered plugin settings UX. The settings form is
 * driven entirely from a plugin's `settingsSchema` (from the bundled-plugin
 * composition) joined with the server's redacted state (non-secret values plus a
 * per-secret "is set" flag). Keeping this logic pure keeps the pages SSR-safe and
 * lets the form/redaction behaviour be tested without mounting a component.
 *
 * Secret handling: a secret field's input starts blank and a blank value is
 * never submitted, so a stored secret is kept unless the operator types a
 * replacement — the client mirror of the server never returning secret plaintext.
 */
import type { PluginSettingsField, PluginSettingsSchema } from '@owlat/plugin-kit';

export type PluginSettingsFormValue = string | number | boolean;
export type PluginSettingsForm = Record<string, PluginSettingsFormValue>;

export interface PluginSettingsRedactedState {
	/**
	 * Non-secret values known to the server (defaults already merged). Typed as
	 * `unknown` because it arrives from the wire; `baselineFieldValue` narrows each
	 * value with a `typeof` guard against the field's declared kind.
	 */
	readonly values: Readonly<Record<string, unknown>>;
	/** Whether each secret field currently has a stored value. */
	readonly secretsSet: Readonly<Record<string, boolean>>;
}

/** The initial (and change-detection baseline) form value for one field. */
export function baselineFieldValue(
	field: PluginSettingsField,
	state: PluginSettingsRedactedState
): PluginSettingsFormValue {
	// Secrets always start blank — the stored value is never sent to the client.
	if (field.kind === 'secret') return '';
	const stored = state.values[field.key];
	switch (field.kind) {
		case 'boolean':
			return typeof stored === 'boolean' ? stored : (field.default ?? false);
		case 'number':
			// Unset with no default ⇒ '' (an empty input), never a fabricated min/0
			// the server never stored — the display must mirror the effective state.
			return typeof stored === 'number' ? stored : (field.default ?? '');
		case 'select':
			// Only a stored value still present in the current options is honoured. A
			// value dropped from `options` in a newer plugin version is treated as
			// unset ⇒ '' (the disabled "Select…" placeholder) or the field default, so
			// a choice the plugin can no longer act on is never shown as configured (it
			// is also then flagged by missingRequiredPluginSettings). Unset with no
			// default ⇒ '', not the first option pretending to be a configured choice.
			return typeof stored === 'string' && field.options.some((option) => option.value === stored)
				? stored
				: (field.default ?? '');
		case 'string':
			return typeof stored === 'string' ? stored : (field.default ?? '');
	}
}

/** The full baseline form for a schema, used to seed inputs and detect changes. */
export function pluginSettingsBaseline(
	schema: PluginSettingsSchema,
	state: PluginSettingsRedactedState
): PluginSettingsForm {
	const form: PluginSettingsForm = {};
	for (const field of schema) form[field.key] = baselineFieldValue(field, state);
	return form;
}

/**
 * The changed subset to submit: any field whose current form value differs from
 * the baseline. Because secret baselines are blank, a blank secret is a no-op
 * (keeps the stored value) and only a typed replacement is sent.
 */
export function pluginSettingsChanges(
	schema: PluginSettingsSchema,
	form: Readonly<PluginSettingsForm>,
	baseline: Readonly<PluginSettingsForm>
): Record<string, PluginSettingsFormValue> {
	const changes: Record<string, PluginSettingsFormValue> = {};
	for (const field of schema) {
		const next = form[field.key];
		if (next === undefined) continue;
		if (field.kind === 'secret') {
			// Only a non-empty secret is a change; blank keeps the stored value.
			if (typeof next === 'string' && next !== '') changes[field.key] = next;
			continue;
		}
		// A blanked number input emits '' (see PluginSettingsField.onNumber). Never
		// submit it: the server would reject the whole save with "must be a finite
		// number", so treat a cleared number as "unchanged" — the stored value
		// (or absence) is kept. Required-empty is caught by missingRequiredPluginSettings.
		if (field.kind === 'number' && next === '') continue;
		if (next !== baseline[field.key]) changes[field.key] = next;
	}
	return changes;
}

/** Whether the form differs from its baseline (drives the Save button state). */
export function hasPluginSettingsChanges(
	schema: PluginSettingsSchema,
	form: Readonly<PluginSettingsForm>,
	baseline: Readonly<PluginSettingsForm>
): boolean {
	return Object.keys(pluginSettingsChanges(schema, form, baseline)).length > 0;
}

/** A client-side required-field check for immediate feedback before submitting. */
export function missingRequiredPluginSettings(
	schema: PluginSettingsSchema,
	form: Readonly<PluginSettingsForm>,
	state: PluginSettingsRedactedState
): readonly string[] {
	const missing: string[] = [];
	for (const field of schema) {
		if (!field.required) continue;
		if (field.kind === 'secret') {
			// Satisfied by an existing stored secret or a freshly typed one.
			const typed = form[field.key];
			if (state.secretsSet[field.key] === true) continue;
			if (typeof typed === 'string' && typed !== '') continue;
			missing.push(field.key);
			continue;
		}
		// An unset number or select now baselines to '' (see baselineFieldValue),
		// so an empty-string form value flags a required string, number, or select
		// that has no effective value. A set number is a `number` and never matches.
		const value = form[field.key];
		if (typeof value === 'string' && value.trim() === '') missing.push(field.key);
	}
	return missing;
}
