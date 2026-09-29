// @vitest-environment happy-dom
/**
 * Plan 3.3: a long conversation reads in pages. The newest messages come with
 * their bodies, older ones render as collapsed envelopes that load their body
 * when expanded, and "Load earlier" at the top reads the page before them.
 *
 * Mounted in the Postbox a11y harness (real Postbox composables, inert shell
 * stubs); the thread and body queries answer per args.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, reactive, ref, useId } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { dashboardShellStubs, installNuxtStubs, paginatedResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useClickOutside } from '~/composables/useClickOutside';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';
import { earlierThreadPageArgs, threadPageArgs } from '~/composables/postbox/postboxThreadPage';

import PostboxThreadReader, { type PostboxReaderMessage } from '../PostboxThreadReader.vue';
import PostboxReaderMessageCard from '../PostboxReaderMessage.vue';
import PostboxThreadEarlier from '../PostboxThreadEarlier.vue';

const THREAD = 'mail/mailbox/messages:listThreadMessages';
const BODY = 'mail/mailbox/messages:getMessageInlineBody';

/** Postbox's own composables and pure helpers, at their real implementations. */
function autoImportedHelpers(): Record<string, unknown> {
	const modules = {
		...import.meta.glob('../../../composables/postbox/*.ts', { eager: true }),
		...import.meta.glob('../../../utils/postbox*.ts', { eager: true }),
	};
	const helpers: Record<string, unknown> = {};
	for (const module of Object.values(modules)) {
		for (const [name, value] of Object.entries(module as Record<string, unknown>)) {
			if (typeof value === 'function') helpers[name] = value;
		}
	}
	return helpers;
}

const keyOf = (name: string, args: unknown) => `${name}|${JSON.stringify(args)}`;
const answers = reactive(new Map<string, unknown>());
/** Args of every subscription the reader opened, skipped ones excluded. */
let opened: Array<{ name: string; args: unknown }>;

beforeEach(() => {
	answers.clear();
	opened = [];
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		...autoImportedHelpers(),
		useId,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useConvexQueryMap,
		usePaginatedQuery: () => paginatedResult([]),
		useOperationErrorToast: () => ({ showOperationError: vi.fn() }),
		POSTBOX_PENDING_COMPOSE_KEY: 'postbox:pending-compose',
		registerCommandPaletteProvider: vi.fn(),
		unregisterCommandPaletteProvider: vi.fn(),
		useRoute: () => ({ path: '/dashboard/postbox/inbox/m9', params: {}, query: {}, meta: {} }),
		useConvexQuery: (query: unknown, args: unknown) => {
			const name = getFunctionName(query as never);
			const resolved = computed(() => (typeof args === 'function' ? args() : args));
			const key = computed(() => {
				const value = resolved.value;
				if (value === 'skip' || value === undefined) return null;
				opened.push({ name, args: value });
				return keyOf(name, value);
			});
			return {
				data: computed(() => (key.value ? answers.get(key.value) : undefined)),
				isLoading: computed(() => !key.value || !answers.has(key.value)),
				isRefetching: ref(false),
				error: ref(null),
				refetch: vi.fn(),
				reset: vi.fn(),
			};
		},
	});
});

function row(id: string, receivedAt: number, extra: Partial<PostboxReaderMessage> = {}) {
	return {
		_id: id,
		mailboxId: 'mbx1',
		threadId: 't1',
		fromAddress: 'ines@example.com',
		fromName: `Sender ${id}`,
		toAddresses: ['ada@example.com'],
		ccAddresses: [],
		subject: 'Quarterly numbers',
		snippet: `Snippet ${id}`,
		receivedAt,
		hasAttachments: false,
		attachments: [],
		flagSeen: true,
		...extra,
	};
}

const passThrough = defineComponent({
	name: 'PostboxLazyBody',
	setup:
		(_p, { slots }) =>
		() =>
			h('div', slots.default?.()),
});
/** Shows which body the card handed the body component. */
const bodyProbe = defineComponent({
	name: 'PostboxMessageBody',
	props: { message: { type: Object, required: true } },
	setup: (props) => () =>
		h('div', {
			'data-testid': 'body',
			'data-id': props.message['_id'],
			'data-pending': String(props.message['bodyPending'] === true),
			'data-text': props.message['textBodyInline'] ?? '',
		}),
});
const marker = (name: string) =>
	defineComponent({ name, setup: () => () => h('div', { 'data-testid': name }) });

