// @vitest-environment happy-dom
/**
 * Images a received body can carry that used to render broken even for a
 * trusted sender:
 *   1. inline `cid:` images, which point at a part of the message itself — the
 *      reader now loads the part and swaps in its `data:` URL, without waiting
 *      for remote images to be allowed (an inline part never phones home);
 *   2. `http:` images, which the frame CSP refused — it now upgrades them to
 *      https instead.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { ref, nextTick } from 'vue';

import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxImageBanner from '../PostboxImageBanner.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import {
	splitQuotedText,
	splitQuotedHtml,
} from '../../../composables/postbox/usePostboxQuotedText';
import { getPostboxRenderCache } from '../../../utils/postboxRenderCache';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const loadMessagePart = vi.fn(async () => new Blob(['png-bytes'], { type: 'image/png' }));
vi.mock('../../../composables/postbox/loadMessagePart', () => ({
	loadMessagePart: (...args: unknown[]) => loadMessagePart(...(args as [])),
}));
vi.mock('../../../composables/postbox/loadRawEml', () => ({ loadRawEml: async () => null }));

const persistBody = vi.fn(async () => {});

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), error: ref(null) }));
	vi.stubGlobal('splitQuotedText', splitQuotedText);
	vi.stubGlobal('splitQuotedHtml', splitQuotedHtml);
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline: ref(false),
		persistBody,
		loadBody: vi.fn(async () => null),
	}));
});

const iconStub = { props: ['name'], template: '<span />' };
const globalMount = {
	plugins: [createTestI18n()],
	components: { PostboxImageBanner, PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
	stubs: { NuxtLink: { props: ['to'], template: '<a><slot /></a>' } },
};

const BODY =
	'<p>Maintenance</p><img src="cid:logo@status.example" alt="Logo" width="180" height="40">';

let messageSeq = 0;

function mountBody(senderImagesAllowed = false) {
	getPostboxRenderCache().clear();
	return mount(PostboxMessageBody, {
		props: {
			message: {
				_id: `msg-cid-${++messageSeq}`,
				htmlBodyInline: BODY,
				fromAddress: 'status@status.example',
				attachments: [
					{
						filename: 'logo.png',
						contentType: 'image/png',
						size: 2_000,
						partIndex: '2',
						contentId: '<logo@status.example>',
					},
				],
			},
			senderImagesAllowed,
		},
		global: globalMount,
	});
}

function srcdoc(wrapper: ReturnType<typeof mountBody>): string {
	return wrapper.find('iframe').attributes('srcdoc') ?? '';
}

describe('PostboxMessageBody inline and http images', () => {
	it('swaps a cid: reference for the loaded part, images blocked or not', async () => {
		const w = mountBody(false);
		await vi.waitFor(() => expect(srcdoc(w)).toContain('src="data:image/png;base64,'));
		expect(srcdoc(w)).not.toContain('cid:logo@status.example');
		expect(loadMessagePart).toHaveBeenCalledWith(
			expect.stringMatching(/^msg-cid-/),
			expect.objectContaining({ partIndex: '2' })
		);
	});

	it('only caches and saves the render once the inline images are in', async () => {
		persistBody.mockClear();
		const w = mountBody(true);
		await nextTick();
		// First pass: the part is still loading, so nothing is saved yet.
		expect(persistBody).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(persistBody).toHaveBeenCalled());
		const saved = persistBody.mock.calls.at(-1) as unknown as [string, string];
		expect(saved[1]).toContain('src="data:image/png;base64,');
		expect(srcdoc(w)).toContain('src="data:image/png;base64,');
	});

	it('upgrades http: images to https instead of refusing them', async () => {
		const w = mountBody(true);
		await nextTick();
		expect(srcdoc(w)).toContain('upgrade-insecure-requests');
	});
});
