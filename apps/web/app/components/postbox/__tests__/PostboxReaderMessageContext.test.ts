/**
 * The message card reads what its reader shares (mailbox, flags, theme, the
 * reduced cut, printing, the downloading part, where its chrome renders) from
 * the reader context, not from props:
 *   - every shared value reaches the card's children;
 *   - a host that changes one after mount re-renders its cards in place;
 *   - two readers mounted side by side keep their own context;
 *   - the chrome placement is asked per message id;
 *   - a card without a reader around it fails loudly instead of rendering
 *     without its mailbox.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type PropType } from 'vue';
import { mount } from '@vue/test-utils';

import PostboxReaderMessage from '../PostboxReaderMessage.vue';
import {
	providePostboxReaderContext,
	type PostboxReaderCardChrome,
} from '~/composables/postbox/usePostboxReaderContext';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		usePostboxSenderBodyOpen: vi.fn(),
	});
});

const hyphenate = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** A child stand-in that renders the props it was given as data attributes. */
const marker = (name: string, props: string[] = []) =>
	defineComponent({
		name,
		props,
		setup:
			(p, { slots }) =>
			() =>
				h(
					'div',
					{
						'data-testid': name,
						...Object.fromEntries(props.map((key) => [`data-${hyphenate(key)}`, String(p[key])])),
					},
					slots.default?.()
				),
	});

/** The body stand-in: its image banner stays beside it unless given a target. */
const BodyMarker = defineComponent({
	name: 'PostboxMessageBody',
	props: { imageBannerTo: { type: Object as PropType<HTMLElement | null>, default: null } },
	setup: (props) => () =>
		h('div', { 'data-testid': 'PostboxMessageBody' }, [
			props.imageBannerTo ? null : h('p', { 'data-testid': 'banner-in-place' }),
		]),
});

const components = {
	UiAvatar: marker('UiAvatar'),
	PostboxTrustChip: marker('PostboxTrustChip', [
		'mailboxId',
		'authEnabled',
		'sealedEnabled',
		'hideWhenOk',
	]),
	PostboxUnsubscribeChip: marker('PostboxUnsubscribeChip', ['mailboxId']),
	PostboxMessageDetails: marker('PostboxMessageDetails'),
	PostboxReaderMessageActions: marker('PostboxReaderMessageActions'),
	PostboxLazyBody: marker('PostboxLazyBody', ['eager']),
	PostboxMessageBody: BodyMarker,
	PostboxSecurityBadge: marker('PostboxSecurityBadge'),
	PostboxReaderSkeleton: marker('PostboxReaderSkeleton'),
	PostboxInviteCard: marker('PostboxInviteCard', ['mailboxId', 'ownEmail']),
	PostboxMessageAttachments: marker('PostboxMessageAttachments', ['downloadingKey']),
	PostboxSchedulingChip: marker('PostboxSchedulingChip'),
	PostboxDeliveryStrip: marker('PostboxDeliveryStrip'),
};

function message(id: string) {
	return {
		_id: id,
		// Each message's own mailbox: the card must use the READER's instead.
		mailboxId: `own_${id}`,
		threadId: 'thr_1',
		fromAddress: 'jonas@example.com',
		fromName: 'Jonas Berg',
		toAddresses: ['ada@example.com'],
		ccAddresses: [],
		subject: 'Planning',
		receivedAt: Date.UTC(2026, 9, 6, 9, 14),
		hasAttachments: true,
		attachments: [{ filename: 'invite.ics', contentType: 'text/calendar', size: 10 }],
		unsubscribe: { mailto: 'unsubscribe@example.com' },
		spamVerdict: 'spam',
	};
}

const cardProps = (id: string) => ({
	message: message(id) as never,
	expanded: true,
	relativeTime: '2h',
	starred: false,
	showReplyAll: false,
	showSenderControls: true,
	secureClass: 'none' as never,
	hideBody: false,
	forcedLight: false,
	images: { senderImagesAllowed: false, autoLoadImages: false, suspicious: false },
	hasInvite: true,
});

