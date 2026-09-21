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
 * Why a leaf of a received message was NOT cleared for indexing. Counted per
 * cause, because the causes send a reader to different places: "this message
 * has more attachments than we process" and "the scanner could not look at one
 * of these" are not the same sentence, and one number standing in for both
 * reported a ClamAV outage as a message with too many files.
 */
export type UnclearedLeaves = {
	/**
	 * A DOCUMENT never opened at all — past the per-message scan count cap.
	 * Documents only, because this is what the reader is told as "more
	 * attachments than one message is processed for", and an embedded signature
	 * logo is not an attachment anyone sent. An INLINE leaf the same cap left
	 * unopened is counted under `unscanned`, which is the true sentence about
	 * it and still keeps the message off a `'clean'` verdict.
	 */
	capped: number;
	/**
	 * Nobody looked at these bytes: a scanner outage, a timeout, its own
	 * fail-open skip — or an inline leaf the per-message count cap never
	 * reached.
	 */
	unscanned: number;
	/** The scanner refused the file type before ClamAV ever ran. */
	refusedType: number;
};

/** No leaf was withheld, for any reason. */
export const NOTHING_UNCLEARED: UnclearedLeaves = { capped: 0, unscanned: 0, refusedType: 0 };

/**
 * Every leaf of a received message that the reader will see listed, scan order
 * first.
 *
 * THE SET IS THE ONE THE READER GETS, not a narrower one. This used to drop
 * every `Content-Disposition: inline` leaf on the grounds that a signature logo
 * is not a document — but the MTA lists any leaf carrying a filename whatever
 * its disposition (`mail-message/parse/body.isAttachmentPart`), the thread view
 * renders a download button for each, and so one header word (`inline` instead
 * of `attachment` on an `invoice.pdf.exe`) bought a sender a live download of
 * bytes ClamAV never saw. Everything the reader can download is scanned — or,
 * where the per-message count cap ran out first, the verdict says so and the
 * row carries the line that says so. What may be INDEXED is narrowed later,
 * inside capture, out of this same set.
 *
 * ORDERED, because the scan budget is a COUNT: attachment-disposition leaves
 * come first so a message of ten inline logos followed by an executable spends
 * the budget on the executable. Empty parts are not bytes at all and carry no
 * verdict worth a round-trip.
 */
export function inboundAttachmentCandidates(rawBinary: string): InboundAttachmentPart[] {
	const leaves = extractAttachments(rawBinary).filter((part) => part.bytes.byteLength > 0);
	return [
		...leaves.filter((part) => part.disposition !== 'inline'),
		...leaves.filter((part) => part.disposition === 'inline'),
	];
}
