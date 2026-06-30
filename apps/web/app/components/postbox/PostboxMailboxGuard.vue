<script setup lang="ts">
/**
 * Tri-state guard every Postbox page opens with: mailbox still resolving →
 * spinner; resolved but absent → "No mailbox configured"; present → page
 * body (default slot). Previously copy-pasted across the label, search, and
 * contacts pages with drifting copy and layout.
 */
defineProps<{
	mailboxId: string | null;
	loading: boolean;
}>();
</script>

<template>
	<div v-if="loading" class="flex-1 flex items-center justify-center p-12">
		<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" aria-label="Loading mailbox" />
	</div>
	<div v-else-if="!mailboxId" class="flex-1 flex items-center justify-center p-12">
		<p class="text-text-secondary">No mailbox configured</p>
	</div>
	<slot v-else />
</template>
