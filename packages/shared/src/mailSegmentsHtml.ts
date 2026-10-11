/**
 * HTML bodies into the `segmentMessage` line model (`./mailSegmentsSource`).
 *
 * It follows the rules of `htmlToPlainText` (`@owlat/shared/html`), the text
 * every other feature reads a message as: comments and `<head>` drop out with
 * their content (an unterminated `<head>` loses only its tag), every tag is
 * removed, the same named and numeric entities decode, and `<br>`, block ends
 * and `</p>`/`</h1-6>` break lines the way its `preserveBreaks` layout does.
 *
 * What may be shown is decided at least as conservatively as the security
 * scan's hidden-markup strip (`agent/steps/security_scan/hiddenMarkup.ts`);
 * it never tries to out-guess a browser in the showing direction:
 *   - tags tokenize the way a browser reads them: a `>` inside a quoted
 *     attribute value does not end the tag, and an unterminated tag or quoted
 *     value swallows the rest of the input;
 *   - EVERY element, raw-text and `plaintext` ones included, is hidden by the
 *     `hidden` attribute or an inline style (default test `display:none` /
 *     `visibility:hidden`; the backend passes the scan's stricter
 *     `styleHides`), and so is everything inside a hidden element;
 *   - the scan's always-hidden elements drop with their content: raw-text
 *     `script`, `style`, `title`, `iframe`, `noembed`, `noframes`, and parsed
 *     `template`, `datalist`, `rp`, plus `noscript`;
 *   - a raw-text element ends only at an end tag of its exact name followed by
 *     whitespace, `/` or `>` (`</script_>` and `</style:x>` end nothing);
 *   - a hidden formatting element closed implicitly keeps hiding until its own
 *     end tag, as browsers reopen it; an end tag reaching past a `<select>`, a
 *     table cell, a caption or a template is ignored, as a browser ignores it
 *     (`./mailSegmentsElements`); `</body>` and `</html>` close nothing;
 *   - a hidden `<body>` or `<html>` tag anywhere hides the whole document.
 * The backend runs the security scan's own `stripHiddenContent` before this
 * (`mail/interpret/scope.ts`), so these rules are defence in depth there.
 * Whitespace inside text collapses to one space (`<pre>` keeps it), blockquote
 * nesting adds to the depth, `>` markers inside HTML text count too, and a
 * Gmail quote container is tracked over its whole extent.
 *
 * Linear: every character is read a bounded number of times. A raw-text close
 * search remembers its answer, so repeated unclosed `<head>`/`<script>` tags do
 * not rescan the rest of the input; the element stack is amortised.
 * `options.work` counts the work for tests.
 */
import {
	BLOCK,
	ElementStack,
	PARSED_HIDDEN,
	RAW_HIDDEN,
	RAW_SHOWN,
	VOID,
} from './mailSegmentsElements';
import {
	LineBuilder,
	finishLine,
	type LineHint,
	type LineSourceOptions,
	type SourceLine,
} from './mailSegmentsSource';

const PARAGRAPH = /^(?:p|h[1-6])$/;
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/iy;
const NAMED = new Map([
	['amp', '&'],
	['lt', '<'],
	['gt', '>'],
	['quot', '"'],
	['apos', "'"],
	['nbsp', ' '],
]);
const COMMENT_END = /--!?>/g;

const DEFAULT_STYLE_HIDES = (style: string) =>
	/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);

const isSpace = (c: string | undefined) =>
	c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isAlpha = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);

interface Tag {
	name: string;
	isEnd: boolean;
	attrs: Map<string, string>;
	end: number;
}

/**
 * The tag starting at `html[i] === '<'`, or null when `<` starts no tag. Quoted
 * attribute values may hold `>`; a tag or value left open runs to the end.
 */
