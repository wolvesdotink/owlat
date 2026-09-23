<script setup lang="ts">
import ReviewApproveUndoToast from '~/components/agent-tasks/ReviewApproveUndoToast.vue';
import ReviewBrowseList from '~/components/agent-tasks/ReviewBrowseList.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.inbox.review.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

// The keyboard-first browse list of every agent draft (bulk approve/reject).
// "Focus" — one card at a time — is the Answer queue, filtered to the team
// inbox, where these drafts sit alongside everything else waiting on you.
function focusInAnswerQueue() {
	void navigateTo({ path: '/dashboard/answer', query: { in: 'team' } });
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<ReviewBrowseList @focus="focusInAnswerQueue" />
		<!-- One shared countdown-undo toast for approvals ("Approved — Undo (14s)"). -->
		<ReviewApproveUndoToast />
	</div>
</template>
