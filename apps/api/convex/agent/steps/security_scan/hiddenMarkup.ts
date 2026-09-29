/**
 * Remove the parts of an HTML document a browser does not show, so the
 * security scan's strip pass (`stripHiddenContent` in `patterns.ts`) can keep
 * them away from a model.
 *
 * The pass tokenizes the input once, left to right, the way an HTML tokenizer
 * reads tags, and keeps a stack of open elements. An element is hidden when its
 * inline style hides it (after decoding character references and CSS escapes
 * and dropping CSS comments), when it carries the `hidden` attribute, or when
 * it is a `<template>`. A hidden element is removed with everything inside it,
 * up to the end tag that closes it. Nested elements of the same name are
 * counted, an end tag may carry attributes, and a hidden element that is never
 * closed runs until an end tag closes one of its ancestors, or to the end of the
 * input.
 *
 * Where the tree builder's rules are too involved to follow exactly, the pass
 * keeps hiding rather than showing: an end tag it cannot match safely does not
 * end a hidden element, and a hidden formatting element (`<b>`, `<font>`, …) that
 * an ancestor's end tag closes keeps hiding until its own end tag, since the
 * browser reopens formatting elements after such a close. Removing too much only
 * costs the model some visible text; removing too little would let hidden text
 * through.
 *
 * Linear: every character is read a bounded number of times, and the element
 * stack keeps per-name and per-kind indexes so each end tag is matched in
 * constant time (amortised over the pops it causes).
 */

/**
 * An inline style that hides its element: display:none, visibility:hidden,
 * font-size:0, opacity:0, or white / transparent text. The negative lookbehind
 * keeps `background-color: white` visible. The `rgba(` arguments are
 * length-bounded so a long unterminated value cannot backtrack.
 */
const HIDING_STYLE =
	/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?(?![.\d])|opacity\s*:\s*0(?:\.0+)?(?![.\d])|(?<![-\w])color\s*:\s*(?:white|transparent|#fff(?:fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\([^)]{0,64},\s*0(?:\.0+)?\s*\))/i;

/** A set of element names from a whitespace-separated list. */
const elementNames = (list: string): ReadonlySet<string> => new Set(list.trim().split(/\s+/));

/** Elements that never have content or an end tag. */
const VOID_ELEMENTS = elementNames(`
	area base basefont bgsound br col embed frame hr img input keygen link meta
	param source track wbr
`);

/** Elements whose content is text up to their own end tag, never markup. */
const RAW_TEXT_ELEMENTS = elementNames(`
	iframe noembed noframes plaintext script style textarea title xmp
`);

/**
 * Formatting elements: the browser reopens these after an ancestor's end tag
 * closes them (the "active formatting elements" list).
 */
const FORMATTING_ELEMENTS = elementNames(`
	a b big code em font i nobr s small strike strong tt u
`);

/**
 * The HTML "special" elements. The end tag of an ordinary element (one not in
 * this set) is ignored when a special element sits above that element on the
 * stack; formatting elements are treated the same way here, which keeps hiding
 * where the browser would restructure the tree instead.
 */
const SPECIAL_ELEMENTS = elementNames(`
	address applet article aside blockquote body button caption center colgroup
	dd details dialog dir div dl dt fieldset figcaption figure footer form
	frameset h1 h2 h3 h4 h5 h6 head header hgroup html iframe li listing main
	marquee menu nav noembed noframes noscript object ol p plaintext pre search
	section select summary table tbody td template textarea tfoot th thead title
	tr ul xmp
`);

/**
 * Scope boundaries: the end tag of a special element is ignored when one of
 * these sits above that element on the stack. The HTML default scope, widened
 * by the list-item and button scopes' extra boundaries, so an end tag is
 * ignored whenever any of those scopes would ignore it.
 */
const SCOPE_BOUNDARIES = elementNames(`
	applet button caption html marquee object ol select table td template th ul
`);

/**
 * Elements whose end tag also clears the reopen list back to where they
 * started, so a formatting element inside one is not reopened after it.
 */
const MARKER_ELEMENTS = elementNames(`applet caption marquee object td template th`);

const isTagSpace = (c: string | undefined): boolean =>
	c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

const isAsciiAlpha = (c: string | undefined): boolean =>
	c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

// ── Attribute values ──

/**
 * The named character references that stand for ASCII punctuation or spacing a
 * style could be spelled with. Letters and digits have no named references.
 */
const NAMED_REFERENCES: Record<string, string> = {
	amp: '&',
	apos: "'",
	ast: '*',
	bsol: '\\',
	colon: ':',
	comma: ',',
	commat: '@',
	dollar: '$',
	equals: '=',
	excl: '!',
	grave: '`',
	gt: '>',
	hat: '^',
	lbrace: '{',
	lbrack: '[',
	lcub: '{',
	lowbar: '_',
	lpar: '(',
	lsqb: '[',
	lt: '<',
	newline: '\n',
	num: '#',
	percnt: '%',
	period: '.',
	plus: '+',
	quest: '?',
	quot: '"',
	rbrace: '}',
	rbrack: ']',
	rcub: '}',
	rpar: ')',
	rsqb: ']',
	semi: ';',
	sol: '/',
	tab: '\t',
	verbar: '|',
	vert: '|',
};

/** A decoded numeric reference; the browser turns invalid ones into U+FFFD. */
function codePointText(code: number): string {
	if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return '\uFFFD';
	if (code >= 0xd800 && code <= 0xdfff) return '\uFFFD';
	return String.fromCodePoint(code);
}

const CHARACTER_REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([a-zA-Z]{2,8});)/g;