function scanTag(html: string, i: number): Tag | null {
	const n = html.length;
	let j = i + 1;
	const isEnd = html[j] === '/';
	if (isEnd) j++;
	if (!isAlpha(html[j])) return null;
	const nameStart = j;
	while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
	const tag: Tag = {
		name: html.slice(nameStart, j).toLowerCase(),
		isEnd,
		attrs: new Map(),
		end: n,
	};
	while (j < n) {
		const c = html[j];
		if (isSpace(c)) {
			j++;
		} else if (c === '>') {
			tag.end = j + 1;
			return tag;
		} else if (c === '/') {
			j++;
		} else {
			const nameAt = j++;
			while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') {
				j++;
			}
			const attr = html.slice(nameAt, j).toLowerCase();
			while (j < n && isSpace(html[j])) j++;
			let value = '';
			if (html[j] === '=') {
				j++;
				while (j < n && isSpace(html[j])) j++;
				const quote = html[j];
				if (quote === '"' || quote === "'") {
					const close = html.indexOf(quote, j + 1);
					if (close === -1) return tag;
					value = html.slice(j + 1, close);
					j = close + 1;
				} else {
					const at = j;
					while (j < n && !isSpace(html[j]) && html[j] !== '>') j++;
					value = html.slice(at, j);
				}
			}
			if (!tag.attrs.has(attr)) tag.attrs.set(attr, value);
		}
	}
	return tag;
}

function hintOf(tag: Tag): LineHint | undefined {
	if (tag.name !== 'div') return undefined;
	const cls = tag.attrs.get('class') ?? '';
	if (/(?:^|\s)gmail_quote(?:\s|$)/.test(cls)) return 'quoteContainer';
	if (/(?:^|\s)moz-forward-container(?:\s|$)/.test(cls)) return 'forwardContainer';
	if (/^divRplyFwdMsg$/i.test(tag.attrs.get('id') ?? '')) return 'outlookHeader';
	if (/border-top:\s*solid\s+#(?:e1e1e1|b5c4df)\b/i.test(tag.attrs.get('style') ?? '')) {
		return 'outlookHeader';
	}
	return undefined;
}

function fromCodePoint(code: number): string {
	if (code === 0xa0) return ' ';
	if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
	return String.fromCodePoint(code);
}

