// @vitest-environment happy-dom
/**
 * Scroll behaviour of the chat message list (plan 1.16): opening a room jumps
 * to the newest message instead of smooth-scrolling through the history, and a
 * new message only pulls the view down when the reader was already at the
 * bottom (or sent it themselves). Reduced motion turns the follow scroll into
 * a jump too.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

import ChatMessageList from '../ChatMessageList.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ChatMessageRow } from '~/composables/chat/useChatRoom';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const ME = 'user-me';
const OTHER = 'user-other';

function row(id: string, authorId: string, createdAt = Date.UTC(2026, 8, 29, 12)): ChatMessageRow {
	return { _id: id, authorId, createdAt, text: id } as unknown as ChatMessageRow;
}

const scrollTo = vi.fn();
const originalScrollTo = HTMLElement.prototype.scrollTo;
// The list used to scroll a sentinel into view; any such call is a scroll too.
const scrollIntoView = vi.fn();
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function stubMatchMedia(reduced: boolean) {
	vi.spyOn(window, 'matchMedia').mockImplementation(
		() =>
			({
				matches: reduced,
				addEventListener: () => {},
				removeEventListener: () => {},
			}) as unknown as MediaQueryList
	);
}

function mountList(messages: ChatMessageRow[]) {
	return mount(ChatMessageList, {
		props: { messages, currentUserId: ME },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, ChatMessage: { template: '<div class="msg" />' } },
		},
	});
}

/** Pretend the scroller is 1000px tall, 400px visible, scrolled to `scrollTop`. */
function placeScroller(el: HTMLElement, scrollTop: number) {
	Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 });
	Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 });
	Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop, writable: true });
}

beforeEach(() => {
	scrollTo.mockClear();
	scrollIntoView.mockClear();
	HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
	HTMLElement.prototype.scrollIntoView = scrollIntoView;
	stubMatchMedia(false);
});

afterEach(() => {
	vi.restoreAllMocks();
	HTMLElement.prototype.scrollTo = originalScrollTo;
	HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

describe('ChatMessageList scrolling', () => {
	it('jumps to the bottom on open instead of smooth-scrolling', () => {
		mountList([row('a', OTHER), row('b', OTHER)]);
		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(scrollTo.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
	});

	it('follows a new message when the reader is within 80px of the bottom', async () => {
		const wrapper = mountList([row('a', OTHER)]);
		placeScroller(wrapper.element as HTMLElement, 540); // 60px from the bottom
		scrollTo.mockClear();
		scrollIntoView.mockClear();

		await wrapper.setProps({ messages: [row('a', OTHER), row('b', OTHER)] });
		await flushPromises();

		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(scrollTo.mock.calls[0]![0]).toMatchObject({ top: 1000, behavior: 'smooth' });
	});

	it('leaves a reader scrolled up in the history where they are', async () => {
		const wrapper = mountList([row('a', OTHER)]);
		placeScroller(wrapper.element as HTMLElement, 100); // 500px from the bottom
		scrollTo.mockClear();
		scrollIntoView.mockClear();

		await wrapper.setProps({ messages: [row('a', OTHER), row('b', OTHER)] });
		await flushPromises();

		expect(scrollTo).not.toHaveBeenCalled();
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it('still scrolls down for the reader’s own new message', async () => {
		const wrapper = mountList([row('a', OTHER)]);
		placeScroller(wrapper.element as HTMLElement, 100);
		scrollTo.mockClear();
		scrollIntoView.mockClear();

		await wrapper.setProps({ messages: [row('a', OTHER), row('mine', ME)] });
		await flushPromises();

		expect(scrollTo).toHaveBeenCalledTimes(1);
	});

	it('does not scroll when older messages are added above', async () => {
		const wrapper = mountList([row('b', OTHER)]);
		placeScroller(wrapper.element as HTMLElement, 600);
		scrollTo.mockClear();
		scrollIntoView.mockClear();

		await wrapper.setProps({ messages: [row('a', OTHER), row('b', OTHER)] });
		await flushPromises();

		expect(scrollTo).not.toHaveBeenCalled();
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it('does not treat deleting the last message as a new arrival', async () => {
		const wrapper = mountList([row('a', ME), row('b', OTHER)]);
		placeScroller(wrapper.element as HTMLElement, 100);
		scrollTo.mockClear();
		scrollIntoView.mockClear();

		await wrapper.setProps({ messages: [row('a', ME)] });
		await flushPromises();

		expect(scrollTo).not.toHaveBeenCalled();
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it('jumps rather than animates under reduced motion', async () => {
		stubMatchMedia(true);
		const wrapper = mountList([row('a', OTHER)]);
		placeScroller(wrapper.element as HTMLElement, 600);
		scrollTo.mockClear();
		scrollIntoView.mockClear();

		await wrapper.setProps({ messages: [row('a', OTHER), row('b', OTHER)] });
		await flushPromises();

		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(scrollTo.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
	});
});
