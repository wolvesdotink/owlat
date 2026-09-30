<script setup lang="ts">
import ReviewApproveUndoToast from '~/components/answer/ReviewApproveUndoToast.vue';
import { provideAnswerQueueSession } from '~/composables/useAnswerQueueSession';

/**
 * The parent of every Answer route: the queue page and both Answer mode
 * routes (`m/<messageId>`, `t/<threadId>`). It stays mounted while the child
 * route changes, which is what lets the Answer queue step from one Answer mode
 * page to the next and keep its place, its undo and its end summary (see
 * useAnswerQueueSession). It renders no chrome of its own.
 *
 * The approve countdown toast lives here too, so approving a team draft and
 * moving on to the next item keeps its Undo on screen.
 */
definePageMeta({ layout: 'dashboard', middleware: 'auth' });

provideAnswerQueueSession();
</script>

<template>
	<div class="contents">
		<NuxtPage />
		<ReviewApproveUndoToast />
	</div>
</template>
