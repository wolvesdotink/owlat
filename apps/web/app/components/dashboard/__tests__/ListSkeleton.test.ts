// @vitest-environment happy-dom
/**
 * DashboardListSkeleton — the content-shaped first-load placeholder that
 * replaces the centered spinner on the major dashboard list/table surfaces
 * (contacts, campaigns, automations, topics, segments) as part of UX piece
 * c3-skeletons.
 *
 * The two behaviours the plan cares about:
 *   - first load (loading, no data yet) shows the skeleton, shaped like the
 *     surface it stands in for;
 *   - a live refresh with data already visible NEVER flashes the skeleton back
 *     — the standard `isLoading && !data` gate keeps the rows on screen.
 *
 * The gate is asserted with a tiny harness that reproduces the exact v-if
 * expression the converted pages use, so the "no spinner flash on refresh"
 * guarantee is covered without mounting a whole page's composable graph.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
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
		// columns × (header + body rows) shimmer bars, no leading circle
		expect(w.findAll('.rounded-full')).toHaveLength(0);
	});

	it('table variant with `leading` adds an avatar/checkbox circle per body row', () => {
		const w = mountSkeleton({ variant: 'table', rows: 3, columns: 4, leading: true });
		// one circle per body row (header uses a bar, not a circle)
		expect(w.findAll('.rounded-full')).toHaveLength(3);
	});

	it('card variant renders a divided list with one item per `rows`', () => {
		const w = mountSkeleton({ variant: 'card', rows: 4 });
		expect(w.find('ul.divide-y').exists()).toBe(true);
		expect(w.findAll('li')).toHaveLength(4);
	});
});

/**
 * Reproduces the converted surfaces' loading gate: skeleton is shown only while
 * loading AND no data has arrived. Proves first-load shows it and a background
 * refresh (data present, loading true again) keeps the rows — no skeleton flash.
 */
const GatedSurface = defineComponent({
	components: { DashboardListSkeleton },
	props: {
		isLoading: { type: Boolean, required: true },
		data: { type: Array as () => unknown[] | null, required: true },
	},
	template: `
		<div>
			<DashboardListSkeleton v-if="isLoading && !data" variant="table" />
			<ul v-else-if="data && data.length" data-testid="rows">
				<li v-for="(_, i) in data" :key="i">row</li>
			</ul>
		</div>
	`,
});

describe('converted-surface loading gate', () => {
	it('shows the skeleton on first load (loading, no data yet)', () => {
		const w = mount(GatedSurface, {
			props: { isLoading: true, data: null },
			global: { components: { DashboardListSkeleton, UiSkeleton } },
		});
		expect(w.find(SKELETON).exists()).toBe(true);
		expect(w.find('[data-testid="rows"]').exists()).toBe(false);
	});

	it('keeps previous data (no skeleton flash) on a refresh with rows visible', async () => {
		const w = mount(GatedSurface, {
			props: { isLoading: false, data: [1, 2, 3] },
			global: { components: { DashboardListSkeleton, UiSkeleton } },
		});
		expect(w.find('[data-testid="rows"]').exists()).toBe(true);
		expect(w.find(SKELETON).exists()).toBe(false);

		// A live-query refresh re-enters loading while data is still present.
		await w.setProps({ isLoading: true, data: [1, 2, 3] });
		expect(w.find(SKELETON).exists()).toBe(false);
		expect(w.find('[data-testid="rows"]').exists()).toBe(true);
	});
});
