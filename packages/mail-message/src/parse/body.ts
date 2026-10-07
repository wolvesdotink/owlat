/**
 * MIME part-tree assembly: parse a raw RFC 822 message (carried as a binary
 * string — one char per byte, from `bytesToBinaryString` in `./binaryString`;
 * never `TextDecoder('latin1')`, which is windows-1252) into a tree of {@link MimeNode}s, then flatten it into the `text` / `html`
 * bodies mailparser exposes.
 *
 * The tree walker is the single traversal shared with `attachments.ts` so the
 * document order of leaves is identical on both the body and attachment sides.
 * Broken input (missing boundary, runaway nesting, headers-only) is tolerated:
 * the walker is depth-bounded and NEVER throws.
 */

import {
	parseHeaders,
	getRawParam,
	decodeQpHexEscapes,
	decodeEncodedWords,
	headerBytesToText,
	type MessageHeaders,
} from './headers';
import { type ContentType } from './contentType';
import { decodeCharset } from './charset';

/** Hard ceiling on multipart nesting depth; beyond it a node is left as a leaf. */
export const MAX_DEPTH = 100;

/**
 * Hard ceiling on descendant MIME parts in one message. The top-level RFC 822
 * message is not counted; every child node, including multipart containers, is.
 * RFC mail in normal use stays far below this, while a flat boundary bomb can
 * otherwise turn a small wire message into hundreds of thousands of objects.
 */
export const MAX_MIME_PARTS = 1000;

/** One node of the MIME part tree. */
export interface MimeNode {
	/** Parsed headers of this part. */
	headers: MessageHeaders;
	/** Structured `Content-Type` (defaulted to `text/plain` when absent). */
	contentType: ContentType;
	/** Whether this node is a `multipart/*` container with a usable boundary. */
	isMultipart: boolean;
	/** Child parts in document order (empty for leaves). */
	children: MimeNode[];
	/** Raw (pre-transfer-decode) body of a leaf, as a binary string. */
	rawBody: string;
}

/** The part budget of one parse, shared by every container in the message. */
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

/** A `multipart/*` node whose body is being split into parts. */
interface Container {
	/** `--boundary`: opens the next part. */
	readonly open: string;
	/** `--boundary--`: ends the last part. */
	readonly close: string;
	/** `preamble` before the first part, `part` inside one, `ended` after the end. */
	state: 'preamble' | 'part' | 'ended';
}

/**
 * A part being read: the root message, or the current part of the container in
 * the frame below it. A part's segment runs from `segStart` up to the line
 * before the delimiter that ends it; the node is built once its header block is
 * known.
 */
interface PartFrame {
	/** First line of the segment, or one past the end when it has no lines. */
	readonly segStart: number;
	readonly depth: number;
	readonly nested: boolean;
	/** The container's `children`, which this part's node joins; null for the root. */
	readonly siblings: MimeNode[] | null;
	/** Where the body starts; `-1` while the header block is still being read. */
	bodyStart: number;
	/**
	 * Set on a blank line that may end the header block: the offset where the
	 * header text stops. The blank line only counts if another line of the
	 * segment follows it.
	 */
	pendingHeaderEnd: number;
	node: MimeNode | null;
	container: Container | null;
}

/**
 * Parse a raw message/part (binary string) into a {@link MimeNode} tree in one
 * forward pass over its lines.
 *
 * The result is the tree the recursive definition gives: a part's header block
 * ends at the first blank line that is neither the segment's first line nor its
 * last; a `multipart/*` body is split on lines equal to `--boundary` or
 * `--boundary--` (trailing spaces and tabs ignored), dropping the preamble and
 * everything after the closing delimiter; and a part ends where a delimiter of
 * its own container or of any enclosing container starts, the enclosing one
 * winning when a line matches several. Instead of re-splitting each nested body,
 * the pass keeps the stack of open parts and one table from delimiter text to
 * the containers that use it, so every line is looked at once however deep the
 * nesting: the work is linear in the message size and the extra memory is
 * linear in the nesting depth.
 *
 * Nesting is bounded by {@link MAX_DEPTH}, total breadth by
 * {@link MAX_MIME_PARTS}, and a missing multipart boundary simply yields a
 * childless node, so hostile input can never overflow the stack, allocate an
 * unbounded node tree, or throw.
 */
