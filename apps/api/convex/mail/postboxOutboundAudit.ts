import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { recordAuditLog } from '../lib/auditLog';
import type { AggregateState, RecipientState } from './postboxOutboundLifecycle';

export type PostboxOutboundAuditEvent = {
	mailMessageId: Id<'mailMessages'>;
	mailboxId: Id<'mailboxes'>;
	recipientIdx: number;
	from: RecipientState;
	to: RecipientState;
	aggregateBefore: AggregateState;
	aggregateAfter: AggregateState;
	at: number;
	details?: {
		bounceMessage?: string;
		errorMessage?: string;
		errorCode?: string;
	};
};

export async function recordPostboxOutboundAudit(
	ctx: MutationCtx,
	event: PostboxOutboundAuditEvent
): Promise<void> {
	await recordAuditLog(ctx, {
		userId: 'system',
		action: 'postbox_outbound_transition',
		resource: 'mail_message',
		resourceId: event.mailMessageId,
		details: {
			mailboxId: event.mailboxId,
			recipientIdx: event.recipientIdx,
			from: event.from,
			to: event.to,
			aggregateBefore: event.aggregateBefore,
			aggregateAfter: event.aggregateAfter,
			at: event.at,
			...(event.details?.bounceMessage !== undefined
				? { bounceMessage: event.details.bounceMessage }
				: {}),
			...(event.details?.errorMessage !== undefined
				? { errorMessage: event.details.errorMessage }
				: {}),
			...(event.details?.errorCode !== undefined ? { errorCode: event.details.errorCode } : {}),
		},
	});
}
