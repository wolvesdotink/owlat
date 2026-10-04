/**
 * Retry of a failed Team inbox message (#1220).
 *
 * Retry used to send every failed message back through the agent pipeline. A
 * reply a person had approved whose send then failed came back as a new agent
 * draft: the approved text and its saved revisions were gone, and with
 * auto-reply on the new draft could go out with nobody reading it. Where the
 * message failed now decides what Retry does (`@owlat/shared/inboxRetry`, the
 * same rule the retry cron and the Retry button's copy use):
 *
 * - `resend`: the approved text is sent again as the person's approval, with
 *   the same checks and undo window as Approve.
 * - `review`: a person's reply goes back to `draft_ready` with its text and
 *   revisions, as a takeover, so the agent stays out of it.
 * - `redraft`: nobody touched the reply; the pipeline runs again from the
 *   security scan, as before.
 *
 * The public entry point stays `inbox/mutations.retryFailedMessage`, so a web
 * client from the previous release keeps calling it with the same arguments.
 */

import type { InboxRetryPlan } from '@owlat/shared/inboxRetry';
import { inboxRetryPlan } from '@owlat/shared/inboxRetry';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { throwInvalidState } from '../_utils/errors';
import { assertNoAnswerGaps } from '../mail/ai/composeDraftStore';
import { resolveReplyCollisionHold } from './decisionFeedback';
import type { TransitionInput, TransitionOutcome } from './processingLifecycle';
import { resolveHumanApproveUndoDelayMs } from './processingLifecycle/effects';
import { assertReplyAttachmentsReady } from './replyAttachmentStore';

/**
 * What a person's send of the working draft must pass first (Approve, and a
 * Retry that sends the approved text again): the composer's attachments have
 * finished copying, and no Answer mode gap placeholder is left in the text —
 * the AI's, the agent's or a saved reply's (`isDraftGapGuarded`).
 */
export async function assertDraftSendable(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>
): Promise<void> {
	await assertReplyAttachmentsReady(ctx, message.threadId);
	await assertNoAnswerGaps(
		ctx,
		message.threadId ? { kind: 'teamThread', threadId: message.threadId } : null,
		{ text: message.draftResponse ?? '' },
		{ guarded: message.isDraftGapGuarded === true }
	);
}

/**
 * The human-approve undo window from the singleton agentConfig (default 15s,
 * clamped 0–120s; 0 = the legacy immediate send).
 */
export async function humanApproveUndoDelayMs(ctx: MutationCtx): Promise<number> {
	const configs = await ctx.db.query('agentConfig').take(1);
	return resolveHumanApproveUndoDelayMs(configs[0]?.humanApproveUndoDelayMs);
}

async function transitionOrThrow(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	input: TransitionInput
): Promise<void> {
	const outcome: TransitionOutcome = await ctx.runMutation(
		internal.inbox.processingLifecycle.transition,
		{ inboundMessageId: message._id, input }
	);
	if (!outcome.ok) throwInvalidState('This message cannot be retried right now');
}

/** Send the reply a person approved again, as that approval (`failed → approved`). */
async function resendApproved(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	userId: string
): Promise<void> {
	// A teammate replying in the thread right now may already be answering.
	const hold = await resolveReplyCollisionHold(ctx, message, userId);
	if (hold) throwInvalidState(`${hold.heldByName} is replying to this thread right now`);
	await assertDraftSendable(ctx, message);

	const undoDelayMs = await humanApproveUndoDelayMs(ctx);
	await transitionOrThrow(ctx, message, {
		to: 'approved',
		at: Date.now(),
		source: 'human',
		userId,
		...(undoDelayMs > 0 ? { undoDelayMs } : {}),
	});
}

/**
 * Re-run the agent pipeline (`failed → received`, source `cron_retry`): clears
 * `errorMessage`, re-kicks the walker from `security_scan`, and resets the most
 * recent failed `agentAction` to pending so the retried step has a clean row —
 * what `retryFailedActions` does per message.
 */
async function redraft(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	userId: string
): Promise<void> {
	// A message only reaches terminal `failed` once its step retries are
	// exhausted, at which point the step row is `abandoned` (the terminal twin
	// of `failed`), so match either.
	const failedAction = (
		await ctx.db
			.query('agentActions')
			.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', message._id))
			.take(50)
	) // bounded: one message's pipeline actions (~1 per step)
		.filter((a) => a.status === 'failed' || a.status === 'abandoned')
		.sort((a, b) => b.createdAt - a.createdAt)[0];

	await transitionOrThrow(ctx, message, {
		to: 'received',
		at: Date.now(),
		source: 'cron_retry',
		userId,
		...(failedAction ? { resetActionId: failedAction._id } : {}),
	});
}

/** Retry a failed message by its plan; returns the plan it took. */
export async function retryFailed(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	userId: string
): Promise<InboxRetryPlan> {
	const plan = inboxRetryPlan(message);
	switch (plan) {
		case 'resend':
			await resendApproved(ctx, message, userId);
			break;
		case 'review':
			// Back to the review queue as the person's reply: text, subject and
			// revisions stay, and the takeover keeps any late agent write out.
			await transitionOrThrow(ctx, message, {
				to: 'draft_ready',
				at: Date.now(),
				manualTakeover: true,
			});
			break;
		case 'redraft':
			await redraft(ctx, message, userId);
			break;
	}
	return plan;
}
