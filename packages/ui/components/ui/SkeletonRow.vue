<script setup lang="ts">
/**
 * One list-row placeholder: optional leading avatar, one or two stacked text
 * lines, optional trailing metadata chip.
 *
 * This is the shape almost every list surface in the product renders — an
 * avatar or icon disc, a title, an optional secondary line, and a right-aligned
 * timestamp or badge — so a loading list is `v-for` over this component at the
 * real row count, and the pane keeps its height when the rows arrive.
 *
 * Decorative: `aria-hidden`, like every other skeleton part.
 */
import Skeleton from './Skeleton.vue';

withDefaults(
	defineProps<{
		/** Leading avatar / icon disc. */
		avatar?: boolean;
		/** Size utilities for that disc — match the real row's avatar. */
		avatarSize?: string;
		/** 1 = title only; 2 = title plus a secondary line. */
		lines?: 1 | 2;
		/** Right-aligned timestamp / badge placeholder. */
		trailing?: boolean;
		/** Width utility for the title bar; vary it to avoid a mechanical grid. */
		titleWidth?: string;
	}>(),
	{ avatar: true, avatarSize: 'w-7 h-7', lines: 2, trailing: true, titleWidth: 'w-1/2' }
);
</script>

<template>
	<div aria-hidden="true" class="flex items-center gap-3">
		<Skeleton v-if="avatar" circle :class="[avatarSize, 'shrink-0']" />
		<div class="flex-1 min-w-0 space-y-1.5">
			<Skeleton class="h-3.5" :class="titleWidth" />
			<Skeleton v-if="lines > 1" class="h-3 w-3/4" />
		</div>
		<Skeleton v-if="trailing" class="h-3 w-10 shrink-0" />
	</div>
</template>
