<script setup lang="ts">
import { INBOX_SLOT_SWATCH } from '~/utils/inboxIdentity';

/**
 * An inbox's identity chip: a square swatch plus the inbox's short name. The
 * name is always shown, so the colour is a second channel and never the only
 * one (the square shape also sets it apart from the round status dots).
 */
const props = withDefaults(
	defineProps<{
		name: string;
		slot: number | null;
		/** `plain` drops the pill background (inline in running text). */
		variant?: 'pill' | 'plain';
		size?: 'sm' | 'md';
	}>(),
	{ variant: 'pill', size: 'sm' }
);

const swatch = computed(() =>
	props.slot === null ? 'bg-text-tertiary' : (INBOX_SLOT_SWATCH[props.slot] ?? 'bg-text-tertiary')
);
</script>

<template>
	<span
		class="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap font-medium text-text-secondary"
		:class="[
			variant === 'pill' ? 'rounded-full bg-bg-surface px-2 py-px' : '',
			size === 'sm' ? 'text-2xs' : 'text-xs',
		]"
	>
		<span class="size-1.5 shrink-0 rounded-[2px]" :class="swatch" aria-hidden="true" />
		<span class="truncate">{{ name }}</span>
	</span>
</template>
