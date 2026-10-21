/**
 * The reader half of the per-sender remote-image allowlist.
 *
 * Three things this file exists to pin down:
 *   1. A trusted sender's images render WITHOUT a click and without the blocked
 *      banner ever appearing — that is the whole feature.
 *   2. Trusting a sender never loads their tracking pixels. The srcdoc for a
 *      trusted sender must still be missing the pixel the stripper removes.
 *   3. Revoking (in settings, or via the banner's own button) takes the images
 *      back on the open message, rather than leaving a stale render.
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
import type * as SharedTrackers from '@owlat/shared/postboxTrackers';
import { getPostboxRenderCache } from '../../../utils/postboxRenderCache';
import {
	POSTBOX_BODY_META_CSP,
	POSTBOX_BODY_META_CSP_NO_REMOTE,
} from '../../../utils/postboxBodyPlaceholder';

// A body whose tracker host is `fail-inventory.example` makes the resource
// inventory throw outside its per-element guard (the whole-body failure).
vi.mock('@owlat/shared/postboxTrackers', async (importOriginal) => {
	const actual = await importOriginal<typeof SharedTrackers>();
	return {
		...actual,
		remoteResourceHost: (url: string | null) => {
			if (url?.includes('fail-inventory.example')) throw new Error('inventory failed');
			return actual.remoteResourceHost(url);
		},
	};
});

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

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
});

const iconStub = { props: ['name'], template: '<span />' };
const globalMount = {
	plugins: [createTestI18n()],
	components: { PostboxImageBanner, PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
	stubs: { NuxtLink: { props: ['to'], template: '<a><slot /></a>' } },
};

/** A newsletter body: one real image plus a 1x1 tracking pixel. */
const NEWSLETTER_HTML =
	'<p>Hello</p><img src="https://stratechery.com/hero.png" width="600" height="200">' +
	'<img src="https://track.example/open.gif" width="1" height="1">';

let messageSeq = 0;

function mountBody(
	options: { senderImagesAllowed?: boolean; fromAddress?: string; html?: string } = {}
) {
	// A fresh id per mount: the session render cache is keyed on it, and these
	// cases differ in options that the key already covers.
	getPostboxRenderCache().clear();
	return mount(PostboxMessageBody, {
		props: {
			message: {
				_id: `msg-allow-${++messageSeq}`,
				htmlBodyInline: options.html ?? NEWSLETTER_HTML,
				fromAddress: options.fromAddress ?? 'Ben <news@stratechery.com>',
			},
			senderImagesAllowed: options.senderImagesAllowed ?? false,
		},
		global: globalMount,
	});
}

function srcdoc(wrapper: ReturnType<typeof mountBody>): string {
	return wrapper.find('iframe').attributes('srcdoc') ?? '';
}