function parseMimeNode(
	raw: string,
	depth: number,
	nested: boolean,
	budget: MimeParseBudget,
	meter: { bytes: number } | undefined
): MimeNode {
	const n = raw.length;
	const frames: PartFrame[] = [
		{
			segStart: 0,
			depth,
			nested,
			siblings: null,
			bodyStart: -1,
			pendingHeaderEnd: -1,
			node: null,
			container: null,
		},
	];
	// Delimiter text -> indexes of the frames whose container uses it, outermost
	// first. Only containers still before or inside a part are listed.
	const delimiters = new Map<string, number[]>();
	// The previous line: where it starts and where its content ends.
	let prevStart = -1;
	let prevEnd = -1;

	const register = (key: string, level: number) => {
		const levels = delimiters.get(key);
		if (levels) levels.push(level);
		else delimiters.set(key, [level]);
	};
	const unregister = (key: string) => {
		const levels = delimiters.get(key);
		levels?.pop();
		if (levels?.length === 0) delimiters.delete(key);
	};
	const endContainer = (container: Container) => {
		if (container.state === 'ended') return;
		container.state = 'ended';
		unregister(container.open);
		unregister(container.close);
	};

	/** The header block of `frame` is `[segStart, headerEnd)`; its body starts at `bodyStart`. */
	const readHeaders = (frame: PartFrame, level: number, headerEnd: number, bodyStart: number) => {
		const headers = parseHeaders(raw.slice(frame.segStart, headerEnd));
		const contentType = headers.contentType;
		let container: Container | null = null;
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
			if (boundary !== undefined && boundary !== '' && frame.depth >= MAX_DEPTH) {
				// A container at the depth bound stays a childless leaf. Its parts are
				// never looked at, so record that the tree is incomplete.
				budget.truncated = true;
			} else if (boundary !== undefined && boundary !== '') {
				container = { open: `--${boundary}`, close: `--${boundary}--`, state: 'preamble' };
				register(container.open, level);
				register(container.close, level);
			}
		}
		const node: MimeNode = {
			headers,
			contentType,
			isMultipart: container !== null,
			children: [],
			rawBody: '',
		};
		frame.node = node;
		frame.container = container;
		frame.bodyStart = bodyStart;
		frame.siblings?.push(node);
	};

	/** End the part in `frames[level]` at `segEnd`. */
	const endPart = (level: number, segEnd: number) => {
		const frame = frames[level] as PartFrame;
		// No blank line ended the header block: the whole segment is headers.
		if (frame.bodyStart === -1) readHeaders(frame, level, segEnd, segEnd);
		const node = frame.node as MimeNode;
		if (frame.container) endContainer(frame.container);
		else
			node.rawBody = leafRawBody(
				node.contentType,
				raw.slice(frame.bodyStart, segEnd),
				frame.nested
			);
	};

	/** End every part above `level`, innermost first, just before the current line. */
	const endPartsAbove = (level: number) => {
		while (frames.length - 1 > level) {
			const frame = frames[frames.length - 1] as PartFrame;
			endPart(frames.length - 1, prevStart >= frame.segStart ? prevEnd : frame.segStart);
			frames.pop();
		}
	};

	/** A delimiter line of the container in `frames[level]`; the next line starts at `next`. */
	const delimiter = (level: number, isOpen: boolean, next: number) => {
		endPartsAbove(level);
		const frame = frames[level] as PartFrame;
		const container = frame.container as Container;
		if (!isOpen) {
			endContainer(container);
			return;
		}
		if (budget.remainingParts <= 0) {
			// The part budget is spent and this container has another part.
			budget.truncated = true;
			endContainer(container);
			return;
		}
		budget.remainingParts--;
		container.state = 'part';
		frames.push({
			segStart: next,
			depth: frame.depth + 1,
			nested: true,
			siblings: (frame.node as MimeNode).children,
			bodyStart: -1,
			pendingHeaderEnd: -1,
			node: null,
			container: null,
		});
	};

	/** The trimmed text of a line that could be a delimiter, or null. */
	const delimiterText = (start: number, end: number): string | null => {
		if (end - start < 3 || raw.charCodeAt(start) !== 0x2d || raw.charCodeAt(start + 1) !== 0x2d) {
			return null;
		}
		while (end > start) {
			const c = raw.charCodeAt(end - 1);
			if (c !== 0x20 && c !== 0x09) break;
			end--;
		}
		return raw.slice(start, end);
	};

	let pos = 0;
	while (pos <= n) {
		const nl = raw.indexOf('\n', pos);
		const atEnd = nl === -1;
		const lineEnd = atEnd ? n : nl > pos && raw.charCodeAt(nl - 1) === 0x0d ? nl - 1 : nl;
		const next = atEnd ? n + 1 : nl + 1;
		if (meter) meter.bytes += next - pos;

		// A delimiter of an open container, the outermost one when several match.
		const text = delimiters.size > 0 ? delimiterText(pos, lineEnd) : null;
		const levels = text === null ? undefined : delimiters.get(text);
		if (levels !== undefined) {
			const level = levels[0] as number;
			delimiter(level, text === (frames[level] as PartFrame).container?.open, next);
		} else {
			const top = frames[frames.length - 1] as PartFrame;
			if (top.bodyStart === -1) {
				if (top.pendingHeaderEnd !== -1) {
					// The blank line before this one ended the header block.
					const level = frames.length - 1;
					readHeaders(top, level, top.pendingHeaderEnd, pos);
					// This line is the body's first; it may open the new container.
					const container = top.container;
					const own = container ? delimiterText(pos, lineEnd) : null;
					if (container && own !== null && (own === container.open || own === container.close)) {
						delimiter(level, own === container.open, next);
					}
				} else if (lineEnd === pos && pos > top.segStart && !atEnd) {
					top.pendingHeaderEnd = prevEnd;
				}
			}
		}

		prevStart = pos;
		prevEnd = lineEnd;
		if (atEnd) break;
		pos = next;
	}

	endPartsAbove(0);
	endPart(0, n);
	return frames[0]?.node as MimeNode;
}