/** A minimal reader: provides its context from refs and renders its cards. */
function makeHost() {
	const state = {
		mailboxId: ref('mbx_reader'),
		authEnabled: ref(true),
		sealedEnabled: ref(false),
		appIsDark: ref(false),
		ownEmail: ref<string | undefined>('ada@example.com'),
		downloadingAttachment: ref<string | null>(null),
		eagerBody: ref(false),
		reduced: ref(false),
		chrome: ref<Record<string, PostboxReaderCardChrome>>({}),
	};
	const chromeOf = vi.fn(
		(id: string) =>
			state.chrome.value[id] ?? { detailsTo: null, imageBannerTo: null, hideDanger: false }
	);
	const Host = defineComponent({
		name: 'TestReaderHost',
		props: { ids: { type: Array as PropType<string[]>, required: true } },
		setup(props) {
			providePostboxReaderContext({
				mailboxId: state.mailboxId,
				authEnabled: state.authEnabled,
				sealedEnabled: state.sealedEnabled,
				appIsDark: state.appIsDark,
				ownEmail: state.ownEmail,
				downloadingAttachment: state.downloadingAttachment,
				eagerBody: state.eagerBody,
				reduced: () => state.reduced.value,
				chromeOf,
			});
			return () =>
				h(
					'div',
					props.ids.map((id) => h(PostboxReaderMessage, { key: id, ...cardProps(id) }))
				);
		},
	});
	return { state, chromeOf, Host };
}

const mountOptions = {
	global: { plugins: [createTestI18n()], components, stubs: { Icon: true } },
};

type Wrapper = ReturnType<typeof mount>;
const attr = (w: Wrapper, testId: string, name: string) =>
	w.get(`[data-testid="${testId}"]`).attributes(`data-${name}`);

