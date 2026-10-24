/**
 * Scroll behaviour of the chat message list (plan 1.16): opening a room jumps
 * to the newest message instead of smooth-scrolling through the history, and a
 * new message only pulls the view down when the reader was already at the
 * bottom (or sent it themselves). Reduced motion turns the follow scroll into
 * a jump too.
 *
 * The list is windowed (useVirtualList): only rows near the viewport mount,
 * with day separators as rows of their own, and a message whose editor is open
 * stays mounted when the reader scrolls away from it.
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

const ChatMessageStub = {
	props: ['message'],
	template: '<div class="msg" :data-id="message._id" />',
};

function mountList(messages: ChatMessageRow[], chatMessage: object = ChatMessageStub) {
	return mount(ChatMessageList, {
		props: { messages, currentUserId: ME },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, ChatMessage: chatMessage },
		},
	});
}

/**
 * Pretend the scroller is 1000px tall, 400px visible, scrolled to `scrollTop`
 * by the reader (the scroll event included, as the browser fires it).
 */
function placeScroller(el: HTMLElement, scrollTop: number, scrollHeight = 1000) {
	Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
	Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 });
	Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop, writable: true });
	el.dispatchEvent(new Event('scroll'));
}

const DAY_MS = 24 * 3600 * 1000;
const HISTORY_START = Date.UTC(2026, 8, 1, 9);

/** `count` messages spread evenly over `days` calendar days. */
function history(count: number, days: number): ChatMessageRow[] {
	const step = (days * DAY_MS) / count;
	return Array.from({ length: count }, (_, i) =>
		row(`m${i}`, i % 3 === 0 ? ME : OTHER, HISTORY_START + Math.round(i * step))
	);
}

const dayLabel = (at: number) =>
	new Intl.DateTimeFormat('en', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	}).format(new Date(at));

const messageRows = (el: Element) =>
	Array.from(el.querySelectorAll<HTMLElement>('[data-row-kind="message"]'));
const mountedIds = (el: Element) =>
	Array.from(el.querySelectorAll<HTMLElement>('.msg')).map((m) => m.dataset['id']);
const dateRows = (el: Element) =>
	Array.from(el.querySelectorAll<HTMLElement>('[data-row-kind="date"]')).map((d) =>
		d.textContent?.trim()
	);

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

	it('mounts only the rows near the viewport of a 500-message history', async () => {
		// Five messages a day, so every window holds a day separator.
		const messages = history(500, 100);
		const wrapper = mountList(messages);
		const el = wrapper.element as HTMLElement;

		placeScroller(el, 0, 30_000);
		await flushPromises();
		expect(messageRows(el).length).toBeGreaterThan(0);
		expect(messageRows(el).length).toBeLessThan(30);
		// The oldest end: the first day's separator, then the first message.
		expect(dateRows(el)[0]).toBe(dayLabel(messages[0]!.createdAt));
		expect(el.querySelector('[data-row-kind]')?.getAttribute('data-row-kind')).toBe('date');
		expect(mountedIds(el)[0]).toBe('m0');

		placeScroller(el, 1e9, 30_000);
		await flushPromises();
		expect(messageRows(el).length).toBeLessThan(30);
		// The newest end: the last day's separator is the last one mounted.
		expect(dateRows(el).at(-1)).toBe(dayLabel(messages.at(-1)!.createdAt));
		expect(mountedIds(el).at(-1)).toBe('m499');
	});

	it('keeps a message with its editor open mounted while the reader scrolls away', async () => {
		const messages = history(500, 14);
		const Editable = {
			props: ['message'],
			emits: ['editing'],
			template:
				'<div class="msg"><button :data-edit="message._id" @click="$emit(\'editing\', message._id, true)">edit</button></div>',
		};
		const wrapper = mountList(messages, Editable);
		const el = wrapper.element as HTMLElement;
		placeScroller(el, 1e9, 30_000);
		await flushPromises();

		const editor = el.querySelector<HTMLElement>('[data-edit="m499"]')!;
		editor.click();
		placeScroller(el, 0, 30_000);
		await flushPromises();

		expect(dateRows(el)[0]).toBe(dayLabel(messages[0]!.createdAt));
		expect(el.querySelector('[data-edit="m499"]')).toBe(editor);
		expect(messageRows(el).length).toBeLessThan(31);
	});
});
