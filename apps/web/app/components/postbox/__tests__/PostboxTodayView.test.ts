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
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref, computed, nextTick, reactive } from 'vue';

import PostboxTodayView from '../PostboxTodayView.vue';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';

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
	items: ref<ReplyQueueItem[]>([]),
	count: computed(() => queue.items.value.length),
	isLoading: ref(false),
};
const threads = ref<{ threads: Array<Record<string, unknown>> } | undefined>({ threads: [] });
// Reactive route so deep-link tests can arm the For-you scroll at mount and the
// component's `route.hash` watch fires when the hash is re-set (a pill re-click).
const routeState = reactive({ hash: '', query: {} as Record<string, unknown> });
// The component strips the consumed hash via router.replace; mirror that onto
// the route so a subsequent re-click (hash re-set) actually re-arms the flag.
const routerReplace = vi.fn((loc: { hash?: string }) => {
	routeState.hash = loc.hash ?? '';
});

beforeAll(() => {
	vi.stubGlobal('usePostboxThreads', () => feed);
	vi.stubGlobal('usePostboxReplyQueue', () => queue);
	vi.stubGlobal('useConvexQuery', () => ({ data: threads, isLoading: ref(false) }));
	vi.stubGlobal('useRoute', () => routeState);
	vi.stubGlobal('useRouter', () => ({ replace: routerReplace }));
});

/** A complete ReplyQueueItem so rendering the For-you strip never trips on a
 * missing field (e.g. replyQueueHeadline reads `subject`). */
function queueItem(id: string, overrides: Partial<ReplyQueueItem> = {}): ReplyQueueItem {
	return {
		threadId: `t-${id}`,
		messageId: id,
		urgency: 'high',
		detectedAt: 1,
		source: 'heuristic',
		fromAddress: 'a@example.com',
		fromName: 'Boss',
		subject: 'Need the deck',
		snippet: 'Can you send it today?',
		receivedAt: Date.now(),
		...overrides,
	};
}

const iconStub = { props: ['name'], template: '<span class="icon" :data-name="name" />' };
const nuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };
const threadListStub = {
	props: {
		messages: { type: Array, default: () => [] },
		loading: { type: Boolean, default: false },
		folderRole: { type: String, default: undefined },
		hasMore: { type: Boolean, default: false },
		mailboxId: { type: String, default: undefined },
		selectable: { type: Boolean, default: false },
		activeMessageId: { type: String, default: undefined },
	},
	emits: ['select', 'load-more'],
	template:
		'<div class="thread-list" :data-count="messages.length" :data-selectable="selectable" :data-active="activeMessageId ?? \'\'" />',
};
const overlayStub = {
	props: ['message', 'advanceIds'],
	emits: ['close', 'open'],
	template: '<div class="reader-overlay" :data-id="message._id" />',
};
const skeletonStub = { template: '<div class="skeleton" />' };
// The Daily Brief card owns its own Convex wiring — covered by its own tests.
const dailyBriefStub = { props: ['mailboxId'], template: '<div class="daily-brief" />' };

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

// Unmount every wrapper between tests: the reactive `routeState` is shared, so a
// component left mounted would keep an active `route.hash` watcher and re-scroll
// (bumping the scroll spy) when a later test re-sets the hash.
const mountedWrappers: VueWrapper[] = [];
afterEach(() => {
	for (const w of mountedWrappers) w.unmount();
	mountedWrappers.length = 0;
});

function mountView(extraProps: Record<string, unknown> = {}) {
	const wrapper = mount(PostboxTodayView, {
		props: { mailboxId: 'mbx-1' as never, ...extraProps },
		global: {
			components: {
				Icon: iconStub,
				NuxtLink: nuxtLinkStub,
				PostboxDailyBrief: dailyBriefStub,
				PostboxThreadList: threadListStub,
				PostboxThreadListSkeleton: skeletonStub,
				PostboxTodayReaderOverlay: overlayStub,
			},
			// Render Transition content synchronously so v-if swaps (overlay
			// open/close, Show past) can be asserted without racing rAF timing.
			stubs: { transition: true },
		},
	});
	mountedWrappers.push(wrapper);
	return wrapper;
}

