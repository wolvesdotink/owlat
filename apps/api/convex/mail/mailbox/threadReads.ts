/**
 * Thread-scoped reads behind the Postbox reader (plan 3.3): the conversation
 * page `listThreadMessages` serves and the SENT rows `listThreadOutboundDelivery`
 * projects. Both are capped at {@link THREAD_READ_CAP} messages, so one very
 * long thread cannot push a reader query past Convex's per-query read limits.
 *
 * Not a Convex function; the helpers `mailbox/messages.ts` builds on.
 */

import type { QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { openMailMessageRows } from '../../lib/messageBody';
import { toMailListRow, type MailListRow } from './rowThreadState';

/**
 * Most messages one thread read returns. Mail threads run to a few dozen
 * messages; a thread past this is a mailing-list or notification pile-up, and
 * its newest messages are the ones the reader shows first anyway. The rest
 * stay reachable through the page cursor.
 */
export const THREAD_READ_CAP = 250;

export type ThreadPageArgs = {
	/** Messages per page, newest first. Absent: {@link THREAD_READ_CAP}. */
	pageSize?: number;
	/** How many of the page's newest messages carry bodies. Absent: all of them. */
	withBodies?: number;
	/** `olderCursor` from the previous page; absent or null for the newest page. */
	cursor?: string | null;
};

export type ThreadPage = {
	/** The page's newest `withBodies` messages, bodies unsealed, oldest first. */
	messages: Doc<'mailMessages'>[];
	/** The page's older messages as body-less envelopes (list rows), oldest first. */
	envelopes: MailListRow[];
	/** Cursor for the next-older page, or null when this page reaches the start. */
	olderCursor: string | null;
};

function clampCount(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(max, Math.floor(value)));
}

/**
 * One page of a thread, newest first through `by_thread_and_received`. With
 * no paging arguments this is the whole thread (up to the cap) with every body,
 * which is what the reader has always rendered.
 */
export async function loadThreadPage(
	ctx: QueryCtx,
	threadId: Id<'mailThreads'>,
	args: ThreadPageArgs
): Promise<ThreadPage> {
	const pageSize = Math.max(1, clampCount(args.pageSize, THREAD_READ_CAP, THREAD_READ_CAP));
	const withBodies = clampCount(args.withBodies, pageSize, pageSize);
	const page = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', threadId))
		.order('desc')
		.paginate({ cursor: args.cursor ?? null, numItems: pageSize });
	// Newest first from the index; the reader wants the conversation oldest first.
	const newest = page.page.slice(0, withBodies).reverse();
	const older = page.page.slice(withBodies).reverse();
	return {
		messages: await openMailMessageRows(newest),
		envelopes: older.map(toMailListRow),
		olderCursor: page.isDone ? null : page.continueCursor,
	};
}

type OutboundState = NonNullable<Doc<'mailMessages'>['outbound']>['state'];

/** Every aggregate outbound state; the `Record` makes a new state a type error here. */
const OUTBOUND_STATES = Object.keys({
	queued: true,
	sent: true,
	bounced: true,
	failed: true,
	partial: true,
} satisfies Record<OutboundState, true>) as OutboundState[];

/**
 * Delivery state of the thread's SENT messages (the only rows with `outbound`),
 * oldest first, newest {@link THREAD_READ_CAP} at most. Reads through
 * `by_thread_and_outbound_state`, one range per state, so inbound messages are
 * never loaded.
 */
export async function loadThreadOutboundDelivery(ctx: QueryCtx, threadId: Id<'mailThreads'>) {
	const perState = await Promise.all(
		OUTBOUND_STATES.map((state) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_thread_and_outbound_state', (q) =>
					q.eq('threadId', threadId).eq('outbound.state', state)
				)
				.take(THREAD_READ_CAP)
		)
	);
	const rows = perState.flat();
	rows.sort((a, b) => a.receivedAt - b.receivedAt || a._creationTime - b._creationTime);
	return rows
		.slice(-THREAD_READ_CAP)
		.flatMap((message) =>
			message.outbound ? [{ messageId: message._id, ...projectOutbound(message.outbound) }] : []
		);
}

/**
 * Narrow a stored `outbound` object to what the reader may see: every
 * per-recipient field EXCEPT `mtaJobId`, which is dispatch bookkeeping. Written
 * as explicit spreads rather than a destructure so an `undefined` never travels
 * as a present key — the reader must be able to tell "no bounce text" from
 * "empty bounce text".
 */
function projectOutbound(outbound: NonNullable<Doc<'mailMessages'>['outbound']>) {
	return {
		state: outbound.state,
		recipients: outbound.recipients.map((r) => ({
			idx: r.idx,
			address: r.address,
			state: r.state,
			...(r.sentAt !== undefined ? { sentAt: r.sentAt } : {}),
			...(r.acceptedAt !== undefined ? { acceptedAt: r.acceptedAt } : {}),
			...(r.bouncedAt !== undefined ? { bouncedAt: r.bouncedAt } : {}),
			...(r.failedAt !== undefined ? { failedAt: r.failedAt } : {}),
			...(r.bounceMessage !== undefined ? { bounceMessage: r.bounceMessage } : {}),
			...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
		})),
	};
}
