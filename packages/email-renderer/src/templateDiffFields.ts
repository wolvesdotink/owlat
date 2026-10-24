/**
 * The building blocks of the template comparison (`./templateDiff.ts`): what a
 * Block's own content says (its copy, its links, everything else) and an
 * order-aware sequence diff.
 *
 * "Own" content is the Block's content without its child Blocks: a container
 * whose child changed has not changed itself, and the child is reported on its
 * own. Copy and links are read per field so a change names where it happened,
 * and kept as sequences rather than sets, so a repeated sentence or URL keeps
 * its occurrence: removing one of two identical links is a removal, not
 * nothing.
 */

import { childBlockLists, type BlockTreeNode } from '@owlat/shared/blockTree';
import { canonicalJson } from '@owlat/shared/canonicalJson';
import { htmlToPlainText } from '@owlat/shared/html';

/** Fields holding HTML: their copy is the plain text, their links the anchors. */
const HTML_KEYS = new Set(['html']);

/**
 * Fields holding reader-facing copy: text Block html, button labels, alt text,
 * accordion and image titles, menu labels, table headers and cells, list
 * items. Matched on the last key of the path, so `links[].label` (menu) and
 * `images[].alt` (carousel) count too.
 */
const COPY_KEYS = new Set([
	'text',
	'alt',
	'title',
	'label',
	'captionText',
	'headers',
	'rows',
	'footerRow',
	'items',
	'content',
]);

/** Fields holding a link target. Image sources are not links: they are "other". */
const LINK_KEYS = new Set(['url', 'linkUrl', 'videoUrl', 'href']);

/** Stands in for a copy or link string, so "other" compares the rest only. */
const EXTRACTED = '\u0000';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const decodeAttribute = (value: string): string =>
	value
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

const isSpace = (char: string | undefined): boolean =>
	char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';

interface ScannedTag {
	/** Index just past the tag's `>` (or the end of the input). */
	end: number;
	/** Attributes by lowercased name; the first occurrence wins, as in a browser. */
	attributes: Map<string, string>;
	/** `[start, end)` of every quoted attribute value. */
	quoted: Array<[number, number]>;
}

/**
 * Read the attributes of the tag whose name ends at `from`, one by one, with
 * quoted values kept whole: a `>` inside quotes does not end the tag.
 */
function scanTag(html: string, from: number): ScannedTag {
	const attributes = new Map<string, string>();
	const quoted: Array<[number, number]> = [];
	let i = from;
	while (i < html.length) {
		const char = html[i];
		if (char === '>') return { end: i + 1, attributes, quoted };
		if (isSpace(char) || char === '/') {
			i++;
			continue;
		}
		let nameEnd = i + 1; // a leading `=` belongs to the name, as in HTML
		while (nameEnd < html.length && !/[\s/>=]/.test(html[nameEnd]!)) nameEnd++;
		const name = html.slice(i, nameEnd).toLowerCase();
		i = nameEnd;
		while (isSpace(html[i])) i++;
		let value = '';
		if (html[i] === '=') {
			i++;
			while (isSpace(html[i])) i++;
			const quote = html[i];
			if (quote === '"' || quote === "'") {
				const close = html.indexOf(quote, i + 1);
				const stop = close < 0 ? html.length : close;
				value = html.slice(i + 1, stop);
				quoted.push([i + 1, stop]);
				i = stop + 1;
			} else {
				const start = i;
				while (i < html.length && !isSpace(html[i]) && html[i] !== '>') i++;
				value = html.slice(start, i);
			}
		}
		if (!attributes.has(name)) attributes.set(name, value);
	}
	return { end: html.length, attributes, quoted };
}

/**
 * Read an html field tag by tag rather than with a pattern: the href of every
 * anchor in document order, and the html with `<` and `>` inside quoted
 * attribute values escaped so the plain-text extraction cannot mistake them
 * for the end of a tag. `data-href` is not `href`, and comments are skipped,
 * so the compared destination is the one a reader actually reaches.
 */
function readHtmlField(html: string): { hrefs: string[]; tagSafe: string } {
	const hrefs: string[] = [];
	let tagSafe = '';
	let copied = 0;
	let i = 0;
	while (i < html.length) {
		const open = html.indexOf('<', i);
		if (open < 0) break;
		if (html.startsWith('<!--', open)) {
			const close = html.indexOf('-->', open + 4);
			i = close < 0 ? html.length : close + 3;
			continue;
		}
		if (!/[a-z]/i.test(html.charAt(open + 1))) {
			i = open + 1;
			continue;
		}
		let nameEnd = open + 1;
		while (nameEnd < html.length && !/[\s/>]/.test(html[nameEnd]!)) nameEnd++;
		const tag = scanTag(html, nameEnd);
		if (html.slice(open + 1, nameEnd).toLowerCase() === 'a') {
			const href = decodeAttribute((tag.attributes.get('href') ?? '').trim());
			if (href) hrefs.push(href);
		}
		for (const [start, stop] of tag.quoted) {
			tagSafe +=
				html.slice(copied, start) +
				html.slice(start, stop).replace(/</g, '&lt;').replace(/>/g, '&gt;');
			copied = stop;
		}
		i = tag.end;
	}
	return { hrefs, tagSafe: tagSafe + html.slice(copied) };
}

