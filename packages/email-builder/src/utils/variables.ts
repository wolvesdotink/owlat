import { escapeHtml } from '@owlat/shared/html';
import {
	containsTemplateVariable,
	extractTemplateVariableNames,
	replaceTemplateVariables,
} from '@owlat/shared/templateVariables';

/**
 * Variable detection utilities for template variables (e.g., {{variableName}}).
 *
 * The GRAMMAR lives in `@owlat/shared/templateVariables` — one definition
 * shared with the send path's personalization pass and the Postbox composer's
 * snippets, rather than a regex copied per call site. What stays here is this
 * surface's POLICY: what a token becomes when nobody supplied a value.
 */

/** Check if a string contains one or more template variables */
export function containsVariable(value: string | undefined | null): boolean {
	return containsTemplateVariable(value);
}

/** Extract the variable name from a simple {{variableName}} string */
export function extractVariableName(value: string | undefined | null): string | null {
	return extractTemplateVariableNames(value)[0] ?? null;
}

/** Extract all variable names from a string */
export function extractVariableNames(value: string | undefined | null): string[] {
	return extractTemplateVariableNames(value);
}

/**
 * Realistic sample values for common contact fields, keyed by the variable
 * name normalized to lowercase alphanumerics (so `firstName`, `first_name`,
 * and `FIRST-NAME` all resolve to the same sample).
 */
const SAMPLE_VALUES: Record<string, string> = {
	firstname: 'Alex',
	lastname: 'Smith',
	name: 'Alex Smith',
	fullname: 'Alex Smith',
	email: 'alex@example.com',
	emailaddress: 'alex@example.com',
	company: 'Acme Inc.',
	companyname: 'Acme Inc.',
	phone: '+1 555 0100',
	phonenumber: '+1 555 0100',
};

/** `first_name` / `firstName` → "First name" */
function humanizeVariableKey(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
	if (words.length === 0) return key;
	const sentence = words.join(' ');
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export interface FillPreviewVariablesOptions {
	/** User-provided values (from the preview's Variable Values panel) */
	values?: Record<string, string>;
	/** Display labels per variable key, used as a default before humanizing */
	labels?: Record<string, string>;
	/** HTML-escape substituted values (use for HTML/AMP output, not plain text) */
	escape?: boolean;
}

/**
 * Preview-only variable substitution. Fills `{{var}}` / `{{var|'fallback'}}`
 * tokens so the preview shows real content instead of raw tokens. Resolution
 * order per token: user-provided value → inline fallback → sample value for
 * common contact fields → variable label → humanized key.
 *
 * Send-time substitution is a separate, per-recipient pass on the backend
 * (`delivery/sendComposition/personalization.ts`) — this mirrors its token
 * regex and HTML-escape policy but intentionally never produces an empty
 * string for a missing variable, so previews stay readable.
 */
export function fillPreviewVariables(
	content: string,
	options: FillPreviewVariablesOptions = {}
): string {
	const { values = {}, labels = {}, escape = false } = options;

	return replaceTemplateVariables(
		content,
		(key, fallback) => {
			const provided = values[key];
			if (provided !== undefined && provided !== null && provided !== '') return String(provided);
			if (fallback !== undefined) return fallback;
			// Never null: a preview that leaves raw tokens standing is unreadable,
			// which is the whole difference between this and the send-time pass.
			return (
				SAMPLE_VALUES[key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()] ??
				labels[key] ??
				humanizeVariableKey(key)
			);
		},
		{ escape: escape ? escapeHtml : undefined }
	);
}
