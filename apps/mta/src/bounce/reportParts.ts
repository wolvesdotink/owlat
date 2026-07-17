/**
 * DSN / ARF report-part recovery for the bounce scrapers.
 *
 * The bounce DSN parser and the FBL/ARF processor read the machine-readable
 * `message/delivery-status`, `message/feedback-report`, `message/rfc822` and
 * `text/rfc822-headers` sub-parts of a report — the parts that carry the
 * authoritative `Status:`/`Action:`/`Diagnostic-Code:`, the structured
 * feedback-report fields, and the echoed `X-Owlat-*` headers.
 *
 * mailparser surfaced every non-text, non-multipart part as an `attachment` —
 * AND, quirkily, folded a disposition-less `message/delivery-status` into the
 * human-readable `.text` body rather than an attachment. Either way its content
 * was always reachable to the old scrapers (from `parsed.attachments` or, for a
 * bare delivery-status, from `parsed.text`). `@owlat/mail-message`'s
 * `parseMessage` follows the `mailMime` predicate instead: a part is an
 * attachment only when it carries a `Content-Disposition: attachment` or a
 * filename, and only `text/plain` / `text/html` fold into `text`/`html`. Real
 * DSNs/ARFs set NEITHER disposition nor filename on their `message/*` report
 * parts, so those parts would vanish from BOTH `parsed.attachments` and
 * `parsed.text` — silently degrading bounce classification and FBL attribution.
 *
 * To keep the scrapers behavior-preserving across the cutover, we recover the
 * report parts by walking the MIME tree directly with the same
 * `parseMimeTree` / `walkLeaves` / `transferDecode` primitives the parser uses.
 * Every leaf that is NOT a true message body — i.e. not a `text/plain` /
 * `text/html` leaf that lacks an attachment disposition/filename — and NOT a
 * `multipart/*` container is surfaced. That is exactly the `mailMime`
 * attachment predicate ({@link isAttachmentPart}) UNION the non-body `message/*`
 * report parts, matching what mailparser handed the scrapers. A `text/plain`
 * attachment (a bounce that returns the original as a text/plain attachment)
 * therefore stays visible to the `X-Owlat-Message-Id` scan, not dropped as body.
 */

import {
	parseMimeTree,
	walkLeaves,
	transferDecode,
	isAttachmentPart,
	partFilename,
	partDisposition,
} from '@owlat/mail-message';

/** A recovered report sub-part — the `{ contentType, content }` shape the scrapers read. */
export interface ReportPart {
	/** Lowercased `type/subtype` (e.g. `message/delivery-status`). */
	contentType: string;
	/** Transfer-decoded part bytes. */
	content: Buffer;
	/**
	 * Attachment-surface metadata mirroring mailparser's attachment fields, for
	 * consumers (e.g. the shadow-replay driver projection) that compare the
	 * recovered surface against mailparser's `attachments`. The scrapers themselves
	 * read only {@link contentType} and {@link content}.
	 */
	/** Decoded filename, or `''` for a disposition-less report part. */
	filename?: string;
	/** `attachment` (default) or `inline` per the part's Content-Disposition. */
	disposition?: 'attachment' | 'inline';
	/** Raw `Content-ID` header value, or `undefined`. */
	contentId?: string;
	/** Byte length of {@link content}. */
	size?: number;
}

/**
 * A leaf is a TRUE message body (folded into `parsed.text`/`.html`, never a
 * report attachment) only when it is a `text/plain` / `text/html` part with no
 * attachment disposition/filename — the exact `mailMime` predicate the parser
 * uses. Everything else (real attachments AND the disposition-less `message/*`
 * report parts) is a recoverable report part.
 */
function isBodyLeaf(contentType: string, isAttachment: boolean): boolean {
	return (contentType === 'text/plain' || contentType === 'text/html') && !isAttachment;
}

/**
 * Recover the non-body report parts of a raw message, matching mailparser's
 * `attachments` for the bounce/FBL scrapers. `raw` may be a Buffer (decoded as
 * latin1, the binary-string convention the MIME walker expects) or a binary string.
 */
export function extractReportParts(raw: string | Buffer): ReportPart[] {
	const binary = typeof raw === 'string' ? raw : raw.toString('latin1');
	const parts: ReportPart[] = [];
	walkLeaves(parseMimeTree(binary), (leaf) => {
		const contentType = leaf.contentType.value;
		if (isBodyLeaf(contentType, isAttachmentPart(leaf))) return;
		const bytes = transferDecode(leaf.rawBody, leaf.headers.last('content-transfer-encoding'));
		const content = Buffer.from(bytes);
		parts.push({
			contentType,
			content,
			filename: partFilename(leaf),
			disposition: partDisposition(leaf),
			contentId: leaf.headers.last('content-id') ?? undefined,
			size: content.length,
		});
	});
	return parts;
}
