<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{
	icon: Component;
	title: string;
	size?: 'sm' | 'md';
	variant?: 'default' | 'destructive';
	active?: boolean;
}>();

defineEmits<{
	(e: 'click', event: MouseEvent): void;
}>();
</script>

<template>
	<button
		class="flex items-center justify-center border-none bg-transparent rounded-md cursor-pointer transition-[background-color,color,transform] duration-(--motion-fast) active:scale-[0.92]"
		:class="[
			size === 'sm' ? 'w-6 h-6' : 'w-[30px] h-[30px]',
			active
				? 'bg-bg-overlay text-text-primary'
				: variant === 'destructive'
					? 'text-text-secondary hover:bg-red-600/[0.08] hover:text-red-600'
					: 'text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary',
		]"
		type="button"
		:title="title"
		@click.stop="$emit('click', $event)"
	>
		<component :is="icon" :size="size === 'sm' ? 12 : 14" />
	</button>
</template>
