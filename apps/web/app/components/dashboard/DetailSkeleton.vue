<script setup lang="ts">
/**
 * First-load placeholder for a dashboard DETAIL page (a contact, a topic, an
 * automation, a file, a knowledge entry …), sibling of `DashboardListSkeleton`
 * (list and table pages) and `DashboardCardSkeleton` (card bodies).
 *
 * Those pages used to show a centred spinner in a `py-16` box while the record
 * loaded, so the page was ~130px tall and then snapped open to its real height
 * when the query landed. This draws the page's own geometry instead: the header
 * row (leading avatar or icon tile, title, lead, meta strip, action buttons),
 * optional tabs and stat tiles, then one of the four body shapes those pages
 * use:
 *   - `sidebar` a two-thirds column of cards next to a one-third facts card
 *   - `cards`   a single column of stacked cards (settings, sections)
 *   - `table`   a search field above a member table
 *   - `list`    one card: a titled header over avatar rows (a roster)
 *
 * The skeleton holds itself back for the shared 150 ms (`useDelayedLoading`):
 * it keeps its box, so nothing below moves, but a record that arrives inside
 * that window never paints a placeholder at all. The status line is outside
 * the hidden block, so a screen reader hears "loading" at once either way.
 */
import {
	DEFAULT_LOADING_DELAY_MS,
	useDelayedLoading,
} from '@owlat/ui/composables/useDelayedLoading';

type DetailSkeletonLead = 'none' | 'avatar' | 'tile' | 'tile-lg';
type DetailSkeletonBack = 'none' | 'link' | 'button';
type DetailSkeletonBody = 'sidebar' | 'cards' | 'table' | 'list';

const props = withDefaults(
	defineProps<{
		/** Screen-reader status copy; defaults to the generic "Loading…". */
		label?: string;
		/** Draw the title block. Off when the page renders its real header already. */
		header?: boolean;
		/** A text back link above the header, or the square back button beside it. */
		back?: DetailSkeletonBack;
		/** What leads the title: a contact avatar, a small icon tile, a large one. */
		lead?: DetailSkeletonLead;
		/** The counts / dates strip some headers hang under the lead. */
		meta?: boolean;
		/** Number of header action buttons. */
		actions?: number;
		/** A tab strip between the header and the body. */
		tabs?: boolean;
		/** Number of stat tiles in a row above the body. */
		stats?: number;
		/** Body shape, see above. */
		body?: DetailSkeletonBody;
		/** Cards in the main column (`sidebar`, `cards`), rows in a `list`. */
		sections?: number;
		/**
		 * Hold the placeholder back for 150 ms. Turn it off inside a
		 * `UiQueryBoundary` `#loading` slot, which has already waited.
		 */
		delay?: boolean;
	}>(),
	{
		label: undefined,
		header: true,
		back: 'none',
		lead: 'none',
		meta: false,
		actions: 1,
		tabs: false,
		stats: 0,
		body: 'sidebar',
		sections: 2,
		delay: true,
	}
);

const { t } = useI18n();

const LEAD_CLASSES: Record<Exclude<DetailSkeletonLead, 'none'>, string> = {
	avatar: 'size-14 rounded-full',
	tile: 'size-9 rounded-lg',
	'tile-lg': 'size-14 rounded-xl',
};

/** Ragged line counts, so stacked cards do not read as a grid of clones. */
const lineCount = (section: number) => (section % 2 === 1 ? 4 : 2);

// Read once: a placeholder already on screen does not blink out on a prop change.
const visible = useDelayedLoading(true, {
	delay: props.delay ? DEFAULT_LOADING_DELAY_MS : 0,
	minVisible: 0,
});
const statusLabel = computed(() => props.label ?? t('common.loading'));
</script>

<template>
	<div data-testid="dashboard-detail-skeleton" aria-busy="true">
		<p role="status" class="sr-only">{{ statusLabel }}</p>

		<div aria-hidden="true" :class="{ invisible: !visible }">
			<UiSkeleton v-if="back === 'link'" class="h-4 w-36 mb-6" />

			<!-- Header row: back button, leading avatar/tile, title ladder, actions. -->
			<div v-if="header" class="flex items-start gap-4 mb-6">
				<UiSkeleton v-if="back === 'button'" class="size-9 mt-1 shrink-0 rounded-lg" />
				<UiSkeleton v-if="lead !== 'none'" class="shrink-0" :class="LEAD_CLASSES[lead]" />
				<div
					class="flex-1 min-w-0 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"
				>
					<div class="min-w-0 flex-1">
						<UiSkeleton class="h-8 w-2/3 max-w-sm" />
						<UiSkeleton class="mt-2 h-4 w-1/2 max-w-xs" />
						<UiSkeleton v-if="meta" class="mt-3 h-4 w-64 max-w-full" />
					</div>
					<div v-if="actions > 0" class="flex flex-wrap items-center gap-2">
						<UiSkeleton v-for="action in actions" :key="`a-${action}`" class="h-9 w-24" />
					</div>
				</div>
			</div>

			<UiSkeleton v-if="tabs" class="h-10 w-80 max-w-full rounded-lg mb-6" />

			<div v-if="stats > 0" class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
				<div v-for="stat in stats" :key="`s-${stat}`" class="card p-4">
					<UiSkeleton class="h-3.5 w-20 mb-3" />
					<UiSkeleton class="h-7 w-16" />
				</div>
			</div>

			<!-- Search field over a member table. -->
			<template v-if="body === 'table'">
				<UiSkeleton class="h-10 w-full max-w-md mb-6" />
				<div class="card p-0 overflow-hidden">
					<DashboardListSkeleton :rows="6" :columns="3" />
				</div>
			</template>

			<!-- One card: icon + title header over avatar rows. -->
			<div v-else-if="body === 'list'" class="card p-0 overflow-hidden">
				<div class="flex items-center gap-3 px-6 py-4 border-b border-border-subtle">
					<UiSkeleton class="size-8 shrink-0 rounded-lg" />
					<div class="flex-1 min-w-0">
						<UiSkeleton class="h-5 w-40" />
						<UiSkeleton class="mt-1.5 h-3.5 w-24" />
					</div>
				</div>
				<DashboardListSkeleton variant="card" leading :rows="sections" />
			</div>

			<!-- Stacked cards, one column. -->
			<div v-else-if="body === 'cards'" class="space-y-6">
				<div v-for="section in sections" :key="`c-${section}`" class="card">
					<UiSkeleton class="h-5 w-40 mb-4" />
					<UiSkeletonText :lines="lineCount(section)" size="sm" />
				</div>
			</div>

			<!-- Two-thirds column of cards beside a one-third facts card. -->
			<div v-else class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<div class="lg:col-span-2 space-y-6">
					<div v-for="section in sections" :key="`m-${section}`" class="card">
						<UiSkeleton class="h-5 w-40 mb-4" />
						<UiSkeletonText :lines="lineCount(section)" size="sm" />
					</div>
				</div>
				<div class="card">
					<UiSkeleton class="h-5 w-24 mb-4" />
					<div class="space-y-3">
						<div v-for="fact in 3" :key="`f-${fact}`">
							<UiSkeleton class="h-3 w-16" />
							<UiSkeleton class="mt-1.5 h-4 w-28" />
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
