/**
 * The line model `segmentMessage` (`./mailSegments`) classifies: a message
 * body turned into visible lines, each with its quote depth, a structural hint
 * from the HTML (a Gmail quote container, an Outlook reply header), and a
 * source map from every character back to the text or HTML it came from.
 *
 * Plain text: lines split on any line break; leading `>` markers become the
 * depth and leave the line, trailing whitespace goes.
 *
 * HTML is read by `./mailSegmentsHtml` into the same line model.
 *
 * Every pass is a single forward scan, so the cost stays linear.
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
	/** The innermost quote container (Gmail `gmail_quote`) holding the line. */
	container?: QuoteContainer;
}

/**
 * A quote container, numbered in document order. Containers opened inside it
 * are numbered `id + 1 … last`, so "inside C" is an interval test.
 */
export interface QuoteContainer {
	id: number;
	last: number;
}

/** Whether `line` sits inside `container` (directly or in a nested one). */
export function insideContainer(line: SourceLine, container: QuoteContainer): boolean {
	const own = line.container;
	return !!own && own.id >= container.id && own.id <= container.last;
}

/**
 * Work a scan did, for the linear-time tests: `chars` counts input characters
 * read (a search that finds nothing counts up to the end of the input),
 * `steps` counts open elements visited. Callers outside tests pass none.
 */
export interface SegmentWork {
	chars: number;
	steps: number;
}

export interface LineSourceOptions {
	/** Whether an inline `style` value hides its element. */
	styleHides?: (style: string) => boolean;
	work?: SegmentWork;
}

const QUOTE_MARKERS = /^((?:[ \t]*>)+)[ \t]?/;

/** Per-character source ranges, compressed into runs once the line is final. */
export class LineBuilder {
	chars: string[] = [];
	srcS: number[] = [];
	srcE: number[] = [];
	depth = 0;
	hint: LineHint | undefined;
	afterRule = false;
	container: QuoteContainer | undefined;
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
export function finishLine(b: LineBuilder, srcEnd: number): SourceLine {
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
		...(b.container ? { container: b.container } : {}),
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
