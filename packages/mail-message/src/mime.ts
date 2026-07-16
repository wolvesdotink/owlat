/**
 * Pure MIME entity construction — the RFC 2045/2046/2387 building blocks shared
 * by `buildRfc822` (legacy) and `composeMessage`. No `ctx`, db, network, or
 * `await`; deterministic w.r.t. its inputs (boundary allocation is the caller's
 * concern via the injected `nextBoundary`).
 */

import { encodeTextBody } from './encoding';
import { escapeHeader, safeAttachmentFilename } from './headers';

/**
 * Attachment content at the package boundary: either decoded `Buffer` bytes or
 * an already-base64-encoded string. Storage fetching / decoding happens in the
 * Convex send path before the bytes reach the composer.
 */
export interface ComposeAttachment {
	filename: string;
	contentType: string;
	isInline: boolean;
	data: Buffer | string;
	contentId?: string;
}

/**
 * A self-contained MIME entity: the header lines that describe it (its
 * Content-Type et al.) plus the already-encoded body that follows the blank
 * line. Composing a message is wrapping one entity inside another (an
 * `alternative` inside a `related` inside a `mixed`), so keeping the two apart
 * lets `asPart` re-emit any entity as a child under a parent boundary.
 */
export interface MimeEntity {
	headerLines: string[];
	body: string;
}

/** A text MIME entity (text/plain, text/html, text/x-amp-html): content-type, chosen CTE, encoded body. */
function textEntity(contentType: string, body: string): MimeEntity {
	const { cte, encoded } = encodeTextBody(body);
	return {
		headerLines: [
			`Content-Type: ${contentType}; charset=utf-8`,
			`Content-Transfer-Encoding: ${cte}`,
		],
		body: encoded,
	};
}

/** Emit an entity as a child part under `parentBoundary` (no trailing CRLF). */
function asPart(parentBoundary: string, entity: MimeEntity): string {
	return `--${parentBoundary}\r\n` + `${entity.headerLines.join('\r\n')}\r\n\r\n${entity.body}`;
}

/** Join child parts with CRLF and close the multipart with its `--boundary--`. */
function closeMultipart(boundary: string, parts: string[]): string {
	return `${parts.join('\r\n')}\r\n--${boundary}--`;
}

/**
 * Seeded boundaries are predictable by design, so — unlike the crypto-random
 * path — a hostile body line equal to `--${boundary}` would split the part
 * (part smuggling / a broken message). Assert no line in a child entity (its
 * full serialized subtree, so descendant leaves are covered too) is this
 * multipart's delimiter, and throw loudly if one is.
 */
function assertNoBoundaryCollision(boundary: string, child: MimeEntity): void {
	const delim = `--${boundary}`;
	const serialized = `${child.headerLines.join('\r\n')}\r\n\r\n${child.body}`;
	for (const rawLine of serialized.split('\r\n')) {
		// A MIME parser treats a line as this multipart's delimiter only when it is
		// exactly `--boundary` or the closing `--boundary--` (transport padding
		// whitespace allowed after). Match that precisely so a nested boundary that
		// merely shares a prefix (`_1` vs `_10`) is not a false positive.
		const line = rawLine.replace(/[ \t]+$/, '');
		if (line === delim || line === `${delim}--`) {
			throw new Error(
				`boundary collision: a child line is the delimiter "${delim}" ` +
					'(part smuggling); this must never happen with a random boundary and ' +
					'indicates a hostile body under a seeded boundary'
			);
		}
	}
}

/** Wrap child entities in a multipart of the given media type, guarding against boundary collision. */
function multipart(boundary: string, contentTypeLine: string, children: MimeEntity[]): MimeEntity {
	for (const child of children) assertNoBoundaryCollision(boundary, child);
	return {
		headerLines: [contentTypeLine],
		body: closeMultipart(
			boundary,
			children.map((c) => asPart(boundary, c))
		),
	};
}

/**
 * Matches a string that is nothing but base64 alphabet characters — no
 * whitespace, no CRLF, no padding mid-string. A caller who passes raw text by
 * mistake (instead of a `Buffer` or an already-base64 string) hits this and
 * fails loudly, rather than shipping a MIME part whose 76-char re-chunk regex
 * has miscounted embedded CRLFs into its window.
 */
const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A Content-ID appears inside angle brackets (`<...>`), so CRLF would smuggle a
 * header and a literal `<`/`>` would break the bracket structure. Strip all four.
 */
