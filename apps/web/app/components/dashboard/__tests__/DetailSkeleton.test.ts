// @vitest-environment happy-dom
/**
 * DashboardDetailSkeleton replaced the centred `py-16` spinner on the dashboard
 * detail pages (plan 2.8). What it must keep true:
 *   - it announces "loading" to a screen reader from the first frame, even
 *     while the drawn placeholder is still held back;
 *   - the drawn placeholder waits 150 ms (keeping its box) so a record that
 *     arrives fast never paints a skeleton frame, unless `delay` is off because
 *     a QueryBoundary already waited;
 *   - each shape draws the parts its page has (tabs, stat tiles, the body), so
 *     the page does not change height when the record lands.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import DashboardDetailSkeleton from '../DetailSkeleton.vue';
import DashboardListSkeleton from '../ListSkeleton.vue';
import ChatRoomSkeleton from '../../chat/ChatRoomSkeleton.vue';
import KnowledgeEntryListSkeleton from '../../knowledge/KnowledgeEntryListSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import UiSkeletonText from '@owlat/ui/components/ui/SkeletonText.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

const components = { UiSkeleton, UiSkeletonText, DashboardListSkeleton };

function mountDetail(props: Record<string, unknown> = {}) {
	return mount(DashboardDetailSkeleton, {
		props,
		global: { components, plugins: [createTestI18n()] },
	});
}

/** The drawn block (everything but the status line). */
const drawn = (wrapper: ReturnType<typeof mountDetail>) => wrapper.find('[aria-hidden="true"]');

describe('DashboardDetailSkeleton', () => {
	it('announces the page-specific loading copy at once', () => {
		const wrapper = mountDetail({ label: 'Loading contact…' });
		expect(wrapper.find('[role="status"]').text()).toBe('Loading contact…');
		expect(wrapper.find('[data-testid="dashboard-detail-skeleton"]').attributes('aria-busy')).toBe(
			'true'
		);
	});

	it('falls back to the generic loading copy', () => {
		expect(mountDetail().find('[role="status"]').text()).toBe('Loading…');
	});

	it('keeps its box but paints nothing for the first 150 ms', async () => {
		const wrapper = mountDetail();
		expect(drawn(wrapper).classes()).toContain('invisible');
		expect(wrapper.findAllComponents(UiSkeleton).length).toBeGreaterThan(0);

		vi.advanceTimersByTime(149);
		await nextTick();
		expect(drawn(wrapper).classes()).toContain('invisible');

		vi.advanceTimersByTime(1);
		await nextTick();
		expect(drawn(wrapper).classes()).not.toContain('invisible');
	});

	it('paints at once with `delay` off (inside a QueryBoundary loading slot)', () => {
		expect(drawn(mountDetail({ delay: false })).classes()).not.toContain('invisible');
	});

	it('draws tabs, stat tiles and one card per section', () => {
		const plain = mountDetail({ body: 'cards', sections: 2, actions: 0 });
		const rich = mountDetail({ body: 'cards', sections: 3, actions: 0, tabs: true, stats: 4 });
		expect(plain.findAll('.card')).toHaveLength(2);
		// 4 stat tiles + 3 section cards.
		expect(rich.findAll('.card')).toHaveLength(7);
		// The tab strip is one rounded bar the width of UiTabs.
		expect(rich.findAll('.w-80')).toHaveLength(1);
		expect(plain.findAll('.w-80')).toHaveLength(0);
	});

	it('draws the sidebar body as a two-thirds column beside a facts card', () => {
		const wrapper = mountDetail({ sections: 2 });
		expect(wrapper.find('.lg\\:col-span-2').findAll('.card')).toHaveLength(2);
		expect(wrapper.find('.lg\\:grid-cols-3').findAll('.card')).toHaveLength(3);
	});

	it('draws a member table for the table body and a roster for the list body', () => {
		const table = mountDetail({ body: 'table' });
		expect(table.findComponent(DashboardListSkeleton).props('variant')).toBe('table');
		const list = mountDetail({ body: 'list', sections: 4, header: false });
		const roster = list.findComponent(DashboardListSkeleton);
		expect(roster.props('variant')).toBe('card');
		expect(roster.props('rows')).toBe(4);
	});

	it('omits the title block when the page already renders its header', () => {
		const withHeader = mountDetail({ body: 'cards', sections: 1, actions: 2 });
		const without = mountDetail({ body: 'cards', sections: 1, actions: 2, header: false });
		// Title + lead + two actions.
		expect(
			withHeader.findAllComponents(UiSkeleton).length - without.findAllComponents(UiSkeleton).length
		).toBe(4);
	});
});

describe('ChatRoomSkeleton', () => {
	function mountRoom(props: Record<string, unknown> = {}) {
		return mount(ChatRoomSkeleton, {
			props,
			global: { components, plugins: [createTestI18n()] },
		});
	}

	it('draws the header bar only when the whole room is loading', () => {
		expect(mountRoom().find('.border-b').exists()).toBe(true);
		expect(mountRoom({ header: false }).find('.border-b').exists()).toBe(false);
	});

	it('draws one avatar per message row and announces loading', () => {
		const wrapper = mountRoom({ rows: 3 });
		const avatars = wrapper.findAllComponents(UiSkeleton).filter((s) => s.props('circle'));
		expect(avatars).toHaveLength(3);
		expect(wrapper.find('[role="status"]').text()).toBe('Loading…');
	});

	it('holds the rows back for 150 ms', async () => {
		const wrapper = mountRoom();
		expect(wrapper.find('[aria-hidden="true"]').classes()).toContain('invisible');
		vi.advanceTimersByTime(150);
		await nextTick();
		expect(wrapper.find('[aria-hidden="true"]').classes()).not.toContain('invisible');
	});
});

describe('KnowledgeEntryListSkeleton', () => {
	it('draws one entry-card placeholder per row', () => {
		const wrapper = mount(KnowledgeEntryListSkeleton, {
			props: { rows: 3 },
			global: { components, plugins: [createTestI18n()] },
		});
		expect(wrapper.findAll('.rounded-xl')).toHaveLength(3);
		expect(wrapper.find('[role="status"]').text()).toBe('Loading…');
	});
});