/** Lines of an HTML body. */
export function linesFromHtml(html: string, options: LineSourceOptions = {}): SourceLine[] {
	const styleHides = options.styleHides ?? DEFAULT_STYLE_HIDES;
	const work = options.work ?? { chars: 0, steps: 0 };
	const n = html.length;
	const lines: SourceLine[] = [];
	const stack = new ElementStack(work);
	let line = new LineBuilder(0);
	let pendingHint: LineHint | undefined;
	let pendingRule = false;
	let space: [number, number] | null = null;
	let documentHidden = false;

	// The first raw-text close tag at or after a position, remembered per name:
	// positions only grow, so a search never rescans what an earlier one read.
	const closeSearch = new Map<string, { re: RegExp; from: number; at: number }>();
	const findClose = (name: string, from: number): number => {
		let entry = closeSearch.get(name);
		if (entry && from >= entry.from && (entry.at === -1 || from <= entry.at)) return entry.at;
		if (!entry) {
			// An end tag's name ends at ASCII whitespace, `/` or `>`: `</script_>` and
			// `</style:x>` close nothing.
			entry = { re: new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi'), from, at: -1 };
			closeSearch.set(name, entry);
		}
		entry.re.lastIndex = from;
		const match = entry.re.exec(html);
		entry.from = from;
		entry.at = match ? match.index : -1;
		work.chars += (match ? match.index : n) - from;
		return entry.at;
	};

	const breakLine = (at: number, end = at) => {
		if (!line.empty || lines.length === 0 || lines[lines.length - 1]?.text !== '') {
			lines.push(finishLine(line, at));
		}
		line = new LineBuilder(end);
		space = null;
	};
	const softBreak = (at: number, end: number) => {
		if (!line.empty) breakLine(at, end);
		else line.srcStart = end;
	};
	const emit = (text: string, s: number, e: number) => {
		if (stack.hidden) return;
		if (line.empty) {
			line.depth = stack.quoteDepth;
			line.hint = pendingHint;
			line.afterRule = pendingRule;
			line.container = stack.container;
			pendingHint = undefined;
			pendingRule = false;
			space = null;
		} else if (space) {
			line.push(' ', space[0], space[1]);
			space = null;
		}
		line.push(text, s, e);
	};
	/** Text from `i`, up to `end`: entities decode, whitespace collapses (or not, in `<pre>`). */
	const emitText = (from: number, end: number, entities: boolean) => {
		let i = from;
		while (i < end) {
			work.chars++;
			const c = html[i] as string;
			if (c === '&' && entities) {
				ENTITY.lastIndex = i;
				const entity = ENTITY.exec(html);
				if (entity && i + entity[0].length <= end) {
					const [, dec, hex, named] = entity;
					const decoded =
						dec !== undefined
							? fromCodePoint(Number.parseInt(dec, 10))
							: hex !== undefined
								? fromCodePoint(Number.parseInt(hex, 16))
								: (NAMED.get((named as string).toLowerCase()) as string);
					emit(decoded, i, i + entity[0].length);
					i += entity[0].length;
					continue;
				}
			}
			if (isSpace(c)) {
				if (!stack.hidden) {
					if (stack.pre > 0) {
						if (c === '\n') breakLine(i, i + 1);
						else if (c !== '\r') emit(c, i, i + 1);
					} else if (!line.empty) {
						space = space ? [space[0], i + 1] : [i, i + 1];
					}
				}
			} else {
				emit(c, i, i + 1);
			}
			i++;
		}
	};
	let i = 0;
	while (i < n) {
		if (html[i] !== '<') {
			let next = html.indexOf('<', i + 1);
			if (next === -1) next = n;
			emitText(i, next, true);
			i = next;
			continue;
		}
		if (html.startsWith('<!--', i)) {
			COMMENT_END.lastIndex = i + 2;
			const close = COMMENT_END.exec(html);
			const end = close ? close.index + close[0].length : n;
			work.chars += end - i;
			i = end;
			continue;
		}
		const tag = scanTag(html, i);
		if (!tag) {
			const c = html[i + 1];
			if (c === '!' || c === '?' || c === '/') {
				// A markup declaration, processing instruction or bogus end tag.
				const close = html.indexOf('>', i + 1);
				const end = close === -1 ? n : close + 1;
				work.chars += end - i;
				i = end;
			} else {
				emitText(i, i + 1, false);
				i++;
			}
			continue;
		}
		work.chars += tag.end - i;
		const { name } = tag;
		if (tag.isEnd) {
			const wasHidden = stack.hidden;
			if (stack.close(name) && !wasHidden && BLOCK.has(name)) {
				softBreak(i, tag.end);
				if (PARAGRAPH.test(name)) breakLine(i, tag.end);
			}
			i = tag.end;
			continue;
		}
		// Every element's own visibility, raw-text and `plaintext` ones included.
		const ownHidden =
			RAW_HIDDEN.has(name) ||
			PARSED_HIDDEN.has(name) ||
			tag.attrs.has('hidden') ||
			styleHides(tag.attrs.get('style') ?? '');
		if (RAW_HIDDEN.has(name) || RAW_SHOWN.has(name) || name === 'head') {
			const close = findClose(name, tag.end);
			if (name === 'head' && close === -1) {
				i = tag.end;
				continue;
			}
			const contentEnd = close === -1 ? n : close;
			if (RAW_SHOWN.has(name) && !ownHidden && !stack.hidden) {
				emitText(tag.end, contentEnd, name === 'textarea');
			}
			i = close === -1 ? n : (scanTag(html, close)?.end ?? n);
			continue;
		}
		if ((name === 'body' || name === 'html') && ownHidden) {
			// A browser merges a later `<body>`/`<html>` tag's attributes into the
			// one element there is: the whole document is hidden, before and after.
			documentHidden = true;
		}
		if (name === 'plaintext') {
			// Everything after it is text, shown only when nothing hides it.
			if (!ownHidden && !stack.hidden) emitText(tag.end, n, false);
			i = n;
			continue;
		}
		stack.closeFor(name);
		if (name === 'br') {
			if (!stack.hidden) breakLine(i, tag.end);
		} else if (name === 'hr') {
			if (!stack.hidden) {
				softBreak(i, tag.end);
				pendingRule = true;
			}
		} else if (!VOID.has(name)) {
			if (BLOCK.has(name) && !stack.hidden && !ownHidden) softBreak(i, tag.end);
			const hint = !stack.hidden && !ownHidden ? hintOf(tag) : undefined;
			// `/>` closes nothing on an HTML element: only void elements are empty.
			stack.open(name, ownHidden, hint === 'quoteContainer' || hint === 'forwardContainer');
			if (hint) pendingHint = hint;
		}
		i = tag.end;
	}
	if (!line.empty) lines.push(finishLine(line, n));
	stack.finish();
	return documentHidden ? [] : lines;
}
