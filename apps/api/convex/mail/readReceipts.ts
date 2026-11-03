/**
 * Read receipts (RFC 8098) on Postbox mail the user sends.
 *
 * Asking: the composer sets `mailDrafts.isReadReceiptRequested`; the send path
 * adds `Disposition-Notification-To` with the From address, and the Sent copy
 * starts an empty `readReceipt` record.
 *
 * Returned receipts: the ingest action parses a disposition-notification
 * report (`@owlat/mail-message/parse/mdn`) and the delivery mutation hands it
 * to {@link recordReturnedReceipt}. A receipt that answers a sent message of
 * the same mailbox which asked for one, from one of that message's
 * recipients, is recorded on the Sent copy and never lands in the Inbox.
 * Anything else is delivered as ordinary mail, so a receipt this code does not
 * understand is never lost.
 *
 * Nothing here sends a receipt. A recipient's client decides that, and a
 * missing receipt says nothing about whether the message was read.
 */

import { v, type Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { postboxMutation } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { assertStateIs } from './draftLifecycle/reducers';
import { editPatch } from './draftProvenance';
import { extractEmail } from '../lib/emailAddress';
import { canonicalMessageId } from '../lib/messageId';
import type {
	inboundReadReceiptValidator,
	MailReturnedReceipt,
} from '../lib/validators/mailContent';

export type InboundReadReceipt = Infer<typeof inboundReadReceiptValidator>;

type ReadReceiptRecord = NonNullable<Doc<'mailMessages'>['readReceipt']>;

/** The Sent copy's starting record, for a draft that asked for a receipt. */
export function requestedReadReceipt(
	draft: Pick<Doc<'mailDrafts'>, 'isReadReceiptRequested'>,
	now: number
): { readReceipt?: ReadReceiptRecord } {
	return draft.isReadReceiptRequested ? { readReceipt: { requestedAt: now, returned: [] } } : {};
}

/**
 * The sent message's receipt record with `receipt` folded in, or `null` when
 * the receipt is not one to record: the message asked for none, the
 * disposition says nothing about reading, or the receipt does not name one of
 * the message's recipients (checked against `Final-Recipient` first, then the
 * receipt's From address).
 */
export function foldReturnedReceipt(
	message: Pick<
		Doc<'mailMessages'>,
		'readReceipt' | 'toAddresses' | 'ccAddresses' | 'bccAddresses'
	>,
	receipt: InboundReadReceipt,
	reporterAddress: string,
	at: number
): ReadReceiptRecord | null {
	const record = message.readReceipt;
	if (!record) return null;
	if (receipt.disposition !== 'displayed' && receipt.disposition !== 'deleted') return null;
	const recipients = new Set(
		[...message.toAddresses, ...message.ccAddresses, ...message.bccAddresses].map((a) =>
			extractEmail(a).toLowerCase()
		)
	);
	const address = [receipt.finalRecipient, reporterAddress.toLowerCase()].find(
		(candidate): candidate is string => candidate !== undefined && recipients.has(candidate)
	);
	if (!address) return null;
	const entry: MailReturnedReceipt = {
		address,
		disposition: receipt.disposition,
		isAutomatic: receipt.isAutomatic,
		at,
	};
	// One entry per recipient, the newest: a client that sends `displayed` and
	// later `deleted` for the same message leaves the later answer.
	return {
		...record,
		returned: [...record.returned.filter((r) => r.address !== address), entry],
	};
}

/**
 * Record an arriving receipt on the sent message it answers in `mailboxId`.
 * Returns whether it was recorded; the caller then drops the receipt instead
 * of delivering it.
 */
export async function recordReturnedReceipt(
	ctx: MutationCtx,
	args: {
		mailboxId: Id<'mailboxes'>;
		receipt: InboundReadReceipt;
		from: string;
		receivedAt: number;
	}
): Promise<boolean> {
	const sent = await ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_rfc822_message_id', (q) =>
			q
				.eq('mailboxId', args.mailboxId)
				.eq('rfc822MessageId', canonicalMessageId(args.receipt.originalMessageId))
		)
		.first();
	if (!sent?.outbound) return false;
	// The receipt's own Date header is the recipient's claim; never in the future.
	const at = Math.min(args.receivedAt, Date.now());
	const readReceipt = foldReturnedReceipt(sent, args.receipt, extractEmail(args.from), at);
	if (!readReceipt) return false;
	await ctx.db.patch(sent._id, { readReceipt });
	return true;
}

/** Turn "Ask for a read receipt" on or off for a draft. */
export const setRequested = postboxMutation({
	args: { draftId: v.id('mailDrafts'), isRequested: v.boolean() },
	handler: async (ctx, args) => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const isChanged = args.isRequested !== (draft.isReadReceiptRequested ?? false);
		await ctx.db.patch(args.draftId, {
			isReadReceiptRequested: args.isRequested ? true : undefined,
			...editPatch(isChanged),
		});
	},
});
