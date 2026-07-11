// @vitest-environment happy-dom
/**
 * DashboardListSkeleton — the content-shaped first-load placeholder that
 * replaces the centered spinner on the major dashboard list/table surfaces
 * (contacts, campaigns, automations, topics, segments) as part of UX piece
 * c3-skeletons.
 *
 * The two behaviours the plan cares about:
 *   - first load (loading, empty results) shows the skeleton, shaped like the
 *     surface it stands in for;
 *   - a live refresh with rows already visible NEVER flashes the skeleton back
 *     — the `isLoading && results.length === 0` gate keeps the rows on screen.
 *
 * The gate is asserted with a tiny harness that reproduces the exact v-if
 * expression the converted pages use against the semantics usePaginatedQuery
 * actually produces (results is `[]`, never null), so the "no spinner flash on
 * refresh" guarantee is covered without mounting a whole page's composable graph.
 */
import { describe, it, expect } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent } from 'vue';

import DashboardListSkeleton from '../ListSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';

const SKELETON = '[data-testid="dashboard-list-skeleton"]';

function mountSkeleton(props: Record<string, unknown> = {}) {
	return mount(DashboardListSkeleton, {
		props,
		global: { components: { UiSkeleton } },
	});
}

/**
 * Count circular placeholders by the UiSkeleton contract (its `circle` prop),
 * rather than coupling to the `.rounded-full` class that is UiSkeleton's own
 * implementation detail.
 */
function circleCount(w: VueWrapper): number {
	return w.findAllComponents(UiSkeleton).filter((c) => c.props('circle') === true).length;
}

describe('DashboardListSkeleton', () => {
	it('renders as a decorative (aria-hidden) placeholder', () => {
		const w = mountSkeleton();
		const root = w.find(SKELETON);
		expect(root.exists()).toBe(true);
		expect(root.attributes('aria-hidden')).toBe('true');
	});

	it('table variant renders a header row plus one row per `rows`', () => {
		const w = mountSkeleton({ variant: 'table', rows: 5, columns: 4 });
		// header + 5 body rows, each is a flex row div under the root
		const rows = w.findAll(`${SKELETON} > .flex.items-center`);
		expect(rows).toHaveLength(6);
		// no leading circle when `leading` is off — assert the UiSkeleton contract
		// (its `circle` prop), not its internal markup class
		expect(circleCount(w)).toBe(0);
	});

	it('table variant with `leading` adds an avatar/checkbox circle per body row', () => {
		const w = mountSkeleton({ variant: 'table', rows: 3, columns: 4, leading: true });
		// one circle per body row (header uses a bar, not a circle)
		expect(circleCount(w)).toBe(3);
	});

	it('card variant renders a divided list with one item per `rows`', () => {
		const w = mountSkeleton({ variant: 'card', rows: 4 });
		expect(w.find('ul.divide-y').exists()).toBe(true);
		expect(w.findAll('li')).toHaveLength(4);
	});
});

/**
 * Reproduces the converted surfaces' loading gate against the semantics
 * usePaginatedQuery actually produces: `results` is always an array (`[]` on
 * first load, never null), so the honest first-load signal is
 * `isLoading && results.length === 0`. Proves first-load (loading + empty) shows
 * the skeleton and a refresh (rows present, loading true again) keeps the rows —
 * no skeleton flash.
 */
const GatedSurface = defineComponent({
	components: { DashboardListSkeleton },
	props: {
		isLoading: { type: Boolean, required: true },
		results: { type: Array as () => unknown[], required: true },
	},
	template: `
		<div>
			<DashboardListSkeleton v-if="isLoading && results.length === 0" variant="table" />
			<ul v-else-if="results.length" data-testid="rows">
				<li v-for="(_, i) in results" :key="i">row</li>
			</ul>
		</div>
	`,
});

describe('converted-surface loading gate', () => {
	it('shows the skeleton on first load (loading, empty results)', () => {
		const w = mount(GatedSurface, {
			props: { isLoading: true, results: [] },
			global: { components: { DashboardListSkeleton, UiSkeleton } },
		});
		expect(w.find(SKELETON).exists()).toBe(true);
		expect(w.find('[data-testid="rows"]').exists()).toBe(false);
	});

	it('keeps previous rows (no skeleton flash) on a refresh with rows visible', async () => {
		const w = mount(GatedSurface, {
			props: { isLoading: false, results: [1, 2, 3] },
			global: { components: { DashboardListSkeleton, UiSkeleton } },
		});
		expect(w.find('[data-testid="rows"]').exists()).toBe(true);
		expect(w.find(SKELETON).exists()).toBe(false);

		// A live-query refresh (or a keepPreviousData resubscribe) re-enters loading
		// while rows are still present — the skeleton must stay hidden.
		await w.setProps({ isLoading: true, results: [1, 2, 3] });
		expect(w.find(SKELETON).exists()).toBe(false);
		expect(w.find('[data-testid="rows"]').exists()).toBe(true);
	});
});
