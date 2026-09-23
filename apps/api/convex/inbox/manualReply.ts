/**
 * Manual reply — a person writes the answer the agent will not.
 *
 * A Team inbox reply rides the review path: the text becomes the message's
 * working draft (`mutations.editDraft`) and is approved (`mutations.approveDraft`),
 * which schedules the send with its undo window. That path starts at
 * `draft_ready`, which only the agent could reach — so with the agent off
 * (the pipeline stops after a clean security scan) or after it failed, a
 * teammate had nowhere to type.
 *
 * `takeOverReply` moves such a message to `draft_ready` without a draft (the
 * same shape as a draftless escalation), after which the normal edit → approve
 * path applies. It never overrides the agent while it is still working, and it
 * never answers a message whose security scan has not finished.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow, throwInvalidState } from '../_utils/errors';
import type { TransitionOutcome } from './processingLifecycle';

/**
 * Why a message cannot be taken over, or `null` when it can. Pure + exported
 * for tests. `scanFinished` is only consulted for `security_check`, the state
 * the pipeline rests in when the agent is off.
 */
export function takeOverRefusal(
	status: Doc<'inboundMessages'>['processingStatus'],
	scanFinished: boolean
): string | null {
	if (status === 'failed') return null;
	if (status === 'security_check') {
		return scanFinished ? null : 'The security check has not finished yet';
	}
	return 'This message cannot take a manual reply in its current state';
}

/** Has the message's security scan completed (the agent-off resting point)? */
async function securityScanFinished(ctx: QueryCtx, message: Doc<'inboundMessages'>) {
	const actions = await ctx.db
		.query('agentActions')
		.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', message._id))
		.take(50);
	return actions.some((a) => a.actionType === 'security_scan' && a.status === 'completed');
}

export const takeOverReply = adminMutation({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args, session) => {
		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		// Already waiting on a person: nothing to take over.
		if (message.processingStatus === 'draft_ready') return { success: true as const };

		const scanFinished =
			message.processingStatus === 'security_check'
				? await securityScanFinished(ctx, message)
				: false;
		const refusal = takeOverRefusal(message.processingStatus, scanFinished);
		if (refusal) throwInvalidState(refusal);

		const outcome: TransitionOutcome = await ctx.runMutation(
			internal.inbox.processingLifecycle.transition,
			{
				inboundMessageId: args.inboundMessageId,
				input: { to: 'draft_ready', at: Date.now() },
			}
		);
		if (!outcome.ok) throwInvalidState('This message cannot take a manual reply right now');

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'inbound.reply_taken_over',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
			details: { from: message.processingStatus },
		});

		return { success: true as const };
	},
});
