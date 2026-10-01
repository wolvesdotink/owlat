/**
 * The verbs that finish a Postbox item of the Answer queue without a reply:
 * Done (clear the needs-reply flag, or dismiss a follow-up reminder), Archive
 * (undoable: the messages move back) and Snooze. The queue card and Answer
 * mode's queue bar both run them, and each reports back through the queue's
 * controls, so an item leaves the queue only when one of these (or a send)
 * actually happened.
 *
 * Archive, its undo and snooze patch the cached Postbox views and counts
 * before the server answers (plan 2.2), like the same verbs in the Postbox.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	optimisticArchive,
	optimisticMove,
	optimisticSnooze,
} from '~/lib/mailOptimistic/mailUpdaters';
import type { AnswerCardControls } from '~/utils/answerCard';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';

type MailRow = Pick<ReplyQueueItem, 'kind' | 'threadId' | 'messageId'>;

export function useAnswerMailActions(
	row: () => MailRow | null,
	controls: () => Pick<AnswerCardControls, 'complete'> | null
) {
	const { t } = useI18n();

	const clearOp = useBackendOperation(api.mail.needsReply.clear, {
		label: () => t('components.postbox.postboxReplyFlow.operations.markDone'),
	});
	const cancelFollowUpOp = useBackendOperation(api.mail.followUps.cancel, {
		label: () => t('components.postbox.postboxReplyFlow.operations.dismissReminder'),
	});
	const archiveOp = useBackendOperation(api.mail.messageActions.archive, {
		label: () => t('components.postbox.postboxReplyFlow.operations.archive'),
		optimisticUpdate: optimisticArchive,
	});
	const moveOp = useBackendOperation(api.mail.messageActions.move, {
		label: () => t('components.postbox.postboxReplyFlow.operations.move'),
		optimisticUpdate: optimisticMove,
	});
	const snoozeOp = useBackendOperation(api.mail.snooze.snooze, {
		label: () => t('components.postbox.postboxReplyFlow.operations.snooze'),
		optimisticUpdate: optimisticSnooze,
	});

	async function markDone(): Promise<boolean> {
		const current = row();
		if (!current) return false;
		const threadId = current.threadId as Id<'mailThreads'>;
		const result =
			current.kind === 'followup'
				? await cancelFollowUpOp.run({ threadId })
				: await clearOp.run({ threadId });
		if (result.ok) controls()?.complete('cleared');
		return result.ok;
	}

	async function archive(): Promise<boolean> {
		const current = row();
		if (!current) return false;
		const result = await archiveOp.run({ messageIds: [current.messageId as Id<'mailMessages'>] });
		if (!result.ok || result.result == null || !('moved' in result.result)) return false;
		const moved = result.result.moved;
		controls()?.complete('archived', async () => {
			for (const m of moved) {
				await moveOp.run({ messageIds: [m.messageId], targetFolderId: m.sourceFolderId });
			}
		});
		return true;
	}

	async function snooze(until: number): Promise<boolean> {
		const current = row();
		if (!current) return false;
		const result = await snoozeOp.run({
			messageId: current.messageId as Id<'mailMessages'>,
			until,
		});
		if (result.ok) controls()?.complete('snoozed');
		return result.ok;
	}

	return { markDone, archive, snooze };
}
