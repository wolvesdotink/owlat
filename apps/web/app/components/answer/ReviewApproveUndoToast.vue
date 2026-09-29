<script setup lang="ts">
/**
 * The shared "Approved — Undo (14s)" countdown toast for review-queue
 * approvals, mounted by the Answer page. The undo window
 * (useReviewApproveUndo) is armed by whichever surface just approved, and
 * Undo runs that surface's true inverse (undoAutoSend + row restore / flow
 * rewind). Auto-dismisses when the window elapses — the send is on its way.
 */
import UiUndoCountdownToast from '~/components/ui/UndoCountdownToast.vue';

const { state, dismiss, runUndo } = useReviewApproveUndo();

const { t } = useI18n();

// A bulk approve arms a per-id partial-result label ("8 approved, 2 held —
// Dana is replying"); a single approve keeps "Approved".
function message(seconds: number): string {
	return t('components.agentTasks.reviewApproveUndoToast.sendingIn', {
		what: state.value.label ?? t('components.agentTasks.reviewApproveUndoToast.approved'),
		seconds,
	});
}

function undoLabel(seconds: number): string {
	return t('components.agentTasks.reviewApproveUndoToast.undo', { seconds });
}
</script>

<template>
	<UiUndoCountdownToast
		:visible="state.visible"
		:send-at="state.sendAt"
		icon="lucide:check"
		:message="message"
		:undo-label="undoLabel"
		:on-undo="runUndo"
		@expire="dismiss"
	/>
</template>
