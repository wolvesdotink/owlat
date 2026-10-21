/**
 * Finding `<img>` start tags in an HTML string the way the browser does, for
 * the remote-image strip in `postboxTrackers.ts`. String surgery only: the
 * strip runs where there is no DOM (the Convex agent pipeline), so this reads
 * just enough of the HTML tokenizer to know where a tag starts and ends.
 */

/**
 * Called with each `<img …>` tag's text; returns what replaces it. `tokenized`
 * is true when the text is the whole tag as the tokenizer read it in its
 * context, and false for the floor's first-`>` reading, which may be cut
 * short inside a quoted value or sit where the browser sees no tag at all.
 */
type ImgTagReplacer = (tag: string, tokenized: boolean) => string;

/**
 * The work a scan did, for tests that hold hostile input to linear cost by
 * counting it instead of timing it. `chars` is characters visited by loops and
 * searches, a failed search's whole span included; `steps` is per-item work
 * (tags handed to a replacer, rounds, element hints derived). Optional on
 * every entry point, so production callers pay one branch per search.
 */
export interface ScanWork {
	chars: number;
	steps: number;
}

/** `haystack.indexOf(needle, from)`, counting the characters it searched. */
function countedIndexOf(
	haystack: string,
	needle: string,
	from: number,
	work: ScanWork | undefined
): number {
	const found = haystack.indexOf(needle, from);
	if (work) work.chars += (found === -1 ? haystack.length : found + needle.length) - from;
	return found;
}

/**
 * `re.exec(input)` for a global or sticky regex, counting the span from its
 * `lastIndex` to the end of the match (or of the input when there is none).
 * The span is what a linear regex reads; a backtracking one reads more, which
 * no counter outside the engine sees.
 */
function countedExec(
	re: RegExp,
	input: string,
	work: ScanWork | undefined
): RegExpExecArray | null {
	const from = re.lastIndex;
	const match = re.exec(input);
	if (work) work.chars += (match ? match.index + match[0].length : input.length) - from;
	return match;
}

// The tokenizer states a start tag passes through between its name and `>`
// (HTML spec 13.2.5.8 onwards; the self-closing and after-quoted-value states
// behave like before-attribute-name here, so they share it).
const TAG_NAME = 0;
const BEFORE_ATTR_NAME = 1;
const ATTR_NAME = 2;
const AFTER_ATTR_NAME = 3;
const BEFORE_ATTR_VALUE = 4;
const DOUBLE_QUOTED = 5;
const SINGLE_QUOTED = 6;
const UNQUOTED = 7;
type TagState =
	| typeof TAG_NAME
	| typeof BEFORE_ATTR_NAME
	| typeof ATTR_NAME
	| typeof AFTER_ATTR_NAME
	| typeof BEFORE_ATTR_VALUE
	| typeof DOUBLE_QUOTED
	| typeof SINGLE_QUOTED
	| typeof UNQUOTED;

