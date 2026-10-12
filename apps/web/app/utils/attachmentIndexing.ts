/**
 * The line a message's attachment-indexing marker renders as, shared by the
 * Team inbox and the Postbox reader. Both routes record the same marker
 * (`inboundMessages.attachmentIndexing`, `mailMessages.attachmentIndexing`;
 * `mail/deliveryPipeline/captureMarker.ts`), so they say the same sentence.
 *
 * TOTAL OVER THE UNION, not `Record<string, string>`: the marker comes from
 * `attachmentIndexingValidator`, and an untyped table let a new member compile
 * everywhere and then render as nothing, a row that looks exactly like a file
 * the assistant read, which is the defect these lines exist to close.
 */
import type { Doc } from '@owlat/api/dataModel';

export type AttachmentIndexing = NonNullable<Doc<'mailMessages'>['attachmentIndexing']>;

type NotIndexedMarker = Exclude<AttachmentIndexing, 'indexed'>;

const NOT_INDEXED_KEYS: Record<NotIndexedMarker, string> = {
	indexed_placeholder: 'notIndexedPlaceholder',
	skipped_unscanned: 'notScanned',
	skipped_unverified: 'notIndexedUnverified',
	skipped_budget: 'notIndexedBudget',
	skipped_cap: 'notIndexedCap',
	skipped_refused_type: 'notIndexedRefusedType',
	skipped_too_large: 'notIndexedTooLarge',
	skipped_unsupported: 'notIndexedUnsupported',
	skipped_failed: 'notIndexedFailed',
	skipped_spam: 'notIndexedSpam',
	skipped_automated: 'notIndexedAutomated',
};

/** The catalog key of the not-indexed line, or null for an indexed (or unmarked) message. */
export function notIndexedNoticeKey(marker: AttachmentIndexing | undefined): string | null {
	if (!marker || marker === 'indexed') return null;
	return `components.inbox.inboxMessageAttachments.${NOT_INDEXED_KEYS[marker]}`;
}
