/**
 * Read receipts (RFC 8098), both ways.
 *
 * Asking: the composer sets `mailDrafts.isReadReceiptRequested` (a new draft
 * starts with it on when its From address is one of the user's
 * `readReceiptRequestAddresses`); the send path adds
 * `Disposition-Notification-To` with the From address, and the Sent copy starts
 * an empty `readReceipt` record.
 *
 * Returned receipts: the ingest action parses a disposition-notification
 * report (`@owlat/mail-message/parse/mdn`) and the delivery mutation hands it
 * to {@link recordReturnedReceipt}. A receipt that answers a sent message of
 * the same mailbox which asked for one, from one of that message's
 * recipients, is recorded on the Sent copy and never lands in the Inbox.
 * Anything else is delivered as ordinary mail, so a receipt this code does not
 * understand is never lost. A missing receipt says nothing about whether the
 * message was read.
 *
 * Requests that arrive: ingest keeps a sender's request as
 * `mailMessages.receiptRequest` when it passes RFC 8098 §2.1's checks
 * ({@link receiptRequestAddress}, {@link receiptRequestToStore}). The reader
 * answers it through {@link respondToReceiptRequest}; on first read the user's
 * `readReceiptReply` setting may answer it instead
 * ({@link applyReceiptReplyPolicy}). A receipt is only ever sent by
 * `./readReceiptsSend.ts`, scheduled from here. The assistant has no tool for
 * this: confirming that someone read a message is theirs to decide.
 */

import { v, type Infer } from 'convex/values';
import { readDispositionNotificationTo } from '@owlat/mail-message/parse/mdn';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { publicQuery } from '../lib/authedFunctions';
import { postboxMutation } from './_helpers';
import { loadAccessibleMailboxes, requireMailboxAccess } from './permissions';
import { readSession } from './mailbox/shared';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { assertStateIs } from './draftLifecycle/reducers';
import { editPatch } from './draftProvenance';
import { extractEmail } from '../lib/emailAddress';
import { canonicalMessageId } from '../lib/messageId';
import { mailboxOwnAddresses } from './ownAddresses';
import type {
	inboundReadReceiptValidator,
	MailReceiptRequest,
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
	// One entry per recipient, the last to arrive: a client that sends `displayed` and
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

// ─── Requests that arrive ─────────────────────────────────────────────────────

/** The value of the first `name:` header in a raw header block, unfolded. */
function firstHeader(headerBlock: string, name: string): string | undefined {
	const block = headerBlock.split(/\r?\n\r?\n/, 1)[0] ?? '';
	const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
	const prefix = `${name.toLowerCase()}:`;
	for (const line of unfolded.split(/\r?\n/)) {
		if (line.toLowerCase().startsWith(prefix)) return line.slice(prefix.length).trim();
	}
	return undefined;
}

/**
 * The address an arriving message asks a read receipt to be sent to, or
 * `undefined` when there is none to keep. RFC 8098 §2.1: a request whose
 * address differs from the Return-Path may come from someone other than the
 * sender (a tracker, or a forged request aimed at a third party), so it is not
 * kept at all. The SMTP envelope sender is the Return-Path where the caller has
 * it (hosted MX); a synced message carries it as a `Return-Path` header. The
 * null sender of a bounce matches nothing.
 */
export function receiptRequestAddress(
	headerBlock: string,
	envelopeReturnPath: string | undefined
): string | undefined {
	const address = readDispositionNotificationTo(
		firstHeader(headerBlock, 'Disposition-Notification-To')
	);
	if (!address) return undefined;
	const returnPath = (envelopeReturnPath ?? firstHeader(headerBlock, 'Return-Path') ?? '')
		.trim()
		.replace(/^<|>$/g, '')
		.toLowerCase();
	return returnPath === address ? address : undefined;
}

/** Folders whose mail is never answered with a receipt. */
const NO_RECEIPT_FOLDER_ROLES: ReadonlySet<string> = new Set(['spam', 'sent', 'drafts', 'trash']);

/**
 * The `receiptRequest` an arriving message is stored with, if any. Spam is
 * never answered (a receipt would confirm the address is read), and neither is
 * the mailbox's own mail: a copy of something it sent, synced back from the
 * provider's Sent folder or Bcc'd to itself.
 */
export async function receiptRequestToStore(
	ctx: Pick<QueryCtx, 'db'>,
	params: {
		mailbox: Doc<'mailboxes'>;
		folder: Doc<'mailFolders'>;
		from: string;
		spamVerdict?: 'ham' | 'spam' | 'quarantine';
		address: string | undefined;
		receivedAt: number;
	}
): Promise<MailReceiptRequest | undefined> {
	if (!params.address) return undefined;
	if (params.spamVerdict === 'spam' || params.spamVerdict === 'quarantine') return undefined;
	if (params.folder.role && NO_RECEIPT_FOLDER_ROLES.has(params.folder.role)) return undefined;
	const own = await mailboxOwnAddresses(ctx, params.mailbox);
	if (own.has(extractEmail(params.from).toLowerCase())) return undefined;
	return { address: params.address, requestedAt: params.receivedAt };
}

/** Whether the request still waits for an answer. */
function isUnanswered(message: Pick<Doc<'mailMessages'>, 'receiptRequest'>): boolean {
	return !!message.receiptRequest && message.receiptRequest.answeredAt === undefined;
}

/** Record the answer and, for `sent`, queue the receipt itself. */
async function answerRequest(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	answer: 'sent' | 'declined',
	isAutomatic: boolean
): Promise<void> {
	const request = message.receiptRequest;
	if (!request) return;
	await ctx.db.patch(message._id, {
		receiptRequest: { ...request, answeredAt: Date.now(), answer, isAutomatic },
	});
	if (answer === 'sent') {
		await ctx.scheduler.runAfter(0, internal.mail.readReceiptsSend.sendReceipt, {
			messageId: message._id,
		});
	}
}

/**
 * Answer a sender's read-receipt request from the reader. Anyone who may act
 * in the mailbox may answer, in a personal mailbox and a team inbox alike.
 * `send` after a receipt was sent does nothing, so a double click never sends
 * two; `send` after `decline` sends one (the reader offers it on the answered
 * line). `decline` only answers a request nobody answered yet.
 */
export const respondToReceiptRequest = postboxMutation({
	args: {
		messageId: v.id('mailMessages'),
		answer: v.union(v.literal('send'), v.literal('decline')),
	},
	handler: async (ctx, args) => {
		const message = await getOrThrow(ctx, args.messageId, 'Message');
		const access = await requireMailboxAccess(ctx, message.mailboxId);
		if (!access.ok) throwForbidden('Message not accessible');
		const request = message.receiptRequest;
		if (!request || request.answer === 'sent') return;
		if (args.answer === 'send') {
			await answerRequest(ctx, message, 'sent', false);
		} else if (request.answer === undefined) {
			await answerRequest(ctx, message, 'declined', false);
		}
	},
});

/**
 * The user's `readReceiptReply` setting, applied to messages they just opened
 * (the reader's mark-thread-read). `ask` leaves every request to the reader;
 * `never` declines; `contacts` sends one without asking when the sender is in
 * the mailbox's contacts and leaves the rest to the reader. Only unanswered
 * requests are touched, so reading a message again never sends a second one.
 */
export async function applyReceiptReplyPolicy(
	ctx: MutationCtx,
	userId: string,
	opened: ReadonlyArray<Doc<'mailMessages'>>
): Promise<void> {
	const pending = opened.filter(isUnanswered);
	if (pending.length === 0) return;
	const settings = await ctx.db
		.query('mailUserSettings')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
	const policy = settings?.readReceiptReply ?? 'ask';
	if (policy === 'ask') return;
	for (const message of pending) {
		if (policy === 'never') {
			await answerRequest(ctx, message, 'declined', true);
			continue;
		}
		const contact = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) =>
				q.eq('mailboxId', message.mailboxId).eq('email', message.fromAddress.toLowerCase())
			)
			.first();
		if (contact) await answerRequest(ctx, message, 'sent', true);
	}
}

