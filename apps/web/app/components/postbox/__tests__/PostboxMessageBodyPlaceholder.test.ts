// @vitest-environment happy-dom
/**
 * A blob-stored body the reader has shown before (saved by the offline read
 * cache) appears at once while the live body loads, online too: no skeleton,
 * remote loads blocked, then replaced by the live render. Offline, the saved
 * copy is served as it was.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { ref } from 'vue';

import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import {
	splitQuotedText,
	splitQuotedHtml,
} from '../../../composables/postbox/usePostboxQuotedText';
import { buildBaseStyle } from '~/utils/postboxDarkMode';
import { POSTBOX_BODY_META_CSP, POSTBOX_SRCDOC_HEAD } from '~/utils/postboxBodyPlaceholder';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const action = vi.fn();
const isOffline = ref(false);
const saved = `${POSTBOX_SRCDOC_HEAD}${POSTBOX_BODY_META_CSP}${buildBaseStyle('light')}</head><body><p>saved copy</p><img src="https://img.example/pic.png"></body></html>`;
const loadBody = vi.fn(async (_messageId: string) => ({ srcdoc: saved, cachedAt: 1 }));

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('requireConvex', () => ({ action }));
	vi.stubGlobal('splitQuotedText', splitQuotedText);
	vi.stubGlobal('splitQuotedHtml', splitQuotedHtml);
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline,
		persistBody: vi.fn(async () => {}),
		loadBody,
	}));
});

beforeEach(() => {
	action.mockReset();
	isOffline.value = false;
});

const iconStub = { props: ['name'], template: '<span />' };

function mountBody() {
	return mount(PostboxMessageBody, {
		props: { message: { _id: 'msg-1', htmlBodyStorageId: 'blob-1' } },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
			stubs: { PostboxImageBanner: true },
		},
	});
}

describe('PostboxMessageBody saved-copy placeholder', () => {
	it('shows the saved copy with remote loads blocked until the live body lands', async () => {
		let resolveBody: ((value: unknown) => void) | undefined;
		action.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveBody = resolve;
				})
		);
		const w = mountBody();
		await flushPromises();

		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(false);
		const placeholder = w.find('iframe').attributes('srcdoc') ?? '';
		expect(placeholder).toContain('saved copy');
		expect(placeholder).toContain('img-src data:;');
		expect(placeholder).not.toContain(POSTBOX_BODY_META_CSP);

		resolveBody?.({
			htmlInline: '<p>live body</p>',
			textInline: null,
			htmlUrl: null,
			textUrl: null,
		});
		await flushPromises();
		const live = w.find('iframe').attributes('srcdoc') ?? '';
		expect(live).toContain('live body');
		expect(live).not.toContain('saved copy');
	});

	it('keeps the skeleton online when there is no saved copy', async () => {
		action.mockImplementation(() => new Promise(() => {}));
		loadBody.mockResolvedValueOnce(null as never);
		const w = mountBody();
		await flushPromises();
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(true);
	});

	it('serves the saved copy as it was while offline', async () => {
		isOffline.value = true;
		action.mockImplementation(() => new Promise(() => {}));
		const w = mountBody();
		await flushPromises();
		expect(w.find('iframe').attributes('srcdoc')).toBe(saved);
	});
});
