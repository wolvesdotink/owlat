// @vitest-environment happy-dom
/**
 * The Answer queue on Answer mode (plan §07):
 *
 *   - opening the queue opens Answer mode on its first item (Postbox items on
 *     `m/<messageId>`, team drafts on `t/<threadId>`), with replaces only;
 *   - browsing (`back` / `next`) moves between items without finishing any;
 *   - an item is done ONLY when its reply is sent (or it is archived, snoozed
 *     or marked done): a send finishes the current item and opens the next,
 *     and an item without Answer mode (a chat mention) shows on the queue page;
 *   - `?in=` / `?queue=` filter the queue, `?focus=` starts on an item;
 *   - an Answer mode page opened outside the queue never reads it, and a send
 *     there leaves as it always did.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, reactive, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { AnswerItem } from '~/composables/useAnswerQueue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const items = ref<AnswerItem[]>([]);
const queueEnabled: Array<() => boolean> = [];
vi.mock('~/composables/useAnswerQueue', () => ({
	useAnswerQueue: (opts: { enabled?: () => boolean } = {}) => {
		if (opts.enabled) queueEnabled.push(opts.enabled);
		return {
			items: computed(() => (opts.enabled?.() === false ? [] : items.value)),
			isLoading: ref(false),
		};
	},
}));

const { createAnswerQueueSession } = await import('../useAnswerQueueSession');

const route = reactive({
	path: '/dashboard/answer',
	fullPath: '/dashboard/answer',
	query: {} as Record<string, string>,
	params: {} as Record<string, string>,
});
const navigateTo = vi.fn();
const markSeen = vi.fn();
let state: Map<string, ReturnType<typeof ref>>;

/** Point the fake route at `href` (what a real replace would do). */
function go(href: string) {
	const url = new URL(href, 'https://owlat.example');
	route.path = url.pathname;
	route.fullPath = url.pathname + url.search;
	route.query = Object.fromEntries(url.searchParams.entries());
}

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => route,
		useRouter: () => ({ back: vi.fn(), currentRoute: computed(() => route) }),
		navigateTo,
		useState: (key: string, init: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init()));
			return state.get(key);
		},
		useBackendOperation: () => ({ run: markSeen, isLoading: ref(false) }),
	});
});

