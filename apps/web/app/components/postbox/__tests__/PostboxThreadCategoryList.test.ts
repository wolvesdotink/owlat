/**
 * The categories view renders the shared conversation row, so a conversation
 * with unread mail carries the same unread-aware accessible name the
 * conversation view gives it: the row's own text, with a screen-reader-only
 * "N unread" beside the pill, and no aria-label hiding the sender.
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
import { NewspaperIcon, UserIcon } from '@coolicons/vue';

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
	stubs: {
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
					label: 'shared.mailCategory.person',
					icon: UserIcon,
					threads: THREADS,
				},
				{
					key: 'newsletter' as const,
					label: 'shared.mailCategory.newsletter',
					icon: NewspaperIcon,
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

const unreadOf = (w: ReturnType<typeof mountCategories>, id: string) =>
	w.get(`#postbox-cat-thread-${id}`).find('[data-testid="row-unread-count"]');
const labelOf = (w: ReturnType<typeof mountCategories>, id: string) => {
	const row = w.get(`#postbox-cat-thread-${id}`);
	return { aria: row.attributes('aria-label'), text: row.text() };
};

describe('PostboxThreadCategoryList', () => {
	it('names an unread conversation with its unread count, and keeps the sender in the name', () => {
		const w = mountCategories();
		expect(unreadOf(w, 't1').text()).toBe('3 unread');
		expect(unreadOf(w, 't3').text()).toBe('1 unread');
		expect(unreadOf(w, 't2').exists()).toBe(false);
		// The visible text stays the accessible name.
		expect(labelOf(w, 't1').aria).toBeUndefined();
		expect(labelOf(w, 't1').text).toContain('Subject t1');
	});

	it('gives a row the same accessible name the conversation view does', () => {
		const group = mount(PostboxThreadGroupList, {
			props: { threads: THREADS, loading: false, folderRole: 'inbox' },
			global: globalOptions,
		});
		const categories = mountCategories();
		for (const t of THREADS) {
			const row = group.get(`#postbox-thread-${t._id}`);
			expect(labelOf(categories, t._id)).toEqual({
				aria: row.attributes('aria-label'),
				text: row.text(),
			});
		}
	});

	it('counts unread mail in the section header and hides a zero count', () => {
		const w = mountCategories();
		const headers = w.findAll('li.sticky');
		expect(headers).toHaveLength(2);
		expect(headers[0]!.get('[data-testid="section-unread"]').text()).toBe('4');
		expect(headers[1]!.find('[data-testid="section-unread"]').exists()).toBe(false);
	});

	it('names the latest sender like the flat list, with the address in the tooltip', () => {
		const w = mount(PostboxThreadGroupList, {
			props: {
				threads: [
					{ ...thread('named', 0), latestFromName: 'Ben Ortiz' },
					{ ...thread('blank', 0), latestFromName: '  ' },
					thread('bare', 0),
				],
				loading: false,
				folderRole: 'inbox',
			},
			global: globalOptions,
		});
		const sender = (id: string) => w.get(`#postbox-thread-${id} [data-testid="row-sender"]`);
		expect(sender('named').text()).toContain('Ben Ortiz');
		expect(sender('named').text()).not.toContain('named@example.com');
		expect(sender('named').attributes('title')).toBe('named@example.com');
		// No usable name: the address stands in, as it does in the flat list.
		expect(sender('blank').text()).toContain('blank@example.com');
		expect(sender('bare').text()).toContain('bare@example.com');
		expect(sender('bare').attributes('title')).toBe('bare@example.com');
	});

	it('keeps the recategorize action on every row', () => {
		const w = mountCategories();
		expect(w.findAll('button[aria-label="Recategorize as…"]')).toHaveLength(4);
	});

	it('offers mark-read on a section header with unread mail, and says which category', async () => {
		const w = mountCategories();
		const headers = w.findAll('li.sticky');
		const button = headers[0]!.get('[data-testid="section-mark-read"]');
		expect(button.attributes('aria-label')).toBe('Mark People as read');
		expect(headers[1]!.find('[data-testid="section-mark-read"]').exists()).toBe(false);

		await button.trigger('click');

		expect(w.emitted('mark-read')).toEqual([['person']]);
		expect(w.emitted('toggle')).toBeUndefined();
	});
});
