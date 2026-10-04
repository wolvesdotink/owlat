/**
 * Tool-call markup a model typed into its reply text (#1254).
 *
 * A model that does not return a structured tool call can print the call as
 * text instead: `<invoke name="recallKnowledge">`, its `<parameter>`s, then a
 * `<function_results>` block it made up, then the reply. To the AI SDK that is
 * one ordinary text step, so without this module the whole string became the
 * draft. Every draft surface runs its final text through
 * {@link stripLeakedToolMarkup}, and a streaming surface shows only
 * {@link visibleDraftStreamText} while the model is still writing.
 *
 * ## The tag grammar
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
 * - HTML-escaped markup (`&lt;invoke name=&quot;…&quot;&gt;`) reads as the
 *   markup it escapes: the text is scanned with the entities for `<`, `>`, `"`
 *   and `'` decoded, and every cut is mapped back to the raw text.
 *
 * ## The policy
 *
 * A leading prefix (only whitespace before it) of complete tool tags, each
 * opener taken up to its closing tag, is the leaked call: it is cut and the
 * reply after it kept. After the reply starts, a reply may quote markup in
 * prose, so only a tool-shaped opener counts:
 *
 * - `<invoke name="…">` anywhere, complete or broken once its `name` attribute
 *   has started (`<invoke name="x" extra>`), or unfinished at the end;
 * - a container opener (`<function_calls>`, `<tool_call>`, ...) that starts a
 *   line, complete, broken or unfinished at the end. Inline, as in "wrap it in
 *   `<tool_call>`", it is prose;
 * - never a closing tag on its own (its opener is what counts, so
 *   `<invoke>foo</invoke>` stays a reply), and never the inner tags.
 *
 * Any of those makes the draft `unusable`. A tool block quoted on its own line
 * in a code sample is therefore treated as a leak: that costs one retry, while
 * the opposite mistake sends markup to a customer.
 *
 * The lexer looks at most a few hundred characters past each `<`, so a scan is
 * linear in the text length on any input.
 *
 * Pure (no ctx, no 'use node').
 */

