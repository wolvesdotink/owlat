<script setup lang="ts">
/**
 * The app-wide composer overlay: the Postbox's floating composer stack, mounted
 * once by the dashboard shell so "Compose email" opens over whatever page you
 * are on instead of navigating to the mailbox.
 *
 * Pages that mount their own stack (the Postbox reader pages and the Answer
 * queue) keep it; on those routes this host renders nothing, so a composer is
 * never drawn twice. The stack's state is shared `useState`, so an open
 * composer survives moving between the two hosts.
 */
import { pageHostsComposerStack } from '~/lib/composeContext';

const route = useRoute();
const pageHostsStack = computed(() => pageHostsComposerStack(route.path));
</script>

<template>
	<PostboxComposerStack v-if="!pageHostsStack" />
</template>
