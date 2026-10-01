// @vitest-environment happy-dom
/**
 * AnswerMailCard reads the prepared draft for the card on screen only (plan C8).
 *
 * `mail.needsReply.listQueue` rows no longer carry the draft-on-arrival slot,
 * just `hasDraftSlot`. The card subscribes to `getDraftSlot` for its own
 * thread when the row says a draft exists, and skips the read otherwise, so the
 * drafts of the rows nobody opens never travel.
 *
 * And the queue bug of plan §10: the card completed the item as the reply
 * composer OPENED, so closing the popup without sending dropped the email from
 * the queue. Replying now opens Answer mode and finishes nothing; only a send
 * (in Answer mode), Archive, Snooze or Done completes the item.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import AnswerMailCard from '../AnswerMailCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';
import type { AnswerCardControls } from '~/utils/answerCard';
import * as mailUpdaters from '~/lib/mailOptimistic/mailUpdaters';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const slotData = ref<unknown>(null);
const queryArgs: Array<() => unknown> = [];
/** Each write's options, in the order the card creates them. */
const operationOptions: Array<{ optimisticUpdate?: unknown }> = [];
const operationRuns: Array<ReturnType<typeof vi.fn>> = [];

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
		queryArgs.push(args);
		return { data: slotData, isLoading: ref(false) };
	});
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { optimisticUpdate?: unknown }) => {
		operationOptions.push(opts);
		const run = vi.fn(async () => ({ ok: true, result: { moved: [] } }));
		operationRuns.push(run);
		return { run, isLoading: ref(false) };
	});
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePostboxComposerStack', () => ({ open: vi.fn() }));
});

// Every card listens on window; a card left mounted would answer the next test's keys.
enableAutoUnmount(afterEach);

beforeEach(() => {
	slotData.value = null;
	queryArgs.length = 0;
	operationOptions.length = 0;
	operationRuns.length = 0;
	vi.mocked(controls.complete).mockClear();
	vi.mocked(controls.openAnswer).mockClear();
});

const controls: AnswerCardControls = {
	complete: vi.fn(),
	skip: vi.fn(),
	undoSelf: vi.fn(),
	back: vi.fn(),
	next: vi.fn(),
	openAnswer: vi.fn(),
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
	emits: ['review', 'dismiss'],
	template:
		'<div class="review-slot" @click="$emit(\'review\', draftSlot.draft)">{{ draftSlot.draft }}</div>',
};

// Clicking the stub's primary button runs the card's primary verb.
const taskActionsStub = {
	name: 'TaskActions',
	props: ['primaryLabel'],
	emits: ['primary', 'skip'],
	template:
		'<div><button class="primary" @click="$emit(\'primary\')">{{ primaryLabel }}</button><slot /></div>',
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
				TaskActions: taskActionsStub,
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
		expect(queryArgs[0]?.()).toBe('skip');
		expect(wrapper.find('.review-slot').exists()).toBe(false);
	});

	it('never reads a draft for a follow-up row', () => {
		mountCard(row({ kind: 'followup', hasDraftSlot: true }));
		expect(queryArgs[0]?.()).toBe('skip');
	});
});

describe('AnswerMailCard writes', () => {
	it('archive, its undo and snooze patch the cached Postbox views first (plan 2.2)', () => {
		mountCard(row());
		const updaters = operationOptions.map((opts) => opts.optimisticUpdate);
		expect(updaters).toContain(mailUpdaters.optimisticArchive);
		expect(updaters).toContain(mailUpdaters.optimisticMove);
		expect(updaters).toContain(mailUpdaters.optimisticSnooze);
	});
});

describe('AnswerMailCard finishes an item only when something was done (plan §10)', () => {
	it('replying opens Answer mode and does not complete the item', async () => {
		const wrapper = mountCard(row());
		await wrapper.get('.primary').trigger('click');
		expect(controls.openAnswer).toHaveBeenCalledTimes(1);
		expect(controls.complete).not.toHaveBeenCalled();
	});

	it('Enter on the card opens Answer mode and does not complete the item', () => {
		mountCard(row());
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		expect(controls.openAnswer).toHaveBeenCalledTimes(1);
		expect(controls.complete).not.toHaveBeenCalled();
	});

	it('reviewing a prepared draft opens it in Answer mode without completing', async () => {
		slotData.value = { draft: 'Sure, Friday works.', confidence: 0.8, generatedAt: 1 };
		const wrapper = mountCard(row({ hasDraftSlot: true }));
		await wrapper.get('.review-slot').trigger('click');
		expect(controls.openAnswer).toHaveBeenCalledTimes(1);
		expect(controls.complete).not.toHaveBeenCalled();
	});

	it('archive completes the item, with the move back as its undo', async () => {
		mountCard(row());
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }));
		await flushPromises();
		expect(controls.complete).toHaveBeenCalledWith('archived', expect.any(Function));
	});

	it('Done on a follow-up completes it; its Reply opens Answer mode', async () => {
		const wrapper = mountCard(row({ kind: 'followup' }));
		await wrapper.get('[data-testid="answer-mail-nudge"]').trigger('click');
		expect(controls.openAnswer).toHaveBeenCalledTimes(1);
		expect(controls.complete).not.toHaveBeenCalled();
		await wrapper.get('.primary').trigger('click');
		await flushPromises();
		expect(controls.complete).toHaveBeenCalledWith('cleared');
	});
});