/** Reader and card chrome this suite does not look into. */
const CHROME = [
	'Icon',
	'UiAvatar',
	'PostboxAiStrip',
	'PostboxAttachmentLightbox',
	'PostboxCrossSurfaceStrip',
	'PostboxDeliveryStrip',
	'PostboxInlineReply',
	'PostboxInviteCard',
	'PostboxKeyChangeBanner',
	'PostboxLabelPickerDialog',
	'PostboxMessageAttachments',
	'PostboxMessageDetails',
	'PostboxMovePickerDialog',
	'PostboxOverflowMenu',
	'PostboxReaderSkeleton',
	'PostboxReplyGuard',
	'PostboxSchedulingChip',
	'PostboxSecurityBadge',
	'PostboxSenderProfile',
	'PostboxSnoozeDialog',
	'PostboxThreadDiscussion',
	'PostboxThreadDiscussionToggle',
	'PostboxThreadHeader',
	'PostboxTriageSuggestion',
	'PostboxTrustChip',
	'PostboxUnsubscribeChip',
];

function mountReader() {
	return mount(PostboxThreadReader, {
		props: { message: row('m9', 9), folderRole: 'inbox' },
		global: {
			plugins: [createTestI18n()],
			mocks: autoImportedHelpers(),
			components: {
				...Object.fromEntries(CHROME.map((name) => [name, marker(name)])),
				PostboxReaderMessage: PostboxReaderMessageCard,
				PostboxThreadEarlier,
				PostboxLazyBody: passThrough,
				PostboxMessageBody: bodyProbe,
			},
		},
	});
}

/** A 60-message thread whose newest page holds three of them. */
function answerNewestPage() {
	answers.set(keyOf(THREAD, threadPageArgs('m9')), {
		thread: { _id: 't1', messageCount: 60, unreadCount: 0 },
		labels: [],
		messages: [row('m9', 9, { textBodyInline: 'The newest message' })],
		envelopes: [row('m7', 7), row('m8', 8)],
		olderCursor: 'c1',
	});
}

const bodies = (w: ReturnType<typeof mountReader>) =>
	w.findAll('[data-testid="body"]').map((b) => b.attributes('data-id'));

describe('PostboxThreadReader on a long thread', () => {
	it('renders the newest message with its body and the older ones as envelopes', async () => {
		answerNewestPage();
		const w = mountReader();
		await flushPromises();

		expect(bodies(w)).toEqual(['m9']);
		expect(w.text()).toContain('Snippet m7');
		expect(w.text()).toContain('Snippet m8');
		// The thread holds 60 messages; three are loaded.
		expect(w.text()).toContain('Load 57 earlier messages');
		expect(opened.filter((s) => s.name === BODY)).toEqual([]);
	});

	it('loads an envelope body when it is expanded', async () => {
		answerNewestPage();
		const w = mountReader();
		await flushPromises();

		const m8 = w.findAll('button').find((b) => b.text().includes('Sender m8'));
		await m8?.trigger('click');
		await flushPromises();
		expect(opened.filter((s) => s.name === BODY).map((s) => s.args)).toContainEqual({
			messageId: 'm8',
		});
		const pending = w.find('[data-id="m8"]');
		expect(pending.attributes('data-pending')).toBe('true');

		answers.set(keyOf(BODY, { messageId: 'm8' }), {
			htmlInline: null,
			textInline: 'An older message',
			hasHtmlBlob: false,
			hasTextBlob: false,
		});
		await flushPromises();
		const body = w.get('[data-id="m8"]');
		expect(body.attributes('data-pending')).toBe('false');
		expect(body.attributes('data-text')).toBe('An older message');
	});

	it('reads the page before the loaded ones from "Load earlier"', async () => {
		answerNewestPage();
		const w = mountReader();
		await flushPromises();

		const load = w.findAll('button').find((b) => b.text().includes('earlier messages'));
		await load?.trigger('click');
		await flushPromises();
		expect(opened.map((s) => s.args)).toContainEqual(earlierThreadPageArgs('m9', 'c1'));

		answers.set(keyOf(THREAD, earlierThreadPageArgs('m9', 'c1')), {
			thread: { _id: 't1', messageCount: 60, unreadCount: 0 },
			labels: [],
			messages: [],
			envelopes: [row('m1', 1)],
			olderCursor: null,
		});
		await flushPromises();
		expect(w.text()).toContain('Snippet m1');
		expect(w.text()).not.toContain('earlier message');
		// The earlier page arrives collapsed: no body loads for it.
		expect(bodies(w)).toEqual(['m9']);
	});
});
