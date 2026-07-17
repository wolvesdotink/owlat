/**
 * DSN / ARF report-part recovery for the bounce scrapers.
 *
 * The bounce DSN parser and the FBL/ARF processor read the machine-readable
 * `message/delivery-status`, `message/feedback-report`, `message/rfc822` and
 * `text/rfc822-headers` sub-parts of a report — the parts that carry the
 * authoritative `Status:`/`Action:`/`Diagnostic-Code:`, the structured
 * feedback-report fields, and the echoed `X-Owlat-*` headers.
 *
 * mailparser surfaced EVERY non-text, non-multipart part as an `attachment`
 * regardless of Content-Disposition, so those parts were always in
 * `parsed.attachments`. `@owlat/mail-message`'s `parseMessage` follows the
 * `mailMime` predicate instead: a part is an attachment only when it carries a
 * `Content-Disposition: attachment` or a filename. Real DSNs/ARFs set NEITHER on
 * their `message/*` report parts, so they would vanish from `parsed.attachments`
 * — silently degrading bounce classification and FBL attribution.
 *
 * To keep the scrapers byte-for-byte behavior-preserving across the cutover, we
 * recover the report parts by walking the MIME tree directly (the same
 * `parseMimeTree` / `walkLeaves` / `transferDecode` primitives the submission
 * listener uses for its AMP recovery). Every leaf that is NOT the message body
 * (`text/plain` / `text/html`, which `parseMessage` folds into `text`/`html`) and
 * NOT a `multipart/*` container is surfaced — matching what mailparser handed the
 * scrapers as `attachments`.
 */

import { parseMimeTree, walkLeaves, transferDecode } from '@owlat/mail-message';

/** A recovered report sub-part — the `{ contentType, content }` shape the scrapers read. */
export interface ReportPart {
	/** Lowercased `type/subtype` (e.g. `message/delivery-status`). */
	contentType: string;
	/** Transfer-decoded part bytes. */
	content: Buffer;
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
		// `text/plain` / `text/html` are the message body (folded into `text`/`html`
		// by `parseMessage`), never a report attachment — mailparser did the same.
		if (contentType === 'text/plain' || contentType === 'text/html') return;
		const bytes = transferDecode(leaf.rawBody, leaf.headers.last('content-transfer-encoding'));
		parts.push({ contentType, content: Buffer.from(bytes) });
	});
	return parts;
}
