<script setup lang="ts">
import { computed, type Component } from 'vue';

const props = defineProps<{
	icon: Component;
	title: string;
	size?: 'sm' | 'md';
	variant?: 'default' | 'destructive';
	active?: boolean;
	/** Overrides the tooltip as the accessible name when the two must differ. */
	ariaLabel?: string;
}>();

defineEmits<{
	(e: 'click', event: MouseEvent): void;
}>();

// The button is icon-only, so it has no accessible name of its own — the
// tooltip is the name unless a caller supplies a more specific one.
const label = computed(() => props.ariaLabel ?? props.title);
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
		:aria-label="label"
		@click.stop="$emit('click', $event)"
	>
		<component :is="icon" :size="size === 'sm' ? 12 : 14" aria-hidden="true" />
	</button>
</template>
