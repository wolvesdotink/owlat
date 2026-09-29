// @vitest-environment happy-dom
/**
 * The body is where a timed Postbox open ends (plan 0.2): the first measured
 * frame document of the real body tells the perf marks the opened message is on
 * screen. A body still on its way (the skeleton) must not end it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('sanitize-html', () => ({ default: vi.fn((html: string) => html) }));

const bodyRendered = vi.hoisted(() => vi.fn());
vi.mock('~/composables/postbox/usePostboxPerfMarks', () => ({
	notePostboxBodyRendered: bodyRendered,
}));

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import {
	splitQuotedText,
	splitQuotedHtml,
} from '../../../composables/postbox/usePostboxQuotedText';
import { getPostboxRenderCache } from '../../../utils/postboxRenderCache';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), error: ref(null) }));
	vi.stubGlobal('splitQuotedText', splitQuotedText);
	vi.stubGlobal('splitQuotedHtml', splitQuotedHtml);
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline: ref(false),
		persistBody: vi.fn(async () => {}),
		loadBody: vi.fn(async () => null),
	}));
	vi.stubGlobal('requestAnimationFrame', () => 0);
	vi.stubGlobal('cancelAnimationFrame', () => {});
});

beforeEach(() => {
	bodyRendered.mockClear();
	getPostboxRenderCache().clear();
});

const globalMount = {
	plugins: [createTestI18n()],
	components: { PostboxReaderSkeleton, UiSkeleton, Icon: { template: '<span />' } },
	stubs: { PostboxImageBanner: true },
};

/** The frame's document is parsed: what the autosizer waits for. */
async function parseFrame(iframe: HTMLIFrameElement): Promise<void> {
	Object.defineProperty(iframe, 'contentDocument', {
		configurable: true,
		value: { readyState: 'complete', URL: 'about:srcdoc', documentElement: { scrollHeight: 480 } },
	});
	iframe.dispatchEvent(new Event('load'));
	await nextTick();
}

describe('PostboxMessageBody and the reader-open timing', () => {
	it('reports its message as rendered once the body frame is measured', async () => {
		const w = mount(PostboxMessageBody, {
			props: { message: { _id: 'msg-open', htmlBodyInline: '<p>Hello</p>' } },
			global: globalMount,
		});
		await nextTick();
		expect(bodyRendered).not.toHaveBeenCalled();

		await parseFrame(w.find('iframe').element as HTMLIFrameElement);

		expect(bodyRendered).toHaveBeenCalledWith('msg-open');
	});

	it('does not report a body that is still on its way', async () => {
		const w = mount(PostboxMessageBody, {
			props: { message: { _id: 'msg-wait', bodyPending: true } },
			global: globalMount,
		});
		await nextTick();

		expect(w.find('[data-testid="postbox-reader-skeleton"]').exists()).toBe(true);
		expect(w.find('iframe').exists()).toBe(false);
		expect(bodyRendered).not.toHaveBeenCalled();

		await w.setProps({ message: { _id: 'msg-wait', htmlBodyInline: '<p>Here now</p>' } });
		await parseFrame(w.find('iframe').element as HTMLIFrameElement);

		expect(bodyRendered).toHaveBeenCalledWith('msg-wait');
	});
});