describe('PostboxTodayView', () => {
	it('renders header, For you, Today and Show past mails in order', () => {
		feed.messages.value = [
			todayMsg('m-today'),
			todayMsg('m-old', { receivedAt: Date.now() - 8 * 86_400_000, flagSeen: true }),
		];
		queue.items.value = [queueItem('q1', { threadId: 't1', fromAddress: 'boss@example.com' })];
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

	it('opens a selected row in the centered overlay, keeping the list mounted', async () => {
		feed.messages.value = [todayMsg('m-a'), todayMsg('m-b')];
		queue.items.value = [];
		threads.value = { threads: [] };
		const w = mountView();
		// Rows open in place (no navigation) — the list is selectable.
		const list = w.findComponent(threadListStub);
		expect(list.attributes('data-selectable')).toBe('true');
		expect(w.find('.reader-overlay').exists()).toBe(false);

		list.vm.$emit('select', 'm-a');
		await nextTick();
		expect(w.find('.reader-overlay').attributes('data-id')).toBe('m-a');
		// The column stays mounted underneath (scroll + selection preserved)
		// and the row reads as active.
		expect(w.find('.thread-list').exists()).toBe(true);
		expect(w.find('.thread-list').attributes('data-active')).toBe('m-a');

		// j/k advance: the overlay swaps the thread in place via `open`.
		const overlay = w.findComponent(overlayStub);
		expect(overlay.props('advanceIds')).toEqual(['m-a', 'm-b']);
		overlay.vm.$emit('open', 'm-b');
		await nextTick();
		expect(w.find('.reader-overlay').attributes('data-id')).toBe('m-b');
		expect(w.emitted('reader-closed')).toBeUndefined();

		// Esc/scrim close: back to the intact list; the host is notified so a
		// deep-linked route can settle back on the inbox URL.
		w.findComponent(overlayStub).vm.$emit('close');
		await nextTick();
		expect(w.find('.reader-overlay').exists()).toBe(false);
		expect(w.find('.thread-list').exists()).toBe(true);
		expect(w.emitted('reader-closed')).toHaveLength(1);
	});

	it('consumes the For-you deep link once and re-scrolls only when re-clicked', async () => {
		const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
		routeState.hash = '#postbox-for-you';
		routerReplace.mockClear();
		feed.messages.value = [];
		threads.value = { threads: [] };
		queue.items.value = [queueItem('q1')];
		try {
			const w = mountView();
			// The section mounts once the queue resolves → exactly one deep-link scroll.
			await nextTick();
			await nextTick();
			expect(w.find('#postbox-for-you').exists()).toBe(true);
			expect(scrollSpy).toHaveBeenCalledTimes(1);
			// The consumed fragment is stripped so a re-click can re-arm the flag.
			expect(routerReplace).toHaveBeenCalledWith(expect.objectContaining({ hash: '' }));

			// A live reply-queue update (count 1 → 2) must NOT yank the viewport back.
			queue.items.value = [...queue.items.value, queueItem('q2', { fromAddress: 'b@example.com' })];
			await nextTick();
			await nextTick();
			expect(scrollSpy).toHaveBeenCalledTimes(1);

			// Re-clicking the titlebar pill re-sets the hash → the flag re-arms and
			// the section scrolls into view a second time.
			routeState.hash = '#postbox-for-you';
			await nextTick();
			await nextTick();
			expect(scrollSpy).toHaveBeenCalledTimes(2);
		} finally {
			routeState.hash = '';
			scrollSpy.mockRestore();
		}
	});

	it('seeds the overlay from a deep-linked message id', () => {
		feed.messages.value = [todayMsg('m-deep')];
		queue.items.value = [];
		threads.value = { threads: [] };
		const w = mountView({ initialMessageId: 'm-deep' });
		expect(w.find('.reader-overlay').attributes('data-id')).toBe('m-deep');
	});
});
