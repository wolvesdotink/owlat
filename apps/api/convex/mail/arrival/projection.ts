/**
 * Read on arrival (SPEC §2.8): the thread's arrival projection.
 *
 * `mailThreads.arrival = { placement, depth, messageId, sourceOrderKey,
 * decidedAt }` and `digestPendingSince` are DERIVED, never stored from an
 * action: {@link refreshArrivalProjection} recomputes them from current state
 * (the newest inbound message's arrival record, the thread, the sender's
 * profile) inside the same mutation as every change to one of those inputs:
 *
 *   - arrival record patches (`records.ts`: delivery, the run, category)
 *   - the needs-reply verdict set or cleared (`mail/needsReply.ts applyResult`,
 *     `clearThreadNeedsReply`, the pending settle)
 *   - Fix, Undo, sender-status changes, overrides (lanes learn and senders)
 *
 * So there is no generation counter: a stale action result is just an input
 * patch followed by a recompute. Placement itself is `computePlacement`
 * (`@owlat/shared/arrivalPlacement`). A shared mailbox has no projection.
 *
 * Bounded: four point reads (thread, mailbox, newest record, its message) and
 * one indexed sender-profile read.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { MailCategory } from '@owlat/shared/arrival';
import { computePlacement } from '@owlat/shared/arrivalPlacement';
import { senderDigest } from '../../decision/senderMemory';
import { isPersonalMailbox } from '../permissions';

type Thread = Doc<'mailThreads'>;

/**
 * Whether the thread's needs-reply verdict is SETTLED: a flag is set and no
 * classification is pending. A heuristic candidate still waiting for its
 * verdict is not (it reads as `today` until the verdict lands). Pure.
 */
export function isReplyVerdictSettled(
	thread: Pick<Thread, 'needsReply' | 'needsReplyPendingAt'>
): boolean {
	return thread.needsReply !== undefined && thread.needsReplyPendingAt === undefined;
}

/** The sender profile of a message's From address in its mailbox, or null. */
export async function senderProfileOf(
	ctx: Pick<MutationCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	fromAddress: string
): Promise<Doc<'mailSenderProfiles'> | null> {
	return ctx.db
		.query('mailSenderProfiles')
		.withIndex('by_mailbox_sender', (q) =>
			q.eq('mailboxId', mailboxId).eq('senderDigest', senderDigest(fromAddress))
		)
		.first();
}

function sameArrival(a: Thread['arrival'], b: NonNullable<Thread['arrival']>): boolean {
	return (
		a !== undefined &&
		a.placement === b.placement &&
		a.depth === b.depth &&
		a.messageId === b.messageId &&
		a.sourceOrderKey === b.sourceOrderKey
	);
}

/** Clear the projection (no record left, or no longer a personal mailbox). */
async function clearProjection(ctx: MutationCtx, thread: Thread): Promise<void> {
	if (thread.arrival === undefined && thread.digestPendingSince === undefined) return;
	await ctx.db.patch(thread._id, { arrival: undefined, digestPendingSince: undefined });
}

/** Recompute the thread's arrival projection (see the module doc). */
export async function refreshArrivalProjection(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const mailbox = await ctx.db.get(thread.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return clearProjection(ctx, thread);
	const record = await ctx.db
		.query('mailArrivalRecords')
		.withIndex('by_thread_source_order', (q) => q.eq('threadId', threadId))
		.order('desc')
		.first();
	const message = record ? await ctx.db.get(record.messageId) : null;
	if (!record || !message) return clearProjection(ctx, thread);
	const profile = await senderProfileOf(ctx, thread.mailboxId, message.fromAddress);
	const category: MailCategory | undefined = record.category ?? thread.category?.label;
	const categorySource = record.categorySource ?? thread.category?.source;
	const { placement } = computePlacement(
		{
			...(record.rulePlacement ? { rulePlacement: record.rulePlacement } : {}),
			...(category ? { category } : {}),
			...(categorySource ? { categorySource } : {}),
		},
		{
			...(thread.placementOverride
				? { placementOverride: { placement: thread.placementOverride.placement } }
				: {}),
			isReplyNeeded: isReplyVerdictSettled(thread),
		},
		profile
			? {
					status: profile.status,
					...(profile.placementOverride ? { placementOverride: profile.placementOverride } : {}),
				}
			: null
	);
	const now = Date.now();
	const next = {
		placement,
		...(record.depth ? { depth: record.depth } : {}),
		messageId: record.messageId,
		...(record.sourceOrderKey ? { sourceOrderKey: record.sourceOrderKey } : {}),
		decidedAt: now,
	};
	// §6.5: pending for the digest while the placement is digest and the newest
	// inbound message lies past what the last sent digest consumed.
	const isPastConsumed =
		thread.digestConsumedThrough === undefined ||
		(record.sourceOrderKey ?? '') > thread.digestConsumedThrough;
	const digestPendingSince =
		placement === 'digest' && isPastConsumed ? (thread.digestPendingSince ?? now) : undefined;
	const isArrivalSame = sameArrival(thread.arrival, next);
	if (isArrivalSame && digestPendingSince === thread.digestPendingSince) return;
	await ctx.db.patch(threadId, {
		...(isArrivalSame ? {} : { arrival: next }),
		...(digestPendingSince === thread.digestPendingSince ? {} : { digestPendingSince }),
	});
}
