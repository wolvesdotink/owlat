/**
 * PostboxThreadRow — pinning from the row.
 *
 * The row's context menu offers Pin / Unpin by the thread's state and hands the
 * verb to the list (`toggle-pin`), which runs the one pin operation; the row
 * body marks a pinned conversation with its own icon, apart from the star.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadRow, { type PostboxThreadRowMessage } from '../PostboxThreadRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import { BASE_MESSAGE } from './spoofedSenderFixture';
import { PinIcon } from '@coolicons/vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

type MenuItem = { id: string; label: string; icon: string; run: () => void };
const contextMenuStub = {
	name: 'ContextMenuStub',
	props: ['items'],
	template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
};

function mountRow(msg: Partial<PostboxThreadRowMessage>) {
	return mount(PostboxThreadRow, {
		props: {
			msg: { ...BASE_MESSAGE, ...msg },
			folderRole: 'inbox',
			virtualize: false,
			selected: false,
			focused: false,
			active: false,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxRowCore,
				PostboxThreadRowBody,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiContextMenu: contextMenuStub,
				UiAvatar: { template: '<span />' },
				PostboxThreadRowFollowUp: { template: '<span />' },
				PostboxSwipeTrack: { template: '<div><slot /></div>' },
			},
			mocks: { resolveComponent: () => 'a' },
		},
	});
}

const pinItem = (w: ReturnType<typeof mountRow>) =>
	(w.findComponent(contextMenuStub).props('items') as MenuItem[]).find((i) => i.id === 'pin');

describe('PostboxThreadRow pin', () => {
	it('offers Pin on an unpinned row and hands the verb to the list', () => {
		const w = mountRow({});
		const item = pinItem(w)!;
		expect(item.label).toBe('Pin conversation');
		expect(item.icon).toBe(PinIcon);
		item.run();
		expect(w.emitted('toggle-pin')).toHaveLength(1);
		expect(w.find('[data-testid="row-pinned-chip"]').exists()).toBe(false);
	});

	it('offers Unpin on a pinned row and shows the pin on an unstarred row', () => {
		const w = mountRow({ pinnedAt: 1, flagFlagged: false });
		expect(pinItem(w)!.label).toBe('Unpin conversation');
		const chip = w.find('[data-testid="row-pinned-chip"]');
		expect(chip.attributes('aria-label')).toBe('Pinned to the top of the Inbox');
		expect(w.findComponent(PinIcon).attributes('data-testid')).toBe('row-pinned-chip');
	});
});
