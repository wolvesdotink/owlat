<script setup lang="ts">
import ReviewApproveUndoToast from '~/components/agent-tasks/ReviewApproveUndoToast.vue';

/**
 * The Answer queue page: everything waiting on the viewer's answer, one card
 * at a time. Replaces the separate personal Reply Queue and the team Review
 * Queue's focus mode (both routes redirect here); the team's browse list stays
 * at /dashboard/inbox/review.
 */
const { t } = useI18n();
useHead({ title: () => t('dashboard.answer.pageTitle') });
definePageMeta({ layout: 'dashboard', middleware: 'auth' });
</script>

<template>
	<div class="min-h-full bg-bg-base">
		<h1 class="sr-only">{{ t('dashboard.answer.pageTitle') }}</h1>
		<AnswerQueueFlow />
		<PostboxComposerStack />
		<ReviewApproveUndoToast />
	</div>
</template>
