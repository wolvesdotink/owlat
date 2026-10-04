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
 * What counts as markup is anchored on the real tag shapes, never on a loose
 * `<word>`:
 *
 * - container tags, recognised anywhere in the text: `<function_calls>`,
 *   `<function_results>`, `<invoke name="…">`, and the `<tool_call>`,
 *   `<tool_calls>`, `<tool_use>`, `<tool_result>` variants other model
 *   families print;
 * - inner tags, recognised only as part of a leading markup prefix:
 *   `<parameter name="…">` and `<result>`. A reply can quote those in a code
 *   sample, and a leaked one always sits inside a container anyway.
 *
 * Each tag may carry a short XML namespace prefix (`<ns:invoke …>`), the form
 * some models print. A tag without its required `name="…"` attribute
 * (`<parameter>`, `<invoke>`) is prose, not markup.
 *
 * Every pattern uses bounded quantifiers only and is tried at a `<` position,
 * so a scan is linear in the text length on any input.
 *
 * Pure (no ctx, no 'use node').
 */

/** Optional XML namespace prefix such as `ns:`. */
const NS = '(?:[a-z][a-z0-9]{0,15}:)?';

/** Tags that carry a required `name="…"` attribute when they open. */
const NAMED_TAGS: ReadonlySet<string> = new Set(['invoke', 'parameter']);

/** Tags that only count as markup at the start of the text. */
const INNER_TAGS: ReadonlySet<string> = new Set(['parameter', 'result']);

/** Longest name first, so an alternation never stops at a shorter prefix. */
const TAG_NAMES = [
	'function_results',
	'function_calls',
	'tool_result',
	'tool_calls',
	'tool_call',
	'tool_use',
	'parameter',
	'invoke',
	'result',
] as const;

const NAME_ATTR = `\\s{1,16}name\\s{0,4}=\\s{0,4}(?:"[^"<>\\n]{1,200}"|'[^'<>\\n]{1,200}')`;

/** One complete tag at a given position (sticky). */
const TAG = new RegExp(`<(/)?${NS}(${TAG_NAMES.join('|')})(${NAME_ATTR})?\\s{0,16}>`, 'y');

/** Where a container tag may start (global); {@link tagAt} confirms it. */
const CONTAINER_START = new RegExp(
	`</?${NS}(?:${TAG_NAMES.filter((name) => !INNER_TAGS.has(name)).join('|')})(?![a-z0-9_])`,
	'g'
);

/**
 * A tag still being written at the very end of the text: `<`, `<inv`,
 * `<ns:func`, `<invoke name="rec`. Sticky and anchored to the end.
 */
const PARTIAL_TAG = /<\/?(?:([a-z][a-z0-9]{0,15}):)?([a-z_]{0,20})(\s[^<>\n]{0,256})?$/y;

/** Longer than any tag {@link PARTIAL_TAG} can be part of. */
const MAX_PARTIAL_TAG_LENGTH = 320;

/** A bare word that may yet turn out to be a namespace (`<ns` before its `:`). */
const NAMESPACE_WORD = /^[a-z][a-z0-9]{0,15}$/;

interface Tag {
	readonly name: string;
	readonly isClosing: boolean;
	/** Index just past the `>`. */
	readonly end: number;
}

/** The markup tag starting at `index`, or null when there is none. */
function tagAt(text: string, index: number): Tag | null {
	TAG.lastIndex = index;
	const match = TAG.exec(text);
	if (!match) return null;
	const isClosing = match[1] === '/';
	const name = match[2]!;
	const hasName = match[3] !== undefined;
	// A closing tag has no attributes; an opening one has `name="…"` exactly
	// when its kind requires it.
	if (isClosing ? hasName : hasName !== NAMED_TAGS.has(name)) return null;
	return { name, isClosing, end: TAG.lastIndex };
}

/** Index just past the first `</name>` at or after `from`, or -1. */
function closingTagEnd(text: string, name: string, from: number): number {
	const closing = new RegExp(`</${NS}${name}\\s{0,16}>`, 'g');
	closing.lastIndex = from;
	return closing.exec(text) ? closing.lastIndex : -1;
}

