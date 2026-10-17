/**
 * The calm reader's one notice slot (SPEC §3): one banner per thread, in
 * priority order. It is the list pane's banner-slot rule (`PostboxBannerSlot`)
 * applied to the open thread: the next one takes the slot the moment the one
 * above it resolves. Pure.
 *
 *   danger     the latest message is spam, or failed DMARC
 *   keyChange  the correspondent's sealing key rotated unsigned (Sealed Mail)
 *   leftDraft  a reply to this thread was left in Answer mode
 *   images     the latest message's image consent (blocked / auto-loaded /
 *              trackers withheld / unchecked)
 *
 * The other per-message banners move into Details.
 */

export type ReaderNoticeKind = 'danger' | 'keyChange' | 'leftDraft' | 'images';

const READER_NOTICE_ORDER: readonly ReaderNoticeKind[] = [
	'danger',
	'keyChange',
	'leftDraft',
	'images',
];

export function pickReaderNotice(
	active: Readonly<Partial<Record<ReaderNoticeKind, boolean>>>
): ReaderNoticeKind | null {
	return READER_NOTICE_ORDER.find((kind) => active[kind] === true) ?? null;
}

/** The danger the slot raises for a message: spam, or a DMARC failure. */
export function readerDangerOf(
	message: { spamVerdict?: string; dmarcResult?: string } | undefined
): 'spam' | 'dmarc' | null {
	if (!message) return null;
	if (message.spamVerdict === 'spam') return 'spam';
	return message.dmarcResult === 'fail' ? 'dmarc' : null;
}