const looksLikeHtml = (value: string): boolean => /<[a-z!/][^>]*>/i.test(value);

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** A Block's own content, split into what the comparison reports separately. */
export interface OwnFields {
	/** Copy per field path (array indices dropped), in document order. */
	copy: Map<string, string[]>;
	/** Link targets per field path, in document order. */
	links: Map<string, string[]>;
	/** Canonical JSON of the own content: any change at all. */
	own: string;
	/** Canonical JSON of the own content with copy and links taken out. */
	rest: string;
}

const lastKey = (field: string): string => field.slice(field.lastIndexOf('.') + 1);

function push(map: Map<string, string[]>, field: string, value: string): void {
	const list = map.get(field);
	if (list) list.push(value);
	else map.set(field, [value]);
}

/** Read `node`'s own content: its copy, its links, and the rest. */
export function readOwnFields(node: BlockTreeNode): OwnFields {
	const children = new Set<unknown>(childBlockLists(node).flat());
	const copy = new Map<string, string[]>();
	const links = new Map<string, string[]>();

	// One walk builds both shapes: `own` keeps every string, `rest` swaps the
	// copy and link strings out. Child Blocks are dropped from their arrays, so
	// adding a child changes the child list's owner in neither.
	const walk = (value: unknown, field: string): { own: unknown; rest: unknown } => {
		if (typeof value === 'string') {
			const key = lastKey(field);
			if (HTML_KEYS.has(key) || (COPY_KEYS.has(key) && looksLikeHtml(value))) {
				const { hrefs, tagSafe } = readHtmlField(value);
				const text = htmlToPlainText(tagSafe);
				if (text) push(copy, field, text);
				for (const href of hrefs) push(links, field, href);
				return { own: value, rest: EXTRACTED };
			}
			if (COPY_KEYS.has(key)) {
				const text = collapse(value);
				if (text) push(copy, field, text);
				return { own: value, rest: EXTRACTED };
			}
			if (LINK_KEYS.has(key)) {
				const href = value.trim();
				if (href) push(links, field, href);
				return { own: value, rest: EXTRACTED };
			}
			return { own: value, rest: value };
		}
		if (Array.isArray(value)) {
			const parts = value
				.filter((entry) => !children.has(entry))
				.map((entry) => walk(entry, field));
			return { own: parts.map((part) => part.own), rest: parts.map((part) => part.rest) };
		}
		if (isRecord(value)) {
			const own: Record<string, unknown> = {};
			const rest: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(value)) {
				const part = walk(entry, field ? `${field}.${key}` : key);
				own[key] = part.own;
				rest[key] = part.rest;
			}
			return { own, rest };
		}
		return { own: value, rest: value };
	};

	const { own, rest } = walk(isRecord(node.content) ? node.content : {}, '');
	return { copy, links, own: canonicalJson(own), rest: canonicalJson(rest) };
}

/** One step of a sequence diff. A `changed` step pairs a removal with an insertion at the same spot. */
export type SequenceStep =
	| { kind: 'added'; after: string }
	| { kind: 'removed'; before: string }
	| { kind: 'changed'; before: string; after: string };

/** Above this many cells the LCS table is skipped and entries pair by position. */
const LCS_CELL_LIMIT = 1_000_000;

/**
 * Index pairs `[i, j]` of a longest common subsequence of `a` and `b`, in
 * order. Lists past `LCS_CELL_LIMIT` cells pair equal entries by position
 * instead: still deterministic, just less clever about insertions.
 */
export function commonSubsequence<T>(
	a: readonly T[],
	b: readonly T[],
	same: (x: T, y: T) => boolean = Object.is
): Array<[number, number]> {
	const pairs: Array<[number, number]> = [];
	if (a.length * b.length > LCS_CELL_LIMIT) {
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			if (same(a[i]!, b[i]!)) pairs.push([i, i]);
		}
		return pairs;
	}
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] = same(a[i]!, b[j]!)
				? table[(i + 1) * width + j + 1]! + 1
				: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
		}
	}
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (same(a[i]!, b[j]!)) {
			pairs.push([i, j]);
			i++;
			j++;
		} else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
		else j++;
	}
	return pairs;
}

/**
 * The steps that turn `before` into `after`. Runs of entries between two kept
 * entries are paired up as `changed` (an edited sentence, a swapped URL); what
 * is left over is a plain removal or insertion.
 */
export function diffSequence(before: readonly string[], after: readonly string[]): SequenceStep[] {
	const steps: SequenceStep[] = [];
	const flush = (removed: string[], added: string[]) => {
		const paired = Math.min(removed.length, added.length);
		for (let k = 0; k < paired; k++) {
			steps.push({ kind: 'changed', before: removed[k]!, after: added[k]! });
		}
		for (const value of removed.slice(paired)) steps.push({ kind: 'removed', before: value });
		for (const value of added.slice(paired)) steps.push({ kind: 'added', after: value });
	};
	let i = 0;
	let j = 0;
	for (const [keptBefore, keptAfter] of [
		...commonSubsequence(before, after),
		[before.length, after.length] as [number, number],
	]) {
		flush(before.slice(i, keptBefore), after.slice(j, keptAfter));
		i = keptBefore + 1;
		j = keptAfter + 1;
	}
	return steps;
}
