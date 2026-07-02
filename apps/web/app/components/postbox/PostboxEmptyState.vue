<script setup lang="ts">
/**
 * Quiet, minimal empty state for Postbox panes: small icon + one line +
 * optional single-line hint and action. Deliberately restrained (no large
 * illustration) to match the Postbox visual language.
 */
defineProps<{
	icon: string;
	title: string;
	hint?: string;
}>();
</script>

<template>
	<div data-testid="postbox-empty-state" class="p-12 text-center">
		<Icon :name="icon" class="w-8 h-8 mx-auto text-text-tertiary" />
		<p class="text-sm text-text-secondary mt-3">{{ title }}</p>
		<p v-if="hint" class="text-xs text-text-tertiary mt-1 max-w-xs mx-auto">{{ hint }}</p>
		<slot name="action" />
	</div>
</template>