describe('PostboxReaderMessage · reader context', () => {
	it('reads the shared values from the reader, not from per-card props', () => {
		const { Host } = makeHost();
		const w = mount(Host, { props: { ids: ['m1'] }, ...mountOptions });

		expect(attr(w, 'PostboxTrustChip', 'mailbox-id')).toBe('mbx_reader');
		expect(attr(w, 'PostboxTrustChip', 'auth-enabled')).toBe('true');
		expect(attr(w, 'PostboxTrustChip', 'sealed-enabled')).toBe('false');
		expect(attr(w, 'PostboxTrustChip', 'hide-when-ok')).toBe('false');
		expect(attr(w, 'PostboxUnsubscribeChip', 'mailbox-id')).toBe('mbx_reader');
		expect(attr(w, 'PostboxInviteCard', 'mailbox-id')).toBe('mbx_reader');
		expect(attr(w, 'PostboxInviteCard', 'own-email')).toBe('ada@example.com');
		expect(attr(w, 'PostboxLazyBody', 'eager')).toBe('false');
		expect(attr(w, 'PostboxMessageAttachments', 'downloading-key')).toBe('null');
		expect(w.find('[data-testid="PostboxReaderMessageActions"]').exists()).toBe(true);
		// Light app: no light-render escape hatch.
		expect(w.find('button[aria-pressed]').exists()).toBe(false);
		// No chrome placement: the danger line stays in the card.
		expect(w.text()).toContain('Marked as spam');
	});

	it('re-renders mounted cards when the reader changes a shared value', async () => {
		const { state, Host } = makeHost();
		const w = mount(Host, { props: { ids: ['m1'] }, ...mountOptions });

		state.mailboxId.value = 'mbx_other';
		state.authEnabled.value = false;
		state.sealedEnabled.value = true;
		state.appIsDark.value = true;
		state.ownEmail.value = 'team@example.com';
		state.downloadingAttachment.value = 'm1:2';
		state.eagerBody.value = true;
		await nextTick();

		expect(attr(w, 'PostboxTrustChip', 'mailbox-id')).toBe('mbx_other');
		expect(attr(w, 'PostboxTrustChip', 'auth-enabled')).toBe('false');
		expect(attr(w, 'PostboxTrustChip', 'sealed-enabled')).toBe('true');
		expect(attr(w, 'PostboxUnsubscribeChip', 'mailbox-id')).toBe('mbx_other');
		expect(attr(w, 'PostboxInviteCard', 'mailbox-id')).toBe('mbx_other');
		expect(attr(w, 'PostboxInviteCard', 'own-email')).toBe('team@example.com');
		expect(attr(w, 'PostboxLazyBody', 'eager')).toBe('true');
		expect(attr(w, 'PostboxMessageAttachments', 'downloading-key')).toBe('m1:2');
		expect(w.find('button[aria-pressed]').exists()).toBe(true);

		state.reduced.value = true;
		await nextTick();
		expect(attr(w, 'PostboxTrustChip', 'hide-when-ok')).toBe('true');
		expect(w.find('[data-testid="PostboxReaderMessageActions"]').exists()).toBe(false);
	});

	it('keeps two readers mounted side by side apart', async () => {
		const a = makeHost();
		const b = makeHost();
		b.state.mailboxId.value = 'mbx_b';
		b.state.reduced.value = true;
		const Pair = defineComponent({
			setup: () => () =>
				h('div', [
					h('section', { id: 'a' }, [h(a.Host, { ids: ['m1'] })]),
					h('section', { id: 'b' }, [h(b.Host, { ids: ['m1'] })]),
				]),
		});
		const w = mount(Pair, mountOptions);
		const chip = (side: string) => w.get(`#${side} [data-testid="PostboxTrustChip"]`);

		expect(chip('a').attributes('data-mailbox-id')).toBe('mbx_reader');
		expect(chip('b').attributes('data-mailbox-id')).toBe('mbx_b');
		expect(w.find('#a [data-testid="PostboxReaderMessageActions"]').exists()).toBe(true);
		expect(w.find('#b [data-testid="PostboxReaderMessageActions"]').exists()).toBe(false);

		a.state.mailboxId.value = 'mbx_a2';
		await nextTick();
		expect(chip('a').attributes('data-mailbox-id')).toBe('mbx_a2');
		expect(chip('b').attributes('data-mailbox-id')).toBe('mbx_b');
	});

	it('asks for each card its own chrome placement and follows a change of target', async () => {
		const details = document.createElement('div');
		document.body.appendChild(details);
		const { state, chromeOf, Host } = makeHost();
		const w = mount(Host, {
			props: { ids: ['m1', 'm2'] },
			...mountOptions,
			attachTo: document.body,
		});

		expect(chromeOf).toHaveBeenCalledWith('m1');
		expect(chromeOf).toHaveBeenCalledWith('m2');
		expect(details.querySelector('[data-testid="PostboxTrustChip"]')).toBeNull();

		// m2 becomes the latest: its chips go to Details and the danger to the notice slot.
		state.chrome.value = { m2: { detailsTo: details, imageBannerTo: details, hideDanger: true } };
		await nextTick();

		const cards = w.findAll('section[data-message-id]');
		expect(cards).toHaveLength(2);
		const [m1, m2] = cards;
		expect(m1!.find('[data-testid="PostboxTrustChip"]').exists()).toBe(true);
		expect(m2!.find('[data-testid="PostboxTrustChip"]').exists()).toBe(false);
		expect(details.querySelectorAll('[data-testid="PostboxTrustChip"]')).toHaveLength(1);
		expect(details.querySelector('[data-testid="PostboxUnsubscribeChip"]')).not.toBeNull();
		expect(m1!.text()).toContain('Marked as spam');
		expect(m2!.text()).not.toContain('Marked as spam');
		expect(m1!.find('[data-testid="banner-in-place"]').exists()).toBe(true);
		expect(m2!.find('[data-testid="banner-in-place"]').exists()).toBe(false);

		w.unmount();
		details.remove();
	});

	it('refuses to render outside a reader', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(() => mount(PostboxReaderMessage, { props: cardProps('m1'), ...mountOptions })).toThrow(
			'reader context'
		);
		warn.mockRestore();
	});
});
