/**
 * The line model `segmentMessage` (`./mailSegments`) classifies: a message
 * body turned into visible lines, each with its quote depth, a structural hint
 * from the HTML (a Gmail quote container, an Outlook reply header), and a
 * source map from every character back to the text or HTML it came from.
 *
 * Plain text: lines split on any line break; leading `>` markers become the
 * depth and leave the line, trailing whitespace goes.
 *
 * HTML follows the rules of `htmlToPlainText` (`@owlat/shared/html`), the text
 * every other feature reads a message as: comments and `<script>`, `<style>`
 * and `<head>` drop out with their content (an unterminated `<head>` loses only
 * its tag), every tag is removed, the same named and numeric entities decode,
 * and `<br>`, block ends and `</p>`/`</h1-6>` break lines the way its
 * `preserveBreaks` layout does. Two deliberate differences, both closer to what
 * the reader renders:
 *   - whitespace inside text collapses to one space, as a browser shows it
 *     (`<pre>` keeps it), instead of keeping the source's line breaks;
 *   - an element hidden by the `hidden` attribute or an inline style is
 *     skipped with its content. The default test is `display:none` /
 *     `visibility:hidden`; a caller with a stricter test (the security scan's
 *     `styleHides`, which also catches zero font size and invisible text)
 *     passes it in.
 * Blockquote nesting adds to the depth, and `>` markers inside HTML text count
 * too (some clients render a plain-text reply that way).
 *
 * One forward pass; every regex is sticky at the current position or bounded,
 * so the scan stays linear on hostile markup.
 */

/** A canonical range `[start, end)` and the source range it came from. */
export interface SourceRun {
	start: number;
	end: number;
	srcStart: number;
	srcEnd: number;
}

export type LineHint = 'quoteContainer' | 'outlookHeader' | 'forwardContainer';

export interface SourceLine {
	/** Visible text: `>` markers stripped, trailing whitespace trimmed. */
	text: string;
	/** Blockquote nesting plus `>` markers. */
	depth: number;
	/** Runs relative to `text`; source offsets are absolute. */
	runs: SourceRun[];
	/** Source offsets around the line, for the line break that joins it. */
	srcStart: number;
	srcEnd: number;
	/** Set on the first line inside a structural container. */
	hint?: LineHint;
	/** The line follows a `<hr>`. */
	afterRule?: boolean;
}

export interface LineSourceOptions {
	/** Whether an inline `style` value hides its element. */
	styleHides?: (style: string) => boolean;
}

const QUOTE_MARKERS = /^((?:[ \t]*>)+)[ \t]?/;

/** Per-character source ranges, compressed into runs once the line is final. */
class LineBuilder {
	chars: string[] = [];
	srcS: number[] = [];
	srcE: number[] = [];
	depth = 0;
	hint: LineHint | undefined;
	afterRule = false;
	srcStart: number;

	constructor(srcStart: number) {
		this.srcStart = srcStart;
	}

	push(text: string, srcStart: number, srcEnd: number): void {
		for (const unit of text) {
			for (let k = 0; k < unit.length; k++) {
				this.chars.push(unit[k] as string);
				this.srcS.push(srcStart);
				this.srcE.push(srcEnd);
			}
		}
	}

	get empty(): boolean {
		return this.chars.length === 0;
	}
}

/** Strip `>` markers and trailing blanks, then compress the char map into runs. */
function finishLine(b: LineBuilder, srcEnd: number): SourceLine {
	let from = 0;
	let to = b.chars.length;
	while (to > from && /\s/.test(b.chars[to - 1] as string)) to--;
	let depth = b.depth;
	const head = b.chars.slice(0, Math.min(to, 200)).join('');
	const markers = QUOTE_MARKERS.exec(head);
	if (markers) {
		depth += (markers[1]?.match(/>/g) ?? []).length;
		from = markers[0].length;
	}
	const runs: SourceRun[] = [];
	for (let k = from; k < to; k++) {
		const s = b.srcS[k] as number;
		const e = b.srcE[k] as number;
		const at = k - from;
		const last = runs[runs.length - 1];
		const lastOneToOne = last && last.end - last.start === last.srcEnd - last.srcStart;
		if (last && lastOneToOne && e - s === 1 && last.end === at && last.srcEnd === s) {
			last.end++;
			last.srcEnd = e;
		} else if (last && last.srcStart === s && last.srcEnd === e && last.end === at) {
			last.end++;
		} else {
			runs.push({ start: at, end: at + 1, srcStart: s, srcEnd: e });
		}
	}
	return {
		text: b.chars.slice(from, to).join(''),
		depth,
		runs,
		srcStart: b.srcStart,
		srcEnd,
		...(b.hint ? { hint: b.hint } : {}),
		...(b.afterRule ? { afterRule: true } : {}),
	};
}

