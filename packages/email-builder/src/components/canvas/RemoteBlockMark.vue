<script setup lang="ts">
/**
 * Another person on this root block: a coloured outline and their name, or
 * "… is editing" with a lock while they hold the block (co-editing, see
 * docs/adr/0071-email-coediting.md). Purely visual; the canvas decides what a
 * locked block still allows.
 */
import { Lock } from '@lucide/vue';
import type { RemoteBlockMark } from '../../types';

defineProps<{ mark: RemoteBlockMark }>();
</script>

<template>
	<div
		class="pointer-events-none absolute -inset-[3px] z-[4] rounded-md border-2"
		:class="mark.isLocked && 'bg-bg-base/40'"
		:style="{ borderColor: mark.color }"
		aria-hidden="true"
		data-testid="remote-block-outline"
	/>
	<div
		class="pointer-events-none absolute -top-2.5 right-2 z-[5] inline-flex max-w-[60%] items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm"
		:style="{ backgroundColor: mark.color }"
		data-testid="remote-block-label"
	>
		<Lock v-if="mark.isLocked" :size="10" class="shrink-0" aria-hidden="true" />
		<span class="truncate">{{ mark.label }}</span>
	</div>
</template>
