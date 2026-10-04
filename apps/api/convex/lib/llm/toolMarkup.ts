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
 *
 * Only raw tags count. A draft is plain text, every leak seen (the issue's
 * example, the providers' behaviour) is raw tags, and an escaped
 * `&lt;invoke …&gt;` is not a tool call: it reads as literal entity text, like
 * any other text a model can get wrong. Decoding entities would put a second
 * grammar beside this one, and a split entity would then show markup while it
 * streams.
 *
 * ## The policy
 *
 * - A leading prefix (only whitespace before it) of complete tool tags, each
 *   opener taken up to its closing tag, is the leaked call: it is cut and the
 *   reply after it kept. Any tool tag counts here, inner tags and stray
 *   closing tags included. A text that ends inside a leading tag is
 *   unfinished.
 * - After the reply starts, prose can mention a tag, so what counts is a call,
 *   not a tag name:
 *   - `<invoke name="…">` anywhere: complete, broken once its `name`
 *     attribute has started, or unfinished at the end. Nothing else is
 *     written that way.
 *   - a container block: a container opener (`<function_calls>`,
 *     `<tool_call>`, ...) followed by its closing tag, on any line. An opener
 *     whose closing tag never comes is unusable too: it cannot be told apart
 *     from a generation that stopped inside the block, which the stream had
 *     to hold back.
 *   - a tool tag the text ends inside (`Hi John, <tool_ca`).
 *   - A code span (the text between a run of backticks and the next run of
 *     the same length: inline `` `<tool_call>` `` or a fenced sample) quotes
 *     a container in two ways only: the whole block, closing tag included,
 *     sits inside one span; or the opener sits in a span and no closing tag
 *     follows outside every span (a lone mention). A span that closes inside
 *     a block's payload never exempts it, so a stray backtick in the prose
 *     cannot pair with one in the call's JSON and hide the call.
 *   - A closing tag on its own, an inner tag, and a container whose opener is
 *     not a well-formed tag are prose too.
 *
 * So a reply may quote markup in a code span and mention tags in prose; a
 * bare block written out in the reply, quoted or leaked, costs one retry.
 *
 * The lexer looks at most a few hundred characters past each `<`, and the
 * closing-tag lookups of one scan share a forward walk per tag name, so a
 * scan is linear in the text length on any input.
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

/** Tags that count after the reply starts. */
const CALL_TAGS = TAG_NAMES.filter((name) => !INNER_TAGS.has(name));

const MAX_WORD = 64;
const MAX_SPACE = 32;
const MAX_NAME_VALUE = 200;
const WORD_CHAR = /[A-Za-z0-9_.:-]/;
const NAMESPACE_SOURCE = '[A-Za-z_][A-Za-z0-9_.-]{0,31}';
const NAMESPACE = new RegExp(`^${NAMESPACE_SOURCE}$`);
const SPACE = /\s/;

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

interface ClosingTag {
	readonly start: number;
	/** Index just past the `>`. */
	readonly end: number;
}

/** The first `</name>` (any namespace, any case) at or after `from`, or null. */
function findClosingTag(text: string, name: string, from: number): ClosingTag | null {
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
function closingTagEnd(text: string, name: string, from: number): number {
	return findClosingTag(text, name, from)?.end ?? -1;
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

/** A partial tag whose name so far starts one of `names` (`<tool_ca`, `</res`). */
function startsTagName(tag: Lexed, names: readonly string[]): boolean {
	return (
		tag.kind === 'partial' && tag.name !== '' && names.some((name) => name.startsWith(tag.name))
	);
}

type Span = readonly [number, number];

/**
 * Code spans after `from`: the text between a run of backticks and the next
 * run of the same length (inline code, or a fenced block). An unpaired run is
 * literal. While streaming, a run at the very end may still grow, so it pairs
 * with nothing yet.
 */
function codeSpans(text: string, from: number, isFinal: boolean): Span[] {
	const runs: Array<readonly [number, number]> = [];
	for (let start = text.indexOf('`', from); start !== -1;) {
		let end = start;
		while (end < text.length && text[end] === '`') end += 1;
		if (isFinal || end < text.length) runs.push([start, end]);
		start = text.indexOf('`', end);
	}
	const nextOfLength = runs.map(() => -1);
	const laterOfLength = new Map<number, number>();
	for (let run = runs.length - 1; run >= 0; run -= 1) {
		const length = runs[run]![1] - runs[run]![0];
		nextOfLength[run] = laterOfLength.get(length) ?? -1;
		laterOfLength.set(length, run);
	}
	const spans: Span[] = [];
	for (let run = 0; run < runs.length;) {
		const closing = nextOfLength[run]!;
		if (closing === -1) {
			run += 1;
			continue;
		}
		spans.push([runs[run]![0], runs[closing]![1]]);
		run = closing + 1;
	}
	return spans;
}

type ReplyMarkup = {
	readonly index: number;
	readonly reason: 'embedded' | 'unclosed' | 'unfinished';
};

/** The span that holds `index`, or null. Spans are sorted and disjoint. */
function spanAt(spans: readonly Span[], index: number): Span | null {
	let low = 0;
	let high = spans.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const span = spans[middle]!;
		if (index < span[0]) high = middle - 1;
		else if (index >= span[1]) low = middle + 1;
		else return span;
	}
	return null;
}

/**
 * Closing-tag lookups for one scan. Each remembers its last answer per tag
 * name: a later search from at or before that answer has the same answer, so
 * the openers of one scan share a single forward walk per name and the scan
 * stays linear.
 */
function closingTagFinder(text: string, spans: readonly Span[]) {
	type Answer = { readonly from: number; readonly closing: ClosingTag | null };
	const anyCache = new Map<string, Answer>();
	const outsideCache = new Map<string, Answer>();
	const reuse = (cache: Map<string, Answer>, name: string, from: number): Answer | undefined => {
		const answer = cache.get(name);
		if (!answer || from < answer.from) return undefined;
		return answer.closing === null || from <= answer.closing.start ? answer : undefined;
	};
	/** The first closing tag after `from`. */
	const first = (name: string, from: number): ClosingTag | null => {
		const known = reuse(anyCache, name, from);
		if (known) return known.closing;
		const closing = findClosingTag(text, name, from);
		anyCache.set(name, { from, closing });
		return closing;
	};
	/** The first closing tag after `from` that is not inside a code span. */
	const outside = (name: string, from: number): ClosingTag | null => {
		const known = reuse(outsideCache, name, from);
		if (known) return known.closing;
		let closing = first(name, from);
		while (closing && spanAt(spans, closing.start)) closing = first(name, closing.end);
		outsideCache.set(name, { from, closing });
		return closing;
	};
	return { first, outside };
}

/**
 * The first call in the reply that starts at `bodyStart`, by the policy above,
 * or null. A container opener inside a code span is a mention only when its
 * block cannot be a call: its first closing tag sits in the same span (the
 * whole block is quoted), or, in the final text, no closing tag follows
 * outside every span. While streaming, a closing tag can still come, so an
 * opener in a span is held unless the span already encloses its closing tag.
 */
function firstMarkupInReply(text: string, bodyStart: number, isFinal: boolean): ReplyMarkup | null {
	const spans = codeSpans(text, bodyStart, isFinal);
	const closings = closingTagFinder(text, spans);
	for (
		let index = text.indexOf('<', bodyStart);
		index !== -1;
		index = text.indexOf('<', index + 1)
	) {
		const tag = lexTag(text, index);
		if (tag.kind === 'none' || tag.isClosing) continue;
		if (tag.kind === 'partial' && !tag.isNameComplete) {
			if (startsTagName(tag, CALL_TAGS)) return { index, reason: 'unfinished' };
			continue;
		}
		if (tag.name === 'invoke') {
			if (tag.kind === 'partial') return { index, reason: 'unfinished' };
			if (tag.kind === 'tag' || tag.hasNameAttribute) return { index, reason: 'embedded' };
			continue;
		}
		if (INNER_TAGS.has(tag.name) || tag.kind === 'broken') continue;
		if (tag.kind === 'partial') return { index, reason: 'unfinished' };
		const span = spanAt(spans, index);
		if (span) {
			const closing = closings.first(tag.name, tag.end);
			if (closing && closing.end <= span[1]) continue;
			if (!isFinal) return { index, reason: 'unclosed' };
			if (closings.outside(tag.name, tag.end)) return { index, reason: 'embedded' };
			continue;
		}
		return {
			index,
			reason: closingTagEnd(text, tag.name, tag.end) === -1 ? 'unclosed' : 'embedded',
		};
	}
	return null;
}

export type ToolMarkupResult =
	/** No markup: the text as given. */
	| { readonly kind: 'clean'; readonly text: string }
	/** A leading markup prefix was removed: the reply that followed it. */
	| { readonly kind: 'stripped'; readonly text: string }
	/**
	 * Nothing to keep: a call after the reply started, a block or tag the text
	 * ends inside, or no reply after the prefix. The generation failed.
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
export function stripLeakedToolMarkup(text: string): ToolMarkupResult {
	const leading = scanLeadingMarkup(text);
	if (leading.state === 'open') return { kind: 'unusable', reason: 'unclosed' };
	if (
		leading.state === 'partial' &&
		(leading.blocks > 0 || startsTagName(lexTag(text, leading.end), TAG_NAMES))
	) {
		return { kind: 'unusable', reason: 'unfinished' };
	}
	const markup = firstMarkupInReply(text, leading.end, true);
	if (markup) return { kind: 'unusable', reason: markup.reason };
	if (leading.blocks === 0) return { kind: 'clean', text };
	const body = text.slice(leading.end);
	return body.trim().length === 0
		? { kind: 'unusable', reason: 'empty' }
		: { kind: 'stripped', text: body };
}

/**
 * The part of a draft still being streamed that is safe to show. Nothing is
 * shown while the text is, or could still become, a leading markup prefix;
 * after it, the reply is shown without it. A call after the reply started,
 * including a container opener whose closing tag has not come yet, holds the
 * text back from where it starts, and so does a tag the text ends inside. An
 * opener in a code span is held too until the span is seen to enclose its
 * closing tag: a lone mention shows only in the final text.
 *
 * Leading whitespace is dropped; the final draft is trimmed anyway.
 */
export function visibleDraftStreamText(text: string): string {
	const leading = scanLeadingMarkup(text);
	if (leading.state !== 'done') return '';
	let end = text.length;
	const markup = firstMarkupInReply(text, leading.end, false);
	if (markup) {
		end = markup.index;
	} else {
		const lastOpen = text.lastIndexOf('<');
		if (lastOpen >= leading.end && lexTag(text, lastOpen).kind === 'partial') end = lastOpen;
	}
	return text.slice(leading.end, end);
}
