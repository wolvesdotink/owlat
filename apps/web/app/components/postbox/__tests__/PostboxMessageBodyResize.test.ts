// @vitest-environment happy-dom
/**
 * Regression: the body iframe must be measurable so it auto-sizes to its
 * content instead of staying clipped at the 200px min-height.
 *
 * The frame is rendered with `sandbox="allow-same-origin"` (deliberately WITHOUT
 * allow-scripts). Under the old empty `sandbox=""` the frame ran in an opaque
 * origin, `contentDocument` was null, and `resizeIframe()` short-circuited on
 * every load — so every HTML email was stuck at 200px with an inner scrollbar
 * and the #89 pre-size cache never recorded a height. These tests pin the
 * sandbox value and prove a tall body drives the iframe height.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick, type Ref } from 'vue';

vi.mock('sanitize-html', () => ({ default: vi.fn((html: string) => html) }));

import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '../../../../../../packages/ui/components/ui/Skeleton.vue';
import { splitQuotedText, splitQuotedHtml } from '../../../composables/postbox/usePostboxQuotedText';
import { getPostboxRenderCache, postboxRenderKey } from '../../../utils/postboxRenderCache';

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
	vi.stubGlobal('splitQuotedText', splitQuotedText);
	vi.stubGlobal('splitQuotedHtml', splitQuotedHtml);
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline: ref(false),
		persistBody: vi.fn(async () => {}),
		loadBody: vi.fn(async () => null),
	}));
});

beforeEach(() => {
	getPostboxRenderCache().clear();
});

const iconStub = { props: ['name'], template: '<span />' };
const globalMount = {
	components: { PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
};

const message = { _id: 'msg-resize', htmlBodyInline: '<p>Tall body</p>' };

function mountBody(msg = message) {
	return mount(PostboxMessageBody, { props: { message: msg }, global: globalMount });
}

describe('PostboxMessageBody iframe sizing', () => {
	it('renders the iframe with sandbox="allow-same-origin" (measurable, no scripts)', async () => {
		const w = mountBody();
		await nextTick();
		const sandbox = w.find('iframe').attributes('sandbox');
		expect(sandbox).toBe('allow-same-origin');
		// allow-scripts must NOT be granted — content stays inert.
		expect(sandbox).not.toContain('allow-scripts');
	});

	it('sizes the iframe to its content height on load (not left at 200px)', async () => {
		const w = mountBody();
		await nextTick();
		const iframe = w.find('iframe').element as HTMLIFrameElement;

		// Same-origin frame: contentDocument is readable. Emulate a tall body.
		Object.defineProperty(iframe, 'contentDocument', {
			configurable: true,
			value: { documentElement: { scrollHeight: 840 } },
		});
		iframe.dispatchEvent(new Event('load'));
		await nextTick();

		expect(iframe.style.height).toBe('840px');
		// The measured height is remembered so re-opening pre-sizes instead of
		// flashing the min-height (the #89 pre-size cache path).
		const key = postboxRenderKey(message._id, {
			scheme: 'light',
			showImages: false,
			loadEverything: false,
			showQuoted: false,
		});
		expect(getPostboxRenderCache().get(key)?.height).toBe(840);
	});
});
