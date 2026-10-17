// @vitest-environment happy-dom
/**
 * Senders open counting (SPEC §5, review r3): a reader card counts its
 * message's first open from ONE signal, the readable body element its
 * renderer registers once the content is there, and only while that element
 * is on screen. Driven through the real renderers inside the real card wiring
 * (`usePostboxSenderBodyOpen`), with `markOpened` as the stubbed server call:
 *   - an inline body counts;
 *   - a blob body counts once its content lands, never for the skeleton;
 *   - a clearsigned body counts from the cleartext the security badge shows;
 *   - an expanded card whose body is off screen does not count.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref, type Component } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxSecurityBadge from '../PostboxSecurityBadge.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import {
	splitQuotedText,
	splitQuotedHtml,
} from '../../../composables/postbox/usePostboxQuotedText';
import { usePostboxSenderBodyOpen } from '~/composables/postbox/usePostboxSenderOpen';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const markOpened = vi.fn();
const action = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useBackendOperation', () => ({ run: markOpened }));
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

beforeEach(() => {
	markOpened.mockReset();
	action.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A reader card reduced to its open-count wiring, holding one body renderer. */
const Card = defineComponent({
	props: { expanded: { type: Boolean, default: true } },
	setup(props, { slots }) {
		usePostboxSenderBodyOpen({
			message: { _id: 'msg-1' },
			get expanded() {
				return props.expanded;
			},
		});
		return () => h('div', slots.default?.());
	},
});

function mountInCard(body: Component, bodyProps: Record<string, unknown>) {
	return mount(Card, {
		slots: { default: () => h(body, bodyProps) },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxReaderSkeleton, UiSkeleton },
			stubs: { Icon: true, PostboxImageBanner: true },
		},
	});
}

const counts = () => markOpened.mock.calls.length;

describe('Senders open counting from the readable body', () => {
	it('counts an inline body', async () => {
		mountInCard(PostboxMessageBody, {
			message: { _id: 'msg-1', textBodyInline: 'Hello, see you Friday.' },
		});
		await flushPromises();
		expect(markOpened.mock.calls).toEqual([[{ messageId: 'msg-1' }]]);
	});

	it('counts a blob body once its content lands, never for the skeleton', async () => {
		let resolveBody: ((value: unknown) => void) | undefined;
		action.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveBody = resolve;
				})
		);
		const w = mountInCard(PostboxMessageBody, {
			message: { _id: 'msg-1', htmlBodyStorageId: 'blob-1' },
		});
		await flushPromises();
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(true);
		expect(counts()).toBe(0);

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ text: async () => '<p>live body</p>' }))
		);
		resolveBody?.({ htmlUrl: 'https://storage.example/live', textUrl: null });
		await flushPromises();
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(false);
		expect(markOpened.mock.calls).toEqual([[{ messageId: 'msg-1' }]]);

		// A later re-render of the same body never counts again.
		await w.setProps({ expanded: true });
		await flushPromises();
		expect(counts()).toBe(1);
	});

	it('counts a clearsigned body from the cleartext the security badge shows', async () => {
		mountInCard(PostboxSecurityBadge, {
			klass: 'pgp-clearsigned',
			message: {
				_id: 'msg-1',
				textBodyInline:
					'-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nHello there\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n',
			},
		});
		await flushPromises();
		expect(markOpened.mock.calls).toEqual([[{ messageId: 'msg-1' }]]);
	});

	it('does not count an expanded card whose body is off screen', async () => {
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
			top: 5000,
			bottom: 5400,
			left: 0,
			right: 600,
		} as DOMRect);
		mountInCard(PostboxMessageBody, {
			message: { _id: 'msg-1', textBodyInline: 'Far below the fold.' },
		});
		await flushPromises();
		expect(counts()).toBe(0);
	});
});
