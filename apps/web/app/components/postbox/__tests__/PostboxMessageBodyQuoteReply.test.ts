/**
 * "Quote in reply" in a message body: offered only where the reader around it
 * can quote this message (a body outside a reader, or one its reader says no
 * for, never shows a dead action), and pressing it hands the reader this
 * message's id and the selected passage, once.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import { getPostboxRenderCache } from '~/utils/postboxRenderCache';
import type { PostboxReaderQuoteReply } from '~/composables/postbox/usePostboxReaderContext';
import { readerContextProvide } from './readerContextFixture';

vi.mock('sanitize-html', () => ({ default: vi.fn((html: string) => html) }));
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), error: ref(null) }));
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline: ref(false),
		persistBody: vi.fn(async () => {}),
		loadBody: vi.fn(async () => null),
	}));
});

beforeEach(() => {
	getPostboxRenderCache().clear();
	vi.stubGlobal('requestAnimationFrame', () => 0);
	vi.stubGlobal('cancelAnimationFrame', () => {});
});

const message = { _id: 'msg_old', htmlBodyInline: '<p>We were billed twice.</p>' };

/** `undefined`: no reader around the body at all. */
function mountBody(quoteReply?: PostboxReaderQuoteReply | null) {
	const wrapper = mount(PostboxMessageBody, {
		props: { message },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxReaderSkeleton, UiSkeleton },
			stubs: { PostboxImageBanner: true },
			provide: quoteReply === undefined ? {} : readerContextProvide({ quoteReply }),
		},
	});
	return wrapper;
}

/** Load a real document into the frame and select `text` in it. */
async function selectInFrame(wrapper: ReturnType<typeof mountBody>, text: string) {
	await nextTick();
	const iframe = wrapper.get('iframe').element as HTMLIFrameElement;
	const doc = document.implementation.createHTMLDocument('');
	Object.defineProperty(doc, 'URL', { configurable: true, value: 'about:srcdoc' });
	doc.body.innerHTML = message.htmlBodyInline;
	Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: doc });
	iframe.dispatchEvent(new Event('load'));
	const node = doc.querySelector('p')!.firstChild as Text;
	const at = node.data.indexOf(text);
	doc.getSelection()!.setBaseAndExtent(node, at, node, at + text.length);
	doc.dispatchEvent(new Event('selectionchange'));
	await nextTick();
	return doc;
}

describe('PostboxMessageBody quote in reply', () => {
	it('quotes the selected passage of this message through the reader', async () => {
		const quote = vi.fn();
		const wrapper = mountBody({ canQuote: (id) => id === 'msg_old', quote });
		await selectInFrame(wrapper, 'billed twice');

		const pill = wrapper.get('[data-testid="quote-reply-pill"]');
		expect(pill.text()).toContain('Quote in reply');
		await pill.trigger('click');
		expect(quote).toHaveBeenCalledExactlyOnceWith('msg_old', 'billed twice');
		expect(wrapper.find('[data-testid="quote-reply-pill"]').exists()).toBe(false);
	});

	it('offers nothing where the reader cannot quote this message', async () => {
		const quote = vi.fn();
		const wrapper = mountBody({ canQuote: () => false, quote });
		const doc = await selectInFrame(wrapper, 'billed twice');
		expect(wrapper.find('[data-testid="quote-reply-pill"]').exists()).toBe(false);
		doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
		expect(quote).not.toHaveBeenCalled();
	});

	it('offers nothing in a reader without quoting, or in a body outside a reader', async () => {
		const inReader = mountBody(null);
		await selectInFrame(inReader, 'billed twice');
		expect(inReader.find('[data-testid="quote-reply-pill"]').exists()).toBe(false);

		const wrapper = mountBody();
		await selectInFrame(wrapper, 'billed twice');
		expect(wrapper.find('[data-testid="quote-reply-pill"]').exists()).toBe(false);
	});
});
