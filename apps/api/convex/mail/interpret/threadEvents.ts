/**
 * Thread activity for what people do to a thread (SPEC §5 "Activity
 * writers"), appended in the transaction of the change through
 * `appendActivity`. The host mutations call one line each, so files near the
 * size cap stay small:
 *
 *   - housekeeping (visibility `housekeeping`, kept out of the brief's
 *     Activity block): snooze, label, archive and mute on Postbox threads;
 *     assignment and snooze on Team Inbox threads;
 *   - a file put on a reply draft (`file_added_to_draft`), Postbox and team;
 *   - a clarification the owner answered (`clarification_answered`);
 *   - a booking made on the host's page (`booked`), on the thread of the
 *     guest's open meeting item, when there is one.
 *
 * Every key names the event, the thread and its moment or object, so a repeat
 * in one transaction is a no-op and a later repeat of the action is a new row.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ActivityType } from '@owlat/shared/threadBrief';
import { normalizeEmail } from '@owlat/shared';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { appendActivity } from './activity';

interface ThreadEvent {
	key: string;
	type: ActivityType;
	/** The person behind it; absent for the system (a rule, a sweep). */
	userId?: string;
	/** The correspondent did it (a guest booking a slot). */
	isBySender?: boolean;
	itemId?: Id<'threadItems'>;
	opRef?: { kind: 'outbound' | 'booking' | 'audit' | 'agentAction' | 'note'; id: string };
	payload?: Record<string, unknown>;
	eventAt?: number;
}

/** Append one recorded event (visibility from the type). */
export async function recordThreadEvent(
	ctx: MutationCtx,
	threadRef: ThreadRef,
	event: ThreadEvent
): Promise<void> {
	await appendActivity(ctx, {
		threadRef,
		idempotencyKey: event.key,
		type: event.type,
		actor: event.userId
			? { kind: 'user', id: event.userId }
			: { kind: event.isBySender ? 'sender' : 'system' },
		provenance: 'recorded',
		...(event.itemId ? { itemId: event.itemId } : {}),
		...(event.opRef ? { opRef: event.opRef } : {}),
		...(event.payload ? { payload: event.payload } : {}),
		...(event.eventAt !== undefined ? { eventAt: event.eventAt } : {}),
	});
}

// ── Postbox housekeeping ───────────────────────────────────────────────────

const mailRef = (threadId: Id<'mailThreads'>): ThreadRef => ({ kind: 'mail', id: threadId });

/** The conversation (or some of its messages) was snoozed until `until`. */
export async function recordMailSnoozed(
	ctx: MutationCtx,
	threadIds: Iterable<Id<'mailThreads'>>,
	args: { userId: string; until: number; isUntilReply?: boolean }
): Promise<void> {
	for (const threadId of new Set(threadIds)) {
		await recordThreadEvent(ctx, mailRef(threadId), {
			key: `snooze:${threadId}:${args.until}`,
			type: 'snoozed',
			userId: args.userId,
			payload: { until: args.until, ...(args.isUntilReply ? { isUntilReply: true } : {}) },
		});
	}
}

/** A label was added to or removed from the thread. */
export async function recordMailLabelled(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	args: { userId: string; labelId: Id<'mailLabels'>; isAdded: boolean; at: number }
): Promise<void> {
	await recordThreadEvent(ctx, mailRef(threadId), {
		key: `label:${threadId}:${args.labelId}:${args.isAdded ? 'add' : 'remove'}:${args.at}`,
		type: 'labelled',
		userId: args.userId,
		payload: { labelId: args.labelId, isAdded: args.isAdded },
	});
}

/** Messages of these threads were archived by a person. */
async function recordMailArchived(
	ctx: MutationCtx,
	threadIds: Iterable<Id<'mailThreads'>>,
	args: { userId: string; at: number }
): Promise<void> {
	for (const threadId of new Set(threadIds)) {
		await recordThreadEvent(ctx, mailRef(threadId), {
			key: `archive:${threadId}:${args.at}`,
			type: 'archived',
			userId: args.userId,
		});
	}
}

/** {@link recordMailArchived} for the messages an archive moved (`messageActions.archive`). */
export async function recordArchivedMoves(
	ctx: MutationCtx,
	moved: ReadonlyArray<{ messageId: Id<'mailMessages'> }>,
	userId: string
): Promise<void> {
	const threadIds: Id<'mailThreads'>[] = [];
	for (const { messageId } of moved) {
		const message = await ctx.db.get(messageId);
		if (message) threadIds.push(message.threadId);
	}
	await recordMailArchived(ctx, threadIds, { userId, at: Date.now() });
}

/** The conversation was muted or unmuted. */
export async function recordMailMuted(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	args: { userId: string; isMuted: boolean; at: number }
): Promise<void> {
	await recordThreadEvent(ctx, mailRef(threadId), {
		key: `mute:${threadId}:${args.isMuted ? 'on' : 'off'}:${args.at}`,
		type: 'muted',
		userId: args.userId,
		payload: { isMuted: args.isMuted },
	});
}

