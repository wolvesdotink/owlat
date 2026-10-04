/**
 * The tool-tag grammar behind lib/llm/toolMarkup.ts (#1254), split out to keep
 * that module under the size cap. Pure (no ctx, no 'use node').
 *
 * One hand-written lexer ({@link lexTag}) decides, for the text at a `<`,
 * whether it is a complete tool tag, a tool tag that went wrong (`broken`), or
 * the unfinished start of one (`partial`, the text ends inside it). The
 * streaming hold-back and the final check both read that one verdict, so every
 * prefix of every tag the final check accepts is also held back while it
 * streams.
 *
 *     '<' '/'? (NAMESPACE ':')? NAME SPACE* '>'                       bare tag
 *     '<' (NAMESPACE ':')? NAME SPACE+ 'name' SPACE* '=' SPACE* QUOTED SPACE* '>'
 *
 * - NAME, case-insensitive: the containers `function_calls`,
 *   `function_results`, `invoke`, `tool_call`, `tool_calls`, `tool_use`,
 *   `tool_result`, and the inner tags `parameter`, `result`.
 * - `invoke` and `parameter` open with the `name="…"` attribute (single or
 *   double quotes) and nothing else; every other tag, and every closing tag,
 *   carries no attribute. `<invoke>` and `<parameter>` are not tool tags.
 * - NAMESPACE (`ns:`, `my_ns:`, `a.b-c:`), the form some models print, starts
 *   with a letter or `_`, then up to 31 letters, digits, `_`, `.` or `-`.
 * - SPACE includes newlines; each run is at most 32 characters, a name value
 *   at most 200 (no newline, `<` or `>` in it).
 *
 * The lexer looks at most a few hundred characters past each `<`.
 */

export const TAG_NAMES = [
	'function_calls',
	'function_results',
	'invoke',
	'tool_call',
	'tool_calls',
	'tool_use',
	'tool_result',
	'parameter',
	'result',
] as const;

/** Tags that open with the `name="…"` attribute. */
const NAMED_TAGS: ReadonlySet<string> = new Set(['invoke', 'parameter']);

/** Tags that only count as markup inside a leading prefix. */
export const INNER_TAGS: ReadonlySet<string> = new Set(['parameter', 'result']);

/** Tags that count after the reply starts. */
export const CALL_TAGS = TAG_NAMES.filter((name) => !INNER_TAGS.has(name));

const MAX_WORD = 64;
const MAX_SPACE = 32;
const MAX_NAME_VALUE = 200;
const WORD_CHAR = /[A-Za-z0-9_.:-]/;
const NAMESPACE_SOURCE = '[A-Za-z_][A-Za-z0-9_.-]{0,31}';
const NAMESPACE = new RegExp(`^${NAMESPACE_SOURCE}$`);
export const SPACE = /\s/;

export type Lexed =
	/** Not the start of a tool tag. */
	| { readonly kind: 'none' }
	| {
			readonly kind: 'tag';
			readonly name: string;
			readonly isClosing: boolean;
			readonly end: number;
	  }
	/** A tool tag name, then something the grammar does not allow. */
	| {
			readonly kind: 'broken';
			readonly name: string;
			readonly isClosing: boolean;
			readonly hasNameAttribute: boolean;
	  }
	/** The text ends inside what may still become a tool tag. */
	| {
			readonly kind: 'partial';
			/** The tag name so far, lower case; a prefix of a name unless `isNameComplete`. */
			readonly name: string;
			readonly isNameComplete: boolean;
			readonly isClosing: boolean;
			readonly hasNameAttribute: boolean;
	  };

const NONE: Lexed = { kind: 'none' };

function isNamePrefix(word: string): boolean {
	const lower = word.toLowerCase();
	return TAG_NAMES.some((name) => name.startsWith(lower));
}

/** The lower-case tag name a complete word spells (`ns:invoke` → `invoke`), or null. */
function tagName(word: string): string | null {
	const colon = word.indexOf(':');
	if (colon !== -1 && !NAMESPACE.test(word.slice(0, colon))) return null;
	const name = word.slice(colon + 1).toLowerCase();
	return (TAG_NAMES as readonly string[]).includes(name) ? name : null;
}