/** Lines of a plain-text body. */
export function linesFromText(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	const breaks = /\r\n|\r|\n/g;
	let start = 0;
	for (;;) {
		const match = breaks.exec(text);
		const end = match ? match.index : text.length;
		const b = new LineBuilder(start);
		for (let k = start; k < end; k++) b.push(text[k] as string, k, k + 1);
		lines.push(finishLine(b, end));
		if (!match) break;
		start = match.index + match[0].length;
	}
	return lines;
}

const TAG = /<[a-zA-Z/!?][^>]*(?:>|$)/y;
const TAG_NAME = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/iy;
const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};
const RAW_CLOSE: Record<string, RegExp> = {
	script: /<\/script\s*>/gi,
	style: /<\/style\s*>/gi,
	head: /<\/head\s*>/gi,
};
const VOID = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr',
]);
const BLOCK = new Set([
	'address',
	'article',
	'aside',
	'blockquote',
	'center',
	'dd',
	'div',
	'dl',
	'dt',
	'figure',
	'footer',
	'form',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'header',
	'li',
	'main',
	'nav',
	'ol',
	'p',
	'pre',
	'section',
	'table',
	'tbody',
	'td',
	'th',
	'thead',
	'tr',
	'ul',
]);
const PARAGRAPH = /^(?:p|h[1-6])$/;

const DEFAULT_STYLE_HIDES = (style: string) =>
	/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);

function attribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
	return match ? (match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}