beforeEach(() => {
	state = new Map();
	items.value = [];
	queueEnabled.length = 0;
	navigateTo.mockReset();
	navigateTo.mockImplementation((href: string) => go(href));
	markSeen.mockReset();
	go('/dashboard/answer');
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function mail(id: string, over: Record<string, unknown> = {}): AnswerItem {
	return {
		id: `mail:thr_${id}`,
		source: 'mail',
		at: 1,
		mailboxId: 'mbx_1' as never,
		inbox: null,
		row: {
			kind: 'needs_reply',
			threadId: `thr_${id}`,
			messageId: `msg_${id}`,
			urgency: 'normal',
			detectedAt: 1,
			source: 'llm',
			fromAddress: `${id}@example.com`,
			subject: `Mail ${id}`,
			snippet: '',
			receivedAt: 1,
			...over,
		},
	} as AnswerItem;
}

function team(id: string): AnswerItem {
	return {
		id: `team:in_${id}`,
		source: 'team',
		at: 1,
		entry: {
			message: { _id: `in_${id}`, draftResponse: 'Draft', from: `${id}@example.org`, subject: id },
			thread: { _id: `ct_${id}` },
			contact: null,
		},
	} as unknown as AnswerItem;
}

function mention(id: string): AnswerItem {
	return {
		id: `mention:${id}`,
		source: 'mention',
		at: 1,
		mention: { _id: id, roomId: 'room_1', roomName: 'general', messagePreview: 'hi' },
	} as unknown as AnswerItem;
}

function mountSession() {
	let session!: ReturnType<typeof createAnswerQueueSession>;
	wrapper = mount(
		defineComponent({
			setup() {
				session = createAnswerQueueSession();
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	return session;
}

describe('the Answer queue opens Answer mode', () => {
	it('opens the first item in Answer mode, replacing the queue page', async () => {
		items.value = [mail('a'), team('b'), mention('c')];
		mountSession();
		await nextTick();
		// Draft reviews come before plain replies.
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/t/ct_b?message=in_b&queue=all', {
			replace: true,
		});
	});

	it('a send finishes the item and opens the next; the last Answer mode item hands over to a card', async () => {
		items.value = [mail('a'), team('b'), mention('c')];
		const session = mountSession();
		await nextTick();
		expect(session.isCurrentRoute.value).toBe(true);

		expect(session.handleSent('sent')).toBe(true);
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/answer/m/msg_a?queue=all', {
			replace: true,
		});
		expect(session.flow.summary.value).not.toBe('');

		expect(session.handleSent()).toBe(true);
		// The mention has no Answer mode: back to the queue page, which shows its card.
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/answer', { replace: true });
		expect(session.flow.current.value?.id).toBe('mention:c');
	});

	it('browsing moves between items without finishing any', async () => {
		items.value = [mail('a'), mail('b')];
		const session = mountSession();
		await nextTick();
		expect(route.path).toBe('/dashboard/answer/m/msg_a');

		session.next();
		expect(route.path).toBe('/dashboard/answer/m/msg_b');
		expect(session.flow.position.value).toBe(2);
		session.back();
		expect(route.path).toBe('/dashboard/answer/m/msg_a');
		expect(session.flow.canUndo.value).toBe(false);
		expect(session.flow.summary.value).toBe('');
	});

	it('finishing the last item shows the done state on the queue page and moves the watermark', async () => {
		items.value = [mail('a')];
		const session = mountSession();
		await nextTick();
		session.complete('archived');
		await nextTick();
		expect(route.fullPath).toBe('/dashboard/answer');
		expect(session.flow.isComplete.value).toBe(true);
		expect(markSeen).toHaveBeenCalledTimes(1);
	});

	it('undo brings the finished item back in Answer mode', async () => {
		items.value = [mail('a'), mail('b')];
		const session = mountSession();
		await nextTick();
		const inverse = vi.fn();
		session.complete('archived', inverse);
		expect(route.path).toBe('/dashboard/answer/m/msg_b');
		await session.undo();
		expect(route.path).toBe('/dashboard/answer/m/msg_a');
		expect(inverse).toHaveBeenCalledTimes(1);
	});

	it('keeps a follow-up reminder as a card on the queue page', async () => {
		items.value = [mail('a', { kind: 'followup' })];
		const session = mountSession();
		await nextTick();
		expect(navigateTo).not.toHaveBeenCalled();
		expect(session.flow.current.value?.id).toBe('mail:thr_a');

		// Its Reply opens Answer mode, where the send finishes it.
		session.controlsFor(session.flow.current.value!).openAnswer();
		expect(route.path).toBe('/dashboard/answer/m/msg_a');
		expect(session.isCurrentRoute.value).toBe(true);
		expect(session.handleSent()).toBe(true);
		expect(session.flow.isComplete.value).toBe(true);
	});
});

describe('filters and entry points', () => {
	it('narrows to the team inbox with ?in=team and carries the filter as ?queue=', async () => {
		go('/dashboard/answer?in=team');
		items.value = [mail('a'), team('b')];
		const session = mountSession();
		await nextTick();
		expect(session.flow.total.value).toBe(1);
		expect(route.fullPath).toBe('/dashboard/answer/t/ct_b?message=in_b&queue=team');
		expect(session.filter.value).toBe('team');
	});

	it('starts on ?focus=', async () => {
		go('/dashboard/answer?focus=mail:thr_b');
		items.value = [mail('a'), mail('b')];
		mountSession();
		await nextTick();
		expect(route.path).toBe('/dashboard/answer/m/msg_b');
	});

	it('a reload of an item in the queue resumes on it', async () => {
		go('/dashboard/answer/m/msg_b?queue=all');
		items.value = [mail('a'), mail('b')];
		const session = mountSession();
		await nextTick();
		expect(navigateTo).not.toHaveBeenCalled();
		expect(session.isCurrentRoute.value).toBe(true);
		expect(session.flow.position.value).toBe(2);
	});

	it('a reload of an item that left the queue stays put; a send there returns to the queue', async () => {
		go('/dashboard/answer/m/msg_gone?queue=all');
		items.value = [mail('a')];
		const session = mountSession();
		await nextTick();
		expect(navigateTo).not.toHaveBeenCalled();
		expect(session.isCurrentRoute.value).toBe(false);
		expect(session.handleSent()).toBe(true);
		expect(route.path).toBe('/dashboard/answer/m/msg_a');
		expect(session.flow.summary.value).toBe('');
	});

	it('an Answer mode page opened outside the queue never reads it', async () => {
		go('/dashboard/answer/m/msg_a');
		items.value = [mail('a')];
		const session = mountSession();
		await nextTick();
		expect(queueEnabled[0]?.()).toBe(false);
		expect(session.handleSent()).toBe(false);
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('leaving the queue returns to the page it was opened from', async () => {
		window.history.replaceState({ back: '/dashboard' }, '');
		items.value = [mail('a')];
		mountSession();
		await nextTick();
		expect(state.get('answer:return-to')?.value).toBe('/dashboard');
	});
});
