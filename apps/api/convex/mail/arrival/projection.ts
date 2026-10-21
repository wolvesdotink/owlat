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
 *   - a cold-pitch verdict committed or cleared (`coldPitch.ts`)
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
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { ComputePlacementResult, MailCategory } from '@owlat/shared/arrival';
import { computePlacement } from '@owlat/shared/arrivalPlacement';
import { loadSenderProfile, senderKeyOf } from '../senders/profiles';
import { isPersonalMailbox } from '../permissions';

type Thread = Doc<'mailThreads'>;

/**
 * Whether the thread's needs-reply verdict is SETTLED: a model (or owner)
 * verdict, or a heuristic flag no classification is still refining. A
 * heuristic candidate waiting for its verdict is not (it reads as `today`
 * until the verdict lands); a model verdict being re-checked still is. Pure.
 */
export function isReplyVerdictSettled(
	thread: Pick<Thread, 'needsReply' | 'needsReplyPendingAt'>
): boolean {
	if (thread.needsReply === undefined) return false;
	return thread.needsReply.source !== 'heuristic' || thread.needsReplyPendingAt === undefined;
}

/** Whether a sender profile carries a choice the owner made: a status they set or accepted, a placement. Pure. */
export function hasOwnerSenderChoice(
	profile: Pick<Doc<'mailSenderProfiles'>, 'statusSource' | 'placementOverride'> | null
): boolean {
	if (!profile) return false;
	return (
		profile.statusSource === 'user' ||
		profile.statusSource === 'suggestion' ||
		profile.placementOverride !== undefined
	);
}

/**
 * Whether a record's cold-pitch verdict (#1381, `coldPitch.ts`) still counts:
 * one was committed, and the owner has not since made a choice about the
 * sender (a choice made before is never asked about at all). Pure.
 */
export function isColdPitchStanding(
	record: Pick<Doc<'mailArrivalRecords'>, 'coldPitchAt'>,
	profile: Pick<Doc<'mailSenderProfiles'>, 'statusSource' | 'placementOverride'> | null
): boolean {
	return record.coldPitchAt !== undefined && !hasOwnerSenderChoice(profile);
}

/**
 * `computePlacement` over the stored inputs: the record (its rule placement and
 * category, else the thread's), the thread (override, settled reply verdict)
 * and the sender profile. Shared by the projection and Explain, so "why here"
 * always answers from the same inputs the projection placed it with. Pure.
 */
export function placementOf(
	record: Pick<
		Doc<'mailArrivalRecords'>,
		'rulePlacement' | 'category' | 'categorySource' | 'coldPitchAt'
	>,
	thread: Pick<Thread, 'category' | 'placementOverride' | 'needsReply' | 'needsReplyPendingAt'>,
	profile: Pick<Doc<'mailSenderProfiles'>, 'status' | 'statusSource' | 'placementOverride'> | null
): ComputePlacementResult {
	const category: MailCategory | undefined = record.category ?? thread.category?.label;
	const categorySource = record.categorySource ?? thread.category?.source;
	return computePlacement(
		{
			...(record.rulePlacement ? { rulePlacement: record.rulePlacement } : {}),
			...(category ? { category } : {}),
			...(categorySource ? { categorySource } : {}),
			...(isColdPitchStanding(record, profile) ? { isColdPitch: true } : {}),
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
}

/** The sender profile of a message's From address in its mailbox, or null (lane senders' key). */
export async function senderProfileOf(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	fromAddress: string
): Promise<Doc<'mailSenderProfiles'> | null> {
	return loadSenderProfile(ctx, mailboxId, senderKeyOf(fromAddress).senderDigest);
}

function sameArrival(a: Thread['arrival'], b: NonNullable<Thread['arrival']>): boolean {
	return (
		a !== undefined &&
		a.placement === b.placement &&
		a.depth === b.depth &&
		a.messageId === b.messageId &&
		a.sourceOrderKey === b.sourceOrderKey &&
		a.isColdPitch === b.isColdPitch
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
	const { placement } = placementOf(record, thread, profile);
	const now = Date.now();
	const next = {
		placement,
		...(record.depth ? { depth: record.depth } : {}),
		messageId: record.messageId,
		...(record.sourceOrderKey ? { sourceOrderKey: record.sourceOrderKey } : {}),
		decidedAt: now,
		...(isColdPitchStanding(record, profile) ? { isColdPitch: true } : {}),
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