function hintOf(name: string, tag: string): LineHint | undefined {
	if (name !== 'div') return undefined;
	const cls = attribute(tag, 'class') ?? '';
	if (/(?:^|\s)gmail_quote(?:\s|$)/.test(cls)) return 'quoteContainer';
	if (/(?:^|\s)moz-forward-container(?:\s|$)/.test(cls)) return 'forwardContainer';
	if (/^divRplyFwdMsg$/i.test(attribute(tag, 'id') ?? '')) return 'outlookHeader';
	const style = attribute(tag, 'style') ?? '';
	if (/border-top:\s*solid\s+#(?:e1e1e1|b5c4df)\b/i.test(style)) return 'outlookHeader';
	return undefined;
}

interface OpenElement {
	name: string;
	hidden: boolean;
}

function fromCodePoint(code: number): string {
	if (code === 0xa0) return ' ';
	if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
	return String.fromCodePoint(code);
}

/** Lines of an HTML body. */
export function linesFromHtml(html: string, options: LineSourceOptions = {}): SourceLine[] {
	const styleHides = options.styleHides ?? DEFAULT_STYLE_HIDES;
	const lines: SourceLine[] = [];
	const stack: OpenElement[] = [];
	let hiddenOpen = 0;
	let quoteDepth = 0;
	let pre = 0;
	let line = new LineBuilder(0);
	let pendingHint: LineHint | undefined;
	let pendingRule = false;
	let space: [number, number] | null = null;

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
		if (hiddenOpen > 0) return;
		if (line.empty) {
			line.depth = quoteDepth;
			line.hint = pendingHint;
			line.afterRule = pendingRule;
			pendingHint = undefined;
			pendingRule = false;
			space = null;
		} else if (space) {
			line.push(' ', space[0], space[1]);
			space = null;
		}
		line.push(text, s, e);
	};

	let i = 0;
	while (i < html.length) {
		const c = html[i] as string;
		if (c === '<') {
			if (html.startsWith('<!--', i)) {
				const close = html.indexOf('-->', i + 2);
				i = close === -1 ? html.length : close + 3;
				continue;
			}
			TAG.lastIndex = i;
			const tagMatch = TAG.exec(html);
			if (!tagMatch) {
				emit('<', i, i + 1);
				i++;
				continue;
			}
			const tag = tagMatch[0];
			const tagEnd = i + tag.length;
			const name = (TAG_NAME.exec(tag)?.[1] ?? '').toLowerCase();
			const isEnd = tag[1] === '/';
			if (!name) {
				i = tagEnd;
				continue;
			}
			if (!isEnd && RAW_CLOSE[name]) {
				const closeRe = RAW_CLOSE[name] as RegExp;
				closeRe.lastIndex = tagEnd;
				const close = closeRe.exec(html);
				if (close) i = close.index + close[0].length;
				else i = name === 'head' ? tagEnd : html.length;
				continue;
			}
			if (name === 'br' && !isEnd) {
				if (hiddenOpen === 0) breakLine(i, tagEnd);
			} else if (name === 'hr' && !isEnd) {
				if (hiddenOpen === 0) {
					softBreak(i, tagEnd);
					pendingRule = true;
				}
			} else if (isEnd) {
				let at = stack.length - 1;
				while (at >= 0 && stack[at]?.name !== name) at--;
				if (at >= 0) {
					const wasHidden = hiddenOpen > 0;
					for (const open of stack.splice(at)) {
						if (open.hidden) hiddenOpen--;
						if (open.name === 'blockquote') quoteDepth--;
						if (open.name === 'pre') pre--;
					}
					if (!wasHidden && BLOCK.has(name)) {
						softBreak(i, tagEnd);
						if (PARAGRAPH.test(name)) breakLine(i, tagEnd);
					}
				}
			} else if (!VOID.has(name)) {
				const hidden =
					/\shidden(?:[\s=/>]|$)/i.test(tag) || styleHides(attribute(tag, 'style') ?? '');
				if (BLOCK.has(name) && hiddenOpen === 0 && !hidden) softBreak(i, tagEnd);
				if (!tag.endsWith('/>')) {
					stack.push({ name, hidden });
					if (hidden) hiddenOpen++;
					if (name === 'blockquote') quoteDepth++;
					if (name === 'pre') pre++;
				}
				const hint = hintOf(name, tag);
				if (hint && hiddenOpen === 0) pendingHint = hint;
			}
			i = tagEnd;
			continue;
		}
		if (c === '&') {
			ENTITY.lastIndex = i;
			const entity = ENTITY.exec(html);
			if (entity) {
				const [, dec, hex, named] = entity;
				const decoded =
					dec !== undefined
						? fromCodePoint(Number.parseInt(dec, 10))
						: hex !== undefined
							? fromCodePoint(Number.parseInt(hex, 16))
							: (NAMED[(named as string).toLowerCase()] as string);
				emit(decoded, i, i + entity[0].length);
				i += entity[0].length;
				continue;
			}
		}
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
			if (hiddenOpen === 0) {
				if (pre > 0) {
					if (c === '\n') breakLine(i, i + 1);
					else if (c !== '\r') emit(c, i, i + 1);
				} else if (!line.empty) {
					space = space ? [space[0], i + 1] : [i, i + 1];
				}
			}
			i++;
			continue;
		}
		emit(c, i, i + 1);
		i++;
	}
	if (!line.empty) lines.push(finishLine(line, html.length));
	return lines;
}

/** Drop leading and trailing blank lines and squeeze blank runs to one. */
export function squeezeBlankLines(lines: SourceLine[]): SourceLine[] {
	const out: SourceLine[] = [];
	for (const current of lines) {
		const blank = current.text.trim() === '';
		const prev = out[out.length - 1];
		if (blank && (!prev || prev.text.trim() === '')) continue;
		out.push(blank ? { ...current, text: '', runs: [] } : current);
	}
	while (out.length > 0 && out[out.length - 1]?.text === '') out.pop();
	return out;
}
