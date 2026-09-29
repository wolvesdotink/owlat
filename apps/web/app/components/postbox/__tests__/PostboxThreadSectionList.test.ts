// @vitest-environment happy-dom
/**
 * The split inbox over the shared sectioned shell: its header badge is the
 * server's unread count (the capped "N+" copy when the count is a floor), and
 * its paging stays per section, emitted with the section's key.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PostboxInboxSection } from '~/composables/postbox/usePostboxThreadSections';

import PostboxThreadSectionList from '../PostboxThreadSectionList.vue';
import PostboxSectionedThreadList from '../PostboxSectionedThreadList.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import { BASE_MESSAGE } from './spoofedSenderFixture';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable') }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
});

function message(id: string) {
	return { ...BASE_MESSAGE, _id: id as Id<'mailMessages'> };
}

const SECTIONS: PostboxInboxSection[] = [
	{
		name: 'Clients',
		key: 'Clients',
		messages: [message('m1')],
		unreadCount: 99,
		isUnreadCapped: true,
		canLoadMore: true,
	},
	{
		name: null,
		key: '',
		messages: [message('m2')],
		unreadCount: 0,
		isUnreadCapped: false,
		canLoadMore: false,
	},
];

function mountSections() {
	return mount(PostboxThreadSectionList, {
		props: { sections: SECTIONS, collapsed: {}, loading: false, folderRole: 'inbox' },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxSectionedThreadList, PostboxThreadListSkeleton, PostboxEmptyState },
			stubs: {
				Icon: { props: ['name'], template: '<span />' },
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				PostboxThreadRowBody: { template: '<span />' },
				UiSkeleton: true,
			},
		},
	});
}

describe('PostboxThreadSectionList', () => {
	it('shows the capped unread copy and hides a zero count', () => {
		const headers = mountSections().findAll('li.sticky');
		expect(headers[0]!.get('[data-testid="section-unread"]').text()).toBe('99+');
		expect(headers[0]!.text()).toContain('Clients');
		expect(headers[1]!.find('[data-testid="section-unread"]').exists()).toBe(false);
		expect(headers[1]!.text()).toContain('Everything else');
	});

	it('pages one section at a time, with no whole-list load more', async () => {
		const w = mountSections();
		const buttons = w.findAll('button').filter((b) => b.text().startsWith('Load more'));
		expect(buttons.map((b) => b.text())).toEqual(['Load more in Clients']);
		await buttons[0]!.trigger('click');
		expect(w.emitted('load-more')).toEqual([['Clients']]);
	});
});
