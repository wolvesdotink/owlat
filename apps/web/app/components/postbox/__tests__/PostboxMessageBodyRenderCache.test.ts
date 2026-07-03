// @vitest-environment happy-dom
/**
 * The session render cache must let PostboxMessageBody skip the whole
 * sanitize/transform pipeline when the same message is re-opened with the same
 * options — and a COLLAPSED message (whose body is never mounted) must never
 * run sanitize at all.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick, defineComponent, type Ref } from 'vue';

// Spy on sanitize-html so we can assert whether the sanitize path ran. Returns
// its input unchanged so the rest of the (real) pipeline behaves normally.
vi.mock('sanitize-html', () => ({ default: vi.fn((html: string) => html) }));
import sanitizeHtml from 'sanitize-html';
const sanitizeSpy = vi.mocked(sanitizeHtml);

import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '../../../../../../packages/ui/components/ui/Skeleton.vue';
import { splitQuotedText, splitQuotedHtml } from '../../../composables/postbox/usePostboxQuotedText';
import { getPostboxRenderCache } from '../../../utils/postboxRenderCache';

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
});

beforeEach(() => {
	getPostboxRenderCache().clear();
	sanitizeSpy.mockClear();
});

const iconStub = { props: ['name'], template: '<span />' };
const globalMount = {
	components: { PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
};

// Inline body → needsBodyFetch is false → contentFinal true → cache engaged.
const message = { _id: 'msg-cache', htmlBodyInline: '<p>Hello world</p>' };

function mountBody(msg = message) {
	return mount(PostboxMessageBody, { props: { message: msg }, global: globalMount });
}

describe('PostboxMessageBody render cache', () => {
	it('runs sanitize on first render', async () => {
		const w = mountBody();
		await nextTick();
		expect(sanitizeSpy).toHaveBeenCalled();
		expect(w.find('iframe').exists()).toBe(true);
	});

	it('skips the sanitize path when re-mounting the same message + options (cache hit)', async () => {
		const w1 = mountBody();
		await nextTick();
		expect(sanitizeSpy).toHaveBeenCalled();
		w1.unmount();

		sanitizeSpy.mockClear();
		const w2 = mountBody();
		await nextTick();
		// Second open of the same (messageId, options) is served from the cache.
		expect(sanitizeSpy).not.toHaveBeenCalled();
		expect(w2.find('iframe').exists()).toBe(true);
	});

	it('re-runs sanitize for a different message id (cache miss)', async () => {
		mountBody();
		await nextTick();
		sanitizeSpy.mockClear();

		mountBody({ _id: 'msg-other', htmlBodyInline: '<p>Other</p>' });
		await nextTick();
		expect(sanitizeSpy).toHaveBeenCalled();
	});
});

describe('collapsed message body', () => {
	// Mirrors the parent contract: PostboxMessageBody lives inside the expanded
	// branch only, so a collapsed message never mounts (never sanitizes) it.
	const Wrapper = defineComponent({
		components: { PostboxMessageBody },
		props: { expanded: { type: Boolean, default: false } },
		template: `<PostboxMessageBody v-if="expanded" :message="msg" />`,
		data: () => ({ msg: { _id: 'msg-collapsed', htmlBodyInline: '<p>Collapsed</p>' } }),
	});

	it('does not invoke sanitize while collapsed, only after expand', async () => {
		const w = mount(Wrapper, { props: { expanded: false }, global: globalMount });
		await nextTick();
		expect(sanitizeSpy).not.toHaveBeenCalled();
		expect(w.find('iframe').exists()).toBe(false);

		await w.setProps({ expanded: true });
		await nextTick();
		expect(sanitizeSpy).toHaveBeenCalled();
		expect(w.find('iframe').exists()).toBe(true);
	});
});
