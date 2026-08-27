// @vitest-environment happy-dom
/**
 * The list header's sort control: it names the order the list is IN, offers the
 * other one as its accessible name, and asks the layout to flip — in every
 * folder, not just the inbox (a backlog is cleared oldest-first wherever it
 * sits).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxListHeader from '../PostboxListHeader.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountHeader(props: { folderRole?: string; sortOrder?: string } = {}) {
	return mount(PostboxListHeader, {
		props: {
			folderName: 'Inbox',
			folderRole: props.folderRole ?? 'inbox',
			sortOrder: props.sortOrder,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				Icon: { props: ['name'], template: '<span />' },
				UiSegmentedControl: { props: ['options', 'modelValue'], template: '<div />' },
			},
		},
	});
}

const sortButton = (w: ReturnType<typeof mountHeader>) =>
	w.findAll('button').find((b) => (b.attributes('aria-label') ?? '').startsWith('Sort by'));

describe('PostboxListHeader sort toggle', () => {
	it('shows newest-first and offers oldest when no order is stored', () => {
		const w = mountHeader();
		const button = sortButton(w);
		expect(button?.text()).toBe('Newest first');
		expect(button?.attributes('aria-label')).toBe('Sort by oldest first');
	});

	it('shows oldest-first and offers newest once the order is flipped', () => {
		const w = mountHeader({ sortOrder: 'oldest' });
		const button = sortButton(w);
		expect(button?.text()).toBe('Oldest first');
		expect(button?.attributes('aria-label')).toBe('Sort by newest first');
	});

	it('asks the layout to flip the order', async () => {
		const w = mountHeader();
		await sortButton(w)?.trigger('click');
		expect(w.emitted('toggle-sort')).toHaveLength(1);
	});

	it('offers the control in a non-inbox folder too', () => {
		const w = mountHeader({ folderRole: 'archive' });
		expect(sortButton(w)).toBeDefined();
	});
});
