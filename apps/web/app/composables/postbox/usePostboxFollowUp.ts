import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Arm or cancel a conversation's "remind me if no reply" watch: one
 * implementation for the reader's follow-up chip and the palette's "Remind me if
 * no reply ›" / "Cancel reply reminder" rows, so both go through the same
 * operations, labels and in-flight guard. Ownership is checked server-side
 * (mail/followUps.ts).
 */
export function usePostboxFollowUp() {
	const { t } = useI18n();
	const armOp = useBackendOperation(api.mail.followUps.arm, {
		label: () => t('components.postbox.postboxFollowUpChip.armOperation'),
	});
	const cancelOp = useBackendOperation(api.mail.followUps.cancel, {
		label: () => t('components.postbox.postboxFollowUpChip.cancelOperation'),
	});

	const busy = ref(false);

	async function guarded(run: () => Promise<unknown>) {
		if (busy.value) return;
		busy.value = true;
		try {
			await run();
		} finally {
			busy.value = false;
		}
	}

	/** Watch the sent message `messageId` for a reply until `remindAt`. */
	function arm(messageId: string, remindAt: number) {
		return guarded(() => armOp.run({ messageId: messageId as Id<'mailMessages'>, remindAt }));
	}

	/** Drop the conversation's watch (armed or already due). */
	function cancel(threadId: string) {
		return guarded(() => cancelOp.run({ threadId: threadId as Id<'mailThreads'> }));
	}

	return { busy, arm, cancel };
}
