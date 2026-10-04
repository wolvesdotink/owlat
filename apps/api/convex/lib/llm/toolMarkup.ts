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
 * - After the reply starts, a tool call counts wherever it appears: inline,
 *   on its own line, inside backticks or a fenced block.
 *   - `<invoke name="…">`: complete, broken once its `name` attribute has
 *     started, or unfinished at the end;
 *   - a well-formed container opener (`<function_calls>`,
 *     `<function_results>`, `<tool_call>`, `<tool_calls>`, `<tool_use>`,
 *     `<tool_result>`, any case or namespace), with or without a closing tag;
 *   - a call opener the text ends inside (`Hi John, <tool_ca`).
 *
 *   Prose: a closing tag on its own, an inner tag (`<parameter>`,
 *   `<result>`), a fragment of either the text ends inside (`Hi <result`,
 *   `Hi </tool_ca`), a malformed opener (`<invoke>`, `<tool_call id="1">`),
 *   and anything that is not a tool tag (`<b>`, `<3`, `a < b`).
 *
 * The trade-off: these are email replies to customers, and one that quotes a
 * tool-call tag on purpose is very unlikely. When it happens it costs one
 * retry, then the soft failure the surface already has, and the person writes
 * that part themselves. Every attempt to tell such a quote from a leak (by
 * line position, by code spans) let a real leak through, so none is made.
 *
 * Linear in the text length on any input: the lexer reads a bounded number of
 * characters past each `<`, the leading scan searches forward for each
 * leading block's closing tag and resumes after it, and the reply scan stops
 * at the first call.
 *
 * Pure (no ctx, no 'use node').
 */

import {
	CALL_TAGS,
	INNER_TAGS,
	SPACE,
	TAG_NAMES,
	closingTagEnd,
	lexTag,
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

type ReplyMarkup = {
	readonly index: number;
	readonly reason: 'embedded' | 'unfinished';
};

/** The first tool call in the reply that starts at `bodyStart` (see the policy), or null. */
function firstMarkupInReply(text: string, bodyStart: number): ReplyMarkup | null {
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
		return { index, reason: tag.kind === 'partial' ? 'unfinished' : 'embedded' };
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
	const markup = firstMarkupInReply(text, leading.end);
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
 * after it, the reply is shown without it. A tool call after the reply
 * started holds the text back from where it starts (the final text is then
 * `unusable`), and so does a tag the text ends inside until it is clearly not
 * a tool tag.
 *
 * Leading whitespace is dropped; the final draft is trimmed anyway.
 */
export function visibleDraftStreamText(text: string): string {
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
	return text.slice(leading.end, end);
}