/**
 * Everything `./readReceiptsSend.ts` needs to build and send one receipt, or
 * `null` when the request no longer calls for one. The receipt goes out from
 * the address the message was sent to when that is one of the mailbox's own
 * (an alias, say), else from the mailbox address.
 */
export const loadReceiptToSend = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		if (!message?.receiptRequest || message.receiptRequest.answer !== 'sent') return null;
		const mailbox = await ctx.db.get(message.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return null;
		const own = await mailboxOwnAddresses(ctx, mailbox);
		const addressedTo = [...message.toAddresses, ...message.ccAddresses, ...message.bccAddresses]
			.map((a) => extractEmail(a).toLowerCase())
			.find((a) => own.has(a));
		return {
			mailboxId: mailbox._id,
			from: addressedTo ?? mailbox.address.toLowerCase(),
			to: message.receiptRequest.address,
			originalSubject: message.subject,
			originalMessageId: message.rfc822MessageId,
			isAutomatic: message.receiptRequest.isAutomatic === true,
		};
	},
});

/**
 * A receipt that could not be handed to a transport: reopen the request so the
 * reader asks again, rather than claiming a receipt went out.
 */
export const reopenUnsentReceipt = internalMutation({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		const request = message?.receiptRequest;
		if (!message || !request || request.answer !== 'sent') return;
		await ctx.db.patch(message._id, {
			receiptRequest: { address: request.address, requestedAt: request.requestedAt },
		});
	},
});

/**
 * Whether a new draft from `fromAddress` starts with "Ask for a read receipt"
 * on: the user listed that address in `readReceiptRequestAddresses`.
 */
export async function isReadReceiptRequestedByDefault(
	ctx: Pick<QueryCtx, 'db'>,
	userId: string,
	fromAddress: string
): Promise<boolean> {
	const settings = await ctx.db
		.query('mailUserSettings')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
	return (settings?.readReceiptRequestAddresses ?? []).includes(fromAddress.toLowerCase());
}

/**
 * The From addresses the caller can send as, for the per-address "ask for a
 * read receipt" setting: the addresses and aliases of their own mailboxes and
 * the team inboxes they belong to.
 */
// public: soft-auth — returns empty for anonymous; access via loadAccessibleMailboxes (own + shared memberships)
export const listOwnFromAddresses = publicQuery({
	args: {},
	handler: async (ctx): Promise<string[]> => {
		const session = await readSession(ctx);
		if (!session) return [];
		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		const addresses = new Set<string>();
		for (const mailbox of mailboxes.filter((m) => m.status === 'active')) {
			for (const address of await mailboxOwnAddresses(ctx, mailbox)) addresses.add(address);
		}
		return [...addresses].sort();
	},
});
