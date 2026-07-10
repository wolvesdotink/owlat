<script setup lang="ts">
/**
 * Content-shaped first-load placeholder for dashboard list / table surfaces
 * (contacts, campaigns, automations, topics, segments, …).
 *
 * It mirrors the real row geometry — same px-6 py-4 padding and column shape —
 * so the pane doesn't reflow when data lands. Generalizes the Postbox pattern
 * (PostboxThreadListSkeleton) to the dashboard's two dominant layouts.
 *
 * SHOW ON FIRST LOAD ONLY. Gate it with `isLoading && !data` (never `isLoading`
 * alone) so a live-query refresh that already has rows keeps them visible and
 * never flashes back to the skeleton. The underlying UiSkeleton renders a static
 * block (no shimmer) under prefers-reduced-motion. Sizing uses FF tokens only.
 */
withDefaults(
	defineProps<{
		/** Number of placeholder rows. */
		rows?: number;
		/** 'table' = columnar rows with a header; 'card' = stacked list rows. */
		variant?: 'table' | 'card';
		/** Column count for the table variant. */
		columns?: number;
		/** Render a leading avatar/checkbox circle on each row. */
		leading?: boolean;
	}>(),
	{ rows: 6, variant: 'table', columns: 4, leading: false }
);
</script>

<template>
	<div data-testid="dashboard-list-skeleton" aria-hidden="true">
		<!-- Table surfaces: contacts / automations / topics / segments -->
		<template v-if="variant === 'table'">
			<div class="flex items-center gap-6 px-6 py-4 border-b border-border-subtle">
				<UiSkeleton v-if="leading" class="h-4 w-5 flex-shrink-0" />
				<UiSkeleton
					v-for="c in columns"
					:key="`h-${c}`"
					class="h-3"
					:class="c === 1 ? 'w-32' : 'w-20 flex-shrink-0'"
				/>
			</div>
			<div
				v-for="i in rows"
				:key="`r-${i}`"
				class="flex items-center gap-6 px-6 py-4 border-b border-border-subtle last:border-b-0"
			>
				<UiSkeleton v-if="leading" circle class="w-5 h-5 flex-shrink-0" />
				<UiSkeleton
					v-for="c in columns"
					:key="`c-${c}`"
					class="h-3.5"
					:class="c === 1 ? 'flex-1' : 'w-24 flex-shrink-0'"
				/>
			</div>
		</template>

		<!-- Card-list surfaces: campaigns command rows -->
		<ul v-else class="divide-y divide-border-subtle">
			<li v-for="i in rows" :key="`li-${i}`" class="flex items-start gap-3 px-6 py-4">
				<UiSkeleton v-if="leading" circle class="mt-0.5 w-9 h-9 flex-shrink-0" />
				<div class="flex-1 min-w-0">
					<div class="flex items-center justify-between gap-3">
						<UiSkeleton class="h-4 w-48 max-w-full" />
						<UiSkeleton class="h-3 w-16 flex-shrink-0" />
					</div>
					<UiSkeleton class="h-3.5 w-2/3 mt-2" />
				</div>
			</li>
		</ul>
	</div>
</template>
