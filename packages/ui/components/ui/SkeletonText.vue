<script setup lang="ts">
/**
 * A paragraph-shaped run of `UiSkeleton` bars.
 *
 * The point of a skeleton is that it occupies the geometry the real content
 * will occupy, so nothing snaps when the query lands. Hand-rolling that means
 * repeating a `v-for` plus a ragged last line at every call site, which is how
 * the app ended up with the same four lines of markup in a couple of dozen
 * files. Pick the line height from the text ladder the real copy uses
 * (`sm` = caption/metadata, `md` = body, `lg` = a heading line) and the block
 * lands at the same height as the paragraph it stands in for.
 *
 * Decorative: the whole block is `aria-hidden`, and the surrounding boundary is
 * responsible for announcing the loading state.
 */
import Skeleton from './Skeleton.vue';

type SkeletonTextSize = 'sm' | 'md' | 'lg';

withDefaults(
	defineProps<{
		/** Number of placeholder lines. */
		lines?: number;
		/** Line height, matched to the text ladder of the copy being replaced. */
		size?: SkeletonTextSize;
		/**
		 * Width utility for the final line, so the block reads as ragged prose
		 * rather than a solid rectangle. Ignored when `lines` is 1.
		 */
		lastLineWidth?: string;
	}>(),
	{ lines: 3, size: 'md', lastLineWidth: 'w-2/3' }
);

/** Mirrors text-caption / text-sm / text-base cap heights closely enough. */
const heightClass: Record<SkeletonTextSize, string> = {
	sm: 'h-3',
	md: 'h-3.5',
	lg: 'h-4',
};
</script>

<template>
	<div aria-hidden="true" class="space-y-2">
		<Skeleton
			v-for="line in lines"
			:key="line"
			:class="[heightClass[size], line === lines && lines > 1 ? lastLineWidth : 'w-full']"
		/>
	</div>
</template>
