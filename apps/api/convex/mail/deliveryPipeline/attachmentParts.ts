/**
 * ONE selection of "the attachment leaves of a received message".
 *
 * The malware scanner and the semantic-file capture used to each walk the raw
 * MIME and each apply their own filter, and the two only agreed when every
 * leaf was ingestible. They did not agree for a message of ten `.exe` stubs
 * followed by one `.txt`: the scanner spent its ten-part budget on the stubs
 * and answered `clean`, while capture — which drops the stubs BEFORE counting —
 * still had a slot left and ingested the `.txt` nobody had scanned.
 *
 * So the selection lives here, once, and the scanner hands capture the parts it
 * cleared rather than both of them re-deriving a set from the same bytes.
 */

import { extractAttachments } from '@owlat/shared/mailMime';

/** One attachment leaf as the MIME walker returns it. */
export type InboundAttachmentPart = ReturnType<typeof extractAttachments>[number];

/**
 * Every leaf of a received message that is a real attachment, in MIME order.
 *
 * Inline parts (embedded logos, signature images) are not documents a reader
 * thinks of as attachments and carry no delivery-gating risk worth a scan
 * round-trip; an empty part is not bytes at all. Everything else — including
 * types the file-type allowlist will refuse and parts over the AI ceiling — IS
 * a candidate, because the malware verdict is about the whole message and a
 * `.exe` is precisely the leaf worth scanning.
 */
export function inboundAttachmentCandidates(rawBinary: string): InboundAttachmentPart[] {
	return extractAttachments(rawBinary).filter(
		(part) => part.disposition !== 'inline' && part.bytes.byteLength > 0
	);
}