/** Decode the character references in an attribute value, as the tokenizer does. */
function decodeAttributeValue(value: string): string {
	if (!value.includes('&')) return value;
	return value.replace(
		CHARACTER_REFERENCE,
		(match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
			if (hex !== undefined) return codePointText(Number.parseInt(hex, 16));
			if (dec !== undefined) return codePointText(Number.parseInt(dec, 10));
			return NAMED_REFERENCES[(name as string).toLowerCase()] ?? match;
		}
	);
}

/**
 * A CSS comment (an unclosed one runs to the end, as in CSS) or a backslash
 * escape: hex digits with one optional trailing space, an escaped newline, or
 * any other escaped character.
 */
const CSS_COMMENT_OR_ESCAPE =
	/\/\*[\s\S]*?(?:\*\/|$)|\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g;

/**
 * A style declaration as CSS reads it: comments dropped and backslash escapes
 * decoded (`\6e one` and `n\one` both read `none`).
 */
function normalizeCss(style: string): string {
	if (!style.includes('\\') && !style.includes('/*')) return style;
	return style.replace(
		CSS_COMMENT_OR_ESCAPE,
		(_match, hex: string | undefined, _newline: string | undefined, char: string | undefined) => {
			if (hex !== undefined) return codePointText(Number.parseInt(hex, 16));
			// An escaped character stands for itself; comments and escaped
			// newlines read as nothing.
			return char ?? '';
		}
	);
}

/** Whether a raw `style` attribute value hides its element. */
function styleHides(rawStyle: string): boolean {
	return HIDING_STYLE.test(normalizeCss(decodeAttributeValue(rawStyle)));
}

// ── Tags ──

/**
 * A tag read by {@link readTag}: either it ends at `end` (its closing `>`),
 * with its first `style` value and whether it carries `hidden`, or it never
 * ends and scanning resumes at `resume`.
 */
type Tag = { end: number; style: string | null; hidden: boolean } | { end: null; resume: number };

/**
 * Read the attributes of a tag the way an HTML tokenizer does, from just after
 * the tag name. A `>` inside a quoted value does not end the tag, and a quote
 * only opens a value right after `=`, as in the browser. Each character is
 * looked at once. End tags are read the same way: the tokenizer parses and then
 * drops their attributes.
 *
 * A tag that never ends reports where scanning should resume: the end of the
 * input when no `>` follows, or just past a quote that never closes. No later
 * tag can hold a value in that quote character, so a later tag may still end
 * and the caller keeps going from there.
 */
