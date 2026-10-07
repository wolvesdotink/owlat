/**
 * Remove the parts of an HTML document a browser does not show, so the
 * security scan's strip pass (`stripHiddenContent` in `patterns.ts`) can keep
 * them away from a model.
 *
 * The pass tokenizes the input once, left to right, the way an HTML tokenizer
 * reads tags, and keeps the stack of open elements (`htmlElements.ts`). An
 * element is hidden when its inline style hides it (`hiddenStyle.ts`), when it
 * carries the `hidden` attribute, or when the browser never shows it
 * (`template`, `script`, `style`, `title`, …). A hidden element is removed with
 * everything inside it, up to where it is closed: by its own end tag (which may
 * carry attributes), by an end tag or a start tag that closes it implicitly
 * (a new `<p>`, `<li>`, cell or row), or at the end of the input. Start tags the
 * browser ignores (`<body>` inside the body, a `<td>` outside a table) are
 * ignored here too, and the content of a raw-text element such as `<textarea>`
 * is text, with no markup in it.
 *
 * Where the tree builder's rules are too involved to follow exactly, the pass
 * keeps hiding rather than showing: an end tag it cannot match safely does not
 * end a hidden element, and a hidden formatting element (`<b>`, `<font>`, …)
 * that something else closes keeps hiding until an end tag of its name, since
 * the browser reopens formatting elements for the content that follows.
 * Removing too much only costs the model some visible text; removing too little
 * would let hidden text through.
 *
 * Linear: every character is read a bounded number of times, and every close
 * decision takes constant time, amortised over the pops it causes. The tests
 * check that by counting the work through a {@link ScanMeter}.
 */

import { ActiveFormatting, type FormattingEntry } from './activeFormatting';
import { styleHides, styleRemoves } from './hiddenStyle';
import {
	ALWAYS_HIDDEN_ELEMENTS,
	ElementStack,
	type EndTagEffect,
	FORMATTING_ELEMENTS,
	IGNORED_START_TAGS,
	MARKER_ELEMENTS,
	type Namespace,
	RAW_TEXT_ELEMENTS,
	reopensFormatting,
	TABLE_PARTS,
	VOID_ELEMENTS,
} from './htmlElements';

/**
 * Work one scan did, counted for the linear-time tests: `chars` is input
 * characters read (a search that finds nothing counts up to the end of the
 * input), `steps` is open elements popped or passed over and formatting list
 * entries visited. Callers outside tests pass none.
 */
export interface ScanMeter {
	chars: number;
	steps: number;
}

const isTagSpace = (c: string | undefined): boolean =>
	c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

const isAsciiAlpha = (c: string | undefined): boolean =>
	c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

// ── Tags ──

/**
 * A tag read by {@link readTag}: either it ends at `end` (its closing `>`),
 * with its first `style` value, whether it carries `hidden` and whether it is
 * self-closing (`<g />`), or it never
 * ends and scanning resumes at `resume`.
 */
type Tag =
	| { end: number; style: string | null; hidden: boolean; selfClosing: boolean }
	| { end: null; resume: number };

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
		// A `/` right before the closing `>` marks a self-closing tag.
		let slash = false;
		while (i < input.length && (isTagSpace(input[i]) || input[i] === '/')) {
			slash = input[i] === '/';
			i++;
		}
		if (i >= input.length) return { end: null, resume: input.length };
		if (input[i] === '>') return { end: i, style, hidden, selfClosing: slash };

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

/** Whether an element hides its content: always, by the `hidden` attribute, or by its style. */
function tagHides(name: string, tag: { hidden: boolean; style: string | null }): boolean {
	return (
		ALWAYS_HIDDEN_ELEMENTS.has(name) || tag.hidden || (tag.style !== null && styleHides(tag.style))
	);
}

/** Elements a select keeps when they appear inside it. */
const SELECT_CONTENT = new Set(['hr', 'optgroup', 'option', 'script', 'template']);

/** Markers the browser clears from the formatting list whenever they close. */
const CELL_MARKERS = new Set(['caption', 'td', 'th']);

/**
 * Drop every hidden element (see the module comment) with its content. The
 * dropped span is replaced by one space. Input without a hidden element comes
 * back unchanged.
 */
