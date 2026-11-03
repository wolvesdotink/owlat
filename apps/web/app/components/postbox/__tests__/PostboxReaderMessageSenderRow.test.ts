/**
 * The message card's sender row at phone widths: the trust chip ran
 * off the card's right edge at 390px, because the row never wrapped and the
 * chip never shrinks. The wrap is for phones only; desktop keeps one line. happy-dom cannot lay out, so what is pinned is the
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
import { readerContextProvide } from './readerContextFixture';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { tooltipOf } from '~/__tests__/tooltip';
import { formatDateTime } from '~/utils/formatters';

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		usePostboxSenderBodyOpen: () => ({ shownBody: { value: null } }),
	});
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
			expanded: true,
			relativeTime: '2h',
			starred: false,
			showReplyAll: false,
			showSenderControls: true,
			secureClass: 'none',
			hideBody: false,
			forcedLight: false,
			images: { senderImagesAllowed: false, autoLoadImages: false, suspicious: false },
			hasInvite: false,
		},
		global: {
			plugins: [createTestI18n()],
			provide: readerContextProvide({ authEnabled: true, reduced }),
			components: {
				UiAvatar: marker('UiAvatar'),
				PostboxTrustChip: marker('PostboxTrustChip'),
				PostboxUnsubscribeChip: marker('PostboxUnsubscribeChip'),
				PostboxMessageDetails: marker('PostboxMessageDetails'),
				PostboxReaderMessageActions: marker('PostboxReaderMessageActions'),
				PostboxLazyBody: marker('PostboxLazyBody'),
				PostboxMessageBody: marker('PostboxMessageBody'),
				PostboxSecurityBadge: marker('PostboxSecurityBadge'),
				PostboxReaderSkeleton: marker('PostboxReaderSkeleton'),
				PostboxInviteCard: marker('PostboxInviteCard'),
				PostboxMessageAttachments: marker('PostboxMessageAttachments'),
				PostboxSchedulingChip: marker('PostboxSchedulingChip'),
				PostboxDeliveryStrip: marker('PostboxDeliveryStrip'),
			},
		},
	});
}

describe('PostboxReaderMessage sender row', () => {
	it('wraps on a phone, so the trust chip takes a line of its own when the sender is long', () => {
		for (const reduced of [false, true]) {
			const row = mountCard(reduced).get('[data-testid="reader-message-sender-row"]');
			expect(row.classes()).toEqual(expect.arrayContaining(['flex', 'max-sm:flex-wrap']));
		}
	});

	it('also wraps when the reader pane itself is narrow (a container query, not the viewport)', () => {
		const row = mountCard(false).get('[data-testid="reader-message-sender-row"]');
		expect(row.classes()).toContain('@max-lg:flex-wrap');
	});

	it('stays one line from sm up, as the desktop reader always was', () => {
		const row = mountCard(false).get('[data-testid="reader-message-sender-row"]');
		// An unconditional wrap made every expanded header a line taller at 1440px.
		expect(row.classes()).not.toContain('flex-wrap');
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

describe('PostboxReaderMessage sender row tooltips', () => {
	it('says what the sender name opens in a tooltip, not a native title', () => {
		for (const [reduced, text] of [
			[false, 'Everything from this sender'],
			[true, 'Show recipients and details'],
		] as const) {
			const w = mountCard(reduced);
			const sender = w.get('[data-testid="reader-message-sender-row"] button');
			expect(sender.attributes('title')).toBeUndefined();
			expect(tooltipOf(w, sender)).toBe(text);
		}
	});

	it('gives the relative time its full date in a tooltip', () => {
		const w = mountCard(false);
		const time = w
			.findAll('[data-testid="reader-message-indicators"] button')
			.find((button) => button.text() === '2h')!;
		expect(time.attributes('title')).toBeUndefined();
		expect(tooltipOf(w, time)).toBe(formatDateTime(message.receivedAt));
	});
});
