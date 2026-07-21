import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { recordAuditLog } from '../lib/auditLog';
import type { AggregateState, RecipientState } from './postboxOutboundLifecycle';

export type PostboxOutboundEffect = {
	kind: 'audit_log';
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

export async function applyPostboxOutboundEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<PostboxOutboundEffect>
): Promise<void> {
	for (const effect of effects) {
		await recordAuditLog(ctx, {
			userId: 'system',
			action: 'postbox_outbound_transition',
			resource: 'mail_message',
			resourceId: effect.mailMessageId,
			details: {
				mailboxId: effect.mailboxId,
				recipientIdx: effect.recipientIdx,
				from: effect.from,
				to: effect.to,
				aggregateBefore: effect.aggregateBefore,
				aggregateAfter: effect.aggregateAfter,
				at: effect.at,
				...(effect.details?.bounceMessage !== undefined
					? { bounceMessage: effect.details.bounceMessage }
					: {}),
				...(effect.details?.errorMessage !== undefined
					? { errorMessage: effect.details.errorMessage }
					: {}),
				...(effect.details?.errorCode !== undefined ? { errorCode: effect.details.errorCode } : {}),
			},
		});
	}
}
