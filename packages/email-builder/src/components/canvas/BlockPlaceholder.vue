<script setup lang="ts">
const emit = defineEmits<{
	(e: 'click'): void;
}>();
</script>

<template>
	<button
		type="button"
		class="w-full text-left p-3 px-1 cursor-text rounded transition-[background-color] duration-(--motion-fast) hover:bg-bg-surface-hover"
		aria-label="Add a text block at the end"
		@click="emit('click')"
	>
		<span class="text-sm text-text-tertiary pointer-events-none select-none">
			Type <kbd class="inline-block py-px px-[5px] text-xs font-[inherit] text-text-tertiary bg-bg-surface border border-border-subtle rounded mx-px">/</kbd> for commands...
		</span>
	</button>
</template>
