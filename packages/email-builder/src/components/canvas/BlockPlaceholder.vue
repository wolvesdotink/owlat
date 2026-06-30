<script setup lang="ts">
const emit = defineEmits<{
	(e: 'click'): void;
}>();
</script>

<template>
	<div
		class="p-3 px-1 cursor-text rounded transition-[background-color] duration-150 hover:bg-bg-surface-hover"
		@click="emit('click')"
	>
		<span class="text-sm text-text-tertiary pointer-events-none select-none">
			Type <kbd class="inline-block py-px px-[5px] text-xs font-[inherit] text-text-tertiary bg-bg-surface border border-border-subtle rounded mx-px">/</kbd> for commands...
		</span>
	</div>
</template>