function isTagWhitespace(c: string): boolean {
	return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

function isAsciiAlpha(c: string): boolean {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * Tokenize the tag whose name begins at `from` the way the browser does,
 * reporting each attribute (lowercased name, raw value) to `onAttr`. Returns
 * the index of the `>` that closes the tag, or -1 when the input ends first.
 * A `>` inside a quoted value does not close the tag, and a quote only opens a
 * value right after `=`: in a name or an unquoted value it is a character.
 * End tags tokenize their attributes the same way, so this reads them too.
 */
export function scanStartTag(
	html: string,
	from: number,
	onAttr?: (name: string, value: string) => void,
	work?: ScanWork
): number {
	const close = scanToTagEnd(html, from, onAttr);
	// The loop visits every character from `from` through the closing `>`.
	if (work) work.chars += (close === -1 ? html.length : close + 1) - from;
	return close;
}

function scanToTagEnd(
	html: string,
	from: number,
	onAttr: ((name: string, value: string) => void) | undefined
): number {
	let state: TagState = TAG_NAME;
	let nameStart = 0;
	let name = '';
	let valueStart = 0;
	for (let i = from; i < html.length; i++) {
		const c = html.charAt(i);
		switch (state) {
			case TAG_NAME:
				if (c === '>') return i;
				if (isTagWhitespace(c) || c === '/') state = BEFORE_ATTR_NAME;
				break;
			case BEFORE_ATTR_NAME:
				if (c === '>') return i;
				if (isTagWhitespace(c) || c === '/') break;
				// Anything else, `=` and quotes included, starts a name.
				nameStart = i;
				state = ATTR_NAME;
				break;
			case ATTR_NAME:
			case AFTER_ATTR_NAME:
				if (state === ATTR_NAME) {
					if (!isTagWhitespace(c) && c !== '/' && c !== '>' && c !== '=') break;
					name = html.slice(nameStart, i).toLowerCase();
					state = AFTER_ATTR_NAME;
				}
				if (isTagWhitespace(c)) break;
				if (c === '=') {
					state = BEFORE_ATTR_VALUE;
					break;
				}
				onAttr?.(name, '');
				if (c === '>') return i;
				if (c === '/') {
					state = BEFORE_ATTR_NAME;
				} else {
					nameStart = i;
					state = ATTR_NAME;
				}
				break;
			case BEFORE_ATTR_VALUE:
				if (isTagWhitespace(c)) break;
				if (c === '>') {
					onAttr?.(name, '');
					return i;
				}
				valueStart = c === '"' || c === "'" ? i + 1 : i;
				state = c === '"' ? DOUBLE_QUOTED : c === "'" ? SINGLE_QUOTED : UNQUOTED;
				break;
			case DOUBLE_QUOTED:
			case SINGLE_QUOTED:
				if (c !== (state === DOUBLE_QUOTED ? '"' : "'")) break;
				onAttr?.(name, html.slice(valueStart, i));
				state = BEFORE_ATTR_NAME;
				break;
			case UNQUOTED:
				if (!isTagWhitespace(c) && c !== '>') break;
				onAttr?.(name, html.slice(valueStart, i));
				if (c === '>') return i;
				state = BEFORE_ATTR_NAME;
				break;
		}
	}
	return -1;
}

/** The lowercased name of the tag whose name begins at `from`. */
function tagName(html: string, from: number, work: ScanWork | undefined): string {
	let end = from;
	while (end < html.length) {
		const c = html.charAt(end);
		if (isTagWhitespace(c) || c === '/' || c === '>') break;
		end++;
	}
	if (work) work.chars += end - from + 1;
	return html.slice(from, end).toLowerCase();
}

// Elements whose content is text up to their own end tag (RAWTEXT and RCDATA
// in the tokenizer), so an `<img` inside them is not a tag. The end tag is
// `</name` followed by whitespace, `/` or `>`, in any case. A Map, so a tag
// named after an Object.prototype member (`<constructor>`) finds nothing.
const TEXT_CONTENT_END: ReadonlyMap<string, RegExp> = new Map(
	['iframe', 'noembed', 'noframes', 'script', 'style', 'textarea', 'title', 'xmp'].map((name) => [
		name,
		new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi'),
	])
);

/**
 * Index just past a comment whose `<!--` ends right before `from`, or the
 * input's length when the input ends inside it. `<!-->` and `<!--->` close at
 * once; otherwise the first `-->` or `--!>` closes it.
 */
function afterComment(html: string, from: number, work: ScanWork | undefined): number {
	if (html.charAt(from) === '>') return from + 1;
	if (html.startsWith('->', from)) return from + 2;
	let at = from;
	for (;;) {
		const dashes = countedIndexOf(html, '--', at, work);
		if (dashes === -1) return html.length;
		if (html.charAt(dashes + 2) === '>') return dashes + 3;
		if (html.startsWith('!>', dashes + 2)) return dashes + 4;
		at = dashes + 1;
	}
}

/** Index just past a bogus comment (`<!…>`, `<?…>`, `</ …>`): its first `>`. */
function afterBogusComment(html: string, from: number, work: ScanWork | undefined): number {
	const close = countedIndexOf(html, '>', from, work);
	return close === -1 ? html.length : close + 1;
}

/**
 * Replace every `<img …>` start tag the browser's tokenizer would emit, in one
 * linear pass. Comments, bogus comments (`<!DOCTYPE …>`, `<?…>`, `<![CDATA[…`
 * outside SVG/MathML), end tags, the attributes of every other tag, and the
 * text content of `<style>`, `<script>`, `<textarea>`, `<title>` and the other
 * raw-text elements are read and stepped over, so an `<img` written inside
 * them never starts a tag. A construct the input ends inside (an open
 * comment, an unterminated quote) runs to the end, as in the browser, and the
 * rest of the input is left as it is. Returns the output and the offsets in
 * it of the `<img` tags that were read and kept.
 *
 * Not modelled: SVG/MathML foreign content (where `<style>` holds markup and
 * `<![CDATA[` runs to `]]>`), the script-data escape states, and `<noscript>`
 * read with scripting on. `replaceImgTags` covers those with a second pass,
 * and `escapeImgTextInForeignContent` with a last one.
 */
function replaceTokenizedImgTags(
	html: string,
	replace: ImgTagReplacer,
	work: ScanWork | undefined
): { html: string; keptAt: Set<number> } {
	const keptAt = new Set<number>();
	let out = '';
	let from = 0;
	let at = 0;
	while (at < html.length) {
		const open = countedIndexOf(html, '<', at, work);
		if (open === -1) break;
		const next = html.charAt(open + 1);
		if (isAsciiAlpha(next)) {
			const close = scanStartTag(html, open + 1, undefined, work);
			// The input ends inside the tag: nothing after it is a tag.
			if (close === -1) break;
			const name = tagName(html, open + 1, work);
			if (name === 'img') {
				const tag = html.slice(open, close + 1);
				if (work) work.steps += 1;
				const replacement = replace(tag, true);
				out += html.slice(from, open);
				if (replacement === tag) keptAt.add(out.length);
				out += replacement;
				from = close + 1;
			}
			at = close + 1;
			if (name === 'plaintext') break;
			const textEnd = TEXT_CONTENT_END.get(name);
			if (textEnd) {
				textEnd.lastIndex = at;
				const end = countedExec(textEnd, html, work);
				if (!end) break;
				at = end.index;
			}
		} else if (next === '/') {
			const after = html.charAt(open + 2);
			if (isAsciiAlpha(after)) {
				const close = scanStartTag(html, open + 2, undefined, work);
				if (close === -1) break;
				at = close + 1;
			} else if (after === '>') {
				at = open + 3;
			} else {
				at = afterBogusComment(html, open + 2, work);
			}
		} else if (next === '!') {
			at = html.startsWith('--', open + 2)
				? afterComment(html, open + 4, work)
				: afterBogusComment(html, open + 2, work);
		} else if (next === '?') {
			at = afterBogusComment(html, open + 1, work);
		} else {
			// A `<` that starts no tag is text.
			at = open + 1;
		}
	}
	return { html: out + html.slice(from), keptAt };
}

// The start of an `<img` tag for the floor pass, which ends each tag at its
// first `>` (with indexOf rather than `<img\b[^>]*>`, which backtracks
// quadratically over unterminated tags).
const IMG_TAG_START_RE = /<img(?![\w])/gi;

/**
 * The scanner `replaceImgTags` used before it read context, kept as a floor.
 * A tag at an offset in `keptAt` was read whole and kept by the tokenizer, so
 * it is kept again; the scan still resumes after its first `>`, as before.
 */
function replaceImgTagsToFirstGt(
	html: string,
	keptAt: ReadonlySet<number>,
	replace: ImgTagReplacer,
	work: ScanWork | undefined
): string {
	const starts = new RegExp(IMG_TAG_START_RE.source, 'gi');
	let out = '';
	let from = 0;
	let match: RegExpExecArray | null;
	while ((match = countedExec(starts, html, work))) {
		const close = countedIndexOf(html, '>', match.index, work);
		// No `>` left: no later tag can close either.
		if (close === -1) break;
		if (!keptAt.has(match.index)) {
			if (work) work.steps += 1;
			out += html.slice(from, match.index) + replace(html.slice(match.index, close + 1), false);
			from = close + 1;
		}
		starts.lastIndex = close + 1;
	}
	return out + html.slice(from);
}

/**
 * Replace every `<img …>` tag, in two linear passes. The first reads the
 * document as the browser's tokenizer does (`replaceTokenizedImgTags`), so a
 * `>` inside a quoted value neither ends a tag nor hides one. The second is
 * the earlier first-`>` scanner run over the result, so wherever the
 * tokenizer's model and a real parser disagree (SVG/MathML content, Outlook
 * conditional comments, which Outlook renders) an `<img` the earlier scanner
 * would have handed to `replace` still reaches it, marked as not tokenized.
 */
export function replaceImgTags(html: string, replace: ImgTagReplacer, work?: ScanWork): string {
	const tokenized = replaceTokenizedImgTags(html, replace, work);
	return replaceImgTagsToFirstGt(tokenized.html, tokenized.keptAt, replace, work);
}

// An `<svg>` or `<math>` start tag: SVG/MathML foreign content, where the
// tree builder (not just the tokenizer) decides which `<img` is a tag.
const FOREIGN_CONTENT_RE = /<(?:svg|math)[\t\n\f\r />]/i;

/**
 * In a document with SVG or MathML content, turn every `<img` the tokenizer
 * does not read as a tag into text (`&lt;img`). There, a `<style>` or
 * `<title>` holds markup, a `<![CDATA[` runs to `]]>`, and an `<img` closes
 * the SVG it sits in, so removing a tag can turn text the tokenizer stepped
 * over into a tag. An `<img` it does read as a tag starts one in any context
 * and keeps its attributes, so those are left as they are.
 */
export function escapeImgTextInForeignContent(html: string, work?: ScanWork): string {
	const foreign = FOREIGN_CONTENT_RE.exec(html);
	if (work) work.chars += foreign ? foreign.index + foreign[0].length : html.length;
	if (!foreign) return html;
	const { keptAt } = replaceTokenizedImgTags(html, (tag) => tag, work);
	// One more pass over the input to find every `<img` start.
	if (work) work.chars += html.length;
	return html.replace(new RegExp(IMG_TAG_START_RE.source, 'gi'), (start, at: number) =>
		keptAt.has(at) ? start : `&lt;${start.slice(1)}`
	);
}
