/**
 * Pure RFC 5322 / RFC 2045 message construction.
 *
 * `buildRfc822` takes plain data (a neutral `ComposeInput` plus decoded
 * attachment bytes) and returns the exact `.eml` bytes that get stored and
 * shipped to the MTA — no `ctx`, db, network, or `await`. Deterministic w.r.t.
 * its inputs; the only impurities live in `encoding.randomBoundary` and the
 * caller-supplied `Message-ID` / `Date`.
 *
 * Storage fetching, DraftRow mapping, and transport orchestration live in the
 * Convex adapter (`apps/api/convex/mail/rfc822.ts`) and `outbound.ts`.
 */

import { encodeAddressHeader, encodeHeaderValue, safeAttachmentFilename } from './headers';
import { encodeTextBody, randomBoundary } from './encoding';

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
 * The neutral shape the composer reads. The Convex adapter maps its `DraftRow`
 * onto this so the composer never depends on Convex types.
 */
export interface ComposeInput {
	fromAddress: string;
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	bodyText?: string;
	/**
	 * Rendered AMP4Email body. Present only for block-designed drafts that use an
	 * interactive block. When set, the multipart message carries it as a
	 * `text/x-amp-html` alternative for AMP-capable clients, with the HTML part as
	 * the fallback.
	 */
	bodyAmp?: string;
}

/** Render a single text MIME part: boundary, content-type, chosen CTE, encoded body. */
function textPart(
	boundary: string,
	contentType: string,
	body: string,
	trailingCrlf: boolean
): string {
	const { cte, encoded } = encodeTextBody(body);
	const part =
		`--${boundary}\r\nContent-Type: ${contentType}; charset=utf-8\r\n` +
		`Content-Transfer-Encoding: ${cte}\r\n\r\n${encoded}`;
	return trailingCrlf ? `${part}\r\n` : part;
}

/**
 * A self-contained MIME entity: the header lines that describe it (its
 * Content-Type et al.) plus the already-encoded body that follows the blank
 * line. Composing a message is wrapping one entity inside another (an
 * `alternative` inside a `related` inside a `mixed`), so keeping the two apart
 * lets `asPart` re-emit any entity as a child under a parent boundary.
 */
interface MimeEntity {
	headerLines: string[];
	body: string;
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
 * Matches a string that is nothing but base64 alphabet characters — no
 * whitespace, no CRLF, no padding mid-string. A caller who passes raw text by
 * mistake (instead of a `Buffer` or an already-base64 string) hits this and
 * fails loudly, rather than shipping a MIME part whose 76-char re-chunk regex
 * has miscounted embedded CRLFs into its window.
 */
const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/;

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
	const headerLines = [
		`Content-Type: ${att.contentType}`,
		'Content-Transfer-Encoding: base64',
		`Content-Disposition: ${dispositionType}; filename="${safeAttachmentFilename(att.filename)}"`,
	];
	if (att.contentId) headerLines.push(`Content-ID: <${att.contentId}>`);
	return { headerLines, body: b64 };
}

