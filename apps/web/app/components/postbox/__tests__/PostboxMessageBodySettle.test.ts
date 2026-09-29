// @vitest-environment happy-dom
/**
 * The lazy body-fetch skeleton in PostboxMessageBody must SETTLE for every
 * action outcome — including `getMessageBodyBlobUrls` resolving to `null`
 * (message deleted/unreadable). A resolved-null must degrade to the normal
 * "(empty message)" sandboxed iframe, never shimmer forever.
 *
 * It must also wait, without memoising anything, while the reader's inline
 * body query is still on its way (plan 2.5: the reader renders a list row
 * before its thread loads).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { nextTick, ref } from 'vue';

import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import {
	splitQuotedText,
	splitQuotedHtml,
} from '../../../composables/postbox/usePostboxQuotedText';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const action = vi.fn();
const loadBody = vi.fn(async (_messageId: string) => null);

beforeAll(() => {
	// The body copy flows through vue-i18n now; `useI18n` is a Nuxt auto-import.
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('requireConvex', () => ({ action }));
	// Real quoted-text splitters (Nuxt auto-imports in the component).
	vi.stubGlobal('splitQuotedText', splitQuotedText);
	vi.stubGlobal('splitQuotedHtml', splitQuotedHtml);
	// App theme (Nuxt auto-import) — light path keeps historical behavior.
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	// Offline read cache (Nuxt auto-import) — inert stub so the component mounts;
	// this suite covers the live render/settle path, not the cache.
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline: ref(false),
		persistBody: vi.fn(async () => {}),
		loadBody,
	}));
});

beforeEach(() => {
	action.mockReset();
	loadBody.mockReset();
	loadBody.mockResolvedValue(null);
});

const iconStub = { props: ['name'], template: '<span />' };

function mountBody(
	message: Record<string, unknown> = { _id: 'msg-1', htmlBodyStorageId: 'blob-1' }
) {
	return mount(PostboxMessageBody, {
		props: { message },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
			stubs: { PostboxImageBanner: true },
		},
	});
}

describe('PostboxMessageBody lazy-fetch settling', () => {
	it('settles to the "(empty message)" iframe when the blob URL action resolves null', async () => {
		action.mockResolvedValue(null);
		const w = mountBody();

		// Still loading: skeleton, no iframe yet.
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(true);
		expect(w.find('iframe').exists()).toBe(false);

		// Action resolves null (deleted/unreadable message).
		await flushPromises();
		await nextTick();

		// Skeleton settles; the empty body renders in the sandboxed iframe.
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(false);
		const iframe = w.find('iframe');
		expect(iframe.exists()).toBe(true);
		expect(iframe.attributes('sandbox')).toBe(
			'allow-same-origin allow-popups allow-popups-to-escape-sandbox'
		);
		expect(iframe.attributes('sandbox')).not.toContain('allow-scripts');
	});

	it('ignores a stale body action after switching messages', async () => {
		let resolveFirst: ((value: unknown) => void) | undefined;
		let resolveSecond: ((value: unknown) => void) | undefined;
		action
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					})
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveSecond = resolve;
					})
			);

		const w = mountBody();
		await w.setProps({
			message: { _id: 'msg-2', htmlBodyStorageId: 'blob-2' },
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => ({
				text: async () => (url.endsWith('/new') ? '<p>new body</p>' : '<p>stale body</p>'),
			}))
		);
		resolveSecond?.({ htmlUrl: 'https://storage.example/new', textUrl: null });
		await flushPromises();
		expect(w.find('iframe').attributes('srcdoc')).toContain('new body');

		resolveFirst?.({ htmlUrl: 'https://storage.example/old', textUrl: null });
		await flushPromises();
		expect(w.find('iframe').attributes('srcdoc')).toContain('new body');
		expect(w.find('iframe').attributes('srcdoc')).not.toContain('stale body');
	});

	it('ignores a stale blob download after switching messages', async () => {
		let resolveOldBody: ((value: string) => void) | undefined;
		const fetchMock = vi.fn(async (url: string) =>
			url.endsWith('/old')
				? {
						text: () =>
							new Promise<string>((resolve) => {
								resolveOldBody = resolve;
							}),
					}
				: { text: async () => '<p>new body</p>' }
		);
		vi.stubGlobal('fetch', fetchMock);
		action
			.mockResolvedValueOnce({ htmlUrl: 'https://storage.example/old', textUrl: null })
			.mockResolvedValueOnce({ htmlUrl: 'https://storage.example/new', textUrl: null });

		const w = mountBody();
		await flushPromises();
		expect(fetchMock).toHaveBeenCalledWith('https://storage.example/old');
		await w.setProps({
			message: { _id: 'msg-2', htmlBodyStorageId: 'blob-2' },
		});
		await flushPromises();
		expect(w.find('iframe').attributes('srcdoc')).toContain('new body');

		resolveOldBody?.('<p>stale downloaded body</p>');
		await flushPromises();
		expect(w.find('iframe').attributes('srcdoc')).toContain('new body');
		expect(w.find('iframe').attributes('srcdoc')).not.toContain('stale downloaded body');
	});

	it('ignores a stale offline body after switching to a message without a live body', async () => {
		let resolveFirstOfflineBody:
			| ((value: { srcdoc: string; cachedAt: number } | null) => void)
			| undefined;
		loadBody
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirstOfflineBody = resolve;
					})
			)
			.mockResolvedValueOnce(null);

		const w = mountBody({ _id: 'offline-msg-1' });
		await w.setProps({ message: { _id: 'offline-msg-2' } });
		await flushPromises();

		resolveFirstOfflineBody?.({
			srcdoc: '<!doctype html><html><body>stale offline body</body></html>',
			cachedAt: Date.now(),
		});
		await flushPromises();

		const srcdoc = w.find('iframe').attributes('srcdoc');
		expect(loadBody).toHaveBeenNthCalledWith(1, 'offline-msg-1');
		expect(loadBody).toHaveBeenNthCalledWith(2, 'offline-msg-2');
		expect(srcdoc).not.toContain('stale offline body');
	});

	it('holds the skeleton while the inline body is pending, and renders it when it lands', async () => {
		const w = mountBody({ _id: 'pending-msg', bodyPending: true });
		await flushPromises();

		// Nothing to fetch: the reader's inline body query answers this one.
		expect(action).not.toHaveBeenCalled();
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(true);
		expect(w.find('iframe').exists()).toBe(false);

		await w.setProps({ message: { _id: 'pending-msg', htmlBodyInline: '<p>inline body</p>' } });
		await flushPromises();

		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(false);
		// The empty render from the pending state was never cached under the
		// message's key, so the real body is what shows.
		expect(w.find('iframe').attributes('srcdoc')).toContain('inline body');
	});

	it('downloads a body the inline query reported as a blob', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ text: async () => '<p>blob body</p>' }))
		);
		action.mockResolvedValue({ htmlUrl: 'https://storage.example/blob', textUrl: null });
		const w = mountBody({ _id: 'blob-flag-msg', hasBodyBlob: true });
		await flushPromises();

		expect(action).toHaveBeenCalledTimes(1);
		expect(w.find('iframe').attributes('srcdoc')).toContain('blob body');
	});
});
