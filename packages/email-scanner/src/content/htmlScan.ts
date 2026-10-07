/**
 * Forward-scanning HTML helpers for the content rules.
 *
 * Message bodies are sender-controlled, so every helper here reads its input
 * left to right and never returns to text it has already passed. The cost is
 * linear in the input length whatever the markup looks like.
 */

/**
 * Longest HTML body, in UTF-16 code units, that `scanContent` and
 * `checkUrlReputation` read; anything past it is dropped before scanning. A
 * Convex document holds under 1 MB, so stored campaign and template HTML is
 * always shorter than this and is scanned whole.
 */
export const MAX_CONTENT_SCAN_CHARS = 1_000_000;

export const capContentScanInput = (html: string): string =>
	html.length > MAX_CONTENT_SCAN_CHARS ? html.slice(0, MAX_CONTENT_SCAN_CHARS) : html;

const isTagSpace = (c: string | undefined): boolean =>
	c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Replace every `<...>` run (at least one character between the brackets, up
 * to the first `>`) with `replacement`. Same result as
 * `input.replace(/<[^>]+>/g, replacement)`. `meter`, when given, counts the
 * characters read inside tags.
 */
export function replaceTags(input: string, replacement: string, meter?: { chars: number }): string {
	let out = '';
	let pos = 0;
	let lt = input.indexOf('<');
	while (lt !== -1) {
		if (input[lt + 1] === '>') {
			lt = input.indexOf('<', lt + 1);
			continue;
		}
		const gt = input.indexOf('>', lt + 1);
		if (meter) meter.chars += (gt === -1 ? input.length : gt) - lt;
		if (gt === -1) break;
		out += input.slice(pos, lt) + replacement;
		pos = gt + 1;
		lt = input.indexOf('<', pos);
	}
	return out + input.slice(pos);
}

/**
 * Remove every span that starts at a match of `open`, optionally runs on to
 * the next `>` (for an opening tag with attributes), and ends at the first
 * match of `close` after that. Same result as the lazy
 * `open[^>]*>[\s\S]*?close` (or `open[\s\S]*?close`) replaced with ''. When a
 * span has no end, no later span can end either, so the pass stops there. Both
 * regexes must carry the `g` flag.
 */
export function removeSpans(
	input: string,
	open: RegExp,
	close: RegExp,
	openEndsAtGt: boolean
): string {
	let out = '';
	let pos = 0;
	for (;;) {
		open.lastIndex = pos;
		const start = open.exec(input);
		if (!start) break;
		let bodyFrom = start.index + start[0].length;
		if (openEndsAtGt) {
			const gt = input.indexOf('>', bodyFrom);
			if (gt === -1) break;
			bodyFrom = gt + 1;
		}
		close.lastIndex = bodyFrom;
		const end = close.exec(input);
		if (!end) break;
		out += input.slice(pos, start.index);
		pos = end.index + end[0].length;
	}
	return out + input.slice(pos);
}

/**
 * An anchor opening tag read by {@link readAnchorTag}: either it ends at `end`
 * (its closing `>`) with its first `href` value, or it never ends and scanning
 * resumes at `resume`.
 */
type AnchorTag = { end: number; href: string | null } | { end: null; resume: number };

/**
 * Read the attributes of an opening tag the way an HTML tokenizer does, from
 * just after the tag name: a `>` inside a quoted value does not end the tag,
 * and the first `href` attribute wins. A tag whose quoted value never closes
 * resumes just past that quote; one with no `>` at all resumes at the end.
 */
function readAnchorTag(input: string, from: number): AnchorTag {
	let href: string | null = null;
	let i = from;
	for (;;) {
		while (i < input.length && (isTagSpace(input[i]) || input[i] === '/')) i++;
		if (i >= input.length) return { end: null, resume: input.length };
		if (input[i] === '>') return { end: i, href };

		const nameStart = i;
		i++;
		while (i < input.length) {
			const c = input[i];
			if (isTagSpace(c) || c === '/' || c === '>' || c === '=') break;
			i++;
		}
		const isHref = href === null && input.slice(nameStart, i).toLowerCase() === 'href';
		while (i < input.length && isTagSpace(input[i])) i++;
		if (input[i] !== '=') continue;
		i++;
		while (i < input.length && isTagSpace(input[i])) i++;

		let value: string;
		const quote = input[i];
		if (quote === '"' || quote === "'") {
			const close = input.indexOf(quote, i + 1);
			if (close === -1) return { end: null, resume: i + 1 };
			value = input.slice(i + 1, close);
			i = close + 1;
		} else {
			const valueStart = i;
			while (i < input.length && !isTagSpace(input[i]) && input[i] !== '>') i++;
			value = input.slice(valueStart, i);
		}
		if (isHref) href = value;
	}
}

const ANCHOR_OPEN = /<a[\t\n\f\r /]/gi;
const ANCHOR_CLOSE = /<\/a>/gi;

/**
 * Every `<a ...>text</a>` in `html`, with the anchor's `href` (double-quoted,
 * single-quoted or unquoted, as HTML5 allows) and its text with tags removed.
 * Anchors without an `href` are skipped (anything inside them is still read);
 * an anchor with no `</a>` after it ends the scan, since no later anchor can be
 * closed either. `meter`, when given, counts the characters read (a search that
 * finds nothing counts up to the end), for the linear-time tests.
 */
export function scanAnchors(
	html: string,
	meter?: { chars: number }
): Array<{ href: string; text: string }> {
	const anchors: Array<{ href: string; text: string }> = [];
	let pos = 0;
	for (;;) {
		ANCHOR_OPEN.lastIndex = pos;
		const open = ANCHOR_OPEN.exec(html);
		if (meter) meter.chars += (open ? open.index : html.length) - pos;
		if (!open) break;
		const tag = readAnchorTag(html, open.index + 2);
		if (meter) meter.chars += (tag.end ?? html.length) - open.index;
		if (tag.end === null) {
			pos = tag.resume;
			continue;
		}
		if (tag.href === null) {
			pos = tag.end + 1;
			continue;
		}
		ANCHOR_CLOSE.lastIndex = tag.end + 1;
		const close = ANCHOR_CLOSE.exec(html);
		if (meter) meter.chars += (close ? close.index : html.length) - tag.end;
		if (!close) break;
		const text = replaceTags(html.slice(tag.end + 1, close.index), '', meter).trim();
		anchors.push({ href: tag.href, text });
		pos = close.index + close[0].length;
	}
	return anchors;
}
