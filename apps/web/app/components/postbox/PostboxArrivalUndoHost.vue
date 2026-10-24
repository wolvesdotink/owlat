<script setup lang="ts">
/**
 * Announces read-on-arrival undos that finish after the component that started
 * them is gone. app.vue mounts it while an undo is pending;
 * it owns their `undoStatus` subscriptions. Renders nothing.
 */
import { usePostboxArrivalUndoAnnouncer } from '~/composables/postbox/usePostboxArrivalUndo';

usePostboxArrivalUndoAnnouncer();
</script>

<template>
	<span hidden />
</template>
