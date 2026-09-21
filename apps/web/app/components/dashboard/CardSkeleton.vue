<script setup lang="ts">
/**
 * Content-shaped first-load placeholder for the *body* of a dashboard card.
 *
 * Every card in `components/dashboard/cards/` used to render a centred
 * `lucide:loader-2` inside a `py-6` box while its query resolved, so a card
 * collapsed to ~48px of body and then snapped open to its real height. Thirteen
 * of those on one grid is the layout jitter the dashboard is known for.
 *
 * The four shapes cover every card body in the folder, at the geometry the real
 * content occupies:
 *   - `stat`    hero numeral + labelled progress bars (campaign performance,
 *               queue depth, cost by step, delivery rates)
 *   - `metrics` the 2-column grid of `bg-bg-surface` metric tiles (agent
 *               health, verification queue, accuracy trend)
 *   - `list`    avatar + title + meta rows (recent contacts/activity, upcoming
 *               campaigns, channel health, knowledge)
 *   - `chart`   a labelled plot block (accuracy trend, pinned visualizations)
 *
 * Compose two of them when a card stacks regions (tiles above charts). The
 * block is decorative (`aria-hidden`) unless a `label` is passed, which is how
 * the two cards whose spinner carried an `aria-label` keep announcing that they
 * are still loading.
 *
 * Sibling of `DashboardListSkeleton`, which does the same job for the full-page
 * table and list surfaces.
 */
type CardSkeletonShape = 'stat' | 'metrics' | 'list' | 'chart';

withDefaults(
	defineProps<{
		/** Which card body to stand in for. */
		shape?: CardSkeletonShape;
		/** Bars (`stat`), tiles (`metrics`), rows (`list`), plots (`chart`). */
		count?: number;
		/** Render the hero numeral line above a `stat` / `metrics` body. */
		hero?: boolean;
		/** `list` rows lead with an avatar disc. */
		avatar?: boolean;
		/**
		 * `chart` plot height. `sm` is the 120px `AgentMetricChart` viewBox; `lg`
		 * is the 180px min-height the pinned-visualization renderer reserves.
		 */
		plot?: 'sm' | 'lg';
		/**
		 * Accessible "still loading" announcement. Omit it (the default) and the
		 * placeholder is purely decorative — the right call when the card already
		 * announces its own state. Pass it and the block becomes a `role="status"`
		 * region named by this string, replacing the `aria-label` the spinner it
		 * stands in for used to carry.
		 */
		label?: string;
	}>(),
	{ shape: 'list', count: 3, hero: false, avatar: true, plot: 'sm', label: undefined }
);

/** 120px (MetricChart) / 180px (VisualizationRenderer), on the spacing scale. */
const PLOT_HEIGHT = { sm: 'h-30', lg: 'h-45' } as const;

/**
 * Ragged widths so a column of bars does not read as a table. Indexed modulo
 * the run length, which keeps it stable across re-renders (a random width would
 * re-roll on every tick of the shimmer's parent).
 */
const LABEL_WIDTHS = ['w-24', 'w-16', 'w-20', 'w-28'];
const labelWidth = (index: number) => LABEL_WIDTHS[index % LABEL_WIDTHS.length];
</script>

<template>
	<div
		data-testid="dashboard-card-skeleton"
		:role="label ? 'status' : undefined"
		:aria-label="label"
		:aria-busy="label ? 'true' : undefined"
		:aria-hidden="label ? undefined : 'true'"
	>
		<!-- Hero numeral + trailing caption, as in `text-3xl` + `text-sm` rows. -->
		<div v-if="hero" class="flex items-baseline gap-2 mb-4">
			<UiSkeleton class="h-8 w-24" />
			<UiSkeleton class="h-3.5 w-32" />
		</div>

		<!-- Labelled progress bars: label / value row, then the 6px track. -->
		<div v-if="shape === 'stat'" class="space-y-3">
			<div v-for="bar in count" :key="`bar-${bar}`">
				<div class="flex items-center justify-between mb-1">
					<UiSkeleton class="h-3" :class="labelWidth(bar - 1)" />
					<UiSkeleton class="h-3 w-10" />
				</div>
				<UiSkeleton class="h-1.5 w-full rounded-full" />
			</div>
		</div>

		<!-- The 2-column tile grid; each tile is one solid block at tile height. -->
		<div v-else-if="shape === 'metrics'" class="grid grid-cols-2 gap-2">
			<UiSkeleton v-for="tile in count" :key="`tile-${tile}`" class="h-15 rounded-lg" />
		</div>

		<!-- Plot blocks at the MetricChart height, each under its label. -->
		<div v-else-if="shape === 'chart'" class="space-y-3">
			<div v-for="series in count" :key="`plot-${series}`">
				<UiSkeleton class="h-3.5 w-32 mb-2" />
				<UiSkeleton class="w-full rounded-lg" :class="PLOT_HEIGHT[plot]" />
			</div>
		</div>

		<!-- List rows at the real `px-2 py-2` row rhythm. -->
		<div v-else class="space-y-1">
			<div v-for="row in count" :key="`row-${row}`" class="px-2 py-2">
				<UiSkeletonRow :avatar="avatar" :title-width="labelWidth(row - 1)" />
			</div>
		</div>
	</div>
</template>
