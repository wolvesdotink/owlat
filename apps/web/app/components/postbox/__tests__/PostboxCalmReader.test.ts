// @vitest-environment happy-dom
/**
 * The calm reader as one page (read on arrival §3, plan §6 rule 2): at most
 * three elements above the first body on every fixture — the header line,
 * the strip (or the slim "Why here? · Details" line) and ONE notice.
 *
 * Mounted in the Postbox harness (real Postbox composables, inert shell
 * stubs) with the real header, strip, notice and message card; the brief, the
 * thread and the sealing-key state are fixtures. Also covered here: the
 * latest message's chips and a demoted image banner land in Details, the
 * header ⋯ entries, and the "Why here?" seam lane learn provides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref, Teleport, useId, type PropType, type Ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { dashboardShellStubs, installNuxtStubs, paginatedResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useClickOutside } from '~/composables/useClickOutside';
import { POSTBOX_WHY_HERE_KEY } from '~/composables/postbox/usePostboxWhyHere';
import { briefView } from '~/utils/__tests__/threadBriefFixtures';
import type { BriefModeView } from '../../../../../api/convex/mail/interpret/briefShape';

import PostboxThreadReader, { type PostboxReaderMessage } from '../PostboxThreadReader.vue';
import PostboxReaderMessageCard from '../PostboxReaderMessage.vue';
import PostboxThreadHeader from '../PostboxThreadHeader.vue';
import PostboxReaderStrip from '../PostboxReaderStrip.vue';
import PostboxReaderStripLinks from '../PostboxReaderStripLinks.vue';
import PostboxReaderNotice from '../PostboxReaderNotice.vue';

const THREAD = 'mail/mailbox/messages:listThreadMessages';
const BRIEF = 'mail/interpret/brief:get';

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

type ImageKind = 'none' | 'blocked';

/** One fixture: the thread, its brief and the reader's surroundings. */
interface Fixture {
	messages: PostboxReaderMessage[];
	brief: BriefModeView | null | undefined;
	thread?: Record<string, unknown>;
	images?: Record<string, ImageKind>;
	keyChanged?: boolean;
	leftDraftFor?: string;
	isShared?: boolean;
}

let fixture: Fixture;
const states = new Map<string, Ref<unknown>>();

function message(id: string, over: Partial<PostboxReaderMessage> = {}): PostboxReaderMessage {
	return {
		_id: id,
		mailboxId: 'mbx1',
		threadId: 't1',
		fromAddress: 'lena@studio.example',
		fromName: 'Lena Hoffmann',
		toAddresses: ['ada@example.com'],
		ccAddresses: [],
		subject: 'Print run for the autumn catalogue',
		snippet: `Snippet ${id}`,
		receivedAt: Date.UTC(2026, 9, 17, 9, 0) + Number(id.slice(1)) * 60_000,
		hasAttachments: false,
		attachments: [],
		flagSeen: true,
		textBodyInline: `Body ${id}`,
		...over,
	};
}

beforeEach(() => {
	states.clear();
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		...autoImportedHelpers(),
		useId,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		usePaginatedQuery: () => paginatedResult([]),
		// The first-open read (lazy.ensure) and mark-seen answer like the server.
		useBackendOperation: () => ({
			run: vi.fn(async () => ({ ok: true, result: { isEnqueued: true } })),
			isLoading: ref(false),
			error: ref(null),
		}),
		useOperationErrorToast: () => ({ showOperationError: vi.fn() }),
		registerCommandPaletteProvider: vi.fn(),
		unregisterCommandPaletteProvider: vi.fn(),
		useRoute: () => ({ path: '/dashboard/postbox/inbox/m3', params: {}, query: {}, meta: {} }),
		// Shared state (the left Answer-mode draft) has to be one ref per key.
		useState: (key: string, init?: () => unknown) => {
			let state = states.get(key);
			if (!state) states.set(key, (state = ref(init?.())));
			return state;
		},
		useInboxes: () => ({
			byId: ref(new Map([['mbx1', { scope: fixture.isShared ? 'shared' : 'personal' }]])),
			inboxes: ref([]),
			ids: ref([]),
			isLoading: ref(false),
		}),
		usePostboxCorrespondentKey: () => ({
			status: ref(null),
			wasVerified: ref(false),
			keyChanged: ref(fixture.keyChanged === true),
			refetch: vi.fn(),
		}),
		useConvexQuery: (query: unknown, args: unknown) => {
			const name = getFunctionName(query as never);
			const resolved = computed(() => (typeof args === 'function' ? args() : args));
			const data = computed(() => {
				if (resolved.value === 'skip') return undefined;
				if (name === THREAD) {
					return {
						thread: { _id: 't1', messageCount: fixture.messages.length, ...fixture.thread },
						labels: [],
						messages: fixture.messages,
						envelopes: [],
						olderCursor: null,
					};
				}
				if (name === BRIEF) return fixture.brief;
				return undefined;
			});
			return {
				data,
				isLoading: computed(() => data.value === undefined),
				isRefetching: ref(false),
				error: ref(null),
				refetch: vi.fn(),
				reset: vi.fn(),
			};
		},
	});
});

