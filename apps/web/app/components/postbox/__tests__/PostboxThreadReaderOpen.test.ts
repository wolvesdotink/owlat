// @vitest-environment happy-dom
/**
 * Plan 2.5: the reader no longer holds a skeleton until `listThreadMessages`
 * answers. Opened on a list row (which carries no body since plan 2.3), it
 * renders that row at once with the body from `getMessageInlineBody`, and
 * keeps what needs the whole thread (the inline reply box) until the thread
 * has loaded.
 *
 * Mounted in the Postbox a11y harness (real Postbox composables, inert shell
 * stubs); only the two queries under test answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref, useId, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { dashboardShellStubs, installNuxtStubs, paginatedResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useClickOutside } from '~/composables/useClickOutside';

import PostboxThreadReader, { type PostboxReaderMessage } from '../PostboxThreadReader.vue';
import PostboxReaderMessageCard from '../PostboxReaderMessage.vue';

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

const thread: { data: Ref<unknown>; isLoading: Ref<boolean> } = {
	data: ref(undefined),
	isLoading: ref(true),
};
const inlineBody = ref<unknown>(undefined);

function queryFor(name: string) {
	if (name === THREAD) return thread;
	if (name === BODY) return { data: inlineBody, isLoading: computed(() => !inlineBody.value) };
	return { data: ref(undefined), isLoading: ref(false) };
}

beforeEach(() => {
	thread.data.value = undefined;
	thread.isLoading.value = true;
	inlineBody.value = undefined;
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		...autoImportedHelpers(),
		useId,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		usePaginatedQuery: () => paginatedResult([]),
		useOperationErrorToast: () => ({ showOperationError: vi.fn() }),
		POSTBOX_PENDING_COMPOSE_KEY: 'postbox:pending-compose',
		registerCommandPaletteProvider: vi.fn(),
		unregisterCommandPaletteProvider: vi.fn(),
		useRoute: () => ({ path: '/dashboard/postbox/inbox/m1', params: {}, query: {}, meta: {} }),
		useConvexQuery: (query: unknown) => {
			const { data, isLoading } = queryFor(getFunctionName(query as never));
			return {
				data,
				isLoading,
				isRefetching: ref(false),
				error: ref(null),
				refetch: vi.fn(),
				reset: vi.fn(),
			};
		},
	});
});

/** A list row: no body fields at all (plan 2.3). */
const listRow: PostboxReaderMessage = {
	_id: 'm1',
	mailboxId: 'mbx1',
	threadId: 't1',
	fromAddress: 'ines@example.com',
	fromName: 'Ines Weber',
	toAddresses: ['ada@example.com'],
	ccAddresses: [],
	subject: 'Quarterly numbers',
	receivedAt: Date.UTC(2026, 0, 14, 9, 30),
	hasAttachments: false,
	attachments: [],
};

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
	'UiButton',
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
		props: { message: listRow, folderRole: 'inbox' },
		global: {
			plugins: [createTestI18n()],
			mocks: autoImportedHelpers(),
			components: {
				...Object.fromEntries(CHROME.map((name) => [name, marker(name)])),
				PostboxReaderMessage: PostboxReaderMessageCard,
				PostboxLazyBody: passThrough,
				PostboxMessageBody: bodyProbe,
			},
		},
	});
}

describe('PostboxThreadReader while its thread loads', () => {
	it('renders the opened row with its inline body instead of a skeleton', async () => {
		const w = mountReader();
		await flushPromises();

		expect(w.find('[data-testid="PostboxReaderSkeleton"]').exists()).toBe(false);
		expect(w.text()).toContain('Ines Weber');
		// The inline body query has not answered: the body waits in place.
		expect(w.get('[data-testid="body"]').attributes('data-pending')).toBe('true');
		// The reply box needs the whole thread (its latest message).
		expect(w.find('[data-testid="PostboxInlineReply"]').exists()).toBe(false);

		inlineBody.value = {
			htmlInline: null,
			textInline: 'Here are the numbers.',
			hasHtmlBlob: false,
			hasTextBlob: false,
		};
		await flushPromises();
		const body = w.get('[data-testid="body"]');
		expect(body.attributes('data-pending')).toBe('false');
		expect(body.attributes('data-text')).toBe('Here are the numbers.');
	});

	it('hands over to the thread once it loads', async () => {
		const w = mountReader();
		thread.data.value = {
			thread: { _id: 't1' },
			labels: [],
			messages: [
				{ ...listRow, _id: 'm0', textBodyInline: 'Earlier message', flagSeen: true },
				{ ...listRow, textBodyInline: 'From the thread', flagSeen: true },
			],
		};
		thread.isLoading.value = false;
		await flushPromises();

		expect(w.findAll('[data-testid="body"]').map((b) => b.attributes('data-text'))).toContain(
			'From the thread'
		);
		expect(w.find('[data-testid="PostboxInlineReply"]').exists()).toBe(true);
	});
});