/**
 * Parse a raw message into a bounded MIME tree. The optional depth/nested
 * parameters remain for the existing low-level test/API surface; every call
 * starts one fresh part budget shared by every container in the message.
 */
export function parseMimeTree(raw: string, depth = 0, nested = false): MimeNode {
	return parseMimeTreeWithBounds(raw, depth, nested).root;
}

/** A bounded MIME tree plus whether the bounds left any content out of it. */
export interface BoundedMimeTree {
	root: MimeNode;
	/**
	 * `true` when the part budget ran out with parts still unparsed, or a
	 * `multipart/*` container with a boundary sat at the depth bound. Leaves in
	 * the omitted content are absent from {@link walkLeaves}, so a consumer that
	 * vouches for the whole message (a malware scan) must treat it as incomplete.
	 */
	truncated: boolean;
}

/**
 * {@link parseMimeTree}, also reporting whether {@link MAX_DEPTH} or
 * {@link MAX_MIME_PARTS} cut any content off. The tree is identical. `meter`,
 * which only tests pass, counts the bytes the line scan reads.
 */
export function parseMimeTreeWithBounds(
	raw: string,
	depth = 0,
	nested = false,
	meter?: { bytes: number }
): BoundedMimeTree {
	const budget: MimeParseBudget = { remainingParts: MAX_MIME_PARTS, truncated: false };
	const root = parseMimeNode(raw, depth, nested, budget, meter);
	return { root, truncated: budget.truncated };
}

/**
 * Visit every leaf of the tree in document order (depth-first, children
 * left-to-right). A `multipart/*` node with no usable boundary is itself a leaf
 * (and simply contributes nothing on the body/attachment sides).
 */
export function walkLeaves(root: MimeNode, visit: (leaf: MimeNode) => void): void {
	if (root.isMultipart && root.children.length > 0) {
		for (const child of root.children) walkLeaves(child, visit);
		return;
	}
	visit(root);
}

/** The raw (lowercased, trimmed) `Content-Disposition` value of a part. */
function rawDisposition(node: MimeNode): string {
	return (node.headers.last('content-disposition') ?? '').toLowerCase().trim();
}

/**
 * Decoded filename of a part (Content-Disposition `filename`, else Content-Type
 * `name`), or `''`. The header is read as text first, so a raw UTF-8 filename
 * (RFC 6532) decodes. Params are read with the whitespace-anchored scanner, so a
 * no-semicolon `attachment filename="x"` still yields a name, and the value is
 * then RFC 2047-decoded.
 */
export function partFilename(node: MimeNode): string {
	const rawName =
		getRawParam(headerText(node.headers.last('content-disposition')), 'filename') ??
		getRawParam(headerText(node.headers.last('content-type')), 'name');
	return rawName ? decodeEncodedWords(rawName) : '';
}

function headerText(raw: string | undefined): string | undefined {
	return raw === undefined ? undefined : headerBytesToText(raw);
}

