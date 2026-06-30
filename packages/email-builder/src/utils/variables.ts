/**
 * Variable detection utilities for template variables (e.g., {{variableName}})
 * Regex mirrors the one used in emailWorker.ts replaceVariables()
 */

const VARIABLE_PATTERN = /\{\{(\w+)(?:\|'[^']*')?\}\}/;
const VARIABLE_PATTERN_GLOBAL = /\{\{(\w+)(?:\|'[^']*')?\}\}/g;

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
