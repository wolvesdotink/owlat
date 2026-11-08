<script setup lang="ts">
/**
 * The app-wide undo-send toast. A send leaves the page it was written on (the
 * compose page, Answer mode), so the countdown that can still take it back
 * lives with the dashboard shell, over whatever page comes next.
 *
 * The toast carries the cancel mutation and the offline outbox behind it, so it
 * is loaded and mounted only once an undo-send window opens; after that it
 * stays mounted, so its transitions run.
 *
 * It also hosts the watchers of replies waiting to be confirmed sent
 * (`useReplyTaskOffer`), which offer to finish the conversation's tasks.
 */
import { defineAsyncComponent, onBeforeUnmount } from 'vue';
import { usePostboxUndoSendVisible } from '~/composables/postbox/usePostboxUndoSend';
import { useMountOnFirst } from '~/composables/useMountOnFirst';
import { clearReplyTaskHolds, useReplyTaskHolds } from '~/composables/useReplyTaskOffer';

const undoSendVisible = usePostboxUndoSendVisible();
const toastNeeded = useMountOnFirst(() => undoSendVisible.value);

// A reply waiting to be confirmed sent outlives its page the same way; each
// one's watcher loads only once a reply is held.
const ReplyTaskOfferWatch = defineAsyncComponent(
	() => import('~/components/tasks/ReplyTaskOfferWatch.vue')
);
const replyHolds = useReplyTaskHolds();
onBeforeUnmount(clearReplyTaskHolds);
</script>

<template>
	<Teleport v-if="toastNeeded" to="body">
		<LazyPostboxUndoSendToast />
	</Teleport>
	<ReplyTaskOfferWatch v-for="hold in replyHolds" :key="hold.key" :hold="hold" />
</template>
