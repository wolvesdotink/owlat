<script setup lang="ts">
/**
 * The app-wide undo-send toast. A send leaves the page it was written on (the
 * compose page, Answer mode), so the countdown that can still take it back
 * lives with the dashboard shell, over whatever page comes next.
 *
 * The toast carries the cancel mutation and the offline outbox behind it, so it
 * is loaded and mounted only once an undo-send window opens; after that it
 * stays mounted, so its transitions run.
 */
import { usePostboxUndoSendVisible } from '~/composables/postbox/usePostboxUndoSend';
import { useMountOnFirst } from '~/composables/useMountOnFirst';

const undoSendVisible = usePostboxUndoSendVisible();
const toastNeeded = useMountOnFirst(() => undoSendVisible.value);
</script>

<template>
	<Teleport v-if="toastNeeded" to="body">
		<LazyPostboxUndoSendToast />
	</Teleport>
</template>
