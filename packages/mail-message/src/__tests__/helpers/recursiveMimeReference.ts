/**
 * Reference implementation for the MIME tree differential: the recursive
 * splitter `parse/body.ts` used before it moved to a single pass. Each nested
 * `multipart/*` body is split again from its own start, which costs time in
 * proportion to nesting depth times size, but its definition of the tree is
 * direct, so the single-pass parser is checked against it.
 */

import { getRawParam, parseHeaders } from '../../parse/headers';
import type { ContentType } from '../../parse/contentType';
import type { MimeNode } from '../../parse/body';

const MAX_DEPTH = 100;
const MAX_MIME_PARTS = 1000;

/** Split a raw part into its header block and body at the first blank line. */
function splitHeadersAndBody(raw: string): { headerText: string; body: string } {
	const m = raw.match(/\r?\n\r?\n/);
	if (!m || m.index == null) return { headerText: raw, body: '' };
	return { headerText: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/**
 * Classify the line `body[pos, lineEnd)` as an opening or closing delimiter,
 * ignoring trailing spaces and tabs, or `null` when it is neither. Every
 * delimiter starts with `open`, so any other line is rejected with one prefix
 * comparison; the right-trim is a plain backwards scan, so a long run of
 * blanks costs time linear in its length.
 */
function delimiterAt(
	body: string,
	pos: number,
	lineEnd: number,
	open: string,
	close: string
): 'open' | 'close' | null {
	if (lineEnd - pos < open.length || !body.startsWith(open, pos)) return null;
	let end = lineEnd;
	while (end > pos) {
		const c = body.charCodeAt(end - 1);
		if (c !== 0x20 && c !== 0x09) break;
		end--;
	}
	const len = end - pos;
	if (len === open.length) return 'open';
	if (len === close.length && body.startsWith(close, pos)) return 'close';
	return null;
}

/**
 * Split a multipart body into its parts on `--boundary` delimiter lines,
 * tolerating trailing whitespace on the delimiter and stopping at the closing
 * `--boundary--`. Preamble/epilogue outside the delimiters is discarded. Order
 * is preserved.
 *
 * Each returned segment is the VERBATIM byte span between the delimiter lines —
 * the CRLF that precedes a delimiter is (per MIME) part of the delimiter, not the
 * part, and is excluded, but every interior line ending is kept exactly as it
 * appeared on the wire. Line-ending normalization (CRLF -> LF) is applied later,
 * per-leaf, and only to nested non-`message/*` parts (see {@link leafRawBody});
 * `message/*` payloads and the top-level body are kept
 * verbatim so DSN scraping and message re-verification see the exact original
 * bytes — byte-for-byte with mailparser.
 */
function* splitMultipart(body: string, boundary: string): Generator<string, void, void> {
	const open = `--${boundary}`;
	const close = `${open}--`;
	let partStart = -1; // offset where the current part's content begins, -1 = idle
	let prevLineEnd = -1; // end offset (exclusive) of the last content line seen
	const n = body.length;
	let pos = 0;
	while (pos <= n) {
		const nl = body.indexOf('\n', pos);
		const atEnd = nl === -1;
		const lineEnd = atEnd ? n : nl > pos && body[nl - 1] === '\r' ? nl - 1 : nl;
		const nextPos = atEnd ? n + 1 : nl + 1;
		const delimiter = delimiterAt(body, pos, lineEnd, open, close);
		if (delimiter !== null) {
			if (partStart !== -1) {
				yield body.slice(partStart, prevLineEnd === -1 ? partStart : prevLineEnd);
			}
			if (delimiter === 'close') {
				partStart = -1;
				break;
			}
			partStart = nextPos;
			prevLineEnd = -1;
		} else if (partStart !== -1) {
			prevLineEnd = lineEnd;
		}
		pos = nextPos;
		if (atEnd) break;
	}
	if (partStart !== -1) {
		yield body.slice(partStart, prevLineEnd === -1 ? partStart : prevLineEnd);
	}
}

/** Shared breadth budget threaded through every recursive branch. */
interface MimeParseBudget {
	remainingParts: number;
	/** Set once any content was left out because a bound was reached. */
	truncated: boolean;
}

/**
 * The raw (pre-transfer-decode) body of a leaf. `message/*` payloads and the
 * top-level (non-`nested`) body are kept VERBATIM — mailparser preserves their
 * exact CRLF bytes, and downstream DSN scraping / message re-verification depends
 * on those bytes. Every other nested leaf is CRLF -> LF normalized.
 */
function leafRawBody(contentType: ContentType, body: string, nested: boolean): string {
	if (nested && !contentType.value.startsWith('message/')) {
		return body.replace(/\r\n/g, '\n');
	}
	return body;
}

/**
 * Parse a raw message/part (binary string) into a {@link MimeNode} tree.
 * Recursion is bounded by {@link MAX_DEPTH}, total breadth by
 * {@link MAX_MIME_PARTS}, and a missing multipart boundary simply yields a
 * childless node, so hostile input can never overflow the stack, allocate an
 * unbounded node tree, or throw.
 */
function parseMimeNode(
	raw: string,
	depth: number,
	nested: boolean,
	budget: MimeParseBudget
): MimeNode {
	const { headerText, body } = splitHeadersAndBody(raw);
	const headers = parseHeaders(headerText);
	const contentType = headers.contentType;
	const children: MimeNode[] = [];
	let isMultipart = false;

	if (contentType.value.startsWith('multipart/')) {
		// Gate on the `multipart/` PREFIX, not `type === 'multipart'`: `value` is
		// the Content-Type up to the first `;`, trimmed and lowercased, so a
		// slashless `Content-Type: multipart` is NOT a container and stays a leaf.
		//
		// Read the boundary from the RAW Content-Type via the whitespace-anchored
		// scanner, NOT from the semicolon-anchored `contentType.params`, so a
		// no-semicolon `multipart/mixed boundary="B"` is still a multipart with
		// indexed parts, which keeps the stored partIndex numbering stable.
		const boundary = getRawParam(headers.last('content-type'), 'boundary');
		if (boundary !== undefined && boundary !== '' && depth >= MAX_DEPTH) {
			// A container at the depth bound stays a childless leaf. Its parts are
			// never looked at, so record that the tree is incomplete.
			budget.truncated = true;
		} else if (boundary !== undefined && boundary !== '') {
			isMultipart = true;
			const parts = splitMultipart(body, boundary);
			for (;;) {
				// Pull lazily only while budget remains, so the unsplit remainder is never
				// collected into an intermediate parts array. Once the budget is spent,
				// pull at most one more segment (and only until the first one is found
				// anywhere in the tree) to learn whether any part was left out.
				if (budget.remainingParts <= 0) {
					if (!budget.truncated && !parts.next().done) budget.truncated = true;
					break;
				}
				const next = parts.next();
				if (next.done) break;
				budget.remainingParts--;
				children.push(parseMimeNode(next.value, depth + 1, true, budget));
			}
		}
	}

	return {
		headers,
		contentType,
		isMultipart,
		children,
		rawBody: isMultipart ? '' : leafRawBody(contentType, body, nested),
	};
}

/** The recursive parse: the tree plus whether a bound left content out. */
export function referenceMimeTree(
	raw: string,
	depth = 0,
	nested = false
): { root: MimeNode; truncated: boolean } {
	const budget: MimeParseBudget = { remainingParts: MAX_MIME_PARTS, truncated: false };
	const root = parseMimeNode(raw, depth, nested, budget);
	return { root, truncated: budget.truncated };
}
