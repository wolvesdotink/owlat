import { escapeHtml } from '@owlat/shared/html';

/**
 * Variable detection utilities for template variables (e.g., {{variableName}})
 * Regex mirrors the one used in emailWorker.ts replaceVariables()
 */

const VARIABLE_PATTERN = /\{\{(\w+)(?:\|'[^']*')?\}\}/;
const VARIABLE_PATTERN_GLOBAL = /\{\{(\w+)(?:\|'[^']*')?\}\}/g;
const VARIABLE_PATTERN_WITH_FALLBACK = /\{\{(\w+)(?:\|'([^']*)')?\}\}/g;

/** Check if a string contains one or more template variables */
export function containsVariable(value: string | undefined | null): boolean {
	if (!value) return false;
	return VARIABLE_PATTERN.test(value);
}

/** Extract the variable name from a simple {{variableName}} string */
export function extractVariableName(value: string | undefined | null): string | null {
	if (!value) return null;
	const match = value.match(VARIABLE_PATTERN);
	return match ? match[1]! : null;
}

/** Extract all variable names from a string */
export function extractVariableNames(value: string | undefined | null): string[] {
	if (!value) return [];
	const names: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = VARIABLE_PATTERN_GLOBAL.exec(value)) !== null) {
		names.push(match[1]!);
	}
	return names;
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
	const applyEscape = (value: string) => (escape ? escapeHtml(value) : value);

	return content.replace(
		VARIABLE_PATTERN_WITH_FALLBACK,
		(_match, key: string, fallback?: string) => {
			const provided = values[key];
			if (provided !== undefined && provided !== null && provided !== '') {
				return applyEscape(String(provided));
			}
			if (fallback !== undefined) return applyEscape(fallback);
			const defaultValue =
				SAMPLE_VALUES[key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()] ??
				labels[key] ??
				humanizeVariableKey(key);
			return applyEscape(defaultValue);
		}
	);
}