export function buildRfc822(
	input: ComposeInput,
	attachments: ComposeAttachment[],
	rfc822MessageId: string,
	inReplyToHeaderValue: string | undefined,
	referencesHeaderValue: string | undefined
): { raw: Buffer; size: number } {
	const headers: string[] = [];
	headers.push(`Message-ID: ${rfc822MessageId}`);
	// RFC 5322 §3.3 date-time uses a numeric `zone` (`+0000`). `toUTCString()`
	// emits the obsolete `GMT` form (RFC 5322 §4.3 obs-zone), so rewrite the
	// trailing zone to the canonical `+0000`.
	headers.push(`Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`);
	headers.push(`From: ${encodeAddressHeader([input.fromAddress])}`);
	headers.push(`To: ${encodeAddressHeader(input.toAddresses)}`);
	if (input.ccAddresses.length > 0) {
		headers.push(`Cc: ${encodeAddressHeader(input.ccAddresses)}`);
	}
	// Bcc is visible to the envelope only; it is deliberately never emitted as a header.
	headers.push(`Subject: ${encodeHeaderValue(input.subject || '(no subject)')}`);
	if (inReplyToHeaderValue) headers.push(`In-Reply-To: ${inReplyToHeaderValue}`);
	if (referencesHeaderValue) headers.push(`References: ${referencesHeaderValue}`);
	headers.push('MIME-Version: 1.0');

	const amp = input.bodyAmp;
	// An AMP part always needs a multipart/alternative wrapper so non-AMP
	// clients can fall through to the HTML part.
	const useMultipartAlt = (!!input.bodyText && !!input.bodyHtml) || !!amp;
	const text = input.bodyText ?? stripHtml(input.bodyHtml ?? '');
	const html = input.bodyHtml ?? '';

	// Inline images (a `cid:`-referenced `<img>` in the body) ride in a
	// multipart/related next to the HTML that references them; file attachments
	// stay in the outer multipart/mixed. An inline part is one flagged `isInline`
	// AND carrying a Content-ID (the two together are how the send path marks an
	// embedded body image); everything else is a downloadable attachment.
	const inlineParts = attachments.filter((a) => a.isInline && !!a.contentId);
	const fileParts = attachments.filter((a) => !(a.isInline && a.contentId));

	// ── The message "content" entity: the body itself, before any attachments.
	// Either a single text/html part, or a multipart/alternative carrying
	// text/plain, an optional text/x-amp-html, and the text/html fallback.
	// RFC 2046: an alternative reader picks the LAST part it can render, so the
	// AMP-email order is text/plain → text/x-amp-html → text/html.
	let content: MimeEntity;
	if (useMultipartAlt) {
		const altBoundary = randomBoundary();
		const altBody =
			textPart(altBoundary, 'text/plain', text, true) +
			(amp ? textPart(altBoundary, 'text/x-amp-html', amp, true) : '') +
			textPart(altBoundary, 'text/html', html, true) +
			`--${altBoundary}--`;
		content = {
			headerLines: [`Content-Type: multipart/alternative; boundary="${altBoundary}"`],
			body: altBody,
		};
	} else {
		// Single-part HTML. CRLF-normalize and pick a CTE that keeps every line
		// <=998 octets and never emits 8bit (RFC 5322 §2.1.1, RFC 6152).
		const { cte, encoded } = encodeTextBody(html || text);
		content = {
			headerLines: ['Content-Type: text/html; charset=utf-8', `Content-Transfer-Encoding: ${cte}`],
			body: encoded,
		};
	}

	// Wrap the body + its inline images in multipart/related (RFC 2387). The
	// `type` parameter names the root part so a reader knows the HTML is the
	// entity the cid: images belong to.
	if (inlineParts.length > 0) {
		const relBoundary = randomBoundary();
		const parts = [
			asPart(relBoundary, content),
			...inlineParts.map((att) => asPart(relBoundary, attachmentEntity(att))),
		];
		content = {
			headerLines: [`Content-Type: multipart/related; type="text/html"; boundary="${relBoundary}"`],
			body: closeMultipart(relBoundary, parts),
		};
	}

	// Wrap everything in multipart/mixed when there are file attachments.
	if (fileParts.length > 0) {
		const mixBoundary = randomBoundary();
		const parts = [
			asPart(mixBoundary, content),
			...fileParts.map((att) => asPart(mixBoundary, attachmentEntity(att))),
		];
		content = {
			headerLines: [`Content-Type: multipart/mixed; boundary="${mixBoundary}"`],
			body: closeMultipart(mixBoundary, parts),
		};
	}

	const raw = Buffer.from(
		`${headers.join('\r\n')}\r\n${content.headerLines.join('\r\n')}\r\n\r\n${content.body}\r\n`,
		'utf-8'
	);
	return { raw, size: raw.length };
}

export function stripHtml(html: string): string {
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
