import { extractVariableNames } from './variables';

/**
 * Plain-text helpers for the subject line's variable picker.
 *
 * The subject is an ordinary `<input>`, not the contenteditable the body uses,
 * so a variable is inserted as literal `{{key}}` text at a character range. The
 * send path personalizes the subject with the same token grammar
 * (`delivery/sendComposition/personalization.ts`, header escape policy).
 */

/** The `[start, end)` character range a picked variable replaces. */
export interface SubjectRange {
	start: number;
	end: number;
}

/**
 * The `{{query` the caret is typing, if any. Only `{{` opens the picker in the
 * subject: `@` is ordinary subject text ("Meet us @ the booth"), so treating it
 * as a trigger the way the body editor does would get in the way.
 */
export function findSubjectVariableTrigger(
	value: string,
	caret: number
): { range: SubjectRange; query: string } | null {
	const match = value.slice(0, caret).match(/\{\{(\w*)$/);
	if (!match) return null;
	return { range: { start: caret - match[0].length, end: caret }, query: match[1]! };
}

/**
 * Replace `range` with `{{key}}` and return the new value plus the caret right
 * after the token. `padBefore` separates the token from a word it would
 * otherwise be glued to — used by the insert button, where no `{{` was typed.
 */
export function insertSubjectVariable(
	value: string,
	key: string,
	range: SubjectRange,
	options: { padBefore?: boolean } = {}
): { value: string; caret: number } {
	const before = value.slice(0, range.start);
	const after = value.slice(range.end);
	const pad = options.padBefore && before !== '' && !/\s$/.test(before) ? ' ' : '';
	const token = `${pad}{{${key}}}`;
	return { value: before + token + after, caret: before.length + token.length };
}

/**
 * Tokens in the subject that name no known variable, deduplicated in reading
 * order. At send time an unknown token is replaced with an empty string, so a
 * typo like `{{frstName}}` silently drops the name from every subject.
 */
export function unknownSubjectVariables(subject: string, knownKeys: readonly string[]): string[] {
	const known = new Set(knownKeys);
	return [...new Set(extractVariableNames(subject))].filter((key) => !known.has(key));
}
