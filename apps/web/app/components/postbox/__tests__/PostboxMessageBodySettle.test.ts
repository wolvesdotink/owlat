// @vitest-environment happy-dom
/**
 * The lazy body-fetch skeleton in PostboxMessageBody must SETTLE for every
 * action outcome — including `getMessageBody` resolving to `null` (message
 * deleted/unreadable). A resolved-null must degrade to the normal
 * "(empty message)" sandboxed iframe, never shimmer forever.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
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

function mountBody(message = { _id: 'msg-1', htmlBodyStorageId: 'blob-1' }) {
	return mount(PostboxMessageBody, {
		props: { message },
		global: {
			components: { PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
		},
	});
}

describe('PostboxMessageBody lazy-fetch settling', () => {
	it('settles to the "(empty message)" iframe when getMessageBody resolves null', async () => {
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
		expect(iframe.attributes('sandbox')).toBe('allow-same-origin');
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
		resolveSecond?.({
			htmlInline: '<p>new body</p>',
			textInline: null,
			htmlUrl: null,
			textUrl: null,
		});
		await flushPromises();
		expect(w.find('iframe').attributes('srcdoc')).toContain('new body');

		resolveFirst?.({
			htmlInline: '<p>stale body</p>',
			textInline: null,
			htmlUrl: null,
			textUrl: null,
		});
		await flushPromises();
		expect(w.find('iframe').attributes('srcdoc')).toContain('new body');
		expect(w.find('iframe').attributes('srcdoc')).not.toContain('stale body');
	});

	it('ignores a stale blob download after switching messages', async () => {
		let resolveOldBody: ((value: string) => void) | undefined;
		const fetchMock = vi.fn(async () => ({
			text: () =>
				new Promise<string>((resolve) => {
					resolveOldBody = resolve;
				}),
		}));
		vi.stubGlobal('fetch', fetchMock);
		action
			.mockResolvedValueOnce({
				htmlInline: null,
				textInline: null,
				htmlUrl: 'https://storage.example/old',
				textUrl: null,
			})
			.mockResolvedValueOnce({
				htmlInline: '<p>new body</p>',
				textInline: null,
				htmlUrl: null,
				textUrl: null,
			});

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
});
