<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{
	icon?: Component;
	label: string;
	variant?: 'dashed' | 'subtle';
}>();

defineEmits<{
	(e: 'click'): void;
}>();
</script>

<template>
	<button
		class="flex items-center justify-center gap-1 text-xs font-medium cursor-pointer transition-[background-color,border-color,color] duration-(--motion-fast)"
		:class="variant === 'subtle'
			? 'py-1 px-2 border border-border-subtle rounded-md bg-none text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary'
			: 'py-[7px] border border-dashed border-border-strong rounded-lg bg-bg-surface text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary hover:border-text-tertiary'"
		type="button"
		@click="$emit('click')"
	>
		<component v-if="icon" :is="icon" :size="14" />
		{{ label }}
	</button>
</template>