/** Whether the text from `index` (a `<`) to its end is a markup tag being written. */
function isPartialTag(text: string, index: number): boolean {
	if (text.length - index > MAX_PARTIAL_TAG_LENGTH) return false;
	PARTIAL_TAG.lastIndex = index;
	const match = PARTIAL_TAG.exec(text);
	if (!match) return false;
	const namespace = match[1];
	const name = match[2]!;
	// Attributes being written: the name before them is complete.
	if (match[3] !== undefined) return NAMED_TAGS.has(name);
	if (TAG_NAMES.some((tag) => tag.startsWith(name))) return true;
	return namespace === undefined && NAMESPACE_WORD.test(name);
}

function skipWhitespace(text: string, from: number): number {
	let index = from;
	while (index < text.length && /\s/.test(text[index]!)) index += 1;
	return index;
}

interface LeadingMarkup {
	/** Leading markup tags and blocks found. */
	readonly blocks: number;
	/** Where the text after them (and after whitespace) starts. */
	readonly end: number;
	/**
	 * `done`: the prefix has ended. `open`: a block opened and has not closed.
	 * `partial`: the text ends inside a tag that may be markup.
	 */
	readonly state: 'done' | 'open' | 'partial';
}

/**
 * Walk the markup blocks at the start of the text: each opening tag up to its
 * closing tag (a `<function_calls>` block swallows the `<invoke>`s inside it),
 * and any stray closing tag, with the whitespace between them.
 */
function scanLeadingMarkup(text: string): LeadingMarkup {
	let blocks = 0;
	let index = skipWhitespace(text, 0);
	while (index < text.length && text[index] === '<') {
		const tag = tagAt(text, index);
		if (!tag) {
			return { blocks, end: index, state: isPartialTag(text, index) ? 'partial' : 'done' };
		}
		blocks += 1;
		const end = tag.isClosing ? tag.end : closingTagEnd(text, tag.name, tag.end);
		if (end === -1) return { blocks, end: index, state: 'open' };
		index = skipWhitespace(text, end);
	}
	return { blocks, end: index, state: 'done' };
}

/** Index of the first container tag in the text, or -1. */
function firstContainerTag(text: string): number {
	CONTAINER_START.lastIndex = 0;
	for (let match = CONTAINER_START.exec(text); match; match = CONTAINER_START.exec(text)) {
		if (tagAt(text, match.index)) return match.index;
	}
	return -1;
}

export type ToolMarkupResult =
	/** No markup: the text as given. */
	| { readonly kind: 'clean'; readonly text: string }
	/** A leading markup prefix was removed: the reply that followed it. */
	| { readonly kind: 'stripped'; readonly text: string }
	/**
	 * Nothing to keep: markup after the reply started, a block that never
	 * closed, or no reply after the prefix. The generation failed.
	 */
	| { readonly kind: 'unusable'; readonly reason: 'embedded' | 'unclosed' | 'empty' };

/**
 * Remove leaked tool-call markup from a model's final draft text. A leading
 * prefix (any number of call and result blocks with whitespace between) is
 * cut and the reply after it kept. Markup anywhere else means the model wrote
 * part of a reply and then a call, so no part of the text can be trusted as
 * the reply: the result is `unusable`.
 */
export function stripLeakedToolMarkup(text: string): ToolMarkupResult {
	const leading = scanLeadingMarkup(text);
	if (leading.state === 'open') return { kind: 'unusable', reason: 'unclosed' };
	if (leading.blocks === 0) {
		return firstContainerTag(text) === -1
			? { kind: 'clean', text }
			: { kind: 'unusable', reason: 'embedded' };
	}
	const body = text.slice(leading.end);
	if (leading.state === 'partial' || body.trim().length === 0) {
		return { kind: 'unusable', reason: 'empty' };
	}
	if (firstContainerTag(body) !== -1) return { kind: 'unusable', reason: 'embedded' };
	return { kind: 'stripped', text: body };
}

/**
 * The part of a draft still being streamed that is safe to show. While the
 * text could still be (or is) a leading markup prefix nothing is shown; once
 * the reply starts it is shown without the prefix. A container tag after that
 * freezes the text before it (the final text is then `unusable`), and a tag
 * still being written at the end is held back until it is clearly not markup.
 *
 * Leading whitespace is dropped; the final draft is trimmed anyway.
 */
export function visibleDraftStreamText(text: string): string {
	const leading = scanLeadingMarkup(text);
	if (leading.state !== 'done') return '';
	const body = text.slice(leading.end);
	const container = firstContainerTag(body);
	if (container !== -1) return body.slice(0, container);
	const lastOpen = body.lastIndexOf('<');
	return lastOpen !== -1 && isPartialTag(body, lastOpen) ? body.slice(0, lastOpen) : body;
}
