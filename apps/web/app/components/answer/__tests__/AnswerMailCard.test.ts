// @vitest-environment happy-dom
/**
 * AnswerMailCard reads the prepared draft for the card on screen only (plan C8).
 *
 * `mail.needsReply.listQueue` rows no longer carry the draft-on-arrival slot,
 * just `hasDraftSlot`. The card subscribes to `getDraftSlot` for its own
 * thread when the row says a draft exists, and skips the read otherwise, so the
 * drafts of the rows nobody opens never travel.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import AnswerMailCard from '../AnswerMailCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';
import type { AnswerCardControls } from '~/utils/answerCard';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const slotData = ref<unknown>(null);
const queryArgs: Array<() => unknown> = [];

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
		queryArgs.push(args);
		return { data: slotData, isLoading: ref(false) };
	});
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePostboxComposerStack', () => ({ open: vi.fn() }));
});

beforeEach(() => {
	slotData.value = null;
	queryArgs.length = 0;
});

const controls: AnswerCardControls = {
	complete: vi.fn(),
	skip: vi.fn(),
	undoSelf: vi.fn(),
	back: vi.fn(),
	next: vi.fn(),
};

function row(over: Partial<ReplyQueueItem> = {}): ReplyQueueItem {
	return {
		kind: 'needs_reply',
		threadId: 'thread-1',
		messageId: 'msg-1',
		urgency: 'normal',
		detectedAt: 1,
		source: 'llm',
		fromAddress: 'ann@acme.com',
		subject: 'Refund?',
		snippet: 'Can you approve the refund?',
		receivedAt: 1,
		...over,
	};
}

const reviewSlotStub = {
	name: 'PostboxReviewSlot',
	props: ['draftSlot'],
	template: '<div class="review-slot">{{ draftSlot.draft }}</div>',
};

function mountCard(item: ReplyQueueItem) {
	return mount(AnswerMailCard, {
		props: { row: item, mailboxId: 'mb-1' as never, controls },
		global: {
			plugins: [createTestI18n()],
			// A Nuxt auto-import the template calls directly.
			mocks: { formatCompactRelativeTime: () => 'now' },
			stubs: {
				Icon: true,
				PostboxReviewSlot: reviewSlotStub,
				PostboxSnoozeDialog: true,
				PostboxClarificationCard: true,
				TaskCardRenderer: true,
				TaskContext: true,
				TaskAsk: true,
				TaskActions: true,
			},
		},
	});
}

describe('AnswerMailCard draft slot', () => {
	it('reads the draft for its own thread when the row has one', () => {
		slotData.value = { draft: 'Sure, Friday works.', confidence: 0.8, generatedAt: 1 };
		const wrapper = mountCard(row({ hasDraftSlot: true }));
		expect(queryArgs.map((args) => args())).toContainEqual({ threadId: 'thread-1' });
		expect(wrapper.find('.review-slot').text()).toBe('Sure, Friday works.');
	});

	it('skips the read and shows no slot when the row has no draft', () => {
		const wrapper = mountCard(row());
		expect(queryArgs.map((args) => args())).toEqual(['skip']);
		expect(wrapper.find('.review-slot').exists()).toBe(false);
	});

	it('never reads a draft for a follow-up row', () => {
		mountCard(row({ kind: 'followup', hasDraftSlot: true }));
		expect(queryArgs.map((args) => args())).toEqual(['skip']);
	});
});
