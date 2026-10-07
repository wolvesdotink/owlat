// @vitest-environment happy-dom
/**
 * The message card's reduced cut, for Answer mode (plan §09):
 *   - no Star / Reply / Reply all / Forward / ⋯ row (you are already replying);
 *   - the trust chip only when something is off (verified is the quiet default);
 *   - To/Cc, the unsubscribe chip and the message details behind a click on
 *     the sender name, which in the full card opens the sender profile.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

import PostboxReaderMessage from '../PostboxReaderMessage.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const marker = (name: string, props: string[] = []) =>
	defineComponent({
		name,
		props,
		setup: (p) => () =>
			h('div', { 'data-testid': name, 'data-hide-when-ok': String(p['hideWhenOk'] === true) }),
	});
const passThrough = (name: string) =>
	defineComponent({
		name,
		setup:
			(_p, { slots }) =>
			() =>
				h('div', slots.default?.()),
	});

const message = {
	_id: 'msg_1',
	mailboxId: 'mbx_1',
	threadId: 'thr_1',
	fromAddress: 'jonas@example.com',
	fromName: 'Jonas Berg',
	toAddresses: ['ada@example.com'],
	ccAddresses: ['finance@example.com'],
	subject: 'September invoice',
	receivedAt: Date.UTC(2026, 8, 30, 9, 14),
	hasAttachments: false,
	attachments: [],
	unsubscribe: { mailto: 'unsubscribe@example.com' },
};

function mountCard(reduced: boolean) {
	return mount(PostboxReaderMessage, {
		props: {
			message: message as never,
			mailboxId: 'mbx_1',
			expanded: true,
			relativeTime: '2h',
			starred: false,
			showReplyAll: true,
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
				PostboxTrustChip: marker('PostboxTrustChip', ['hideWhenOk']),
				PostboxUnsubscribeChip: marker('PostboxUnsubscribeChip'),
				PostboxMessageDetails: marker('PostboxMessageDetails'),
				PostboxReaderMessageActions: marker('PostboxReaderMessageActions'),
				PostboxLazyBody: passThrough('PostboxLazyBody'),
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

const has = (w: ReturnType<typeof mountCard>, id: string) =>
	w.find(`[data-testid="${id}"]`).exists();

describe('PostboxReaderMessage reduced', () => {
	it('drops the action row and keeps the body', () => {
		const w = mountCard(true);
		expect(has(w, 'PostboxReaderMessageActions')).toBe(false);
		expect(has(w, 'PostboxMessageBody')).toBe(true);
		expect(has(mountCard(false), 'PostboxReaderMessageActions')).toBe(true);
	});

	it('asks the trust chip to stay quiet while the sender checks out', () => {
		expect(
			mountCard(true).get('[data-testid="PostboxTrustChip"]').attributes('data-hide-when-ok')
		).toBe('true');
		expect(
			mountCard(false).get('[data-testid="PostboxTrustChip"]').attributes('data-hide-when-ok')
		).toBe('false');
	});

	it('folds recipients, unsubscribe and details behind the sender name', async () => {
		const w = mountCard(true);
		expect(w.text()).not.toContain('ada@example.com');
		expect(has(w, 'PostboxUnsubscribeChip')).toBe(false);
		expect(has(w, 'PostboxMessageDetails')).toBe(false);

		const sender = w.get('button[aria-expanded]');
		await sender.trigger('click');
		expect(sender.attributes('aria-expanded')).toBe('true');
		expect(w.text()).toContain('ada@example.com');
		expect(has(w, 'PostboxUnsubscribeChip')).toBe(true);
		expect(has(w, 'PostboxMessageDetails')).toBe(true);
		// The sender profile is still one click away from there.
		const profile = w.findAll('button').find((b) => b.text() === 'Everything from this sender');
		expect(profile).toBeDefined();
		await profile!.trigger('click');
		expect(w.emitted('open-sender-profile')).toHaveLength(1);
	});

	it('keeps the full card as it was: recipients shown, the name opens the profile', async () => {
		const w = mountCard(false);
		expect(w.text()).toContain('ada@example.com');
		await w.findAll('button')[0]!.trigger('click');
		expect(w.emitted('open-sender-profile')).toHaveLength(1);
	});
});
