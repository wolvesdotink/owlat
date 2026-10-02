// @vitest-environment happy-dom
/**
 * Answer mode for a message that is gone (#1100): deleted, moved by another
 * client, purged from Trash, or in a mailbox no longer shared. `getMessage`
 * answers `null`, which is not a failed read, so the page used to fall through
 * to the loading skeleton and stay there. It now says the message is no longer
 * available and offers the way on: back to where Answer mode was opened from,
 * or the queue's next item inside a queue session.
 *
 * The page's real `usePostboxActiveMessageRead` runs here, against queries
 * answered by name, so the state is driven by `getMessage` itself.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, useId, type Ref } from 'vue';
import { getFunctionName } from 'convex/server';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AnswerModeFrame from '~/components/answer/AnswerModeFrame.vue';
import PostboxMessageNotFound from '~/components/postbox/PostboxMessageNotFound.vue';
import { usePostboxActiveMessageRead } from '~/composables/postbox/usePostboxOpenMessage';
import AnswerPage from '../m/[messageId].vue';
import en from '../../../../../i18n/locales/en.json';

interface QueueSessionStub {
	engaged: Ref<boolean>;
	flow: { active: Ref<boolean>; current: Ref<{ id: string } | null> };
	isCurrentRoute: Ref<boolean>;
	controlsFor: ReturnType<typeof vi.fn>;
	goCurrent: ReturnType<typeof vi.fn>;
	handleSent: ReturnType<typeof vi.fn>;
}
let activeQueueSession: QueueSessionStub | null = null;
vi.mock('~/composables/useAnswerQueueSession', () => ({
	useAnswerQueueSession: () => activeQueueSession,
}));
vi.mock('~/composables/useAnswerModeAssist', () => ({
	useAnswerModeAssist: () => ({
		aiEnabled: ref(false),
		catchUp: { catchUp: ref(null), loading: ref(false), covered: ref([]) },
		statusNote: ref(undefined),
		ask: {
			phase: ref('idle'),
			busy: ref(false),
			session: ref(null),
			injectionFlagged: ref(false),
			start: vi.fn(),
			answer: vi.fn(),
		},
		attaching: ref(null),
		attachThreadFile: vi.fn(),
		resolveThreadFile: vi.fn(),
		onComposerDrop: vi.fn(),
	}),
}));

const THREAD = 'mail/mailbox/messages:listThreadMessages';
const BY_ID = 'mail/mailbox/messages:getMessage';

/** What each query answers, by function name; anything unnamed answers `undefined`. */
let answers: Record<string, { data?: unknown; error?: Error }>;
const refetch = vi.fn();

function useConvexQueryByName(query: unknown, args: () => unknown) {
	const name = getFunctionName(query as never);
	const skipped = computed(() => args() === 'skip');
	const answer = computed(() => (skipped.value ? undefined : answers[name]));
	return {
		data: computed(() => answer.value?.data),
		isLoading: computed(() => !skipped.value && !answer.value),
		error: computed(() => answer.value?.error ?? null),
		refetch,
	};
}

const route = reactive({
	path: '/dashboard/answer/m/msg_gone',
	fullPath: '/dashboard/answer/m/msg_gone',
	params: { messageId: 'msg_gone' } as Record<string, string>,
	query: {} as Record<string, string>,
	meta: {},
});
const navigateTo = vi.fn();
let state: Map<string, Ref<unknown>>;

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useId,
		useHead: () => {},
		definePageMeta: () => {},
		usePermissions: () => ({ canManageOrganization: ref(true) }),
		useBackendOperation: () => ({ run: vi.fn(), isLoading: ref(false) }),
		useRoute: () => route,
		useRouter: () => ({ replace: vi.fn(), back: vi.fn(), currentRoute: computed(() => route) }),
		navigateTo,
		useState: (key: string, init: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init()));
			return state.get(key);
		},
		useConvex: () => null,
		useConvexQuery: useConvexQueryByName,
		usePostboxActiveMessageRead,
		usePostboxSettings: () => ({ replyDefault: ref('reply') }),
		useFeatureFlag: () => ({ isEnabled: () => false }),
		useInboxes: () => ({ byId: ref(new Map()) }),
	});
});

const inert = (name: string) => defineComponent({ name, setup: () => () => h('div') });
const SkeletonStub = defineComponent({
	name: 'PostboxReaderSkeleton',
	setup: () => () => h('div', { 'data-testid': 'reader-skeleton' }),
});
const UiSkeletonStub = defineComponent({
	name: 'UiSkeleton',
	setup: () => () => h('div', { 'data-testid': 'composer-skeleton' }),
});

