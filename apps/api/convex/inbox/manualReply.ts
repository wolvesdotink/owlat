/**
 * Manual reply — a person writes the answer the agent will not.
 *
 * A Team inbox reply rides the review path: the text becomes the message's
 * working draft (`mutations.editDraft`) and is approved (`mutations.approveDraft`),
 * which schedules the send with its undo window. That path starts at
 * `draft_ready`, which normally only the agent reaches. `takeOverReply` moves a
 * message there without a draft (the same shape as a draftless escalation) in
 * every case where no agent is going to answer it:
 *
 * - `failed`: the agent tried and failed.
 * - `security_check` with the agent off: the pipeline stops after a clean scan.
 * - `received` with no pipeline run: automated/self-send mail and mail over the
 *   agent cost cap are stored without starting the walker
 *   (inbox/messages.ts), so they would otherwise sit there for good.
 * - `rejected` / `archived`: a teammate threw out a wrong draft, or the agent
 *   filed the message away, and a person wants to answer after all.
 *
 * It never overrides the agent while it is still working — the scan-finished
 * check alone is not enough, the `ai.agent` flag is read here too — and it
 * never answers a message whose security scan is still running.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getOrThrow, throwInvalidState } from '../_utils/errors';
import type { TransitionOutcome } from './processingLifecycle';

/** What {@link takeOverRefusal} needs to know besides the status. */
export interface TakeOverFacts {
	/** The message's security scan has completed. */
	scanFinished: boolean;
	/** The `ai.agent` flag is on, so a scanned message is still the agent's. */
	agentEnabled: boolean;
	/** Any agent action exists for the message: a pipeline run started. */
	pipelineStarted: boolean;
	/**
	 * The message has sat in `received` longer than a coalesced burst waits
	 * before its pipeline starts, so nothing is about to pick it up.
	 */
	receivedLongEnough: boolean;
}

/**
 * Why a message cannot be taken over, or `null` when it can. Pure + exported
 * for tests.
 */
export function takeOverRefusal(
	status: Doc<'inboundMessages'>['processingStatus'],
	facts: TakeOverFacts
): string | null {
	switch (status) {
		case 'failed':
		case 'rejected':
		case 'archived':
			return null;
		case 'security_check':
			if (!facts.scanFinished) return 'The security check has not finished yet';
			return facts.agentEnabled ? 'The agent is still working on this message' : null;
		case 'received':
			return !facts.pipelineStarted && facts.receivedLongEnough
				? null
				: 'This message is still being read';
		default:
			return 'This message cannot take a manual reply in its current state';
	}
}

/**
 * How long a message must have sat in `received` with no pipeline run before a
 * person may take it over: the coalescing window a burst waits out, plus a
 * minute of slack for the scheduler. Never less than {@link MIN_RECEIVED_WAIT_MS}.
 */
export const MIN_RECEIVED_WAIT_MS = 5 * 60 * 1000;

async function receivedWaitMs(ctx: QueryCtx): Promise<number> {
	const config = await ctx.db.query('agentConfig').first();
	return Math.max(MIN_RECEIVED_WAIT_MS, (config?.coalesceWindowMs ?? 0) + 60_000);
}

/** The message's agent actions (bounded: a run records a handful). */
async function agentActionsFor(ctx: QueryCtx, message: Doc<'inboundMessages'>) {
	return ctx.db
		.query('agentActions')
		.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', message._id))
		.take(50);
}

export const takeOverReply = adminMutation({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args, session) => {
		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		// Already waiting on a person: nothing to take over.
		if (message.processingStatus === 'draft_ready') return { success: true as const };

		const status = message.processingStatus;
		const actions =
			status === 'security_check' || status === 'received'
				? await agentActionsFor(ctx, message)
				: [];
		const refusal = takeOverRefusal(status, {
			scanFinished: actions.some(
				(a) => a.actionType === 'security_scan' && a.status === 'completed'
			),
			agentEnabled: status === 'security_check' && (await isFeatureEnabled(ctx, 'ai.agent')),
			pipelineStarted: actions.length > 0,
			receivedLongEnough:
				status === 'received' &&
				Date.now() - message._creationTime >= (await receivedWaitMs(ctx)),
		});
		if (refusal) throwInvalidState(refusal);

		const outcome: TransitionOutcome = await ctx.runMutation(
			internal.inbox.processingLifecycle.transition,
			{
				inboundMessageId: args.inboundMessageId,
				input: { to: 'draft_ready', at: Date.now(), manualTakeover: true },
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
