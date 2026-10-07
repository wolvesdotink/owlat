// @vitest-environment happy-dom
/**
 * A collapsed message in a personal thread reads its own "Latest update"
 * sentence instead of the raw snippet (SPEC §7, plan §4.2), under the same
 * `signedOnly` gate as the snippet: a clearsigned message shows neither. A
 * cited message is marked and hands its quote to the body.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

import PostboxReaderMessage from '../PostboxReaderMessage.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('requireConvex', () => ({ action: vi.fn() }));
});

const marker = (name: string, props: string[] = []) =>
	defineComponent({
		name,
		props,
		setup: (p) => () =>
			h('div', {
				'data-testid': name,
				'data-quote': JSON.stringify((p as Record<string, unknown>)['highlightQuote'] ?? null),
			}),
	});
const passThrough = (name: string) =>
	defineComponent({
		name,
		setup:
			(_p, { slots }) =>
			() =>
				h('div', slots.default?.()),
	});

const base = {
	_id: 'msg_1',
	mailboxId: 'mbx_1',
	threadId: 'thr_1',
	fromAddress: 'jonas@example.com',
	fromName: 'Jonas Weber',
	toAddresses: ['ada@example.com'],
	ccAddresses: [],
	subject: 'Website relaunch',
	snippet: 'v2 looks great, the team loves it. Two changes: could',
	receivedAt: Date.UTC(2026, 9, 7, 9, 12),
	hasAttachments: false,
	attachments: [],
};

function mountCard(props: Record<string, unknown>, message: Record<string, unknown> = {}) {
	return mount(PostboxReaderMessage, {
		props: {
			message: { ...base, ...message } as never,
			mailboxId: 'mbx_1',
			expanded: false,
			relativeTime: '2h',
			starred: false,
			showReplyAll: false,
			showSenderControls: true,
			authEnabled: false,
			sealedEnabled: false,
			secureClass: 'none' as never,
			hideBody: false,
			showRenderToggle: false,
			forcedLight: false,
			imagesAllowed: false,
			hasInvite: false,
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				UiAvatar: marker('UiAvatar'),
				PostboxTrustChip: marker('PostboxTrustChip'),
				PostboxUnsubscribeChip: marker('PostboxUnsubscribeChip'),
				PostboxMessageDetails: passThrough('PostboxMessageDetails'),
				PostboxReaderMessageActions: marker('PostboxReaderMessageActions'),
				PostboxLazyBody: passThrough('PostboxLazyBody'),
				PostboxMessageBody: marker('PostboxMessageBody', ['highlightQuote']),
				PostboxMessageAttachments: marker('PostboxMessageAttachments'),
				PostboxReaderSkeleton: marker('PostboxReaderSkeleton'),
				PostboxSchedulingChip: marker('PostboxSchedulingChip'),
				PostboxDeliveryStrip: marker('PostboxDeliveryStrip'),
				PostboxSecurityBadge: marker('PostboxSecurityBadge'),
				PostboxInviteCard: marker('PostboxInviteCard'),
			},
			stubs: { Icon: true },
		},
	});
}

describe('PostboxReaderMessage · latest line and cite', () => {
	it('a collapsed row shows its latest line instead of the snippet', () => {
		const w = mountCard({ latestLine: 'Jonas likes v2 and wants two changes.' });
		expect(w.text()).toContain('Jonas likes v2 and wants two changes.');
		expect(w.text()).not.toContain('v2 looks great');
	});

	it('falls back to the snippet without a latest line', () => {
		expect(mountCard({ latestLine: null }).text()).toContain('v2 looks great');
	});

	it('shows neither for a message bound to its clearsigned block', () => {
		const w = mountCard(
			{ latestLine: 'Pay invoice 4471.', secureClass: 'pgp-clearsigned', hideBody: true },
			{
				textBodyInline:
					'-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nPay.\n-----BEGIN PGP SIGNATURE-----\n\nx\n-----END PGP SIGNATURE-----',
				inboundSignatureInfo: { isSigned: true, isSignatureValid: true, scope: 'clearsigned' },
			}
		);
		expect(w.text()).not.toContain('Pay invoice 4471.');
	});

	it('a cited message is marked and hands its quote and occurrence to the body', () => {
		const cite = { quote: 'approve that by Friday', occurrence: 1 };
		const w = mountCard({ expanded: true, citeQuote: cite });
		expect(w.get('section').classes()).toContain('ring-brand');
		expect(
			JSON.parse(w.get('[data-testid="PostboxMessageBody"]').attributes('data-quote')!)
		).toEqual(cite);
		expect(w.find('[data-testid="cite-not-located"]').exists()).toBe(false);
	});

	it('says so when the body cannot locate the exact passage', async () => {
		const w = mountCard({ expanded: true, citeQuote: { quote: 'approve', occurrence: 3 } });
		w.findComponent({ name: 'PostboxMessageBody' }).vm.$emit('cite-located', false);
		await w.vm.$nextTick();
		expect(w.get('[data-testid="cite-not-located"]').text()).toBe(
			"Couldn't locate the exact passage in this message."
		);
	});
});