const passThrough = defineComponent({
	name: 'PostboxLazyBody',
	setup:
		(_p, { slots }) =>
		() =>
			h('div', slots.default?.()),
});

/**
 * The body: an image banner (in place, or teleported where the card says)
 * over the text, and the banner state reported up like the real body does.
 */
const bodyProbe = defineComponent({
	name: 'PostboxMessageBody',
	props: {
		message: { type: Object as PropType<PostboxReaderMessage>, required: true },
		imageBannerTo: { type: Object as PropType<HTMLElement | null>, default: null },
	},
	emits: ['imageState'],
	setup(props, { emit }) {
		const kind = fixture.images?.[props.message._id] ?? 'none';
		emit('imageState', kind);
		return () =>
			h('div', [
				kind === 'none'
					? null
					: h(Teleport, { to: props.imageBannerTo, disabled: !props.imageBannerTo }, [
							h('div', { 'data-testid': 'image-banner' }, 'Images blocked'),
						]),
				h('div', { 'data-testid': 'body' }, props.message.textBodyInline),
			]);
	},
});

const marker = (name: string) =>
	defineComponent({ name, setup: () => () => h('div', { 'data-testid': name }) });

/** Reader chrome this suite does not look into. */
const CHROME = [
	'UiAvatar',
	'PostboxThreadCiteNote',
	'PostboxAiStrip',
	'PostboxBriefSheet',
	'PostboxReaderDetails',
	'PostboxAnswerDraftBar',
	'PostboxAttachmentLightbox',
	'PostboxDeliveryStrip',
	'PostboxInviteCard',
	'PostboxKeyChangeBanner',
	'PostboxLabelPickerDialog',
	'PostboxMessageAttachments',
	'PostboxMessageDetails',
	'PostboxMovePickerDialog',
	'PostboxReaderMessageActions',
	'PostboxReaderSkeleton',
	'PostboxReplyGuard',
	'PostboxSchedulingChip',
	'PostboxSecurityBadge',
	'PostboxSenderProfile',
	'PostboxSnoozeDialog',
	'PostboxThreadDiscussion',
	'PostboxThreadDiscussionToggle',
	'PostboxThreadEarlier',
	'PostboxTriageSuggestion',
	'PostboxTeamComposer',
	'PostboxTeamInterlude',
	'TeamPinnedItems',
	'PostboxTrustChip',
	'PostboxUnsubscribeChip',
];

/** The ⋯ menu with its items always rendered (the real one opens on click). */
const overflowMenu = defineComponent({
	name: 'PostboxOverflowMenu',
	setup:
		(_p, { slots }) =>
		() =>
			h('div', { 'data-testid': 'overflow' }, slots.default?.({ close: () => {} })),
});

const mounted: VueWrapper[] = [];
afterEach(() => {
	for (const w of mounted) w.unmount();
	mounted.length = 0;
});

async function mountReader(next: Fixture, provide: Record<symbol, unknown> = {}) {
	fixture = next;
	const latest = next.messages[next.messages.length - 1]!;
	if (next.leftDraftFor) {
		states.set(
			'answer:left-draft',
			ref({ messageId: next.leftDraftFor, draftId: 'd1', mailboxId: 'mbx1', recipient: 'Lena' })
		);
	}
	const w = mount(PostboxThreadReader, {
		props: { message: latest, folderRole: 'inbox' },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			mocks: autoImportedHelpers(),
			provide,
			components: {
				...Object.fromEntries(CHROME.map((name) => [name, marker(name)])),
				PostboxThreadHeader,
				PostboxReaderStrip,
				PostboxReaderStripLinks,
				PostboxReaderNotice,
				PostboxOverflowMenu: overflowMenu,
				PostboxReaderMessage: PostboxReaderMessageCard,
				PostboxLazyBody: passThrough,
				PostboxMessageBody: bodyProbe,
			},
			stubs: { transition: false },
		},
	});
	mounted.push(w);
	await flushPromises();
	return w;
}

