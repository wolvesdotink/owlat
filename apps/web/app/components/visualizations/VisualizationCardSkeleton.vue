<script setup lang="ts">
/**
 * First-load placeholder for one `VisualizationsVisualizationCard`.
 *
 * The visualizations page used to render a centred spinner in a `py-16` box and
 * then snap into a two-column grid of ~380px cards — the single biggest layout
 * jump in the product. This mirrors the real card: same `.card` shell, same
 * header rhythm (title, two-line description, meta row, three icon buttons) and
 * a plot block at the renderer's reserved `min-height`, so the grid is the right
 * height from the first paint.
 *
 * Decorative — the page's loading copy stays with the surrounding state.
 */
</script>

<template>
	<div class="card overflow-hidden" data-testid="visualization-card-skeleton" aria-hidden="true">
		<div class="flex items-start justify-between mb-4">
			<div class="min-w-0 flex-1">
				<UiSkeleton class="h-4 w-2/5" />
				<UiSkeletonText class="mt-2" :lines="2" size="sm" last-line-width="w-1/2" />
				<div class="flex items-center gap-2 mt-2">
					<UiSkeleton class="h-3 w-24" />
					<UiSkeleton class="h-4 w-16 rounded" />
				</div>
			</div>
			<div class="flex items-center gap-1 flex-shrink-0 ml-3">
				<UiSkeleton v-for="action in 3" :key="`action-${action}`" class="size-7 rounded" />
			</div>
		</div>

		<UiSkeleton class="h-62 w-full rounded-lg" />
	</div>
</template>
