/**
 * Send lifecycle — finalizing the record a 1:1 inbox Send was carrying.
 *
 * Two kinds of Send answer a Team inbox thread, and each closes a different
 * record once the Send is terminal:
 *
 * - `agent_reply` → the inbound message it replies to (`approved → sent` or
 *   `→ failed`), plus the reply mirrored into the thread's unified timeline.
 * - `team_reply` → the follow-up it carries (`inbox/followUps.ts`).
 *
 * This belongs to the Send terminal edge, not to one transport callback.
 * Direct/relay completion and authenticated MTA remote acceptance both pass
 * here, while duplicate transitions remain a no-op. That closes the
 * approved-message state before the stale reconciler can enqueue a second
 * reply.
 */

import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { mirrorEmailSendWrite } from '../../unifiedMessages';
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
		return;
	}

	if (tSend.kind !== 'agent_reply' || !tSend.inboundMessageId) return;
	await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
		inboundMessageId: tSend.inboundMessageId,
		input:
			input.to === 'sent'
				? { to: 'sent', at: input.at }
				: { to: 'failed', at: input.at, errorMessage: failureMessage(input) },
	});
	if (input.to !== 'sent') return;

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
