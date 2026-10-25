/**
 * Answer mode's conversation column (v1):
 *   - the thread newest last, every card in its reduced cut;
 *   - "Overview" opens the newest and the unread messages and leaves the rest
 *     as one-line rows (the thread's first message too, unlike the reader);
 *   - "Conversation" opens everything loaded, and going back restores
 *     the summary set;
 *   - the brief has a slot at the top, and the top bar gets the count.
 *
 * The thread paging composables are replaced by a fixed page: the paging has
 * its own suites; what is under test is what this column does with it.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { defineComponent, h, ref, computed, nextTick } from 'vue';
import { mount } from '@vue/test-utils';

import AnswerConversation from '../AnswerConversation.vue';
import PostboxReaderMessage from '~/components/postbox/PostboxReaderMessage.vue';
import { usePostboxReaderContext } from '~/composables/postbox/usePostboxReaderContext';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: {
		mail: { identities: { listForOwnedMailbox: {} }, messageActions: { markThreadRead: {} } },
	},
}));

const row = (id: string, receivedAt: number, flagSeen = true) => ({
	_id: id,
	mailboxId: 'mbx_1',
	threadId: 'thr_1',
	fromAddress: id === 'm2' ? 'ada@example.com' : 'jonas@example.com',
	fromName: id === 'm2' ? 'Ada' : 'Jonas',
	toAddresses: ['ada@example.com'],
	ccAddresses: [],
	subject: 'September invoice',
	receivedAt,
	flagSeen,
	hasAttachments: false,
	attachments: [],
	textBodyInline: `Body of ${id}`,
});
const THREAD = [row('m1', 1), row('m2', 2), row('m3', 3, false), row('m4', 4), row('m5', 5)];

vi.mock('~/composables/postbox/usePostboxThreadPages', () => ({
	usePostboxThreadPages: () => ({
		newest: { data: ref({ thread: { _id: 'thr_1', messageCount: 5 }, messages: THREAD }) },
		hasUnread: computed(() => THREAD.some((m) => !m.flagSeen)),
		rows: computed(() => THREAD),
		newestRows: computed(() => THREAD),
		bodyIds: computed(() => new Set(THREAD.map((m) => m._id))),
		startsThread: computed(() => true),
		hasEarlier: ref(false),
		loadingEarlier: ref(false),
		earlierFailed: ref(false),
		loadEarlier: vi.fn(),
	}),
	usePostboxEnvelopeBodies: (source: { rows: () => unknown[] }) => computed(() => source.rows()),
}));
vi.mock('~/composables/postbox/usePostboxReaderOpenRow', () => ({
	usePostboxReaderOpenRow: (source: { message: () => unknown }) => computed(() => source.message()),
}));
vi.mock('~/composables/useNow', () => ({ useNow: () => ref(0) }));

const markRead = vi.fn();
const markReadPolicy = ref('immediate');

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		usePostboxSenderBodyOpen: vi.fn(),
		usePostboxSettings: () => ({ markReadPolicy }),
		useBackendOperation: () => ({ run: markRead }),
		useFeatureFlag: () => ({ isEnabled: () => true }),
		useConvexQuery: () => ({ data: ref(['ada@example.com']) }),
		useAppTheme: () => ({ isDark: ref(false) }),
		usePostboxForcedLight: () => ({ isForcedLight: () => false, toggleForcedLight: vi.fn() }),
		usePostboxImageAllowlist: () => ({ isAllowed: () => false, allow: vi.fn(), revoke: vi.fn() }),
		usePostboxReaderAttachments: () => ({
			downloadingAttachment: ref(null),
			lightbox: ref(null),
			handleAttachmentDownload: vi.fn(),
			openAttachmentPreview: vi.fn(),
			loadLightboxPart: vi.fn(),
			downloadLightboxAttachment: vi.fn(),
		}),
	});
});

const CardStub = defineComponent({
	name: 'PostboxReaderMessage',
	props: {
		message: { type: Object, required: true },
		expanded: Boolean,
		showSenderControls: Boolean,
	},
	emits: ['toggle-expanded'],
	setup(props, { emit }) {
		const reader = usePostboxReaderContext();
		return () =>
			h(
				'button',
				{
					'data-testid': 'card',
					'data-id': (props.message as { _id: string })._id,
					'data-expanded': String(props.expanded),
					'data-reduced': String(reader.reduced),
					onClick: () => emit('toggle-expanded'),
				},
				(props.message as { _id: string })._id
			);
	},
});
const inert = (name: string) => defineComponent({ name, setup: () => () => h('div') });

function mountColumn(slots: Record<string, string> = {}) {
	return mount(AnswerConversation, {
		props: { message: THREAD[4]! as never },
		slots,
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxReaderMessage: CardStub,
				PostboxThreadEarlier: inert('PostboxThreadEarlier'),
				PostboxSenderProfile: inert('PostboxSenderProfile'),
				PostboxAttachmentLightbox: inert('PostboxAttachmentLightbox'),
			},
		},
	});
}

const expandedIds = (w: ReturnType<typeof mountColumn>) =>
	w
		.findAll('[data-testid="card"]')
		.filter((c) => c.attributes('data-expanded') === 'true')
		.map((c) => c.attributes('data-id'));

describe('AnswerConversation', () => {
	it('shows the thread newest last, every card in its reduced cut', () => {
		const w = mountColumn();
		const cards = w.findAll('[data-testid="card"]');
		expect(cards.map((c) => c.attributes('data-id'))).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
		expect(cards.every((c) => c.attributes('data-reduced') === 'true')).toBe(true);
	});

	it('opens only the newest and the unread messages in the summary view', () => {
		expect(expandedIds(mountColumn())).toEqual(['m3', 'm5']);
	});

	it('opens everything in the full view and restores the summary on the way back', async () => {
		const w = mountColumn();
		await w.get('[data-testid="answer-view-full"]').trigger('click');
		expect(w.emitted('update:view')?.[0]).toEqual(['full']);
		await w.setProps({ view: 'full' });
		expect(expandedIds(w)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
		await w.setProps({ view: 'summary' });
		expect(expandedIds(w)).toEqual(['m3', 'm5']);
	});

	it('still opens a single row on click', async () => {
		const w = mountColumn();
		await w.findAll('[data-testid="card"]')[0]!.trigger('click');
		await nextTick();
		expect(expandedIds(w)).toEqual(['m1', 'm3', 'm5']);
	});

	it('keeps a place for the brief and reports the count', () => {
		const w = mountColumn({ brief: '<aside data-testid="brief">Overview</aside>' });
		const children = w.get('[data-testid="answer-conversation"]').element.children;
		// The card comes before the first message.
		const order = Array.from(children).map((el) => el.getAttribute('data-testid'));
		expect(order.indexOf('brief')).toBeLessThan(order.indexOf('card'));
		expect(w.emitted('count')?.[0]).toEqual([5]);
	});

	it('lets the card reveal a source message: opened, scrolled to and flashed', async () => {
		const scrolled: string[] = [];
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function (this: Element) {
			scrolled.push(this.getAttribute('data-answer-message') ?? '');
		};
		let reveal!: (id: string) => Promise<void>;
		const w = mount(AnswerConversation, {
			props: { message: THREAD[4]! as never },
			slots: {
				brief: (props: { reveal: (id: string) => Promise<void> }) => {
					reveal = props.reveal;
					return h('aside');
				},
			},
			attachTo: document.body,
			global: {
				plugins: [createTestI18n()],
				components: {
					PostboxReaderMessage: CardStub,
					PostboxThreadEarlier: inert('PostboxThreadEarlier'),
					PostboxSenderProfile: inert('PostboxSenderProfile'),
					PostboxAttachmentLightbox: inert('PostboxAttachmentLightbox'),
				},
			},
		});
		await reveal('m1');
		await nextTick();
		expect(expandedIds(w)).toContain('m1');
		expect(scrolled).toEqual(['m1']);
		expect(w.get('[data-answer-message="m1"]').classes()).toContain('ring-2');
		Element.prototype.scrollIntoView = original;
		w.unmount();
	});

	it('does not offer sender controls on our own messages', () => {
		const w = mountColumn();
		const own = w
			.findAllComponents(CardStub)
			.find((c) => (c.props('message') as { _id: string })._id === 'm2');
		expect(own?.props('showSenderControls')).toBe(false);
	});

	it('renders the real card in its reduced cut, on the answered mailbox, chrome in place', () => {
		const marker = (name: string) =>
			defineComponent({
				name,
				props: ['mailboxId', 'hideWhenOk'],
				setup: (p) => () =>
					h('div', {
						'data-testid': name,
						'data-mailbox-id': String(p['mailboxId']),
						'data-hide-when-ok': String(p['hideWhenOk']),
					}),
			});
		const w = mount(AnswerConversation, {
			props: { message: { ...THREAD[4]!, mailboxId: 'mbx_answered' } as never },
			global: {
				plugins: [createTestI18n()],
				components: {
					PostboxReaderMessage,
					UiAvatar: marker('UiAvatar'),
					PostboxTrustChip: marker('PostboxTrustChip'),
					PostboxReaderMessageActions: marker('PostboxReaderMessageActions'),
					PostboxLazyBody: marker('PostboxLazyBody'),
					PostboxMessageAttachments: marker('PostboxMessageAttachments'),
					PostboxUnsubscribeChip: marker('PostboxUnsubscribeChip'),
					PostboxMessageDetails: marker('PostboxMessageDetails'),
					PostboxSchedulingChip: marker('PostboxSchedulingChip'),
					PostboxDeliveryStrip: marker('PostboxDeliveryStrip'),
					PostboxReaderSkeleton: marker('PostboxReaderSkeleton'),
					PostboxSecurityBadge: marker('PostboxSecurityBadge'),
					PostboxMessageBody: marker('PostboxMessageBody'),
					PostboxInviteCard: marker('PostboxInviteCard'),
					PostboxThreadEarlier: inert('PostboxThreadEarlier'),
					PostboxSenderProfile: inert('PostboxSenderProfile'),
					PostboxAttachmentLightbox: inert('PostboxAttachmentLightbox'),
				},
				stubs: { Icon: true },
			},
		});
		const cards = w.findAll('section[data-message-id]');
		expect(cards.map((c) => c.attributes('data-message-id'))).toEqual(['m3', 'm5']);
		expect(w.find('[data-testid="PostboxReaderMessageActions"]').exists()).toBe(false);
		const chips = w.findAll('[data-testid="PostboxTrustChip"]');
		expect(chips).toHaveLength(2);
		for (const chip of chips) {
			expect(chip.attributes('data-hide-when-ok')).toBe('true');
			expect(chip.attributes('data-mailbox-id')).toBe('mbx_answered');
		}
	});

	it('reads the conversation it answers, under the mark-read policy', () => {
		markRead.mockClear();
		markReadPolicy.value = 'immediate';
		mountColumn();
		expect(markRead).toHaveBeenCalledWith({ threadId: 'thr_1', seen: true });

		markRead.mockClear();
		markReadPolicy.value = 'manual';
		mountColumn();
		expect(markRead).not.toHaveBeenCalled();
	});
});
