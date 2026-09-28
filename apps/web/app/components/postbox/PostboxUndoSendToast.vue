<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import UiUndoCountdownToast from '~/components/ui/UndoCountdownToast.vue';

const emit = defineEmits<{
	/** The window ran out without an undo: the message is on its way. */
	expired: [];
	/** Undo was pressed and its reversal has finished, whatever it found. */
	undone: [];
}>();

const { t } = useI18n();

const { state, dismiss, runUndo } = usePostboxUndoSend();
const stack = usePostboxComposerStack();
// Offline-queued sends arm this toast with a synthetic `outbox:` token;
// undo for those un-queues on-device instead of asking the server to
// cancel.
const offlineOutbox = usePostboxOfflineOutbox();
const cancelPending = useBackendOperation(api.mail.drafts.cancelPendingSend, {
	label: () => t('components.postbox.postboxUndoSendToast.undoSendOperation'),
});

// Honest copy for an offline-queued send: nothing is "sending" yet — the
// message sits in the on-device outbox until the connection returns.
const isQueued = computed(
	() => !!state.value.undoToken && isQueuedSendToken(state.value.undoToken)
);

function message(seconds: number): string {
	return isQueued.value
		? t('components.postbox.postboxUndoSendToast.queued', { seconds })
		: t('components.postbox.postboxUndoSendToast.sending', { seconds });
}

/**
 * The reversal, run by `runUndo` after it has already closed the window, so a
 * second click cannot cancel the send (and reopen the draft) twice.
 */
async function undoSend({ undoToken, mailboxId }: typeof state.value) {
	if (!undoToken) return;
	if (isQueuedSendToken(undoToken)) {
		// Offline queue: undo = un-queue. Reopen the composer seeded from the
		// queued payload so the message lands back in the editor, nothing lost.
		// A null item means undo lost the race with the drain (the item is
		// claimed or already sent) — the composable said so.
		const item = await offlineOutbox.undoQueuedSend(undoToken);
		if (item && mailboxId) {
			stack.open({
				mailboxId,
				...(item.payload.draftId ? { draftId: item.payload.draftId as Id<'mailDrafts'> } : {}),
				prefillTo: item.payload.toAddresses,
				prefillCc: item.payload.ccAddresses,
				prefillBcc: item.payload.bccAddresses,
				prefillSubject: item.payload.subject,
				prefillBodyHtml: item.payload.bodyHtml,
				// The draft row is unreachable while offline, so the committed
				// attachment refs ride in from the payload — without them a
				// re-send would drop the files silently.
				prefillAttachments: item.payload.attachments,
			});
		}
		return;
	}
	const result = await cancelPending.run({ undoToken });
	// Reopen the recovered draft so the user lands back in the editor.
	if (result.ok && result.result.ok && mailboxId) {
		stack.open({ mailboxId, draftId: result.result.draftId as Id<'mailDrafts'> });
	}
}

async function onUndo() {
	await runUndo(undoSend);
	emit('undone');
}

function onExpire() {
	dismiss();
	emit('expired');
}
</script>

<template>
	<UiUndoCountdownToast
		:visible="state.visible"
		:send-at="state.sendAt"
		icon="lucide:send"
		:message="message"
		:undo-label="t('components.postbox.postboxUndoSendToast.undo')"
		:on-undo="onUndo"
		@expire="onExpire"
	/>
</template>
