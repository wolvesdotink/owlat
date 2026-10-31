/**
 * Storage + context helpers for personal-mail draft-on-arrival (postbox.aiDraft).
 *
 * The Node action that actually calls the shared draft service lives in the
 * sibling `mail/ai/draftOnArrival.ts` ('use node'); the v8-isolate query/mutation
 * halves live here so a single 'use node' file doesn't try to host a query.
 *
 * FAIL-SOFT posture: the loader returns `null` (skip drafting) for anything that
 * isn't a live, needs-a-reply personal-mail thread whose trigger someone ELSE
 * sent and the owner has not answered yet; the persister no-ops on a
 * stale trigger so a draft can never overwrite a newer message's slot.
 *
 * No draft is written while the owner still has to supply a fact: a thread
 * with a clarification is drafted after the answers (needsReplyClarify), and a
 * draft that comes back with placeholders of its own is not stored; its gaps
 * become the thread's questions instead (`holdForGapQuestions`).
 */

import { v } from 'convex/values';
import { internalQuery, type MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { draftQualityValidator } from '../../lib/convexValidators';
import { NEEDS_REPLY_CONTEXT_MESSAGES } from '../needsReply';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { buildThreadTranscript, DRAFT_ON_ARRIVAL } from './transcript';
import { withStoredInlineBodies } from '../../lib/messageBodyStore';
import { needsReplyClarificationQuestionValidator } from '../../lib/validators/clarification';
import type { Doc, Id } from '../../_generated/dataModel';
import { checkDraftGaps } from './gapQuestions';
import type { AskQuestion } from './composeDraftPolicy';
import { isFencedThread } from '../interpret/staleFence';
import { isDraftOnArrivalPaused } from '../draftPause';
import { planCheckFields, recordPlanCheck } from '../interpret/responsePlanDraft';

/**
 * Load everything the draft-on-arrival action needs for one thread, or `null`
 * when the thread should NOT be drafted (no needs-reply flag, inactive mailbox,
 * missing trigger message, a trigger the owner wrote, or an owner reply after
 * it). Builds the untrusted transcript server-side so the
 * Node action never handles raw message docs.
 */
export const loadForDraft = internalQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const flag = thread.needsReply;
		if (!flag) return null; // nothing flagged for reply → nothing to draft
		// The owner is asked first; the reply is written from the answers.
		if (flag.clarification) return null;

		const mailbox = await ctx.db.get(thread.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return null;

		const trigger = await ctx.db.get(flag.messageId);
		if (!trigger) return null;

		// Bounded read: the `by_thread` index is ordered by _creationTime, so
		// `order('desc').take(N)` pulls only the newest N docs off the index
		// instead of scanning the whole thread (no unbounded collect).
		const newestDesc = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.take(NEEDS_REPLY_CONTEXT_MESSAGES);

		// Only ever answer mail someone else sent us. A trigger we wrote, or a
		// reply of ours that already followed it, means there is nothing to
		// answer — drafting anyway produces a reply to our own message.
		const ownerAddress = mailbox.address;
		if (isFromMailboxOwner(trigger, ownerAddress)) return null;
		// Their last drafts went unused: paused until Resume (mail/draftPause.ts).
		if (await isDraftOnArrivalPaused(ctx, thread.mailboxId, trigger.fromAddress)) return null;
		if (
			newestDesc.some(
				(m) => isFromMailboxOwner(m, ownerAddress) && m.receivedAt >= trigger.receivedAt
			)
		) {
			return null;
		}

		// Chronological history up to the trigger, then the trigger itself LAST
		// and marked, with every message labelled by side (mail/ai/transcript.ts
		// explains why the labels matter). Oldest history is trimmed first.
		const history = newestDesc
			.filter((m) => m._id !== trigger._id && m.receivedAt <= trigger.receivedAt)
			.sort((a, b) => a.receivedAt - b.receivedAt);
		const transcript = await buildThreadTranscript(
			await withStoredInlineBodies(ctx.db, [...history, trigger]),
			{
				...DRAFT_ON_ARRIVAL,
				ownerAddress,
				triggerId: trigger._id,
			}
		);

		return {
			context: transcript,
			triggerMessageId: flag.messageId,
			triggerSubject: trigger.subject,
			// Who the questions a held draft asks are attributed to.
			senderAddress: trigger.fromAddress,
			mailboxId: thread.mailboxId,
			// Whose background AI bucket the draft is charged to (#1380).
			ownerUserId: mailbox.userId,
			ownerAddress,
			// Stale guard the persister re-checks: a newer inbound moves this.
			latestMessageId: thread.latestMessageId,
			urgency: flag.urgency,
			// person vs newsletter — the personal-mail taxonomy. Aligned to the
			// shared draft block's vocabulary in the action.
			isBulk: trigger.unsubscribe !== undefined,
		};
	},
});

