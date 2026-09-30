// @vitest-environment happy-dom
/**
 * One team-inbox message's text in the thread view (#900):
 *   - a message whose text fit on its row renders it and calls nothing;
 *   - a message whose text part is held in storage shows the excerpt AND says
 *     it is the beginning, then swaps in the full text the action returns;
 *   - a failed fetch keeps the excerpt and the note — a reader is never shown
 *     a cut message as whole;
 *   - no text at all is the existing "no text content" line.
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { InboxMessageText } from '../InboxMessageBody.vue';

const TEXT_FN = getFunctionName(api.inbox.bodyText.getInboundMessageText);

let answer: () => Promise<string | null>;
const action = vi.fn(async (fn: unknown, args: unknown) => {
	expect(getFunctionName(fn as never)).toBe(TEXT_FN);
	expect(args).toEqual({ messageId: 'msg_1' });
	return await answer();
});

const InboxMessageBody = (await import('../InboxMessageBody.vue')).default;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('requireConvex', () => ({ action }));
});

beforeEach(() => {
	action.mockClear();
	answer = async () => 'The whole long message, every line of it.';
});

function mountBody(message: Partial<InboxMessageText>) {
	return mount(InboxMessageBody, {
		props: { message: { _id: 'msg_1', ...message } as InboxMessageText },
		global: { plugins: [createTestI18n()] },
	});
}

const EXCERPT_NOTE = '[data-testid="inbox-message-body-excerpt"]';

describe('InboxMessageBody', () => {
	it('renders an inline text part as before, without a fetch', async () => {
		const wrapper = mountBody({ textBody: 'Short and inline.' });
		await flushPromises();
		expect(wrapper.text()).toContain('Short and inline.');
		expect(wrapper.find(EXCERPT_NOTE).exists()).toBe(false);
		expect(action).not.toHaveBeenCalled();
	});

	it('shows the excerpt, marked, then the full text from storage', async () => {
		let release: (value: string) => void = () => {};
		answer = () => new Promise<string>((resolve) => (release = resolve));
		const wrapper = mountBody({
			bodyExcerpt: 'The whole long message',
			textBodyStorageId: 'storage_1' as InboxMessageText['textBodyStorageId'],
		});
		await flushPromises();
		expect(wrapper.text()).toContain('The whole long message');
		expect(wrapper.find(EXCERPT_NOTE).exists()).toBe(true);

		release('The whole long message, every line of it.');
		await flushPromises();
		expect(wrapper.text()).toContain('every line of it.');
		expect(wrapper.find(EXCERPT_NOTE).exists()).toBe(false);
		expect(action).toHaveBeenCalledTimes(1);
	});

	it('keeps the excerpt and its note when the fetch fails', async () => {
		answer = async () => {
			throw new Error('offline');
		};
		const wrapper = mountBody({
			bodyExcerpt: 'Only the opening',
			textBodyStorageId: 'storage_1' as InboxMessageText['textBodyStorageId'],
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Only the opening');
		expect(wrapper.find(EXCERPT_NOTE).exists()).toBe(true);
	});

	it('says there is no text content when the message has none', async () => {
		const wrapper = mountBody({});
		await flushPromises();
		expect(wrapper.text()).toContain('No text content');
		expect(action).not.toHaveBeenCalled();
	});
});