/**
 * `inline` when the disposition token starts with `inline`, otherwise
 * `attachment`.
 */
export function partDisposition(node: MimeNode): 'attachment' | 'inline' {
	return rawDisposition(node).startsWith('inline') ? 'inline' : 'attachment';
}

/**
 * Whether a leaf is an attachment: a disposition that starts with `attachment`
 * OR the presence of a filename. `multipart/*` nodes are never attachments. The
 * disposition check is a raw `startsWith('attachment')`, not token equality, so
 * `attachment filename="x"` without a semicolon still counts. This is the one
 * attachment predicate: the writers and `@owlat/shared/mailMime` both use it.
 */
export function isAttachmentPart(node: MimeNode): boolean {
	if (node.contentType.value.startsWith('multipart/')) return false;
	if (rawDisposition(node).startsWith('attachment')) return true;
	return partFilename(node) !== '';
}

/**
 * Transfer-decode a leaf body (binary string) into raw bytes, honoring
 * `Content-Transfer-Encoding`. base64 / quoted-printable / 7bit / 8bit / binary
 * are handled; a malformed base64 part yields empty bytes rather than aborting.
 * `@owlat/shared/mailMime` adapts this decoder rather than keeping its own.
 */
export function transferDecode(
	rawBody: string,
	encoding: string | undefined
): Uint8Array<ArrayBuffer> {
	const enc = (encoding ?? '7bit').toLowerCase().trim();
	if (enc === 'base64') {
		const clean = rawBody.replace(/[^A-Za-z0-9+/=]/g, '');
		let bin: string;
		try {
			bin = atob(clean);
		} catch {
			return new Uint8Array(0);
		}
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	if (enc === 'quoted-printable') {
		const decoded = decodeQpHexEscapes(rawBody.replace(/=\r?\n/g, ''));
		const out = new Uint8Array(decoded.length);
		for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i) & 0xff;
		return out;
	}
	const out = new Uint8Array(rawBody.length);
	for (let i = 0; i < rawBody.length; i++) out[i] = rawBody.charCodeAt(i) & 0xff;
	return out;
}

/** The assembled human-readable bodies of a message. */
export interface AssembledBody {
	/** Concatenated `text/plain` bodies, or `undefined` when there are none. */
	text: string | undefined;
	/**
	 * Concatenated `text/html` bodies, or the load-bearing `false` sentinel when
	 * the message carries no HTML part (mailparser parity — downstream code
	 * distinguishes "no html" from "empty html").
	 */
	html: string | false;
}

/**
 * Which body a leaf feeds, if any: a non-attachment `text/plain` leaf is
 * `text`, a non-attachment `text/html` leaf is `html`, anything else is none.
 * {@link assembleBody}'s rule, exported so a reader of a body's bytes (the
 * clearsigned verifier) picks exactly the leaves the displayed body is made of.
 */
export function bodyLeafKind(leaf: MimeNode): 'text' | 'html' | null {
	if (isAttachmentPart(leaf)) return null;
	const { type, subtype } = leaf.contentType;
	if (type !== 'text') return null;
	if (subtype === 'plain') return 'text';
	if (subtype === 'html') return 'html';
	return null;
}

/**
 * Flatten a parsed MIME tree into `text` / `html` bodies. Every
 * {@link bodyLeafKind} `text` leaf feeds `text` and every `html` leaf feeds
 * `html`; each is transfer-decoded and then charset-decoded under ITS OWN
 * declared charset. `html` is `false` when no HTML part exists.
 */
export function assembleBody(root: MimeNode): AssembledBody {
	const textParts: string[] = [];
	const htmlParts: string[] = [];

	walkLeaves(root, (leaf) => {
		const kind = bodyLeafKind(leaf);
		if (kind === null) return;
		const bytes = transferDecode(leaf.rawBody, leaf.headers.last('content-transfer-encoding'));
		const decoded = decodeCharset(bytes, leaf.contentType.params['charset']);
		if (kind === 'html') htmlParts.push(decoded);
		else textParts.push(decoded);
	});

	return {
		text: textParts.length > 0 ? textParts.join('\n') : undefined,
		html: htmlParts.length > 0 ? htmlParts.join('\n') : false,
	};
}

/** Parse a raw message and assemble its `text` / `html` bodies in one call. */
export function parseBody(raw: string): AssembledBody {
	return assembleBody(parseMimeTree(raw));
}
