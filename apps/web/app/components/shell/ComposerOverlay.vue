<script setup lang="ts">
/**
 * The app-wide composer overlay: the Postbox's floating composer stack, mounted
 * by the dashboard shell so "Compose email" opens over whatever page you are on
 * instead of navigating to the mailbox.
 *
 * Pages that mount their own stack (the Postbox reader pages and the Answer
 * queue) keep it; on those routes this host renders nothing, so a composer is
 * never drawn twice. The stack's state is shared `useState`, so an open
 * composer survives moving between the two hosts.
 *
 * The stack is the whole composer (editor, attachments, preview-as-sent and
 * the email renderer behind it), so it is loaded and mounted only once a
 * composer opens, or an undo-send window does (an inline reply sent from the
 * Today reader arms the toast without ever opening a popup). After that it
 * stays mounted, so closing the last composer keeps its toast and transitions.
 */
import { pageHostsComposerStack } from '~/lib/composeContext';
import { usePostboxComposerStack } from '~/composables/postbox/usePostboxComposerStack';
import { usePostboxUndoSendVisible } from '~/composables/postbox/usePostboxUndoSend';
import { useMountOnFirst } from '~/composables/useMountOnFirst';

const route = useRoute();
const pageHostsStack = computed(() => pageHostsComposerStack(route.path));

const { state: composers } = usePostboxComposerStack();
const undoSendVisible = usePostboxUndoSendVisible();
const stackNeeded = useMountOnFirst(() => composers.value.length > 0 || undoSendVisible.value);
</script>

<template>
	<LazyPostboxComposerStack v-if="stackNeeded && !pageHostsStack" />
</template>