let wrapper: VueWrapper | null = null;

async function mountPage() {
	wrapper = mount(AnswerPage, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: {
				AnswerModeFrame,
				PostboxMessageNotFound,
				AnswerConversation: inert('AnswerConversation'),
				PostboxComposer: inert('PostboxComposer'),
				PostboxReplyGuard: inert('PostboxReplyGuard'),
				PostboxReaderSkeleton: SkeletonStub,
				UiSkeleton: UiSkeletonStub,
				AnswerQueueBar: inert('AnswerQueueBar'),
				AnswerQueueMailAsk: inert('AnswerQueueMailAsk'),
				AnswerPeekDraft: inert('AnswerPeekDraft'),
				PostboxAiStrip: inert('PostboxAiStrip'),
				PostboxOverflowMenu: inert('PostboxOverflowMenu'),
				PostboxLabelPickerDialog: inert('PostboxLabelPickerDialog'),
				InboxChip: inert('InboxChip'),
			},
		},
	});
	await flushPromises();
	return wrapper;
}

const NOT_FOUND = '[data-testid="postbox-message-not-found"]';
const LEAVE = '[data-testid="answer-not-found-leave"]';

beforeEach(() => {
	activeQueueSession = null;
	state = new Map();
	answers = { [THREAD]: { data: null } };
	navigateTo.mockClear();
	refetch.mockClear();
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe('Answer mode for a message that is gone (#1100)', () => {
	it('shows the loading skeleton while getMessage has not answered', async () => {
		const w = await mountPage();
		expect(w.find('[data-testid="reader-skeleton"]').exists()).toBe(true);
		expect(w.find(NOT_FOUND).exists()).toBe(false);
	});

	it('says the message is no longer available once getMessage answers null', async () => {
		answers[BY_ID] = { data: null };
		const w = await mountPage();
		expect(w.find(NOT_FOUND).exists()).toBe(true);
		expect(w.text()).toContain(en.components.postbox.postboxMessageNotFound.title);
		// Neither the conversation nor the composer is left as a skeleton.
		expect(w.find('[data-testid="reader-skeleton"]').exists()).toBe(false);
		expect(w.find('[data-testid="composer-skeleton"]').exists()).toBe(false);
	});

	it('leads back to the page Answer mode was opened from', async () => {
		answers[BY_ID] = { data: null };
		const w = await mountPage();
		const leave = w.get(LEAVE);
		expect(leave.text()).toBe('Back to Inbox');
		await leave.trigger('click');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});

	it("inside a queue session, skips the queue's current item", async () => {
		answers[BY_ID] = { data: null };
		const skip = vi.fn();
		activeQueueSession = {
			engaged: ref(true),
			flow: { active: ref(true), current: ref({ id: 'mail:msg_gone' }) },
			isCurrentRoute: ref(true),
			controlsFor: vi.fn(() => ({ skip })),
			goCurrent: vi.fn(),
			handleSent: vi.fn(),
		};
		const w = await mountPage();
		const leave = w.get(LEAVE);
		expect(leave.text()).toBe(en.components.answer.mode.skipMissing);
		await leave.trigger('click');
		expect(activeQueueSession.controlsFor).toHaveBeenCalledWith({ id: 'mail:msg_gone' });
		expect(skip).toHaveBeenCalledTimes(1);
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('inside a queue session that no longer holds this item, goes to its current item', async () => {
		answers[BY_ID] = { data: null };
		activeQueueSession = {
			engaged: ref(true),
			flow: { active: ref(true), current: ref({ id: 'mail:msg_next' }) },
			isCurrentRoute: ref(false),
			controlsFor: vi.fn(),
			goCurrent: vi.fn(),
			handleSent: vi.fn(),
		};
		const w = await mountPage();
		await w.get(LEAVE).trigger('click');
		expect(activeQueueSession.goCurrent).toHaveBeenCalledTimes(1);
		expect(activeQueueSession.controlsFor).not.toHaveBeenCalled();
	});

	it('keeps a failed getMessage an error with Try again, not "no longer available"', async () => {
		answers[BY_ID] = { error: new Error('[CONVEX Q(x:y)] [Request ID: 1] Server Error') };
		const w = await mountPage();
		expect(w.find(NOT_FOUND).exists()).toBe(false);
		expect(w.find('[data-testid="composer-skeleton"]').exists()).toBe(false);
		const retry = w.findAll('button').find((b) => b.text() === 'Try again');
		expect(retry).toBeDefined();
		await retry!.trigger('click');
		expect(refetch).toHaveBeenCalled();
	});
});
