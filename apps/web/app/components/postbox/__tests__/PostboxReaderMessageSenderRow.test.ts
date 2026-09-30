// @vitest-environment happy-dom
/**
 * The message card's sender row at phone widths (plan §10): the trust chip ran
 * off the card's right edge at 390px, because the row never wrapped and the
 * chip never shrinks. happy-dom cannot lay out, so what is pinned is the
 * structure the fix relies on: a wrapping row, a sender that may shrink and
 * break its long address, and the chip's group pushed right on whatever line
 * it lands on (its popover opens leftwards from there, inside the card).
 *
 * Also the touch cue of the reduced card: its sender name is a disclosure, and
 * nothing but a hover underline said so.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

import PostboxReaderMessage from '../PostboxReaderMessage.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const marker = (name: string) =>
	defineComponent({ name, setup: () => () => h('div', { 'data-testid': name }) });

const message = {
	_id: 'msg_1',
	mailboxId: 'mbx_1',
	threadId: 'thr_1',
	fromAddress: 'accounts-receivable.notifications@brightpath-finance.example.com',
	fromName: 'Brightpath Finance Accounts Receivable',
	toAddresses: ['ada@example.com'],
	ccAddresses: [],
	subject: 'September invoice',
	receivedAt: Date.UTC(2026, 8, 30, 9, 14),
	hasAttachments: false,
	attachments: [],
};

function mountCard(reduced: boolean) {
	return mount(PostboxReaderMessage, {
		props: {
			message: message as never,
			mailboxId: 'mbx_1',
			expanded: true,
			relativeTime: '2h',
			starred: false,
			showReplyAll: false,
			showSenderControls: true,
			authEnabled: true,
			sealedEnabled: false,
			secureClass: 'none',
			hideBody: false,
			showRenderToggle: false,
			forcedLight: false,
			imagesAllowed: false,
			hasInvite: false,
			reduced,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				UiAvatar: marker('UiAvatar'),
				PostboxTrustChip: marker('PostboxTrustChip'),
				PostboxUnsubscribeChip: marker('PostboxUnsubscribeChip'),
				PostboxMessageDetails: marker('PostboxMessageDetails'),
				PostboxReaderMessageActions: marker('PostboxReaderMessageActions'),
				PostboxLazyBody: marker('PostboxLazyBody'),
				PostboxMessageBody: marker('PostboxMessageBody'),
				PostboxSecurityBadge: marker('PostboxSecurityBadge'),
				PostboxInviteCard: marker('PostboxInviteCard'),
				PostboxMessageAttachments: marker('PostboxMessageAttachments'),
				PostboxSchedulingChip: marker('PostboxSchedulingChip'),
				PostboxDeliveryStrip: marker('PostboxDeliveryStrip'),
				Icon: defineComponent({
					name: 'Icon',
					inheritAttrs: true,
					setup: () => () => h('span'),
				}),
			},
		},
	});
}

describe('PostboxReaderMessage sender row', () => {
	it('wraps, so the trust chip takes a line of its own when the sender is long', () => {
		for (const reduced of [false, true]) {
			const row = mountCard(reduced).get('[data-testid="reader-message-sender-row"]');
			expect(row.classes()).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
		}
	});

	it('lets the sender shrink and break its address instead of pushing the chip out', () => {
		const row = mountCard(false).get('[data-testid="reader-message-sender-row"]');
		const sender = row.get('button');
		expect(sender.text()).toContain(message.fromAddress);
		expect(sender.classes()).toEqual(expect.arrayContaining(['min-w-0', 'break-words']));
	});

	it('keeps the chip and the time together, right-aligned and never wider than the card', () => {
		const indicators = mountCard(false).get('[data-testid="reader-message-indicators"]');
		expect(indicators.find('[data-testid="PostboxTrustChip"]').exists()).toBe(true);
		expect(indicators.text()).toContain('2h');
		expect(indicators.classes()).toEqual(
			expect.arrayContaining(['ml-auto', 'max-w-full', 'flex-shrink-0'])
		);
	});
});

describe('PostboxReaderMessage reduced disclosure cue', () => {
	it('shows a chevron on the sender name, turned while the details are open', async () => {
		const w = mountCard(true);
		const cue = () => w.get('[data-testid="reader-message-details-cue"]');
		expect(cue().classes()).not.toContain('rotate-180');
		await w.get('button[aria-expanded]').trigger('click');
		expect(cue().classes()).toContain('rotate-180');
	});

	it('has no chevron on the full card, where the name opens the sender profile', () => {
		expect(mountCard(false).find('[data-testid="reader-message-details-cue"]').exists()).toBe(
			false
		);
	});
});
