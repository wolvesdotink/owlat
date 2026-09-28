// @vitest-environment happy-dom
/**
 * The categories view renders the shared conversation row, so a conversation
 * with unread mail carries the same unread-aware accessible name the
 * conversation view gives it. It used to render its own copy of the row
 * without the label, and a screen reader heard the subject with no count.
 *
 * Its section headers count unread mail, like the split inbox, not the number
 * of conversations: a total would read as a size.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxThreadCategoryList from '../PostboxThreadCategoryList.vue';
import PostboxThreadGroupList from '../PostboxThreadGroupList.vue';
import PostboxSectionedThreadList from '../PostboxSectionedThreadList.vue';
import PostboxConversationRow from '../PostboxConversationRow.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxSettings', () => ({ density: ref('comfortable') }));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', vi.fn());
});

function thread(id: string, unreadCount: number, latestSubject = `Subject ${id}`) {
	return {
		_id: id,
		latestMessageId: `msg-${id}`,
		latestFromAddress: `${id}@example.com`,
		latestSubject,
		latestSnippet: `Snippet ${id}`,
		lastMessageAt: 1_700_000_000_000,
		messageCount: 2,
		unreadCount,
		hasFlagged: false,
		hasAttachments: false,
	};
}

const globalOptions = {
	plugins: [createTestI18n()],
	components: {
		PostboxSectionedThreadList,
		PostboxConversationRow,
		PostboxThreadListSkeleton,
		PostboxEmptyState,
	},
	mocks: { formatThreadTimestamp: () => '10:24' },
	stubs: {
		Icon: { props: ['name'], template: '<span />' },
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		UiModal: { template: '<span />' },
		UiSkeleton: { template: '<span />' },
	},
};

const THREADS = [thread('t1', 3), thread('t2', 0), thread('t3', 1, '')];

function mountCategories() {
	return mount(PostboxThreadCategoryList, {
		props: {
			sections: [
				{
					key: 'person' as const,
					label: 'shared.postbox.usePostboxThreadCategories.sections.person',
					icon: 'lucide:user',
					threads: THREADS,
				},
				{
					key: 'newsletter' as const,
					label: 'shared.postbox.usePostboxThreadCategories.sections.newsletter',
					icon: 'lucide:newspaper',
					threads: [thread('t4', 0)],
				},
			],
			collapsed: {},
			loading: false,
			folderRole: 'inbox',
		},
		global: globalOptions,
	});
}

const labelOf = (w: ReturnType<typeof mountCategories>, id: string) =>
	w.get(`#postbox-cat-thread-${id}`).attributes('aria-label');

describe('PostboxThreadCategoryList', () => {
	it('names an unread conversation with its unread count', () => {
		const w = mountCategories();
		expect(labelOf(w, 't1')).toBe('Subject t1, 3 unread');
		expect(labelOf(w, 't3')).toBe('No subject, 1 unread');
		// A read row keeps its visible text as its name.
		expect(labelOf(w, 't2')).toBeUndefined();
	});

	it('gives a row the same accessible name the conversation view does', () => {
		const group = mount(PostboxThreadGroupList, {
			props: { threads: THREADS, loading: false, folderRole: 'inbox' },
			global: globalOptions,
		});
		const categories = mountCategories();
		for (const t of THREADS) {
			expect(labelOf(categories, t._id)).toBe(
				group.get(`#postbox-thread-${t._id}`).attributes('aria-label')
			);
		}
	});

	it('counts unread mail in the section header and hides a zero count', () => {
		const w = mountCategories();
		const headers = w.findAll('li.sticky');
		expect(headers).toHaveLength(2);
		expect(headers[0]!.get('[data-testid="section-unread"]').text()).toBe('4');
		expect(headers[1]!.find('[data-testid="section-unread"]').exists()).toBe(false);
	});

	it('keeps the recategorize action on every row', () => {
		const w = mountCategories();
		expect(w.findAll('button[aria-label="Recategorize as…"]')).toHaveLength(4);
	});
});