const TAG_NAMES = [
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
const INNER_TAGS: ReadonlySet<string> = new Set(['parameter', 'result']);

const CONTAINER_TAGS = TAG_NAMES.filter((name) => !INNER_TAGS.has(name));

const MAX_WORD = 64;
const MAX_SPACE = 32;
const MAX_NAME_VALUE = 200;
const WORD_CHAR = /[A-Za-z0-9_.:-]/;
const NAMESPACE_SOURCE = '[A-Za-z_][A-Za-z0-9_.-]{0,31}';
const NAMESPACE = new RegExp(`^${NAMESPACE_SOURCE}$`);
const SPACE = /\s/;

/** Entities a model or an escaping layer writes for the tag characters. */
const ENTITIES: ReadonlyArray<readonly [string, string]> = [
	['&lt;', '<'],
	['&gt;', '>'],
	['&quot;', '"'],
	['&apos;', "'"],
	['&#60;', '<'],
	['&#62;', '>'],
	['&#34;', '"'],
	['&#39;', "'"],
	['&#x3c;', '<'],
	['&#x3e;', '>'],
	['&#x22;', '"'],
	['&#x27;', "'"],
];
const MAX_ENTITY = 6;

type Lexed =
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
function lexTag(text: string, at: number): Lexed {
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

/** Index just past the first `</name>` (any namespace, any case) at or after `from`, or -1. */
function closingTagEnd(text: string, name: string, from: number): number {
	let pattern = closingTagPatterns.get(name);
	if (!pattern) {
		pattern = new RegExp(`</(?:${NAMESPACE_SOURCE}:)?${name}\\s{0,${MAX_SPACE}}>`, 'gi');
		closingTagPatterns.set(name, pattern);
	}
	pattern.lastIndex = from;
	return pattern.exec(text) ? pattern.lastIndex : -1;
}

function skipWhitespace(text: string, from: number): number {
	let index = from;
	while (index < text.length && SPACE.test(text[index]!)) index += 1;
	return index;
}

interface LeadingMarkup {
	/** Leading tool tags and blocks found. */
	readonly blocks: number;
	/** Where the text after them (and after whitespace) starts. */
	readonly end: number;
	/**
	 * `done`: the prefix has ended. `open`: a block opened and has not closed.
	 * `partial`: the text ends inside a tag that may be a tool tag.
	 */
	readonly state: 'done' | 'open' | 'partial';
}

/**
 * Walk the tool tags at the start of the text: each opener up to its closing
 * tag (a `<function_calls>` block swallows the `<invoke>`s inside it), and any
 * stray closing tag, with the whitespace between them.
 */
function scanLeadingMarkup(text: string): LeadingMarkup {
	let blocks = 0;
	let index = skipWhitespace(text, 0);
	while (index < text.length && text[index] === '<') {
		const tag = lexTag(text, index);
		if (tag.kind === 'partial') return { blocks, end: index, state: 'partial' };
		if (tag.kind !== 'tag') break;
		blocks += 1;
		const end = tag.isClosing ? tag.end : closingTagEnd(text, tag.name, tag.end);
		if (end === -1) return { blocks, end: index, state: 'open' };
		index = skipWhitespace(text, end);
	}
	return { blocks, end: index, state: 'done' };
}

/** Whether only spaces and tabs stand between `index` and the line (or body) start. */
function startsLine(text: string, index: number, bodyStart: number): boolean {
	let before = index - 1;
	while (before >= bodyStart && (text[before] === ' ' || text[before] === '\t')) before -= 1;
	return before < bodyStart || text[before] === '\n' || text[before] === '\r';
}

/** The policy in the module comment, for one lexed tag after the reply started. */
function countsInReply(tag: Lexed, isLineStart: boolean): boolean {
	if (tag.kind === 'none' || tag.isClosing) return false;
	if (tag.kind === 'partial' && !tag.isNameComplete) {
		return (
			isLineStart && tag.name !== '' && CONTAINER_TAGS.some((name) => name.startsWith(tag.name))
		);
	}
	if (INNER_TAGS.has(tag.name)) return false;
	if (tag.name === 'invoke') {
		return tag.kind === 'tag' || tag.hasNameAttribute || (tag.kind === 'partial' && isLineStart);
	}
	return isLineStart;
}

/** The first tool tag in the reply that starts at `bodyStart`, or null. */
function firstMarkupInReply(
	text: string,
	bodyStart: number
): { readonly index: number; readonly isUnfinished: boolean } | null {
	for (
		let index = text.indexOf('<', bodyStart);
		index !== -1;
		index = text.indexOf('<', index + 1)
	) {
		const tag = lexTag(text, index);
		if (countsInReply(tag, startsLine(text, index, bodyStart))) {
			return { index, isUnfinished: tag.kind === 'partial' };
		}
	}
	return null;
}

interface DecodedText {
	readonly text: string;
	/** The raw index of a decoded index (the decoded length maps to the raw length). */
	toRaw(index: number): number;
}

/** The text with the tag-character entities decoded, one level deep. */
function decodeTagEntities(raw: string): DecodedText {
	if (!raw.includes('&')) return { text: raw, toRaw: (index) => index };
	const parts: string[] = [];
	const offsets: number[] = [];
	let index = 0;
	while (index < raw.length) {
		const candidate = raw[index] === '&' ? raw.slice(index, index + MAX_ENTITY).toLowerCase() : '';
		const entity = candidate ? ENTITIES.find(([name]) => candidate.startsWith(name)) : undefined;
		offsets.push(index);
		if (entity) {
			parts.push(entity[1]);
			index += entity[0].length;
		} else {
			parts.push(raw[index]!);
			index += 1;
		}
	}
	offsets.push(raw.length);
	return { text: parts.join(''), toRaw: (decoded) => offsets[decoded]! };
}

/** Where a trailing, unfinished tag-character entity (`&l`, `&#6`) starts, or -1. */
function trailingEntityStart(raw: string, from: number): number {
	const amp = raw.lastIndexOf('&');
	if (amp < from || raw.length - amp >= MAX_ENTITY) return -1;
	const tail = raw.slice(amp).toLowerCase();
	return ENTITIES.some(([name]) => name.length > tail.length && name.startsWith(tail)) ? amp : -1;
}

export type ToolMarkupResult =
	/** No markup: the text as given. */
	| { readonly kind: 'clean'; readonly text: string }
	/** A leading markup prefix was removed: the reply that followed it. */
	| { readonly kind: 'stripped'; readonly text: string }
	/**
	 * Nothing to keep: a tool tag after the reply started, a tag or block the
	 * text ends inside, or no reply after the prefix. The generation failed.
	 */
	| {
			readonly kind: 'unusable';
			readonly reason: 'embedded' | 'unclosed' | 'unfinished' | 'empty';
	  };

/**
 * Remove leaked tool-call markup from a model's final draft text: cut a
 * leading prefix and keep the reply after it, or report the draft unusable
 * (see the policy in the module comment).
 */
export function stripLeakedToolMarkup(raw: string): ToolMarkupResult {
	const decoded = decodeTagEntities(raw);
	const leading = scanLeadingMarkup(decoded.text);
	if (leading.state === 'open') return { kind: 'unusable', reason: 'unclosed' };
	if (leading.state === 'partial' && leading.blocks > 0) {
		return { kind: 'unusable', reason: 'unfinished' };
	}
	const markup = firstMarkupInReply(decoded.text, leading.end);
	if (markup) return { kind: 'unusable', reason: markup.isUnfinished ? 'unfinished' : 'embedded' };
	if (leading.blocks === 0) return { kind: 'clean', text: raw };
	const body = raw.slice(decoded.toRaw(leading.end));
	return body.trim().length === 0
		? { kind: 'unusable', reason: 'empty' }
		: { kind: 'stripped', text: body };
}

/**
 * The part of a draft still being streamed that is safe to show. Nothing is
 * shown while the text is, or could still become, a leading markup prefix;
 * after it, the reply is shown without it. A tool tag after the reply started
 * freezes the text before it (the final text is then `unusable`), and a tag or
 * entity the text ends inside is held back until it is clearly not markup.
 *
 * Leading whitespace is dropped; the final draft is trimmed anyway.
 */
export function visibleDraftStreamText(raw: string): string {
	const decoded = decodeTagEntities(raw);
	const text = decoded.text;
	const leading = scanLeadingMarkup(text);
	if (leading.state !== 'done') return '';
	let end = text.length;
	const markup = firstMarkupInReply(text, leading.end);
	if (markup) {
		end = markup.index;
	} else {
		const lastOpen = text.lastIndexOf('<');
		if (lastOpen >= leading.end && lexTag(text, lastOpen).kind === 'partial') end = lastOpen;
	}
	const rawStart = decoded.toRaw(leading.end);
	let rawEnd = decoded.toRaw(end);
	if (rawEnd === raw.length) {
		const entity = trailingEntityStart(raw, rawStart);
		if (entity !== -1) rawEnd = entity;
	}
	return raw.slice(rawStart, rawEnd);
}