/**
 * Persist a generated review slot onto the thread's needs-reply flag. Guarded:
 * skips silently if the flag is gone or now points at a different (newer)
 * trigger message — the draft was for a message that is no longer current, so
 * writing it would surface a stale reply. Never clears the rest of the flag.
 * A draft with gaps is never stored, whoever wrote it (a run started before
 * the action checked them too): its gaps become the thread's questions, and a
 * gap no question may ask for leaves no slot at all.
 */
export const persistDraftSlot = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		triggerMessageId: v.id('mailMessages'),
		draft: v.string(),
		draftSubject: v.optional(v.string()),
		confidence: v.number(),
		quality: v.optional(draftQualityValidator),
		// Deprecated (#1200), accepted and ignored: an action started before the
		// deploy that stopped generating variants may still pass them. Remove
		// in the release after.
		options: v.optional(v.array(v.string())),
		/** The thread's checked plan, stored bound to this slot's text. */
		plan: v.optional(v.object(planCheckFields)),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread || !thread.needsReply) return;
		// A draft written from a fenced thread's plan is never kept (interpret/staleFence.ts).
		if (isFencedThread(thread)) return;
		// Stale guard: only attach to the trigger we drafted for.
		if (thread.needsReply.messageId !== args.triggerMessageId) return;
		// Questions arrived meanwhile: the reply waits for their answers.
		if (thread.needsReply.clarification) return;
		const trigger = await ctx.db.get(args.triggerMessageId);
		// Paused while this run was drafting (mail/draftPause.ts): no slot.
		if (trigger && (await isDraftOnArrivalPaused(ctx, thread.mailboxId, trigger.fromAddress))) {
			return;
		}
		const gaps = checkDraftGaps(args.draft, {
			fromAddress: trigger?.fromAddress ?? '',
			existing: [],
		});
		if (gaps.kind === 'unaskable') return;
		if (gaps.kind === 'ask') {
			await askInstead(ctx, args.threadId, thread.needsReply, gaps.questions);
			return;
		}

		await ctx.db.patch(args.threadId, {
			needsReply: {
				...thread.needsReply,
				draftSlot: {
					draft: args.draft,
					...(args.draftSubject ? { draftSubject: args.draftSubject } : {}),
					confidence: args.confidence,
					...(args.quality ? { quality: args.quality } : {}),
					generatedAt: Date.now(),
				},
			},
			updatedAt: Date.now(),
		});
		// In the same commit as the slot: a slot the guards above refused gets no plan.
		if (args.plan) {
			await recordPlanCheck(ctx, {
				threadRef: { kind: 'mail', id: args.threadId },
				draftRef: { kind: 'arrivalDraft', id: args.threadId },
				...args.plan,
			});
		}
	},
});

/**
 * Hold a draft that came back with gaps: instead of the slot, the thread gets
 * one question per gap, and its reply is written once they are answered (or
 * the owner drafts with what they have). The same guards as the slot: only for
 * the trigger it was drafted for, and never over questions already there.
 */
export const holdForGapQuestions = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		triggerMessageId: v.id('mailMessages'),
		questions: v.array(needsReplyClarificationQuestionValidator),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		const flag = thread?.needsReply;
		if (!thread || !flag || flag.messageId !== args.triggerMessageId) return;
		if (flag.clarification || args.questions.length === 0) return;
		await askInstead(ctx, args.threadId, flag, args.questions);
	},
});

/** The thread asks `questions` in place of an arrival slot. */
async function askInstead(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	flag: NonNullable<Doc<'mailThreads'>['needsReply']>,
	questions: AskQuestion[]
): Promise<void> {
	const now = Date.now();
	const { draftSlot: _stale, ...rest } = flag;
	await ctx.db.patch(threadId, {
		needsReply: { ...rest, clarification: { isNeeded: true, questions, askedAt: now } },
		updatedAt: now,
	});
}
