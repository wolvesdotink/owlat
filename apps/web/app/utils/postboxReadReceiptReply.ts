/**
 * What happens when someone asks for a read receipt on mail the user opens:
 * ask each time (the default), never send one, or send one to contacts without
 * asking. The backend applies it when the reader marks a conversation read
 * (mail/readReceipts.ts).
 */

export type PostboxReadReceiptReply = 'ask' | 'never' | 'contacts';

/** Ask: nothing is sent unless the person chooses to. */
export const POSTBOX_READ_RECEIPT_REPLY_DEFAULT: PostboxReadReceiptReply = 'ask';

/** The picker options; `label` is the catalog key the settings screen renders. */
export const POSTBOX_READ_RECEIPT_REPLY_OPTIONS: ReadonlyArray<{
	value: PostboxReadReceiptReply;
	label: string;
}> = [
	{ value: 'ask', label: 'shared.postboxReadReceiptReply.ask' },
	{ value: 'contacts', label: 'shared.postboxReadReceiptReply.contacts' },
	{ value: 'never', label: 'shared.postboxReadReceiptReply.never' },
];

/** A stored value read defensively: anything unknown is the default. */
export function resolvePostboxReadReceiptReply(value: unknown): PostboxReadReceiptReply {
	return value === 'never' || value === 'contacts' || value === 'ask'
		? value
		: POSTBOX_READ_RECEIPT_REPLY_DEFAULT;
}
