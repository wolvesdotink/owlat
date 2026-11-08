/**
 * After a reply on a conversation has gone out, the viewer's open tasks taken
 * from that conversation may be finished too. Never automatically: a reply is
 * not proof that the task is done. These are the pure halves of that offer:
 * which toast to show, and whether the reply has actually gone, read from the
 * server's record of the send.
 */

interface OfferableTask<Id extends string = string> {
	_id: Id;
	title: string;
	status: string;
}

export type ReplyTaskOffer<T extends OfferableTask> =
	/** "Sent. Mark “<title>” done?" with Mark done. */
	| { kind: 'one'; task: T }
	/** "Sent. 3 tasks from this conversation are still open." with Review, opening the first. */
	| { kind: 'several'; count: number; first: T };

/**
 * The offer for the conversation's tasks, or null when none is open. `tasks`
 * is `tasks.forThread`: the tasks the viewer can see, open ones first, so the
 * first open one is the one the Tasks page should open on.
 */
export function replyTaskOffer<T extends OfferableTask>(
	tasks: readonly T[] | null | undefined
): ReplyTaskOffer<T> | null {
	const open = (tasks ?? []).filter((task) => task.status === 'open');
	const first = open[0];
	if (!first) return null;
	return open.length === 1
		? { kind: 'one', task: first }
		: { kind: 'several', count: open.length, first };
}

/**
 * Whether a mail reply the composer reports sent is worth watching. A send
 * scheduled for later, or one queued on the device while offline, will not
 * leave while anyone is looking, so neither is held.
 */
export function mailReplyWillLeave(outcome: {
	scheduled: boolean;
	/** The receipt belongs to the on-device outbox (`isQueuedSendToken`). */
	queuedOffline: boolean;
}): boolean {
	return !outcome.scheduled && !outcome.queuedOffline;
}

/**
 * Where a held reply stands, read from the server's own record of it. Only
 * `sent` releases the offer; `failed` covers everything that is not a send
 * that reached the recipient: an Undo, a dispatch the server refused, a
 * bounce, a reply we can no longer find.
 */
export type ReplySendStatus = 'waiting' | 'sent' | 'failed';

/** A row of `mail.mailbox.messages.listThreadOutboundDelivery`. */
interface OutboundRow {
	messageId: string;
	state: string;
	recipients: ReadonlyArray<{ state: string }>;
}

/**
 * The outbound rows of the thread while the reply's draft was still held:
 * the sent message the reply becomes is the one row not among them.
 */
export function outboundBaseline(rows: readonly OutboundRow[] | null | undefined): string[] | null {
	return rows ? rows.map((row) => row.messageId) : null;
}

/**
 * A Postbox reply. `mail.drafts.get` holds the draft in `pending_send` through
 * its undo window; the send deletes the row in the same commit that files the
 * sent message, and an Undo or a refused dispatch puts it back to `draft`.
 * The sent message's `outbound` record then says whether the transport took
 * it for every recipient.
 *
 * `baseline` is the thread's outbound rows seen in the same snapshot as the
 * held draft (`outboundBaseline`). Without one the draft was already gone at
 * the first read, so the reply's message cannot be told from the others, and
 * nothing is offered.
 */
export function mailReplyStatus(o: {
	/** `undefined` while loading, `null` once the row is gone. */
	draft: { state: string } | null | undefined;
	baseline: readonly string[] | null;
	/** `null`: the mailbox is not readable any more. */
	delivery: readonly OutboundRow[] | null | undefined;
}): ReplySendStatus {
	if (o.draft === undefined) return 'waiting';
	if (o.draft) return o.draft.state === 'pending_send' ? 'waiting' : 'failed';
	if (!o.baseline || o.delivery === null) return 'failed';
	if (o.delivery === undefined) return 'waiting';
	const known = new Set(o.baseline);
	const ours = o.delivery.find((row) => !known.has(row.messageId));
	if (!ours) return 'waiting';
	if (ours.state === 'sent') return 'sent';
	return ours.recipients.some((r) => r.state === 'queued') ? 'waiting' : 'failed';
}

/**
 * A team draft approved (with or without an undo window): its inbound message
 * stays `approved` until the Send reaches a terminal edge, then becomes `sent`;
 * an Undo or a failed Send leaves `approved` for another state.
 */
export function teamReplyStatus(
	messages: ReadonlyArray<{ _id: string; processingStatus: string }> | undefined,
	inboundMessageId: string
): ReplySendStatus {
	if (!messages) return 'waiting';
	const status = messages.find((m) => m._id === inboundMessageId)?.processingStatus;
	if (status === 'sent') return 'sent';
	return status === 'approved' ? 'waiting' : 'failed';
}

/**
 * A team follow-up: `scheduled` through its undo window, `sending` while its
 * Send is out, then `sent` or `failed` (a refusal at dispatch writes no Send).
 * An undone follow-up is left out of the list.
 */
export function followUpStatus(
	followUps: ReadonlyArray<{ _id: string; status: string }> | undefined,
	followUpId: string
): ReplySendStatus {
	if (!followUps) return 'waiting';
	const status = followUps.find((f) => f._id === followUpId)?.status;
	if (status === 'sent') return 'sent';
	return status === 'scheduled' || status === 'sending' ? 'waiting' : 'failed';
}
