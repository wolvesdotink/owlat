/**
 * MIME part-tree assembly: parse a raw RFC 822 message (carried as a binary
 * string — one char per byte, e.g. `new TextDecoder('latin1').decode(bytes)`)
 * into a tree of {@link MimeNode}s, then flatten it into the `text` / `html`
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
	type MessageHeaders,
} from './headers';
import { type ContentType } from './contentType';
import { decodeCharset } from './charset';

/** Hard ceiling on multipart nesting depth; beyond it a node is left as a leaf. */
const MAX_DEPTH = 100;

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

/** Split a raw part into its header block and body at the first blank line. */
function splitHeadersAndBody(raw: string): { headerText: string; body: string } {
	const m = raw.match(/\r?\n\r?\n/);
	if (!m || m.index == null) return { headerText: raw, body: '' };
	return { headerText: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
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
 * per-leaf, only to the parts where the old `mailMime` extractor applied it (see
 * {@link leafRawBody}); `message/*` payloads and the top-level body are kept
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
		const t = body.slice(pos, lineEnd).replace(/[ \t]+$/, '');
		if (t === open || t === close) {
			if (partStart !== -1) {
				yield body.slice(partStart, prevLineEnd === -1 ? partStart : prevLineEnd);
			}
			if (t === close) {
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
}

/**
 * The raw (pre-transfer-decode) body of a leaf. `message/*` payloads and the
 * top-level (non-`nested`) body are kept VERBATIM — mailparser preserves their
 * exact CRLF bytes, and downstream DSN scraping / message re-verification depends
 * on those bytes. Every other nested leaf is CRLF -> LF normalized, reproducing
 * the byte-for-byte behavior of the old `mailMime` per-part `split(/\r?\n/).join('\n')`.
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

	if (contentType.value.startsWith('multipart/') && depth < MAX_DEPTH) {
		// Gate on the `multipart/` PREFIX, not `type === 'multipart'`: `value` is
		// byte-identical to mailMime's `mainType` (up-to-first-`;`, trimmed,
		// lowercased), so a slashless `Content-Type: multipart` is NOT a container
		// (matching `mainType.startsWith('multipart/')` === false) and stays a leaf
		// exactly as the oracle treats it.
		//
		// Read the boundary from the RAW Content-Type via the whitespace-anchored
		// scanner, byte-for-byte as `mailMime.getBoundary` does — NOT from the
		// semicolon-anchored `contentType.params`, so a no-semicolon
		// `multipart/mixed boundary="B"` is a multipart with indexed parts on both
		// sides and the stored partIndex contract is preserved.
		const boundary = getRawParam(headers.last('content-type'), 'boundary');
		if (boundary !== undefined && boundary !== '') {
			isMultipart = true;
			const parts = splitMultipart(body, boundary);
			while (budget.remainingParts > 0) {
				// Pull lazily only while budget remains, so the unsplit remainder is never
				// scanned or collected into an intermediate parts array.
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

/**
 * Parse a raw message into a bounded MIME tree. The optional depth/nested
 * parameters remain for the existing low-level test/API surface; every call
 * starts one fresh global part budget shared by all recursive branches.
 */
export function parseMimeTree(raw: string, depth = 0, nested = false): MimeNode {
	return parseMimeNode(raw, depth, nested, { remainingParts: MAX_MIME_PARTS });
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
 * `name`), or `''`. Matches `mailMime.extractAttachments` byte-for-byte, including
 * the no-semicolon param extraction and the `decodeEncodedWords` post-step.
 */
export function partFilename(node: MimeNode): string {
	const rawName =
		getRawParam(node.headers.last('content-disposition'), 'filename') ??
		getRawParam(node.headers.last('content-type'), 'name');
	return rawName ? decodeEncodedWords(rawName) : '';
}

/**
 * `inline` when the disposition token starts with `inline`, otherwise
 * `attachment` (mailMime parity: `disposition.startsWith('inline')`).
 */
export function partDisposition(node: MimeNode): 'attachment' | 'inline' {
	return rawDisposition(node).startsWith('inline') ? 'inline' : 'attachment';
}

/**
 * Whether a leaf is an attachment: a disposition that starts with `attachment`
 * OR the presence of a filename. `multipart/*` nodes are never attachments. This
 * is byte-for-byte the predicate `mailMime.extractAttachments` uses (a raw
 * `startsWith('attachment')`, not token equality — so `attachment filename="x"`
 * without a semicolon still counts).
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
 * Byte-for-byte identical to the current `mailMime` decoder.
 */
export function transferDecode(rawBody: string, encoding: string | undefined): Uint8Array {
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
 * Flatten a parsed MIME tree into `text` / `html` bodies. Every non-attachment
 * `text/plain` leaf feeds `text`; every non-attachment `text/html` leaf feeds
 * `html`; each is transfer-decoded and then charset-decoded under ITS OWN
 * declared charset. `html` is `false` when no HTML part exists.
 */
export function assembleBody(root: MimeNode): AssembledBody {
	const textParts: string[] = [];
	const htmlParts: string[] = [];

	walkLeaves(root, (leaf) => {
		if (isAttachmentPart(leaf)) return;
		const { type, subtype } = leaf.contentType;
		if (type !== 'text') return;
		if (subtype !== 'plain' && subtype !== 'html') return;
		const bytes = transferDecode(leaf.rawBody, leaf.headers.last('content-transfer-encoding'));
		const decoded = decodeCharset(bytes, leaf.contentType.params['charset']);
		if (subtype === 'html') htmlParts.push(decoded);
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
