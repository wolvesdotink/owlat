// @vitest-environment happy-dom
/**
 * PostboxTodayView smoke — the focused inbox landing surface:
 *   - renders the sections in order (header → For you → Today → Show past)
 *   - "For you" strips come from the Reply Queue feed and route there
 *   - auto-filed roll-up line summarises categorized Today mail
 *   - inbox-zero shows the quiet "All clear" line
 *   - Browse button emits `browse`; "Show past mails (n)" expands inline.
 *
 * The component leans on Nuxt auto-imports; each composable is stubbed as a
 * global so the presentational structure can be asserted in isolation
 * (PostboxThreadList itself is covered by its own tests and stubbed here).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, computed } from 'vue';

import PostboxTodayView from '../PostboxTodayView.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

// Mutable fixtures the stubbed composables serve per test.
const feed = {
	messages: ref<Array<Record<string, unknown>>>([]),
	isLoading: ref(false),
	hasMore: ref(false),
	loadMore: vi.fn(),
};
const queue = {
	items: ref<Array<Record<string, unknown>>>([]),
	count: computed(() => queue.items.value.length),
	isLoading: ref(false),
};
const threads = ref<{ threads: Array<Record<string, unknown>> } | undefined>({ threads: [] });

beforeAll(() => {
	vi.stubGlobal('usePostboxThreads', () => feed);
	vi.stubGlobal('usePostboxReplyQueue', () => queue);
	vi.stubGlobal('useConvexQuery', () => ({ data: threads, isLoading: ref(false) }));
});

const iconStub = { props: ['name'], template: '<span class="icon" :data-name="name" />' };
const nuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };
const threadListStub = {
	props: ['messages', 'loading', 'folderRole', 'hasMore', 'mailboxId'],
	template: '<div class="thread-list" :data-count="messages.length" />',
};
const skeletonStub = { template: '<div class="skeleton" />' };

function todayMsg(id: string, overrides: Record<string, unknown> = {}) {
	return {
		_id: id,
		receivedAt: Date.now(),
		flagSeen: false,
		fromAddress: 'a@example.com',
		subject: 'S',
		snippet: 'x',
		flagFlagged: false,
		hasAttachments: false,
		...overrides,
	};
}

function mountView() {
	return mount(PostboxTodayView, {
		props: { mailboxId: 'mbx-1' as never },
		global: {
			components: {
				Icon: iconStub,
				NuxtLink: nuxtLinkStub,
				PostboxThreadList: threadListStub,
				PostboxThreadListSkeleton: skeletonStub,
			},
		},
	});
}

describe('PostboxTodayView', () => {
	it('renders header, For you, Today and Show past mails in order', () => {
		feed.messages.value = [
			todayMsg('m-today'),
			todayMsg('m-old', { receivedAt: Date.now() - 8 * 86_400_000, flagSeen: true }),
		];
		queue.items.value = [
			{
				threadId: 't1',
				messageId: 'q1',
				urgency: 'high',
				detectedAt: 1,
				source: 'heuristic',
				fromAddress: 'boss@example.com',
				fromName: 'Boss',
				subject: 'Need the deck',
				snippet: 'Can you send it today?',
				receivedAt: Date.now(),
			},
		];
		const w = mountView();
		const text = w.text();
		// Section order: header count → For you → Today → Show past.
		expect(text.indexOf('Inbox')).toBeLessThan(text.indexOf('For you (1)'));
		expect(text.indexOf('For you (1)')).toBeLessThan(text.indexOf('Today'));
		expect(text.indexOf('Today')).toBeLessThan(text.indexOf('Show past mails (1)'));
		// The strip carries the ask + one muted context line and routes to the queue.
		expect(text).toContain('Need the deck');
		expect(text).toContain('Boss — Can you send it today?');
		expect(text).toContain('Answer');
		expect(w.find('a[href="/dashboard/postbox/reply-queue"]').exists()).toBe(true);
		// Today rows go through the shared thread list (hover actions, j/k, triage).
		expect(w.find('.thread-list').attributes('data-count')).toBe('1');
	});

	it('rolls up auto-filed mail into one quiet line and emits view-auto-filed', async () => {
		feed.messages.value = [
			todayMsg('m-person', { threadId: 't-person' }),
			todayMsg('m-news', { threadId: 't-news' }),
		];
		queue.items.value = [];
		threads.value = {
			threads: [
				{ _id: 't-person', category: { label: 'person' } },
				{ _id: 't-news', category: { label: 'newsletter' } },
			],
		};
		const w = mountView();
		expect(w.text()).toContain('1 newsletter auto-filed');
		expect(w.find('.thread-list').attributes('data-count')).toBe('1');
		const viewButton = w.findAll('button').find((b) => b.text() === 'view');
		expect(viewButton).toBeTruthy();
		await viewButton!.trigger('click');
		expect(w.emitted('view-auto-filed')).toBeTruthy();
	});

	it('shows the quiet All clear line at inbox zero and no For you section', () => {
		feed.messages.value = [];
		queue.items.value = [];
		threads.value = { threads: [] };
		const w = mountView();
		expect(w.text()).toContain('All clear');
		expect(w.text()).not.toContain('For you');
		expect(w.text()).not.toContain('Show past mails');
	});

	it('emits browse from the header button and expands past mail inline', async () => {
		feed.messages.value = [
			todayMsg('m-old-1', { receivedAt: Date.now() - 8 * 86_400_000, flagSeen: true }),
			todayMsg('m-old-2', { receivedAt: Date.now() - 9 * 86_400_000, flagSeen: true }),
		];
		queue.items.value = [];
		threads.value = { threads: [] };
		const w = mountView();
		await w.find('button[aria-keyshortcuts="b"]').trigger('click');
		expect(w.emitted('browse')).toBeTruthy();

		expect(w.find('.thread-list').exists()).toBe(false);
		const showPast = w.findAll('button').find((b) => b.text().includes('Show past mails (2)'));
		expect(showPast).toBeTruthy();
		await showPast!.trigger('click');
		expect(w.find('.thread-list').attributes('data-count')).toBe('2');
		expect(w.text()).toContain('Past');
	});
});