/** A word the text ends in: a namespace or name still being written, or none. */
function partialWord(word: string, isClosing: boolean): Lexed {
	const colon = word.indexOf(':');
	if (colon !== -1) {
		const rest = word.slice(colon + 1);
		if (!NAMESPACE.test(word.slice(0, colon)) || rest.includes(':') || !isNamePrefix(rest)) {
			return NONE;
		}
		return partial(rest.toLowerCase(), false, isClosing, false);
	}
	if (!isNamePrefix(word) && !NAMESPACE.test(word)) return NONE;
	return partial(word.toLowerCase(), false, isClosing, false);
}

function partial(
	name: string,
	isNameComplete: boolean,
	isClosing: boolean,
	hasNameAttribute: boolean
): Lexed {
	return { kind: 'partial', name, isNameComplete, isClosing, hasNameAttribute };
}

/** Index after a run of up to {@link MAX_SPACE} spaces, or -1 for a longer run. */
function spaceEnd(text: string, from: number): number {
	let index = from;
	while (index < text.length && SPACE.test(text[index]!)) {
		if (index - from >= MAX_SPACE) return -1;
		index += 1;
	}
	return index;
}

/** Read the tag that starts at `at` (a `<`) by the grammar in the module comment. */
export function lexTag(text: string, at: number): Lexed {
	let index = at + 1;
	const isClosing = text[index] === '/';
	if (isClosing) index += 1;
	const wordStart = index;
	while (index < text.length && WORD_CHAR.test(text[index]!)) {
		if (index - wordStart >= MAX_WORD) return NONE;
		index += 1;
	}
	const word = text.slice(wordStart, index);
	if (index === text.length) return partialWord(word, isClosing);
	const name = tagName(word);
	if (name === null) return NONE;
	const needsNameAttribute = NAMED_TAGS.has(name) && !isClosing;
	const ends = (hasNameAttribute: boolean) => partial(name, true, isClosing, hasNameAttribute);
	const broken = (hasNameAttribute: boolean): Lexed => ({
		kind: 'broken',
		name,
		isClosing,
		hasNameAttribute,
	});
	const close = (end: number): Lexed => ({ kind: 'tag', name, isClosing, end });

	let cursor = spaceEnd(text, index);
	if (cursor === -1) return broken(false);
	if (cursor === text.length) return ends(false);
	if (text[cursor] === '>') return needsNameAttribute ? broken(false) : close(cursor + 1);
	if (!needsNameAttribute || cursor === index) return broken(false);

	for (const letter of 'name') {
		if (cursor === text.length) return ends(false);
		if (text[cursor]!.toLowerCase() !== letter) return broken(false);
		cursor += 1;
	}
	cursor = spaceEnd(text, cursor);
	if (cursor === -1) return broken(true);
	if (cursor === text.length) return ends(true);
	if (text[cursor] !== '=') return broken(true);
	cursor = spaceEnd(text, cursor + 1);
	if (cursor === -1) return broken(true);
	if (cursor === text.length) return ends(true);
	const quote = text[cursor];
	if (quote !== '"' && quote !== "'") return broken(true);
	const valueStart = cursor + 1;
	cursor = valueStart;
	while (cursor < text.length && text[cursor] !== quote) {
		if ('<>\n'.includes(text[cursor]!) || cursor - valueStart >= MAX_NAME_VALUE) {
			return broken(true);
		}
		cursor += 1;
	}
	if (cursor === text.length) return ends(true);
	if (cursor === valueStart) return broken(true);
	cursor = spaceEnd(text, cursor + 1);
	if (cursor === -1) return broken(true);
	if (cursor === text.length) return ends(true);
	return text[cursor] === '>' ? close(cursor + 1) : broken(true);
}

const closingTagPatterns = new Map<string, RegExp>();

export interface ClosingTag {
	readonly start: number;
	/** Index just past the `>`. */
	readonly end: number;
}

/** The first `</name>` (any namespace, any case) at or after `from`, or null. */
export function findClosingTag(text: string, name: string, from: number): ClosingTag | null {
	let pattern = closingTagPatterns.get(name);
	if (!pattern) {
		pattern = new RegExp(`</(?:${NAMESPACE_SOURCE}:)?${name}\\s{0,${MAX_SPACE}}>`, 'gi');
		closingTagPatterns.set(name, pattern);
	}
	pattern.lastIndex = from;
	const match = pattern.exec(text);
	return match ? { start: match.index, end: pattern.lastIndex } : null;
}

/** Index just past the first `</name>` at or after `from`, or -1. */
export function closingTagEnd(text: string, name: string, from: number): number {
	return findClosingTag(text, name, from)?.end ?? -1;
}