describe('PostboxMessageBody remote-image allowlist', () => {
	it('blocks images and offers the per-sender grant for an untrusted sender', async () => {
		const w = mountBody();
		await nextTick();
		expect(w.text()).toContain('Images blocked');
		expect(w.text()).toContain('stratechery.com');
		expect(srcdoc(w)).toContain('data-blocked-img');
	});

	it('offers no "Always for…" button when the From header holds no address', async () => {
		const w = mountBody({ fromAddress: 'Ben Thompson' });
		await nextTick();
		expect(w.text()).toContain('Images blocked');
		expect(w.text()).not.toContain('Always for');
	});

	it('loads a trusted sender’s images with no click and no blocked banner', async () => {
		const w = mountBody({ senderImagesAllowed: true });
		await nextTick();
		expect(w.text()).not.toContain('Images blocked');
		expect(srcdoc(w)).not.toContain('data-blocked-img');
		expect(srcdoc(w)).toContain('https://stratechery.com/hero.png');
	});

	it('still strips the tracking pixel for a trusted sender', async () => {
		const w = mountBody({ senderImagesAllowed: true });
		await nextTick();
		// The real image is in; the 1x1 beacon is not.
		expect(srcdoc(w)).toContain('https://stratechery.com/hero.png');
		expect(srcdoc(w)).not.toContain('track.example/open.gif');
	});

	it('emits the grant when "Always for…" is pressed, and shows images at once', async () => {
		const w = mountBody();
		await nextTick();
		const buttons = w.findAll('button');
		const always = buttons.find((b) => b.text().includes('Always for'));
		expect(always).toBeDefined();
		await always!.trigger('click');
		expect(w.emitted('trustSender')?.[0]).toEqual(['Ben <news@stratechery.com>']);
		await nextTick();
		expect(srcdoc(w)).not.toContain('data-blocked-img');
	});

	it('takes the images back when the grant is revoked', async () => {
		const w = mountBody({ senderImagesAllowed: true });
		await nextTick();
		expect(srcdoc(w)).not.toContain('data-blocked-img');

		await w.setProps({ senderImagesAllowed: false });
		await nextTick();
		expect(srcdoc(w)).toContain('data-blocked-img');
		expect(w.text()).toContain('Images blocked');
	});

	it('emits the revoke from the auto-loaded banner', async () => {
		const w = mountBody({ senderImagesAllowed: true });
		await nextTick();
		const block = w.findAll('button').find((b) => b.text().includes('Block again'));
		expect(block).toBeDefined();
		await block!.trigger('click');
		expect(w.emitted('untrustSender')?.[0]).toEqual(['Ben <news@stratechery.com>']);
	});

	it('gates CSS-background-only mail behind the banner and a no-network policy', async () => {
		const html =
			'<div style="background-image:url(https://bg.example/hero.png);width:600px">Sale</div>' +
			'<img src="data:image/gif;base64,R0lGOD" srcset="https://img.example/b.png 2x">';
		const w = mountBody({ html });
		await nextTick();
		expect(w.text()).toContain('Images blocked');
		expect(srcdoc(w)).toContain(POSTBOX_BODY_META_CSP_NO_REMOTE);
		expect(srcdoc(w)).not.toContain('bg.example');
		expect(srcdoc(w)).not.toContain('img.example');

		const show = w.findAll('button').find((b) => b.text().includes('Show'));
		expect(show).toBeDefined();
		await show!.trigger('click');
		await nextTick();
		expect(srcdoc(w)).toContain(POSTBOX_BODY_META_CSP);
		expect(srcdoc(w)).toContain('https://bg.example/hero.png');
		expect(srcdoc(w)).toContain('https://img.example/b.png 2x');
	});

	describe('when the body cannot be checked', () => {
		const UNCHECKED_HTML =
			'<p>Hello</p><img src="https://stratechery.com/hero.png" width="600" height="200">' +
			'<img src="https://fail-inventory.example/open.gif" width="1" height="1">';
		const UNCHECKED_COPY = "Images stay blocked because this message couldn't be checked safely.";

		function buttonLabels(w: ReturnType<typeof mountBody>): string[] {
			return w.findAll('button').map((b) => b.text());
		}

		it('says images stay blocked and offers only "Load everything"', async () => {
			const w = mountBody({ html: UNCHECKED_HTML });
			await nextTick();
			expect(w.text()).toContain(UNCHECKED_COPY);
			expect(buttonLabels(w)).toEqual(['Load everything']);
			expect(srcdoc(w)).toContain(POSTBOX_BODY_META_CSP_NO_REMOTE);

			await w.find('button').trigger('click');
			await nextTick();
			expect(w.text()).not.toContain(UNCHECKED_COPY);
			expect(srcdoc(w)).toContain(POSTBOX_BODY_META_CSP);
			expect(srcdoc(w)).toContain('https://stratechery.com/hero.png');
		});

		it('never claims a trusted sender’s images load automatically', async () => {
			const w = mountBody({ html: UNCHECKED_HTML, senderImagesAllowed: true });
			await nextTick();
			expect(w.text()).toContain(UNCHECKED_COPY);
			expect(w.text()).not.toContain('load automatically');
			expect(buttonLabels(w)).toEqual(['Load everything']);
			expect(srcdoc(w)).toContain(POSTBOX_BODY_META_CSP_NO_REMOTE);

			await w.find('button').trigger('click');
			await nextTick();
			expect(srcdoc(w)).toContain(POSTBOX_BODY_META_CSP);
			expect(srcdoc(w)).toContain('https://fail-inventory.example/open.gif');
		});
	});
});
