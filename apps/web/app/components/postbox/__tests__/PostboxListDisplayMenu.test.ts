// @vitest-environment happy-dom
/**
 * The Display menu — the one place four persisted list preferences now live.
 *
 * The contract is that nothing was lost on the way in: all five view modes are
 * reachable (the segmented control they came from could not fit its own labels
 * and shipped a horizontal scroller for them), both sort orders, both
 * densities and all three reading-pane positions are offered, each group
 * reports which option is active, and a pick routes straight back out to the
 * layout that owns the setter.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PostboxListDisplayMenu from '../PostboxListDisplayMenu.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

/** The panel is `v-if`-ed in the real menu; render it open. */
const stubs = {
	PostboxOverflowMenu: {
		props: ['label', 'triggerText', 'icon', 'triggerClass'],
		template:
			'<div><button class="trigger" :aria-label="label">{{ triggerText }}</button><div role="menu"><slot :close="() => {}" /></div></div>',
	},
	Icon: { props: ['name'], template: '<span />' },
};

const VIEW_MODES = [
	{ value: 'flat', label: 'Flat' },
	{ value: 'conversations', label: 'Conversations' },
	{ value: 'categories', label: 'Categories' },
	{ value: 'bundled', label: 'Bundled' },
	{ value: 'sections', label: 'Sections' },
];

function mountMenu(props: Record<string, unknown> = {}) {
	return mount(PostboxListDisplayMenu, {
		props: {
			viewMode: 'flat',
			viewModeOptions: VIEW_MODES,
			sortOrder: 'newest',
			density: 'comfortable',
			readingPane: 'right',
			...props,
		},
		global: { plugins: [createTestI18n()], stubs },
	});
}

const radios = (w: ReturnType<typeof mountMenu>) => w.findAll('[role="menuitemradio"]');
const named = (w: ReturnType<typeof mountMenu>, text: string) =>
	radios(w).find((r) => r.text().trim() === text);

describe('PostboxListDisplayMenu', () => {
	it('names itself on the trigger — it is the only rendering of its contents', () => {
		const w = mountMenu();
		expect(w.find('.trigger').text()).toBe('Display');
		expect(w.find('.trigger').attributes('aria-label')).toBe('Display options');
	});

	it('offers every option of all four preferences', () => {
		const w = mountMenu();
		const labels = radios(w).map((r) => r.text().trim());
		// All five view modes, including the two the old control clipped.
		expect(labels).toEqual(
			expect.arrayContaining(['Flat', 'Conversations', 'Categories', 'Bundled', 'Sections'])
		);
		expect(labels).toEqual(expect.arrayContaining(['Newest first', 'Oldest first']));
		expect(labels).toEqual(expect.arrayContaining(['Comfortable', 'Compact']));
		expect(labels).toEqual(
			expect.arrayContaining([
				'Reader on the right (resizable)',
				'Reader below a wide list',
				'No reading pane — opening navigates',
			])
		);
	});

	it('marks exactly the active option in each group', () => {
		const w = mountMenu({ viewMode: 'bundled', sortOrder: 'oldest', density: 'compact' });
		const checked = radios(w)
			.filter((r) => r.attributes('aria-checked') === 'true')
			.map((r) => r.text().trim());
		expect(checked).toEqual([
			'Bundled',
			'Oldest first',
			'Compact',
			'Reader on the right (resizable)',
		]);
	});

	it('routes each pick back to the layout', async () => {
		const w = mountMenu();
		await named(w, 'Categories')!.trigger('click');
		await named(w, 'Oldest first')!.trigger('click');
		await named(w, 'Compact')!.trigger('click');
		await named(w, 'Reader below a wide list')!.trigger('click');

		expect(w.emitted('select-view-mode')).toEqual([['categories']]);
		expect(w.emitted('select-sort-order')).toEqual([['oldest']]);
		expect(w.emitted('select-density')).toEqual([['compact']]);
		expect(w.emitted('select-reading-pane')).toEqual([['bottom']]);
	});

	it('drops the view-mode group where there is no view mode to pick', () => {
		// Every folder but the inbox renders flat, so the group would be a lie.
		const w = mountMenu({ viewModeOptions: undefined });
		const labels = radios(w).map((r) => r.text().trim());
		expect(labels).not.toContain('Conversations');
		expect(labels).toContain('Newest first');
	});

	it('renders every label through the catalog', () => {
		expectFullyLocalized(mountMenu());
	});
});
