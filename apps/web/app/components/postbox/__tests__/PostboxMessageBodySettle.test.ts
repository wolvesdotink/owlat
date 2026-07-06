// @vitest-environment happy-dom
/**
 * The lazy body-fetch skeleton in PostboxMessageBody must SETTLE for every
 * query outcome — including `getMessageBody` resolving to `null` (message
 * deleted/unreadable). A resolved-null must degrade to the normal
 * "(empty message)" sandboxed iframe, never shimmer forever.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick, type Ref } from 'vue';

import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import { splitQuotedText, splitQuotedHtml } from '../../../composables/postbox/usePostboxQuotedText';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const bodyData: Ref<unknown> = ref(undefined);

beforeAll(() => {
	vi.stubGlobal('useConvexQuery', () => ({ data: bodyData, error: ref(null) }));
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
		loadBody: vi.fn(async () => null),
	}));
});

const iconStub = { props: ['name'], template: '<span />' };

function mountBody() {
	return mount(PostboxMessageBody, {
		props: {
			// No inline body + a storage id → needsBodyFetch is true.
			message: { _id: 'msg-1', htmlBodyStorageId: 'blob-1' },
		},
		global: {
			components: { PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
		},
	});
}

describe('PostboxMessageBody lazy-fetch settling', () => {
	it('settles to the "(empty message)" iframe when getMessageBody resolves null', async () => {
		bodyData.value = undefined;
		const w = mountBody();

		// Still loading: skeleton, no iframe yet.
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(true);
		expect(w.find('iframe').exists()).toBe(false);

		// Query resolves null (deleted/unreadable message).
		bodyData.value = null;
		await nextTick();

		// Skeleton settles; the empty body renders in the sandboxed iframe.
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(false);
		const iframe = w.find('iframe');
		expect(iframe.exists()).toBe(true);
		expect(iframe.attributes('sandbox')).toBe('allow-same-origin');
		expect(iframe.attributes('sandbox')).not.toContain('allow-scripts');
	});
});