// ── Team housekeeping ──────────────────────────────────────────────────────

const teamRef = (threadId: Id<'conversationThreads'>): ThreadRef => ({
	kind: 'team',
	id: threadId,
});

/** The team thread was assigned (or unassigned: no `assignedTo`). */
export async function recordTeamAssigned(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	args: { userId: string; assignedTo?: string; at: number }
): Promise<void> {
	await recordThreadEvent(ctx, teamRef(threadId), {
		key: `assign:${threadId}:${args.assignedTo ?? 'none'}:${args.at}`,
		type: 'assigned',
		userId: args.userId,
		payload: args.assignedTo ? { assignedTo: args.assignedTo } : { isUnassigned: true },
	});
}

/** The team thread was snoozed until `until`. */
export async function recordTeamSnoozed(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	args: { userId: string; until: number }
): Promise<void> {
	await recordThreadEvent(ctx, teamRef(threadId), {
		key: `snooze:${threadId}:${args.until}`,
		type: 'snoozed',
		userId: args.userId,
		payload: { until: args.until },
	});
}

// ── Files on a reply ───────────────────────────────────────────────────────

/** A file was put on a reply draft of the thread. */
export async function recordFileAddedToDraft(
	ctx: MutationCtx,
	threadRef: ThreadRef,
	args: { userId?: string; draftKey: string; fileKey: string; filename: string }
): Promise<void> {
	await recordThreadEvent(ctx, threadRef, {
		key: `file:${args.draftKey}:${args.fileKey}`,
		type: 'file_added_to_draft',
		...(args.userId ? { userId: args.userId } : {}),
		payload: { filename: args.filename },
	});
}

// ── Clarification ──────────────────────────────────────────────────────────

/** The owner answered the clarification questions asked at `askedAt`. */
export async function recordClarificationAnswered(
	ctx: MutationCtx,
	threadRef: ThreadRef,
	args: {
		userId: string;
		/** Names the clarification: the Postbox card's askedAt, or the inbound message. */
		clarificationKey: string;
		questions: ReadonlyArray<{ itemId?: Id<'threadItems'>; answer?: unknown }>;
	}
): Promise<void> {
	const answered = args.questions.filter((q) => q.answer !== undefined);
	const itemIds = [...new Set(answered.flatMap((q) => (q.itemId ? [q.itemId] : [])))];
	await recordThreadEvent(ctx, threadRef, {
		key: `clarification:${args.clarificationKey}`,
		type: 'clarification_answered',
		userId: args.userId,
		// One item: the row belongs to it; several are listed in the payload.
		...(itemIds.length === 1 ? { itemId: itemIds[0] } : {}),
		payload: { answered: answered.length, ...(itemIds.length > 1 ? { itemIds } : {}) },
	});
}

// ── Bookings ───────────────────────────────────────────────────────────────

/** Bound on the guest's items the booking link is looked up in. */
const BOOKING_ITEM_SCAN = 25;

/**
 * The thread a booking belongs to: the newest open meeting item of the host's
 * own Postbox thread with the guest as its counterparty (the host proposed a
 * time, the guest booked it). Null when there is none: then the booking is
 * not linked to a thread and records nothing.
 */
async function bookingThreadOf(
	ctx: MutationCtx,
	booking: Pick<Doc<'bookings'>, 'userId' | 'guestEmail'>
): Promise<Id<'mailThreads'> | null> {
	const items = await ctx.db
		.query('threadItems')
		.withIndex('by_counterparty', (q) =>
			q.eq('counterpartyKey', normalizeEmail(booking.guestEmail))
		)
		.order('desc')
		.take(BOOKING_ITEM_SCAN);
	for (const item of items) {
		if (item.status !== 'open' || !item.facets.includes('meeting')) continue;
		if (!item.mailThreadId || !item.mailboxId) continue;
		const mailbox = await ctx.db.get(item.mailboxId);
		if (mailbox?.userId === booking.userId) return item.mailThreadId;
	}
	return null;
}

/** A guest booked a slot: `booked` on the thread it answers, when linked. */
export async function recordBooked(
	ctx: MutationCtx,
	bookingId: Id<'bookings'>,
	booking: Pick<Doc<'bookings'>, 'userId' | 'guestEmail' | 'startAt' | 'title'>
): Promise<void> {
	const threadId = await bookingThreadOf(ctx, booking);
	if (!threadId) return;
	await recordThreadEvent(ctx, mailRef(threadId), {
		key: `booked:${bookingId}`,
		type: 'booked',
		isBySender: true,
		opRef: { kind: 'booking', id: bookingId },
		payload: { startAt: booking.startAt, title: booking.title },
	});
}