function readTag(input: string, from: number): Tag {
	let style: string | null = null;
	let hidden = false;
	let i = from;
	for (;;) {
		while (i < input.length && (isTagSpace(input[i]) || input[i] === '/')) i++;
		if (i >= input.length) return { end: null, resume: input.length };
		if (input[i] === '>') return { end: i, style, hidden };

		// Attribute name: a leading `=` belongs to the name.
		const nameStart = i;
		i++;
		while (i < input.length) {
			const c = input[i];
			if (isTagSpace(c) || c === '/' || c === '>' || c === '=') break;
			i++;
		}
		const name = input.slice(nameStart, i).toLowerCase();
		if (name === 'hidden') hidden = true;
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
		if (style === null && name === 'style') style = value;
	}
}

/** Index just past a tag name that starts at `from`, lowercased name included. */
function readTagName(input: string, from: number): { name: string; end: number } {
	let i = from;
	while (i < input.length && !isTagSpace(input[i]) && input[i] !== '/' && input[i] !== '>') i++;
	return { name: input.slice(from, i).toLowerCase(), end: i };
}

const rawTextCloseCache = new Map<string, RegExp>();

/** The end tag of a raw-text element: `</name` followed by a space, `/` or `>`. */
function rawTextClose(name: string): RegExp {
	let re = rawTextCloseCache.get(name);
	if (!re) {
		re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
		rawTextCloseCache.set(name, re);
	}
	return re;
}

// ── Element stack ──

/** The last entry of an index list, or -1 when it is empty. */
const top = (list: readonly number[]): number =>
	list.length > 0 ? (list[list.length - 1] as number) : -1;

/**
 * The open elements, with per-name, special and scope-boundary indexes so an
 * end tag finds its element, or learns it cannot close it, in constant time.
 */
class ElementStack {
	private readonly names: string[] = [];
	private readonly byName = new Map<string, number[]>();
	private readonly specials: number[] = [];
	private readonly boundaries: number[] = [];

	push(name: string): number {
		const index = this.names.length;
		this.names.push(name);
		let positions = this.byName.get(name);
		if (!positions) {
			positions = [];
			this.byName.set(name, positions);
		}
		positions.push(index);
		if (SPECIAL_ELEMENTS.has(name)) this.specials.push(index);
		if (SCOPE_BOUNDARIES.has(name)) this.boundaries.push(index);
		return index;
	}

	/** Pop down to `depth` elements. */
	truncate(depth: number): void {
		while (this.names.length > depth) {
			const name = this.names.pop() as string;
			const index = this.names.length;
			this.byName.get(name)?.pop();
			if (top(this.specials) === index) this.specials.pop();
			if (top(this.boundaries) === index) this.boundaries.pop();
		}
	}

	/**
	 * The stack index an end tag for `name` closes, or -1 when it closes nothing
	 * here: no such element is open, or an element it may not close through sits
	 * above the nearest one (see {@link SPECIAL_ELEMENTS} and
	 * {@link SCOPE_BOUNDARIES}). `</body>` and `</html>` never close anything,
	 * since the browser keeps adding later content to the open elements, and
	 * `</form>` only closes a form that is the current element, since the browser
	 * then removes the form alone and leaves the elements inside it open.
	 */
	closeTarget(name: string): number {
		if (name === 'body' || name === 'html') return -1;
		const positions = this.byName.get(name);
		if (!positions) return -1;
		const index = top(positions);
		if (index === -1) return -1;
		if (name === 'form' && index !== this.names.length - 1) return -1;
		const blockers = SPECIAL_ELEMENTS.has(name) ? this.boundaries : this.specials;
		const blocker = top(blockers);
		// An element never blocks its own end tag.
		return blocker > index ? -1 : index;
	}
}

/**
 * Drop every hidden element (see the module comment) with its content. The
 * dropped span is replaced by one space. Input without a hidden element comes
 * back unchanged.
 */
