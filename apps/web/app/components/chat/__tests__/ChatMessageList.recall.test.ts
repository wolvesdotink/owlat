/**
 * `openEditor` (the composer's ↑) reaches a message in the windowed list even
 * when its row is scrolled out of the window: the row mounts, takes the
 * request in that render, and stays mounted while its editor is open.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, watch } from 'vue';

import ChatMessageList from '../ChatMessageList.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ChatMessageRow } from '~/composables/chat/useChatRoom';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const ME = 'user-me';
const START = Date.UTC(2026, 8, 1, 9);
const messages = Array.from(
	{ length: 300 },
	(_, i) =>
		({
			_id: `m${i}`,
			authorId: i % 3 === 0 ? ME : 'user-other',
			createdAt: START + i * 600_000,
			text: `m${i}`,
		}) as unknown as ChatMessageRow
);

// What each row saw of the request: the id, and whether it was set.
let requests: string[];

const RowStub = defineComponent({
	props: ['message', 'editRequested'],
	emits: ['editing'],
	setup(props, { emit }) {
		watch(
			() => props.editRequested,
			(requested) => {
				if (!requested) return;
				requests.push(props.message._id);
				emit('editing', props.message._id, true);
			},
			{ immediate: true }
		);
		return () => h('div', { class: 'msg', 'data-id': props.message._id });
	},
});

function placeScroller(el: HTMLElement, scrollTop: number, scrollHeight = 20_000) {
	Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
	Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 });
	Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop, writable: true });
	el.dispatchEvent(new Event('scroll'));
}

const originalScrollTo = HTMLElement.prototype.scrollTo;
const mountedIds = (el: Element) =>
	Array.from(el.querySelectorAll<HTMLElement>('.msg')).map((m) => m.dataset['id']);

beforeEach(() => {
	requests = [];
	HTMLElement.prototype.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
	vi.spyOn(window, 'matchMedia').mockImplementation(
		() =>
			({
				matches: false,
				addEventListener: () => {},
				removeEventListener: () => {},
			}) as unknown as MediaQueryList
	);
});

afterEach(() => {
	HTMLElement.prototype.scrollTo = originalScrollTo;
	vi.restoreAllMocks();
});

describe('ChatMessageList.openEditor', () => {
	it('mounts a row outside the window, opens it once, and keeps it mounted', async () => {
		const wrapper = mount(ChatMessageList, {
			props: { messages, currentUserId: ME },
			global: { plugins: [createTestI18n()], stubs: { ChatMessage: RowStub } },
		});
		const el = wrapper.element as HTMLElement;
		// Reading the oldest messages: the newest are far out of the window.
		placeScroller(el, 0);
		await flushPromises();
		expect(mountedIds(el)).not.toContain('m297');

		(wrapper.vm as unknown as { openEditor: (id: string) => void }).openEditor('m297');
		await flushPromises();

		expect(requests).toEqual(['m297']);
		expect(mountedIds(el)).toContain('m297');

		// The request ended with that render; the open editor keeps the row.
		placeScroller(el, 10);
		await flushPromises();
		expect(mountedIds(el)).toContain('m297');
		expect(requests).toEqual(['m297']);
	});
});
