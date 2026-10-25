/**
 * Mail draft lifecycle: the runner for every effect except the `→ sent`
 * cascade. The only place the lifecycle touches `ctx.scheduler` and the audit
 * log. `./effects.ts` holds the `→ sent` cascade and `dispatch`, which calls
 * this after the cascade.
 */

import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { recordAuditLog } from '../../lib/auditLog';
import { deleteOwnedUpload } from '../../storage/uploads';
import type { Effect } from './types';

export async function applyNonSentEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'schedule_dispatch_action': {
				await ctx.scheduler.runAt(effect.sendAt, internal.mail.outbound.dispatchDraft, {
					draftId: effect.draftId,
					undoToken: effect.undoToken,
				});
				break;
			}
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId: 'system',
					action: effect.action,
					resource: 'mail_message',
					resourceId: effect.draftId,
					details: {
						mailboxId: effect.mailboxId,
						...effect.details,
					},
				});
				break;
			}
			case 'delete_attachment_storage': {
				for (const storageId of effect.storageIds) {
					await deleteOwnedUpload(ctx, storageId, `mailDrafts:${effect.draftId}`);
				}
				break;
			}
			case 'record_recipients_in_address_book': {
				// Routed through the same internalMutation used by the old
				// inline call site at outbound.dispatchDraft.
				await ctx.runMutation(internal.mail.contacts.internalRecordRecipients, {
					mailboxId: effect.mailboxId,
					emails: Array.from(effect.emails),
				});
				break;
			}
			case 'schedule_reply_done': {
				const { kind: _kind, ...args } = effect;
				await ctx.scheduler.runAfter(0, internal.mail.replyDone.archiveAnswered, args);
				break;
			}
			case 'schedule_edit_learning': {
				// Fire-and-forget: the diff + recurrence gating run out of band so
				// a learning failure can never block or delay the send.
				await ctx.scheduler.runAfter(0, internal.mail.ai.editLearning.recordEdit, {
					mailboxId: effect.mailboxId,
					...(effect.contactAddress !== undefined ? { contactAddress: effect.contactAddress } : {}),
					baselineText: effect.baselineText,
					sentText: effect.sentText,
				});
				break;
			}
		}
	}
}
