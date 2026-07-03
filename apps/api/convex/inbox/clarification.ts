/**
 * Inbound clarification-loop mutation.
 *
 * Split out of `inbox/mutations.ts` to keep that file under the ~500 LOC
 * file-size ratchet (CONVENTIONS.md — split into domain siblings). Co-located
 * with the clarification validators (`./clarificationValidators.ts`).
 */

import { v } from 'convex/values';
import { adminMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getMutationContext } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow, throwInvalidState } from '../_utils/errors';

/**
 * Answer the open clarification questions parked on a message and resume the
 * draft.
 *
 * Backs the "Answer to continue" control on the review surface. The message was
 * parked in `awaiting_clarification` because the agent was missing a fact it
 * needed before it could safely draft; this folds the owner's answers back onto
 * `pendingClarification`, drives `awaiting_clarification → drafting` through the
 * single lifecycle writer, and schedules `walker.resumeDraft` to re-enter the
 * DRAFT step with the answers threaded in as a TRUSTED `[CONFIRMED BY OWNER]`
 * block. Mirrors `approveDraft`: authz is the `adminMutation` wrapper, the
 * status change is atomic inside the lifecycle, and the resume runs off the
 * scheduler so a slow draft never blocks the mutation.
 */
export const answerClarification = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		answers: v.array(
			v.object({
				questionId: v.string(),
				value: v.string(),
				// Origin of the value — the owner typed it ("user", default) or it
				// was auto-filled from stored memory ("memory").
				source: v.optional(v.union(v.literal('user'), v.literal('memory'))),
			}),
		),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);

		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		if (message.processingStatus !== 'awaiting_clarification') {
			throwInvalidState('Message is not awaiting clarification');
		}
		const pending = message.pendingClarification;
		if (!pending) throwInvalidState('No clarification is pending');

		const now = Date.now();
		const answerByQuestion = new Map(
			args.answers.map((a) => [a.questionId, a] as const),
		);
		const questions = pending.questions.map((q) => {
			const provided = answerByQuestion.get(q.id);
			if (!provided) return q;
			return {
				...q,
				answer: {
					value: provided.value,
					source: provided.source ?? ('user' as const),
					at: now,
				},
			};
		});

		// Persist the answers (advisory field — direct patch, like editDraft). The
		// processingStatus change goes through the lifecycle below, not here.
		await ctx.db.patch(args.inboundMessageId, {
			pendingClarification: { ...pending, questions, answeredAt: now },
		});

		// Drive awaiting_clarification → drafting via the single lifecycle writer.
		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: { to: 'drafting', at: now },
		});

		// Re-enter the DRAFT step with the confirmed answers folded in. Off the
		// scheduler so a slow draft can't block the mutation; the transition above
		// has already committed the message into `drafting`.
		await ctx.scheduler.runAfter(0, internal.agent.walker.resumeDraft, {
			inboundMessageId: args.inboundMessageId,
		});

		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.clarification_answered',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		return { success: true };
	},
});