export function stripHiddenElements(input: string, meter?: ScanMeter): string {
	const stack = new ElementStack();
	const formatting = new ActiveFormatting(meter);
	let out = '';
	let copied = 0;

	// The hidden span being dropped: where it began, or -1, and the stack index
	// of the hidden element keeping it open, or -1 while none is open. The span
	// also stays open while a closed hidden formatting element waits to be
	// reopened (see activeFormatting.ts).
	let regionStart = -1;
	let rootIndex = -1;
	// SVG and MathML content is not followed closely enough to know where a
	// hidden span inside or around it ends, so such a span runs to the end,
	// unless the SVG or MathML closes cleanly by its own end tag.
	let sticky = false;

	const endRegionIfClosed = (end: number) => {
		if (regionStart === -1 || rootIndex !== -1 || sticky) return;
		if (formatting.hiddenClosed > 0 || formatting.overflowed) return;
		out += `${input.slice(copied, regionStart)} `;
		copied = end;
		regionStart = -1;
	};

	/** Push an element, starting or continuing a hidden span when it hides. */
	const open = (name: string, hides: boolean, namespace: Namespace, at: number) => {
		const html = namespace === '';
		const entry = html && FORMATTING_ELEMENTS.has(name) ? formatting.add(name, hides) : null;
		if (html && MARKER_ELEMENTS.has(name)) formatting.addMarker();
		const index = stack.push(name, hides, namespace, entry);
		if (hides && rootIndex === -1) {
			if (regionStart === -1) regionStart = at;
			rootIndex = index;
		}
		if (regionStart !== -1 && stack.hasForeign()) sticky = true;
	};

	/** Reopen closed formatting elements before new content, as the browser does. */
	const reopenFormatting = (at: number) => {
		for (const entry of formatting.reopen()) {
			const index = stack.push(entry.name, entry.hides, '', entry);
			if (entry.hides && rootIndex === -1) {
				if (regionStart === -1) regionStart = at;
				rootIndex = index;
			}
		}
	};

	// Whether a form is open for the parser: a second `<form>` is ignored until
	// a `</form>`, even when the first form was closed implicitly.
	let formOpen = false;

	/**
	 * Close the element at `target` and everything above it. The tag doing so
	 * starts at `at` and ends just before `after`; `explicit` when it is the
	 * element's own end tag.
	 */
	const closeTo = (target: number, at: number, after: number, explicit: boolean) => {
		let closedForeignRoot = false;
		if (meter) meter.steps += stack.depth - target;
		stack.truncate(target, (name, _hides, index, entry) => {
			const ownEndTag = explicit && index === target;
			if (ownEndTag && (name === 'svg' || name === 'math')) closedForeignRoot = true;
			if (entry) {
				if (ownEndTag) formatting.remove(entry);
				else formatting.closed(entry);
			}
			if (CELL_MARKERS.has(name) || (ownEndTag && MARKER_ELEMENTS.has(name))) {
				formatting.clearToMarker();
			}
		});
		// SVG or MathML that closed by its own end tag, with none left open, was
		// followed well enough: the span can end normally again.
		if (closedForeignRoot && !stack.hasForeign()) sticky = false;
		let end = at;
		if (rootIndex >= target) {
			// Its own end tag ends the hidden element; any other close leaves that
			// tag, which belongs to a visible element, in place.
			if (explicit && rootIndex === target) end = after;
			rootIndex = -1;
		}
		endRegionIfClosed(end);
	};

	let pos = 0;
	for (;;) {
		const lt = input.indexOf('<', pos);
		if (meter) meter.chars += (lt === -1 ? input.length : lt) - pos;
		if (lt === -1) break;
		if (lt > pos) reopenFormatting(pos);
		const next = input[lt + 1];

		if (isAsciiAlpha(next)) {
			const { name, end: nameEnd } = readTagName(input, lt + 1);
			const tag = readTag(input, nameEnd);
			if (meter) meter.chars += (tag.end ?? input.length) - lt;
			if (tag.end === null) {
				if (tag.resume >= input.length) break;
				pos = tag.resume;
				continue;
			}
			pos = tag.end + 1;
			if (stack.insideForeign(name)) {
				// An SVG or MathML element: none of the HTML tree rules below apply.
				if (!tag.selfClosing) open(name, tagHides(name, tag), stack.namespaceFor(name), lt);
				continue;
			}
			if (IGNORED_START_TAGS.has(name)) {
				// The browser copies `<html>` and `<body>` attributes onto the
				// document's own elements, so hiding one hides the whole document.
				if (
					(name === 'html' || name === 'body') &&
					(tag.hidden || (tag.style !== null && styleRemoves(tag.style)))
				) {
					return ' ';
				}
				continue;
			}
			if (TABLE_PARTS.has(name) && !stack.inTable()) continue;
			if (name === 'form') {
				if (formOpen) continue;
				formOpen = true;
			}
			if (stack.inSelect()) {
				// Inside a select the browser keeps only options and a few others,
				// and ends the select at another select, a form control, or (in a
				// table) a table part.
				const endsSelect =
					name === 'select' ||
					name === 'input' ||
					name === 'keygen' ||
					name === 'textarea' ||
					((name === 'table' || TABLE_PARTS.has(name)) && stack.has('table'));
				if (endsSelect) {
					closeTo(stack.nearest('select'), lt, lt, false);
					if (name === 'select') continue;
				} else if (!SELECT_CONTENT.has(name)) {
					continue;
				}
			}

			if (name === 'a') {
				// A new link closes one still open in the same stretch.
				const link = formatting.lastAfterMarker('a');
				if (link) closeFormatting('a', link, lt, lt);
			}
			const item = stack.impliedClose(name);
			if (item !== -1) closeTo(item, lt, lt, false);
			const paragraph = stack.impliedParagraphClose(name);
			if (paragraph !== -1) closeTo(paragraph, lt, lt, false);
			const heading = stack.impliedHeadingClose(name);
			if (heading !== -1) closeTo(heading, lt, lt, false);
			for (const parent of stack.impliedTableParents(name)) open(parent, false, '', lt);

			const namespace = stack.namespaceFor(name);
			const foreign = namespace !== '';
			if (!foreign && reopensFormatting(name)) reopenFormatting(lt);
			if (VOID_ELEMENTS.has(name) || (foreign && tag.selfClosing)) continue;

			open(name, tagHides(name, tag), namespace, lt);

			if (!foreign && RAW_TEXT_ELEMENTS.has(name)) {
				// The content is text up to `</name`, or to the end of the input
				// when there is none (always, for `plaintext`).
				let found: RegExpExecArray | null = null;
				if (name !== 'plaintext') {
					const close = rawTextClose(name);
					close.lastIndex = pos;
					found = close.exec(input);
				}
				if (meter) meter.chars += (found ? found.index : input.length) - pos;
				if (!found) break;
				pos = found.index;
			}
			continue;
		}

		if (next === '/') {
			const after = input[lt + 2];
			if (!isAsciiAlpha(after)) {
				// `</>` is dropped; `</` + anything else is a bogus comment up to `>`.
				const gt = after === '>' ? lt + 2 : input.indexOf('>', lt + 2);
				if (meter) meter.chars += (gt === -1 ? input.length : gt) - lt;
				if (gt === -1) break;
				pos = gt + 1;
				continue;
			}
			const { name, end: nameEnd } = readTagName(input, lt + 2);
			const tag = readTag(input, nameEnd);
			if (meter) meter.chars += (tag.end ?? input.length) - lt;
			if (tag.end === null) {
				if (tag.resume >= input.length) break;
				pos = tag.resume;
				continue;
			}
			pos = tag.end + 1;

			if (name === 'p' || name === 'br') {
				// `</p>` and `</br>` inside SVG or MathML end that content first.
				const breakout = stack.foreignBreakout();
				if (breakout !== -1) closeTo(breakout, lt, lt, false);
			}
			if (name === 'form') formOpen = false;
			// How `<noscript>` content is parsed depends on where it sits and on
			// whether scripting is on, so its end tag never ends a hidden span.
			if (name === 'noscript' && regionStart !== -1) continue;
			if (
				stack.inSelect() &&
				!SELECT_CONTENT.has(name) &&
				name !== 'select' &&
				name !== 'table' &&
				!TABLE_PARTS.has(name)
			) {
				continue;
			}
			const entry = FORMATTING_ELEMENTS.has(name) ? formatting.lastAfterMarker(name) : null;
			if (entry) {
				closeFormatting(name, entry, lt, pos);
				continue;
			}
			applyEndTag(name, stack.endTag(name), lt, pos);
			continue;
		}

		if (next === '!' || next === '?') {
			// Comments are gone by now (`stripHiddenContent` removes them first);
			// what is left is a doctype or a bogus comment, which ends at `>`.
			const gt = input.indexOf('>', lt + 2);
			if (meter) meter.chars += (gt === -1 ? input.length : gt) - lt;
			if (gt === -1) break;
			pos = gt + 1;
			continue;
		}

		pos = lt + 1;
	}

	if (regionStart !== -1) {
		out += `${input.slice(copied, regionStart)} `;
		copied = input.length;
	}
	return copied === 0 ? input : out + input.slice(copied);

	/** Close a formatting element that is on the list (the adoption agency). */
	function closeFormatting(name: string, entry: FormattingEntry, at: number, after: number) {
		if (!entry.open) {
			// Closed already and waiting to be reopened: it just leaves the list.
			formatting.remove(entry);
			endRegionIfClosed(after);
			return;
		}
		// Closing or detaching it takes it off the list; when the end tag is
		// ignored (it is out of scope) it stays on the list.
		applyEndTag(name, stack.endTag(name), at, after);
	}

	/** Apply what an end tag does to the stack. */
	function applyEndTag(name: string, effect: EndTagEffect, at: number, after: number) {
		if (effect.kind === 'close') {
			closeTo(effect.index, at, after, true);
		} else if (effect.kind === 'detach') {
			const detached = stack.detach(effect.index);
			if (detached) {
				formatting.remove(detached);
				// The browser moves the content of the highest special element above
				// the formatting element into a copy of it, then closes that copy
				// and everything opened inside it.
				const above = stack.topSpecial() + 1;
				if (above < stack.depth) closeTo(above, at, at, false);
			}
			if (effect.index === rootIndex) {
				// What was open inside a form stays inside it in the page; what was
				// inside a detached formatting element no longer sits inside it.
				rootIndex = name === 'form' ? effect.index + 1 : stack.nextHiding(effect.index);
				if (meter) meter.steps += (rootIndex === -1 ? stack.depth : rootIndex) - effect.index;
				endRegionIfClosed(after);
			}
		}
	}
}
