/**
 * A reply marked done moves on through the list it was opened from, whichever
 * renderer that list was: conversations, categories, the split inbox or the
 * bundled feed, each in the order it shows its rows (collapsed sections and
 * shut bundles left out). The flat list's side is in
 * PostboxThreadListAnswerMode.test.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PostboxFeedEntry } from '~/utils/postboxBundles';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import type { PostboxThreadRowMessage } from '../PostboxThreadRow.vue';
import { takeListPlace, useAnswerModeNav } from '../../../composables/useAnswerMode';

import PostboxThreadGroupList from '../PostboxThreadGroupList.vue';
import PostboxThreadCategoryList from '../PostboxThreadCategoryList.vue';
import PostboxThreadSectionList from '../PostboxThreadSectionList.vue';
import PostboxThreadBundleList from '../PostboxThreadBundleList.vue';
import PostboxSectionedThreadList from '../PostboxSectionedThreadList.vue';
import PostboxConversationRow from '../PostboxConversationRow.vue';
import PostboxThreadListSkeleton from '../PostboxThreadListSkeleton.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import { BASE_MESSAGE } from './spoofedSenderFixture';

const navigate = vi.fn();
const state = new Map<string, Ref<unknown>>();
const currentRoute = ref({
	path: '/dashboard/postbox/inbox',
	fullPath: '/dashboard/postbox/inbox',
});

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePostboxSettings', () => ({
		density: ref('comfortable'),
		autoSummarize: ref(false),
	}));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useState', (key: string, init?: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init ? init() : null));
		return state.get(key);
	});
	vi.stubGlobal('useRouter', () => ({ currentRoute, back: vi.fn() }));
});

beforeEach(() => {
	navigate.mockClear();
	state.clear();
	currentRoute.value = { path: '/dashboard/postbox/inbox', fullPath: '/dashboard/postbox/inbox' };
	takeListPlace('__drain__');
});

const globalOptions = {
	plugins: [createTestI18n()],
	components: {
		PostboxSectionedThreadList,
		PostboxConversationRow,
		PostboxThreadListSkeleton,
		PostboxEmptyState,
	},
	stubs: {
		Icon: { props: ['name'], template: '<span />' },
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		PostboxThreadRowBody: { template: '<span />' },
		UiModal: { template: '<span />' },
		UiSkeleton: { template: '<span />' },
		UiButton: true,
	},
};

function thread(id: string) {
	return {
		_id: `thread-${id}`,
		latestMessageId: `msg-${id}`,
		latestFromAddress: `${id}@example.com`,
		latestSubject: `Subject ${id}`,
		latestSnippet: `Snippet ${id}`,
		lastMessageAt: 1_700_000_000_000,
		messageCount: 1,
		unreadCount: 0,
		hasFlagged: false,
		hasAttachments: false,
	};
}

function message(id: string, threadId: string): PostboxThreadRowMessage {
	return { ...BASE_MESSAGE, _id: `msg-${id}` as Id<'mailMessages'>, threadId };
}

/**
 * Reply to `messageId` from the mounted list (the list unmounts as Answer
 * mode opens), mark it done, and return where that leaves.
 */
function replyDone(
	list: VueWrapper,
	done: { messageId: string; threadId: string },
	mode: PostboxAutoAdvanceMode
) {
	const nav = useAnswerModeNav();
	void nav.open(done.messageId);
	list.unmount();
	currentRoute.value = {
		path: `/dashboard/answer/m/${done.messageId}`,
		fullPath: `/dashboard/answer/m/${done.messageId}`,
	};
	navigate.mockClear();
	nav.leaveDone(done, mode);
	return navigate.mock.calls.at(-1)?.[0];
}

describe('a reply marked done, opened from a grouped list', () => {
	it('moves on to the next conversation of the conversation view', () => {
		const list = mount(PostboxThreadGroupList, {
			props: { threads: ['a', 'b', 'c'].map(thread), loading: false, folderRole: 'inbox' },
			global: globalOptions,
		});
		expect(replyDone(list, { messageId: 'msg-a', threadId: 'thread-a' }, 'next')).toBe(
			'/dashboard/postbox/inbox/msg-b'
		);
	});

	it('finds an older message by the conversation open beside the list', () => {
		const list = mount(PostboxThreadGroupList, {
			props: {
				threads: ['a', 'b', 'c'].map(thread),
				loading: false,
				folderRole: 'inbox',
				activeMessageId: 'msg-c',
			},
			global: globalOptions,
		});
		// msg-old is not a row, but its conversation is.
		expect(replyDone(list, { messageId: 'msg-old', threadId: 'thread-c' }, 'previous')).toBe(
			'/dashboard/postbox/inbox/msg-b'
		);
	});

	it('walks the categories as shown, past a collapsed category', () => {
		const list = mount(PostboxThreadCategoryList, {
			props: {
				sections: [
					{ key: 'person', label: 'People', icon: 'lucide:user', threads: [thread('a')] },
					{ key: 'newsletter', label: 'News', icon: 'lucide:news', threads: [thread('b')] },
					{ key: 'other', label: 'Other', icon: 'lucide:inbox', threads: [thread('c')] },
				],
				collapsed: { newsletter: true },
				loading: false,
				folderRole: 'inbox',
			},
			global: globalOptions,
		});
		expect(replyDone(list, { messageId: 'msg-a', threadId: 'thread-a' }, 'next')).toBe(
			'/dashboard/postbox/inbox/msg-c'
		);
	});

	it('walks the split inbox as shown, past a collapsed section and the same conversation', () => {
		const section = (key: string, messages: PostboxThreadRowMessage[]) => ({
			name: key,
			key,
			messages,
			unreadCount: 0,
			isUnreadCapped: false,
			canLoadMore: false,
		});
		const list = mount(PostboxThreadSectionList, {
			props: {
				sections: [
					section('Clients', [message('a1', 'thread-a'), message('a2', 'thread-a')]),
					section('Shut', [message('b', 'thread-b')]),
					section('Team', [message('c', 'thread-c')]),
				],
				collapsed: { Shut: true },
				loading: false,
				folderRole: 'inbox',
			},
			global: globalOptions,
		});
		expect(replyDone(list, { messageId: 'msg-a1', threadId: 'thread-a' }, 'next')).toBe(
			'/dashboard/postbox/inbox/msg-c'
		);
	});

	it('walks the bundled feed as shown, past a shut bundle', () => {
		const entries: Array<PostboxFeedEntry<PostboxThreadRowMessage>> = [
			{ kind: 'message', message: message('a', 'thread-a') },
			{
				kind: 'bundle',
				id: 'b-shut',
				category: 'newsletter',
				messages: [message('b', 'thread-b')],
				count: 1,
				latestFrom: 'Northwind Digest',
				unreadCount: 0,
			},
			{ kind: 'message', message: message('c', 'thread-c') },
		];
		const list = mount(PostboxThreadBundleList, {
			props: { entries, expanded: {}, loading: false, folderRole: 'inbox' },
			global: globalOptions,
		});
		expect(replyDone(list, { messageId: 'msg-a', threadId: 'thread-a' }, 'next')).toBe(
			'/dashboard/postbox/inbox/msg-c'
		);
	});

	it('goes back to the list when asked to', () => {
		const list = mount(PostboxThreadGroupList, {
			props: { threads: ['a', 'b'].map(thread), loading: false, folderRole: 'inbox' },
			global: globalOptions,
		});
		expect(replyDone(list, { messageId: 'msg-a', threadId: 'thread-a' }, 'back-to-list')).toBe(
			'/dashboard/postbox/inbox'
		);
	});
});
