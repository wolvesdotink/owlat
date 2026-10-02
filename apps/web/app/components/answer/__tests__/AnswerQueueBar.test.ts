// @vitest-environment happy-dom
/**
 * The Answer queue in Answer mode's top bar: "2 of 3 ‹ ›", `[` / `]` browse
 * without finishing anything, `e` archives a Postbox item and `h` snoozes it
 * (both finish the item and move on), and the bar is absent when the page is
 * not part of a queue. On a phone the menu is its icon alone, so the subject
 * keeps the room in the one-line bar.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AnswerQueueBar from '../AnswerQueueBar.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const current = ref<unknown>(null);
const isCurrentRoute = ref(true);
const active = ref(true);
const session = {
	engaged: ref(true),
	isCurrentRoute,
	filter: computed(() => 'all'),
	queue: { items: computed(() => []) },
	flow: {
		active,
		isComplete: ref(false),
		current,
		position: ref(2),
		total: ref(3),
		canGoBack: ref(true),
		canGoNext: ref(true),
	},
	back: vi.fn(),
	next: vi.fn(),
	complete: vi.fn(),
	goCurrent: vi.fn(),
	setFilter: vi.fn(),
};
let provided: typeof session | null = session;
vi.mock('~/composables/useAnswerQueueSession', () => ({
	useAnswerQueueSession: () => provided,
}));

const runs: Array<ReturnType<typeof vi.fn>> = [];
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useInboxes: () => ({ inboxes: ref([]) }),
		useBackendOperation: () => {
			const run = vi.fn(async () => ({ ok: true, result: { moved: [] } }));
			runs.push(run);
			return { run, isLoading: ref(false) };
		},
	});
});

enableAutoUnmount(afterEach);
beforeEach(() => {
	provided = session;
	active.value = true;
	isCurrentRoute.value = true;
	runs.length = 0;
	current.value = {
		id: 'mail:thr_1',
		source: 'mail',
		row: { kind: 'needs_reply', threadId: 'thr_1', messageId: 'msg_1' },
	};
	for (const fn of [session.back, session.next, session.complete, session.goCurrent]) {
		fn.mockClear();
	}
});

const snoozeStub = {
	name: 'PostboxSnoozeDialog',
	props: ['open'],
	emits: ['update:open', 'confirm'],
	template: '<div v-if="open" role="dialog" class="snooze" @click="$emit(\'confirm\', 42)" />',
};

function mountBar() {
	return mount(AnswerQueueBar, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				PostboxSnoozeDialog: snoozeStub,
				PostboxOverflowMenu: {
					props: ['triggerText'],
					template:
						'<div><span data-testid="menu-trigger-text">{{ triggerText }}</span><slot :close="() => {}" /></div>',
				},
			},
		},
	});
}

function setWidth(width: number) {
	window.matchMedia = ((query: string) => {
		const max = /max-width:\s*([\d.]+)px/.exec(query);
		const min = /min-width:\s*([\d.]+)px/.exec(query);
		const matches =
			(max ? width <= Number(max[1]) : true) && (min ? width >= Number(min[1]) : true);
		return {
			matches,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		} as unknown as MediaQueryList;
	}) as typeof window.matchMedia;
}

function press(key: string) {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
}

describe('AnswerQueueBar', () => {
	it('shows the position in the queue', () => {
		const wrapper = mountBar();
		expect(wrapper.get('[data-testid="answer-queue-position"]').text()).toBe('2 of 3');
	});

	it('names the menu beside its icon, except on a phone', () => {
		setWidth(1440);
		expect(mountBar().get('[data-testid="menu-trigger-text"]').text()).toBe('in Answer queue');
		setWidth(390);
		expect(mountBar().get('[data-testid="menu-trigger-text"]').text()).toBe('');
	});

	it('renders nothing outside a queue', () => {
		provided = null;
		const wrapper = mountBar();
		expect(wrapper.find('[data-testid="answer-queue-bar"]').exists()).toBe(false);
	});

	it('[ and ] browse without finishing the item', () => {
		mountBar();
		press('[');
		press(']');
		expect(session.back).toHaveBeenCalledTimes(1);
		expect(session.next).toHaveBeenCalledTimes(1);
		expect(session.complete).not.toHaveBeenCalled();
	});

	it('keys stay with a text field', () => {
		mountBar();
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
		expect(session.next).not.toHaveBeenCalled();
		expect(session.complete).not.toHaveBeenCalled();
		input.remove();
	});

	it('e archives the Postbox item and finishes it', async () => {
		mountBar();
		press('e');
		await flushPromises();
		expect(session.complete).toHaveBeenCalledWith('archived', expect.any(Function));
	});

	it('h opens snooze; picking a time finishes the item', async () => {
		const wrapper = mountBar();
		press('h');
		await flushPromises();
		await wrapper.get('.snooze').trigger('click');
		await flushPromises();
		expect(session.complete).toHaveBeenCalledWith('snoozed');
	});

	it('offers no archive and no snooze on a team item (a snoozed thread came straight back)', async () => {
		current.value = {
			id: 'team:in_1',
			source: 'team',
			entry: { message: { _id: 'in_1' }, thread: { _id: 'ct_1' } },
		};
		const wrapper = mountBar();
		press('e');
		press('h');
		await flushPromises();
		expect(wrapper.find('.snooze').exists()).toBe(false);
		expect(wrapper.find('[data-testid="answer-queue-snooze"]').exists()).toBe(false);
		expect(session.complete).not.toHaveBeenCalled();
	});

	it('on a page the queue no longer holds, offers the way back instead of acting', async () => {
		isCurrentRoute.value = false;
		const wrapper = mountBar();
		press('e');
		await flushPromises();
		expect(session.complete).not.toHaveBeenCalled();
		await wrapper.get('[data-testid="answer-queue-return"]').trigger('click');
		expect(session.goCurrent).toHaveBeenCalledTimes(1);
	});
});
