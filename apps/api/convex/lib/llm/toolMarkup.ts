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
 * Tags are read by one lexer, in `./toolTagGrammar.ts`, which documents the
 * grammar. Only raw tags count. A draft is plain text, every leak seen (the
 * issue's example, the providers' behaviour) is raw tags, and an escaped
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

import {
	CALL_TAGS,
	INNER_TAGS,
	SPACE,
	TAG_NAMES,
	closingTagEnd,
	findClosingTag,
	lexTag,
	type ClosingTag,
	type Lexed,
} from './toolTagGrammar';

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