/**
 * Everything a reader sees before the first word of mail: the article's own
 * children ahead of the conversation, plus a banner left in place inside the
 * card above the body (the image consent tier of the notice slot).
 */
function aboveFirstBody(w: VueWrapper): string[] {
	const article = w.get('article').element;
	const body = article.querySelector('[data-testid="body"]');
	expect(body).not.toBeNull();
	const before = (el: Element) =>
		!!(el.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.contains(body);
	const topLevel = [...article.children].filter(before).map((el) => {
		const chrome = el.getAttribute('data-reader-chrome');
		return chrome ?? el.getAttribute('data-testid') ?? el.tagName.toLowerCase();
	});
	const card = body!.closest('section');
	const inCard = [
		...(card?.querySelectorAll('[data-testid="image-banner"], .bg-warning\\/10') ?? []),
	]
		.filter(before)
		.map(() => 'in-card banner');
	return [...topLevel, ...inCard];
}

const earlier = () => [
	message('m1'),
	message('m2', { fromName: 'Ada', fromAddress: 'ada@example.com' }),
];

describe('the calm reader, one page', () => {
	it('a full brief: header, strip, the mail', async () => {
		const w = await mountReader({ messages: [...earlier(), message('m3')], brief: briefView() });
		expect(aboveFirstBody(w)).toEqual(['header', 'strip']);
		expect(w.find('[data-testid="reader-strip"]').exists()).toBe(true);
		// No Overview / Conversation switch any more.
		expect(w.find('[data-testid="thread-view-switch"]').exists()).toBe(false);
		expect(w.find('[data-testid="thread-overview"]').exists()).toBe(false);
	});

	it('earlier messages collapse to one line; the latest is expanded', async () => {
		const w = await mountReader({ messages: [...earlier(), message('m3')], brief: briefView() });
		expect(w.findAll('[data-testid="body"]').map((b) => b.text())).toEqual(['Body m3']);
		expect(w.findAll('button[data-message-id]')).toHaveLength(2);
	});

	it('a pending brief: no strip and no skeleton, the slim line says it is reading', async () => {
		const w = await mountReader({
			messages: [message('m3')],
			brief: briefView({ completeness: 'pending', deferredSources: 1, latest: undefined }),
		});
		expect(aboveFirstBody(w)).toEqual(['header', 'strip']);
		expect(w.get('[data-reader-chrome="strip"]').attributes('data-strip')).toBe('meta');
		expect(w.get('[data-testid="meta-reading"]').text()).toBe('Reading this thread now');
		expect(w.find('[data-testid="PostboxReaderSkeleton"]').exists()).toBe(false);
		expect(w.find('[data-testid="brief-reading"]').exists()).toBe(false);
		expect(w.find('[aria-busy="true"]').exists()).toBe(false);
	});

	it('spam: the danger is the one notice, and the card does not repeat it', async () => {
		const w = await mountReader({
			messages: [...earlier(), message('m3', { spamVerdict: 'spam' })],
			brief: briefView(),
			images: { m3: 'blocked' },
			keyChanged: true,
		});
		expect(aboveFirstBody(w)).toEqual(['header', 'strip', 'notice']);
		expect(w.get('[data-reader-chrome="notice"]').attributes('data-notice')).toBe('danger');
		// The demoted image banner waits in Details.
		const details = w.get('[data-testid="strip-details-panel"]');
		expect(details.find('[data-testid="image-banner"]').exists()).toBe(true);
	});

	it('images blocked and nothing above it: the image banner is the notice, in place', async () => {
		const w = await mountReader({
			messages: [message('m3')],
			brief: briefView({ completeness: 'pending', latest: undefined }),
			images: { m3: 'blocked' },
		});
		expect(aboveFirstBody(w)).toEqual(['header', 'strip', 'in-card banner']);
		expect(w.get('[data-testid="strip-summary"]').text()).toBe('images off');
	});

	it('a key change outranks the left draft; only one shows', async () => {
		const w = await mountReader({
			messages: [message('m3')],
			brief: briefView(),
			keyChanged: true,
			leftDraftFor: 'm3',
		});
		expect(aboveFirstBody(w)).toEqual(['header', 'strip', 'notice']);
		expect(w.find('[data-testid="PostboxKeyChangeBanner"]').exists()).toBe(true);
		expect(w.find('[data-testid="PostboxAnswerDraftBar"]').exists()).toBe(false);
	});

	it('a draft left in Answer mode for this thread is offered back', async () => {
		const w = await mountReader({ messages: [message('m3')], brief: null, leftDraftFor: 'm3' });
		expect(aboveFirstBody(w)).toEqual(['header', 'strip', 'notice']);
		expect(w.find('[data-testid="PostboxAnswerDraftBar"]').exists()).toBe(true);
	});

	it('a team inbox: header and the slim Details line, no Why here?', async () => {
		const w = await mountReader({ messages: [message('m3')], brief: undefined, isShared: true });
		expect(aboveFirstBody(w)).toEqual(['header', 'strip']);
		expect(w.find('[data-testid="strip-why-here"]').exists()).toBe(false);
		expect(w.find('[data-testid="thread-menu-why-here"]').exists()).toBe(false);
	});
});

describe('Details and the header ⋯', () => {
	it("holds the thread details and the latest message's chips; ⋯ › Details opens it", async () => {
		const w = await mountReader({ messages: [...earlier(), message('m3')], brief: briefView() });
		const panel = w.get('[data-testid="strip-details-panel"]');
		expect(panel.attributes('style')).toContain('display: none');
		expect(panel.find('[data-testid="PostboxReaderDetails"]').exists()).toBe(true);
		// The latest card's trust chip and message details render in Details,
		// not on the card.
		expect(panel.find('[data-testid="PostboxTrustChip"]').exists()).toBe(true);
		expect(panel.find('[data-testid="PostboxMessageDetails"]').exists()).toBe(true);
		const card = w.get('[data-testid="body"]').element.closest('section')!;
		expect(card.querySelector('[data-testid="PostboxTrustChip"]')).toBeNull();

		await w.get('[data-testid="thread-menu-details"]').trigger('click');
		expect(w.get('[data-testid="strip-details-panel"]').attributes('style') ?? '').not.toContain(
			'display: none'
		);
	});

	it('the header carries Reply, Archive and the ⋯ entries', async () => {
		const w = await mountReader({ messages: [message('m3')], brief: briefView() });
		expect(w.find('[data-testid="thread-header-reply"]').exists()).toBe(true);
		expect(w.find('[data-testid="thread-header-archive"]').exists()).toBe(true);
		expect(w.get('[data-testid="thread-menu-why-here"]').text()).toBe('Why is this here?');
		expect(w.get('[data-testid="thread-menu-details"]').text()).toBe('Details');
		expect(w.find('[data-testid="thread-menu-snooze"]').exists()).toBe(true);
	});
});

describe('the "Why here?" seam', () => {
	it('renders the link and opens nothing without a provider', async () => {
		const w = await mountReader({ messages: [message('m3')], brief: briefView() });
		await w.get('[data-testid="strip-why-here"]').trigger('click');
		expect(w.find('[data-testid="why-here-popover"]').exists()).toBe(false);
	});

	it('hands the thread, its placement and the anchor to the provided handler', async () => {
		const open = vi.fn();
		const w = await mountReader(
			{
				messages: [message('m3')],
				brief: briefView(),
				thread: { arrival: { placement: 'today', messageId: 'm3', decidedAt: 1 } },
			},
			{ [POSTBOX_WHY_HERE_KEY]: { open } }
		);
		const link = w.get('[data-testid="strip-why-here"]');
		await link.trigger('click');
		expect(open).toHaveBeenCalledWith({
			mailboxId: 'mbx1',
			threadId: 't1',
			placement: 'today',
			anchor: link.element,
		});
		await w.get('[data-testid="thread-menu-why-here"]').trigger('click');
		expect(open).toHaveBeenCalledTimes(2);
		expect(open.mock.calls[1]?.[0]?.anchor).toBe(w.get('header').element);
	});
});