function sanitizeContentId(id: string): string {
	return id.replace(/[\r\n<>]/g, '');
}

/** A base64 attachment/inline entity (Content-Disposition + optional Content-ID). */
function attachmentEntity(att: ComposeAttachment): MimeEntity {
	let base64: string;
	if (typeof att.data === 'string') {
		if (!BASE64_ONLY.test(att.data)) {
			throw new Error(
				`attachment "${att.filename}": string data must be base64 ` +
					'(A-Za-z0-9+/=); pass a Buffer for raw bytes'
			);
		}
		base64 = att.data;
	} else {
		base64 = att.data.toString('base64');
	}
	const b64 = base64.replace(/(.{76})/g, '$1\r\n');
	const dispositionType = att.isInline ? 'inline' : 'attachment';
	// contentType comes from user-uploaded file metadata; strip CRLF so it cannot
	// smuggle a header. contentId additionally cannot carry `<`/`>` or CRLF.
	const headerLines = [
		`Content-Type: ${escapeHeader(att.contentType)}`,
		'Content-Transfer-Encoding: base64',
		`Content-Disposition: ${dispositionType}; filename="${safeAttachmentFilename(att.filename)}"`,
	];
	if (att.contentId) headerLines.push(`Content-ID: <${sanitizeContentId(att.contentId)}>`);
	return { headerLines, body: b64 };
}

/** Inputs to the shared body/attachment assembler. */
export interface BodyParams {
	text: string;
	html: string;
	amp: string | undefined;
	useMultipartAlt: boolean;
	inlineParts: ComposeAttachment[];
	fileParts: ComposeAttachment[];
	nextBoundary: () => string;
	/**
	 * Legacy shape kept for `buildRfc822`'s not-yet-cut-over call sites: the
	 * `related` wraps the WHOLE alternative. nodemailer (and `composeMessage`)
	 * instead nest `related` inside the alternative, wrapping only the html leaf.
	 */
	legacyRelatedNesting: boolean;
	/** Content-Type media for a single (non-multipart) body. */
	singlePartContentType: 'text/html' | 'text/plain';
}

/**
 * Build the message "content" entity — the body plus its attachments — shared by
 * `buildRfc822` and `composeMessage`, collapsing each MIME layer that is
 * unneeded. The nodemailer-parity shape is
 * `mixed(alternative(plain[, amp], related(html, inline)), files)`: the
 * `related` sits as the LAST alternative child and wraps only the html leaf +
 * its inline cid: parts. `legacyRelatedNesting` restores the older shape where
 * `related` wraps the whole alternative.
 *
 * RFC 2046: an alternative reader picks the LAST part it can render, so the
 * AMP-email order is text/plain -> text/x-amp-html -> text/html.
 */
export function assembleBody(p: BodyParams): MimeEntity {
	const relatedWrap = (inner: MimeEntity): MimeEntity => {
		const b = p.nextBoundary();
		return multipart(b, `Content-Type: multipart/related; type="text/html"; boundary="${b}"`, [
			inner,
			...p.inlineParts.map(attachmentEntity),
		]);
	};

	let content: MimeEntity;
	if (p.useMultipartAlt) {
		const htmlPart = textEntity('text/html', p.html);
		const htmlSlot =
			!p.legacyRelatedNesting && p.inlineParts.length > 0 ? relatedWrap(htmlPart) : htmlPart;
		const altB = p.nextBoundary();
		content = multipart(altB, `Content-Type: multipart/alternative; boundary="${altB}"`, [
			textEntity('text/plain', p.text),
			...(p.amp ? [textEntity('text/x-amp-html', p.amp)] : []),
			htmlSlot,
		]);
		if (p.legacyRelatedNesting && p.inlineParts.length > 0) content = relatedWrap(content);
	} else {
		// Single part: text/html or text/plain. CRLF-normalize and pick a CTE that
		// keeps every line <=998 octets and never emits 8bit (RFC 5322, RFC 6152).
		content = textEntity(p.singlePartContentType, p.html || p.text);
		if (p.inlineParts.length > 0) content = relatedWrap(content);
	}

	if (p.fileParts.length > 0) {
		const mixB = p.nextBoundary();
		content = multipart(mixB, `Content-Type: multipart/mixed; boundary="${mixB}"`, [
			content,
			...p.fileParts.map(attachmentEntity),
		]);
	}
	return content;
}
