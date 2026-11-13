<script setup lang="ts">
import { computed, type Component } from 'vue';
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';

const props = defineProps<{
	icon: Component;
	title: string;
	size?: 'sm' | 'md';
	variant?: 'default' | 'destructive';
	active?: boolean;
	/** Overrides the tooltip as the accessible name when the two must differ. */
	ariaLabel?: string;
	/** A toggle's on state (bold, an alignment): exposed as aria-pressed and drawn like `active`. */
	pressed?: boolean;
}>();

defineEmits<{
	(e: 'click', event: MouseEvent): void;
}>();

// The button is icon-only, so it has no accessible name of its own: the
// tooltip text is the name too unless a caller supplies a more specific one.
const label = computed(() => props.ariaLabel ?? props.title);
</script>

<template>
	<UiTooltip :text="title">
		<button
			class="flex items-center justify-center border-none bg-transparent rounded-md cursor-pointer transition-[background-color,color,transform] duration-(--motion-fast) active:scale-[0.92] pointer-coarse:min-h-11 pointer-coarse:min-w-11"
			:class="[
				size === 'sm' ? 'w-7 h-7' : 'w-[30px] h-[30px]',
				// The on state needs a visible step off the toolbar: bg-overlay is white
				// in the builder's light theme, the same as the bar it sits on.
				active || pressed
					? 'bg-text-primary/10 text-text-primary'
					: variant === 'destructive'
						? 'text-text-secondary hover:bg-error/10 hover:text-error'
						: 'text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary',
			]"
			type="button"
			:aria-label="label"
			:aria-pressed="pressed === undefined ? undefined : pressed"
			@click.stop="$emit('click', $event)"
		>
			<component :is="icon" :size="size === 'sm' ? 12 : 14" aria-hidden="true" />
		</button>
	</UiTooltip>
</template>
