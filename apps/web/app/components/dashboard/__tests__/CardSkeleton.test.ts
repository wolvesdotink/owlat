// @vitest-environment happy-dom
/**
 * DashboardCardSkeleton / DashboardCardPlaceholder — the content-shaped first
 * load that replaced the dashboard's spinner-collapse (UX piece T9).
 *
 * What matters is not which bars are drawn but that the placeholder is the
 * SHAPE of the thing it stands in for and that the grid does not move when the
 * data lands:
 *   - each shape emits the part count the real body has, so the height is right;
 *   - the placeholder grid uses the same span mapping as the real renderer, so
 *     the columns are right;
 *   - the block is decorative by default, and becomes a named `role="status"`
 *     region only where the spinner it replaced carried an `aria-label`.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import DashboardCardSkeleton from '../CardSkeleton.vue';
import DashboardCardPlaceholder from '../CardPlaceholder.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import UiSkeletonRow from '@owlat/ui/components/ui/SkeletonRow.vue';
import { dashboardCardSpan } from '~/utils/dashboardGrid';

const SKELETON = '[data-testid="dashboard-card-skeleton"]';

const components = { UiSkeleton, UiSkeletonRow };

function mountSkeleton(props: Record<string, unknown> = {}) {
	return mount(DashboardCardSkeleton, { props, global: { components } });
}

describe('DashboardCardSkeleton', () => {
	it('is decorative by default', () => {
		const root = mountSkeleton().find(SKELETON);
		expect(root.attributes('aria-hidden')).toBe('true');
		expect(root.attributes('role')).toBeUndefined();
	});

	it('becomes a named busy status region when given a label', () => {
		const root = mountSkeleton({ label: 'Loading token usage' }).find(SKELETON);
		expect(root.attributes('role')).toBe('status');
		expect(root.attributes('aria-label')).toBe('Loading token usage');
		expect(root.attributes('aria-busy')).toBe('true');
		// A labelled status must NOT also be hidden, or the announcement is lost.
		expect(root.attributes('aria-hidden')).toBeUndefined();
	});

	it('stat shape draws a label/value pair and a track per bar', () => {
		const w = mountSkeleton({ shape: 'stat', count: 4 });
		// 3 bars per row (label, value, track) and no hero line by default.
		expect(w.findAllComponents(UiSkeleton)).toHaveLength(12);
	});

	it('adds the hero numeral line above the body when asked', () => {
		const withHero = mountSkeleton({ shape: 'stat', count: 2, hero: true });
		const without = mountSkeleton({ shape: 'stat', count: 2 });
		// The hero is a numeral bar plus its trailing caption.
		expect(withHero.findAllComponents(UiSkeleton).length).toBe(
			without.findAllComponents(UiSkeleton).length + 2
		);
	});

	it('metrics shape draws one tile block per metric', () => {
		const w = mountSkeleton({ shape: 'metrics', count: 4 });
		expect(w.findAllComponents(UiSkeleton)).toHaveLength(4);
	});

	it('chart shape draws a labelled plot per series at the requested height', () => {
		const small = mountSkeleton({ shape: 'chart', count: 2 });
		// label + plot per series
		expect(small.findAllComponents(UiSkeleton)).toHaveLength(4);
		const plotHeight = (w: ReturnType<typeof mountSkeleton>) =>
			w
				.findAllComponents(UiSkeleton)
				.at(-1)!
				.classes()
				.find((c) => c.startsWith('h-'));
		expect(plotHeight(small)).toBe('h-30');
		expect(plotHeight(mountSkeleton({ shape: 'chart', count: 1, plot: 'lg' }))).toBe('h-45');
	});

	it('list shape draws one row per item, with the avatar under caller control', () => {
		const withAvatars = mountSkeleton({ shape: 'list', count: 4 });
		expect(withAvatars.findAllComponents(UiSkeletonRow)).toHaveLength(4);
		expect(withAvatars.findAllComponents(UiSkeletonRow).at(0)!.props('avatar')).toBe(true);

		const bare = mountSkeleton({ shape: 'list', count: 3, avatar: false });
		expect(bare.findAllComponents(UiSkeletonRow).at(0)!.props('avatar')).toBe(false);
	});
});

describe('DashboardCardPlaceholder', () => {
	const cardStub = { UiCard: { template: '<div class="ui-card"><slot /></div>' } };

	function mountPlaceholder(props: Record<string, unknown> = {}) {
		return mount(DashboardCardPlaceholder, {
			props,
			global: { components: { ...components, DashboardCardSkeleton }, stubs: cardStub },
		});
	}

	it('stands inside the real card shell with a header rhythm', () => {
		const w = mountPlaceholder();
		expect(w.find('.ui-card').exists()).toBe(true);
		expect(w.find(SKELETON).exists()).toBe(true);
	});

	it('picks a body big enough for the cell: list for small, stat for medium, tiles for large', () => {
		const shapeOf = (size: string) =>
			mountPlaceholder({ size }).findComponent(DashboardCardSkeleton).props('shape');
		expect(shapeOf('small')).toBe('list');
		expect(shapeOf('medium')).toBe('stat');
		expect(shapeOf('large')).toBe('metrics');
	});

	it('omits the trailing "view all" bar for cards that do not link out', () => {
		const withAction = mountPlaceholder({ size: 'small' });
		const without = mountPlaceholder({ size: 'small', action: false });
		expect(without.findAllComponents(UiSkeleton).length).toBe(
			withAction.findAllComponents(UiSkeleton).length - 1
		);
	});
});

/**
 * The placeholder grid on pages/dashboard/index.vue and DashboardCardRenderer
 * both place cells on `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`. If they ever
 * disagreed the page would snap from the placeholder layout into the real one —
 * exactly the jump the placeholders exist to remove.
 */
describe('dashboardCardSpan', () => {
	it('spans the full row for large, half for medium, one column for small', () => {
		expect(dashboardCardSpan('large')).toBe('col-span-1 sm:col-span-2 lg:col-span-4');
		expect(dashboardCardSpan('medium')).toBe('col-span-1 sm:col-span-2');
		expect(dashboardCardSpan('small')).toBe('col-span-1');
	});

	it('falls back to a single column for an unrecognised size', () => {
		expect(dashboardCardSpan('enormous')).toBe('col-span-1');
	});
});
