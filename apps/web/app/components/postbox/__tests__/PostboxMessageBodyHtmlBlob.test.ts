/**
 * Body parts are split for storage one by one, so a newsletter's HTML part
 * (over the inline threshold) sits in a blob while its short text alternative
 * stays inline. The reader must still fetch and render the HTML, keep the text
 * as the fallback when that fails, and load remote images on open unless the
 * message looks suspicious.
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
import {
	POSTBOX_BODY_META_CSP,
	POSTBOX_BODY_META_CSP_NO_REMOTE,
} from '~/utils/postboxBodyPlaceholder';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const action = vi.fn();
const NEWSLETTER =
	'<table><tr><td><img src="https://cdn.example/hero.jpg" width="600" height="300">Top camps</td></tr></table>';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('requireConvex', () => ({ action }));
	vi.stubGlobal('splitQuotedText', splitQuotedText);
	vi.stubGlobal('splitQuotedHtml', splitQuotedHtml);
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline: ref(false),
		persistBody: vi.fn(async () => {}),
		loadBody: vi.fn(async () => null),
	}));
});

let messageSequence = 0;

beforeEach(() => {
	action.mockReset();
	action.mockResolvedValue({ htmlUrl: 'https://storage.example/html', textUrl: null });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ text: async () => NEWSLETTER }))
	);
});

function mountBody(props: Record<string, unknown> = {}, id?: string) {
	// A fresh id per mount: the client-scoped body cache would otherwise answer
	// the second test from the first one's download.
	messageSequence += 1;
	return mount(PostboxMessageBody, {
		props: {
			message: {
				_id: id ?? `newsletter-${messageSequence}`,
				textBodyInline: 'https://example.com/tips?utm_source=x plain alternative',
				htmlBodyStorageId: 'blob-html',
			},
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			components: { PostboxReaderSkeleton, UiSkeleton },
			stubs: { PostboxImageBanner: true },
		},
	});
}

const srcdocOf = (w: ReturnType<typeof mountBody>) => w.find('iframe').attributes('srcdoc') ?? '';

describe('PostboxMessageBody with an HTML blob beside inline text', () => {
	it('fetches and renders the HTML part, not the text alternative', async () => {
		const w = mountBody();
		await flushPromises();

		expect(action).toHaveBeenCalledTimes(1);
		const srcdoc = srcdocOf(w);
		expect(srcdoc).toContain('Top camps');
		expect(srcdoc).not.toContain('plain alternative');
	});

	it('falls back to the inline text when the HTML download fails', async () => {
		action.mockRejectedValue(new Error('offline'));
		const w = mountBody();
		await flushPromises();

		expect(srcdocOf(w)).toContain('plain alternative');
	});

	it('does not cache the text fallback, so a later successful fetch shows the HTML', async () => {
		action.mockRejectedValueOnce(new Error('offline'));
		const failed = mountBody({}, 'reopened');
		await flushPromises();
		expect(srcdocOf(failed)).toContain('plain alternative');
		failed.unmount();

		const reopened = mountBody({}, 'reopened');
		await flushPromises();
		expect(srcdocOf(reopened)).toContain('Top camps');
		expect(srcdocOf(reopened)).not.toContain('plain alternative');
	});

	it('loads remote images on open when the preference says so', async () => {
		const w = mountBody({ autoLoadImages: true });
		await flushPromises();

		const srcdoc = srcdocOf(w);
		expect(srcdoc).toContain(POSTBOX_BODY_META_CSP);
		expect(srcdoc).toContain('src="https://cdn.example/hero.jpg"');
	});

	it('keeps images blocked in suspicious mail until the reader asks for them', async () => {
		const w = mountBody({ autoLoadImages: true, senderImagesAllowed: true, suspicious: true });
		await flushPromises();

		expect(srcdocOf(w)).toContain(POSTBOX_BODY_META_CSP_NO_REMOTE);
		expect(srcdocOf(w)).not.toContain('src="https://cdn.example/hero.jpg"');

		w.findComponent({ name: 'PostboxImageBanner' }).vm.$emit('show-once');
		await flushPromises();
		expect(srcdocOf(w)).toContain('src="https://cdn.example/hero.jpg"');
	});
});
