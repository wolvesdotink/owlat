/**
 * Send lifecycle — finalizing the record a 1:1 inbox Send was carrying.
 *
 * Two kinds of Send answer a Team inbox thread, and each closes a different
 * record once the Send is terminal:
 *
 * - `agent_reply` → the inbound message it replies to (`approved → sent` or
 *   `→ failed`; a delivered reply whose message refuses `→ sent` is still
 *   reported to the thread as a reply), the thread's older messages the agent was still drafting or
 *   asking about once it is sent (archived, `inbox/answeredThread.ts`; a later
 *   bounce reopens them), plus the reply mirrored into the thread's unified timeline
 *   and the thread brief's activity and interpretation
 *   (mail/interpret/sendActivity.ts).
 * - `team_reply` → the follow-up it carries (`inbox/followUps.ts`), plus the
 *   thread brief's activity and interpretation, like an agent reply.
 *
 * This belongs to the Send terminal edge, not to one transport callback.
 * Direct/relay completion and authenticated MTA remote acceptance both pass
 * here, while duplicate transitions remain a no-op. That closes the
 * approved-message state before the stale reconciler can enqueue a second
 * reply.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { transition as threadTransition } from '../../inbox/threads/module';
import { mirrorEmailSendWrite } from '../../channels/messages';
import { onTeamSendFinalized } from '../../mail/interpret/sendActivity';
import { restoreAnsweredTeamThread, settleAnsweredTeamThread } from '../../inbox/answeredThread';
import type { EmailSendDoc, SendRef, TransactionalSendDoc, TransitionInput } from './types';

type TerminalInput = Extract<TransitionInput, { to: 'sent' | 'failed' | 'bounced' | 'complained' }>;

function isTerminal(input: TransitionInput): input is TerminalInput {
	return (
		input.to === 'sent' ||
		input.to === 'failed' ||
		input.to === 'bounced' ||
		input.to === 'complained'
	);
}

/** Why a terminal non-`sent` edge failed, in the source record's words. */
function failureMessage(input: Exclude<TerminalInput, { to: 'sent' }>): string {
	if (input.to === 'failed') return input.errorMessage;
	if (input.to === 'bounced') return input.bounceMessage ?? 'Delivery bounced';
	return 'Recipient complained about delivery';
}

/** A reply to `inboundMessageId` reached the customer, whatever its message's state. */
async function reportReplyToThread(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	at: number
): Promise<void> {
	const message = await ctx.db.get(inboundMessageId);
	if (!message?.threadId || message.processingStatus === 'sent') return;
	await threadTransition(ctx, { threadId: message.threadId, input: { kind: 'reply_sent', at } });
}

export async function finalizeSendSource(
	ctx: MutationCtx,
	ref: SendRef,
	send: EmailSendDoc | TransactionalSendDoc,
	input: TransitionInput
): Promise<void> {
	if (ref.kind !== 'transactional' || !isTerminal(input)) return;
	const tSend = send as TransactionalSendDoc;

	if (tSend.kind === 'team_reply' && tSend.followUpId) {
		await ctx.runMutation(internal.inbox.followUps.completeSend, {
			followUpId: tSend.followUpId,
			outcome:
				input.to === 'sent'
					? { kind: 'sent', at: input.at, providerMessageId: input.providerMessageId }
					: { kind: 'failed', at: input.at, errorMessage: failureMessage(input) },
		});
		// The thread brief, as for an agent reply below.
		if (input.to !== 'complained') {
			await onTeamSendFinalized(ctx, tSend, { to: input.to, at: input.at });
		}
		return;
	}

	if (tSend.kind !== 'agent_reply' || !tSend.inboundMessageId) return;
	const source = await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId: tSend.inboundMessageId,
		input:
			input.to === 'sent'
				? { to: 'sent', at: input.at }
				: { to: 'failed', at: input.at, errorMessage: failureMessage(input) },
	});
	// The reply reached the customer even when its message refuses `→ sent`
	// (archived while the Send was in flight, say), and that edge is what
	// reports a reply to the thread. Report it here instead: bounce markers end,
	// `lastReplySentAt` moves, the clock settles. A message already `sent` had
	// its reply reported, so a repeat report never counts twice.
	if (input.to === 'sent' && !source.ok) {
		await reportReplyToThread(ctx, tSend.inboundMessageId, input.at);
	}
	// The thread brief: sent → activity + the reply's interpretation; a failed
	// or bounced Send → activity + the dispositions it answered fail.
	if (input.to !== 'complained') {
		await onTeamSendFinalized(ctx, tSend, { to: input.to, at: input.at });
	}
	if (input.to !== 'sent') {
		// The reply never reached them (a complaint means it did): whatever it
		// settled in the thread reopens (inbox/answeredThread.ts).
		if (input.to !== 'complained') {
			await restoreAnsweredTeamThread(ctx, tSend.inboundMessageId, input.at);
		}
		return;
	}
	// The thread's older messages this reply answered too (inbox/answeredThread.ts).
	await settleAnsweredTeamThread(ctx, tSend.inboundMessageId, input.at);

	try {
		const inbound = await ctx.db.get(tSend.inboundMessageId);
		if (inbound?.threadId && tSend.contactId) {
			await mirrorEmailSendWrite(ctx, {
				threadId: inbound.threadId,
				contactId: tSend.contactId,
				subject: tSend.subject,
				textBody: inbound.draftResponse,
				externalMessageId: input.providerMessageId,
				status: 'sent',
			});
		}
	} catch {
		// The timeline is a denormalized, idempotent read model. It must
		// never roll back the authoritative Send/source lifecycle edge.
	}
}
