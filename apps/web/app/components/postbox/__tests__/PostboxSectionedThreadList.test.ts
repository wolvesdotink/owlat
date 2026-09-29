// @vitest-environment happy-dom
/**
 * The sectioned list shell behind the categories view and the split inbox.
 *
 * Both views used to carry their own copy of this logic; the shell now owns it
 * once, so these cases pin what both views rely on: collapsed sections leave
 * the keyboard order, windowing starts above POSTBOX_VIRTUAL_THRESHOLD, the
 * `#section-footer` slot renders once per expanded section, and the header
 * badge is the unread count, hidden at 0.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { h, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { usePostboxListKeyboard } from '~/composables/postbox/usePostboxListKeyboard';
import { POSTBOX_VIRTUAL_THRESHOLD } from '~/utils/postboxDensity';

import PostboxSectionedThreadList, {
	type PostboxThreadListSection,
} from '../PostboxSectionedThreadList.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';

type Item = { _id: string };

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable') }));
	// The real keyboard composable: the point is the order it is handed.
	vi.stubGlobal('usePostboxListKeyboard', usePostboxListKeyboard);
});

function items(prefix: string, count: number): Item[] {
	return Array.from({ length: count }, (_, i) => ({ _id: `${prefix}-${i}` }));
}

function section(
	key: string,
	rows: Item[],
	extra: Partial<PostboxThreadListSection<Item>> = {}
): PostboxThreadListSection<Item> {
	return { key, label: key.toUpperCase(), icon: 'lucide:inbox', items: rows, ...extra };
}

function mountList(
	props: {
		sections: PostboxThreadListSection<Item>[];
		collapsed?: Record<string, boolean>;
		hasMore?: boolean;
		onActivate?: (item: Item) => void;
	},
	withFooter = false
) {
	return mount(PostboxSectionedThreadList, {
		props: {
			sections: props.sections,
			collapsed: props.collapsed ?? {},
			loading: false,
			folderRole: 'inbox',
			rowDomId: (item: Item) => `row-${item._id}`,
			onActivate: props.onActivate ?? (() => {}),
			listLabel: 'Sections',
			emptyTitle: 'All clear',
			hasMore: props.hasMore,
			loadMoreLabel: 'Load more',
		},
		slots: {
			row: ({ item, focused }: { item: Item; focused: boolean }) =>
				h('a', { id: `row-${item._id}`, 'data-row': item._id, 'aria-selected': focused }),
			...(withFooter
				? {
						'section-footer': ({ section: s }: { section: PostboxThreadListSection<Item> }) =>
							h('li', { 'data-footer': s.key }, `more in ${s.label}`),
					}
				: {}),
		},
		global: {
			plugins: [createTestI18n()],
			components: { PostboxThreadListSkeleton, PostboxEmptyState },
			stubs: { Icon: { props: ['name'], template: '<span />' }, UiSkeleton: true },
		},
	});
}

const rowIds = (w: ReturnType<typeof mountList>) =>
	w.findAll('[data-row]').map((el) => el.attributes('data-row'));

describe('PostboxSectionedThreadList', () => {
	it('drops collapsed sections out of the keyboard order', async () => {
		const activated: string[] = [];
		const w = mountList({
			sections: [
				section('a', items('a', 2)),
				section('b', items('b', 2)),
				section('c', items('c', 1)),
			],
			collapsed: { b: true },
			onActivate: (item) => activated.push(item._id),
		});
		const list = w.get('[role="listbox"]');
		const seen: Array<string | undefined> = [];
		for (let i = 0; i < 4; i++) {
			await list.trigger('keydown', { key: 'j' });
			seen.push(list.attributes('aria-activedescendant'));
		}
		// a-0, a-1, then straight to c-0: section b's rows are skipped. The
		// fourth press clamps on the last visible row.
		expect(seen).toEqual(['row-a-0', 'row-a-1', 'row-c-0', 'row-c-0']);
		expect(w.get('[data-row="c-0"]').attributes('aria-selected')).toBe('true');
		expect(rowIds(w)).not.toContain('b-0');

		await list.trigger('keydown', { key: 'Enter' });
		expect(activated).toEqual(['c-0']);
	});

	it('mounts every row at the threshold and only a window above it', () => {
		const atThreshold = mountList({
			sections: [section('a', items('a', POSTBOX_VIRTUAL_THRESHOLD))],
		});
		expect(rowIds(atThreshold)).toHaveLength(POSTBOX_VIRTUAL_THRESHOLD);
		expect(atThreshold.find('.pbx-virtual-row').exists()).toBe(false);

		const large = POSTBOX_VIRTUAL_THRESHOLD + 50;
		const above = mountList({
			sections: [section('a', items('a', large / 2)), section('b', items('b', large / 2))],
		});
		const mounted = rowIds(above);
		expect(mounted.length).toBeGreaterThan(0);
		expect(mounted.length).toBeLessThan(large);
		expect(above.findAll('li.pbx-virtual-row')).toHaveLength(mounted.length);
		expect(above.findAll('li.sticky.pbx-section-header')).toHaveLength(2);
	});

	it('counts only expanded sections toward the threshold', () => {
		const w = mountList({
			sections: [section('a', items('a', 60)), section('b', items('b', 60))],
			collapsed: { b: true },
		});
		expect(rowIds(w)).toHaveLength(60);
		expect(w.find('.pbx-virtual-row').exists()).toBe(false);
	});

	it('renders the footer slot once per expanded section', () => {
		const w = mountList(
			{
				sections: [
					section('a', items('a', 1)),
					section('b', items('b', 1)),
					section('c', items('c', 1)),
				],
				collapsed: { b: true },
			},
			true
		);
		expect(w.findAll('[data-footer]').map((el) => el.attributes('data-footer'))).toEqual([
			'a',
			'c',
		]);
		// Inside the listbox, right after its own section's rows.
		const a = w.get('[data-footer="a"]');
		expect(a.element.parentElement?.getAttribute('role')).toBe('listbox');
		expect(
			a.element.previousElementSibling?.querySelector('[data-row]')?.getAttribute('data-row')
		).toBe('a-0');
	});

	it('shows the unread badge, its capped text, and hides it at 0', () => {
		const w = mountList({
			sections: [
				section('a', items('a', 1), { headerBadge: { count: 3 } }),
				section('b', items('b', 1), { headerBadge: { count: 0 } }),
				section('c', items('c', 1), { headerBadge: { count: 99, text: '99+' } }),
				section('d', items('d', 1)),
			],
		});
		const badges = w.findAll('[data-testid="section-unread"]').map((el) => el.text());
		expect(badges).toEqual(['3', '99+']);
	});

	it('emits toggle with the section key from its header', async () => {
		const w = mountList({ sections: [section('a', items('a', 1))] });
		const header = w.get('li.sticky button');
		expect(header.attributes('aria-expanded')).toBe('true');
		await header.trigger('click');
		expect(w.emitted('toggle')).toEqual([['a']]);
	});

	it('offers whole-list paging only when hasMore is set', async () => {
		const without = mountList({ sections: [section('a', items('a', 1))] });
		expect(without.text()).not.toContain('Load more');

		const withMore = mountList({ sections: [section('a', items('a', 1))], hasMore: true });
		const button = withMore.findAll('button').find((b) => b.text() === 'Load more');
		expect(button).toBeDefined();
		await button!.trigger('click');
		expect(withMore.emitted('load-more')).toHaveLength(1);
	});

	it('shows the empty state when there are no sections', () => {
		const w = mountList({ sections: [] });
		expect(w.find('[role="listbox"]').exists()).toBe(false);
		expect(w.text()).toContain('All clear');
	});
});