export function stripHiddenElements(input: string): string {
	const stack = new ElementStack();
	let out = '';
	let copied = 0;

	// The hidden element being dropped: where its start tag begins, its stack
	// index, and its name. `carry` is set once an ancestor's end tag closed a
	// hidden formatting element: hiding then lasts until an end tag of its name.
	let hiddenStart = -1;
	let hiddenIndex = -1;
	let hiddenName = '';
	let carry = false;
	// While carrying: elements at or above this stack depth were opened after
	// the hidden element was closed, so an end tag for one of them closes it,
	// not the carried element.
	let carryDepth = 0;
	// Raw-text elements whose end tag is missing from some position on: it is
	// then missing from every later position too, so it is not searched again.
	const missingRawClose = new Set<string>();

	const drop = (end: number) => {
		out += `${input.slice(copied, hiddenStart)} `;
		copied = end;
		hiddenStart = -1;
		hiddenIndex = -1;
		carry = false;
	};

	let pos = 0;
	for (;;) {
		const lt = input.indexOf('<', pos);
		if (lt === -1) break;
		const next = input[lt + 1];

		if (isAsciiAlpha(next)) {
			const { name, end: nameEnd } = readTagName(input, lt + 1);
			const tag = readTag(input, nameEnd);
			if (tag.end === null) {
				if (tag.resume >= input.length) break;
				pos = tag.resume;
				continue;
			}
			pos = tag.end + 1;
			if (VOID_ELEMENTS.has(name)) continue;

			const index = stack.push(name);
			if (
				hiddenStart === -1 &&
				(name === 'template' || tag.hidden || (tag.style !== null && styleHides(tag.style)))
			) {
				hiddenStart = lt;
				hiddenIndex = index;
				hiddenName = name;
			}
			if (RAW_TEXT_ELEMENTS.has(name) && !missingRawClose.has(name)) {
				// The content is text up to `</name`; no markup inside it counts.
				// Without such an end tag the rest is scanned as markup, which can
				// only remove more.
				const close = rawTextClose(name);
				close.lastIndex = pos;
				const found = close.exec(input);
				if (found) pos = found.index;
				else missingRawClose.add(name);
			}
			continue;
		}

		if (next === '/') {
			const after = input[lt + 2];
			if (!isAsciiAlpha(after)) {
				// `</>` is dropped; `</` + anything else is a bogus comment up to `>`.
				const gt = after === '>' ? lt + 2 : input.indexOf('>', lt + 2);
				if (gt === -1) break;
				pos = gt + 1;
				continue;
			}
			const { name, end: nameEnd } = readTagName(input, lt + 2);
			const tag = readTag(input, nameEnd);
			if (tag.end === null) {
				if (tag.resume >= input.length) break;
				pos = tag.resume;
				continue;
			}
			pos = tag.end + 1;

			const target = stack.closeTarget(name);
			if (carry) {
				if (name === hiddenName && target < carryDepth) {
					// No element of this name was opened since the carried one was
					// closed, so this end tag closes the carried one.
					drop(pos);
					continue;
				}
				if (target === -1) continue;
				stack.truncate(target);
				if (target < carryDepth && MARKER_ELEMENTS.has(name)) {
					// The carried element was opened inside this one, and its end tag
					// stops the browser reopening it.
					drop(lt);
					continue;
				}
				carryDepth = Math.min(carryDepth, target);
				continue;
			}
			if (target === -1) continue;
			stack.truncate(target);
			if (hiddenStart === -1 || target > hiddenIndex) continue;
			if (target === hiddenIndex) {
				drop(pos);
			} else if (FORMATTING_ELEMENTS.has(hiddenName) && !MARKER_ELEMENTS.has(name)) {
				// An ancestor closed a hidden formatting element; the browser reopens
				// it for the content that follows.
				carry = true;
				carryDepth = target;
				hiddenIndex = -1;
			} else {
				// An ancestor's end tag closed the hidden element; the end tag itself
				// belongs to the visible ancestor and stays.
				drop(lt);
			}
			continue;
		}

		if (next === '!' || next === '?') {
			// Comments are gone by now (`stripHiddenContent` removes them first);
			// what is left is a doctype or a bogus comment, which ends at `>`.
			const gt = input.indexOf('>', lt + 2);
			if (gt === -1) break;
			pos = gt + 1;
			continue;
		}

		pos = lt + 1;
	}

	if (hiddenStart !== -1) {
		out += `${input.slice(copied, hiddenStart)} `;
		copied = input.length;
	}
	return copied === 0 ? input : out + input.slice(copied);
}
