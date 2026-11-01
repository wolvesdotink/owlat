/**
 * The team card's keys are the `teamCard` scope, bound through the app-wide
 * dispatcher: `a` approves the draft, `x` rejects it, Enter is the primary
 * action. While the agent's questions hold the draft the question card has the
 * keyboard (1 to 9 pick a chip) and nothing here approves or rejects.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import { useReviewQueue } from '~/composables/useReviewQueue';
import type { AnswerCardControls } from '~/utils/answerCard';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';
import AnswerTeamCard from '../AnswerTeamCard.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

/** What the card asked the backend to do, in order: `approve`, `reject`, … */
let done: string[];
let entry: Record<string, unknown>;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});
afterEach(() => resetShortcutPreferences());

const READY = {
	message: {
		_id: 'im_1',
		from: 'Jonas Keller <jonas@example.com>',
		subject: 'Two more seats',
		textBody: 'Can we add two seats before Friday?',
		processingStatus: 'draft_ready',
		draftResponse: 'Hi Jonas, I have added two seats.',
		draftSavedAt: 1,
	},
	thread: null,
	contact: null,
};

const HELD = {
	message: {
		_id: 'im_4',
		from: 'Lea Brandt <lea@example.com>',
		subject: 'Order status',
		textBody: 'When does my order ship?',
		processingStatus: 'awaiting_clarification',
		pendingClarification: {
			questions: [
				{ id: 'clarify_0', slotType: 'decision', text: 'Ship today?', options: ['Yes', 'No'] },
			],
			askedAt: 1,
		},
	},
	thread: null,
	contact: null,
};

beforeEach(() => {
	done = [];
	entry = READY;
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) =>
		queryResult(args() === 'skip' ? [] : [entry])
	);
	// The queue builds its operations in a fixed order: approveDraft,
	// rejectDraft, editDraft, undoAutoSend; the card's own come after.
	const names = ['approve', 'reject', 'edit', 'undo'];
	let built = 0;
	vi.stubGlobal('useBackendOperation', () => {
		const name = names[built++] ?? 'other';
		const run = vi.fn(async () => {
			done.push(name);
			return { ok: true, result: { success: true } };
		});
		return { run, isLoading: ref(false) };
	});
	vi.stubGlobal('useReviewQueue', useReviewQueue);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useReviewApproveUndo', () => ({
		arm: vi.fn(),
		state: ref({ inboundMessageId: null }),
		dismiss: vi.fn(),
	}));
	vi.stubGlobal('approveUndoWindow', () => undefined);
	vi.stubGlobal('isApproveAlreadyHandled', () => false);
	vi.stubGlobal('capitalize', (s: string) => s);
	for (const fn of Object.values(controls)) vi.mocked(fn).mockClear();
});

const controls: AnswerCardControls = {
	complete: vi.fn(),
	skip: vi.fn(),
	undoSelf: vi.fn(),
	back: vi.fn(),
	next: vi.fn(),
	openAnswer: vi.fn(),
};

function mountCard() {
	return mount(AnswerTeamCard, {
		props: { entry: entry as never, controls },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				InboxTrustChip: true,
				InboxDecisionRationale: true,
				TaskContext: true,
				TaskAsk: true,
			},
		},
	});
}

// Through the app-wide dispatcher, a document listener.
const press = (key: string) =>
	document.body.dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
	);

describe('AnswerTeamCard keys', () => {
	it('approves with a and rejects with x', async () => {
		mountCard();
		press('a');
		await flushPromises();
		expect(done).toContain('approve');
		press('x');
		await flushPromises();
		expect(done).toContain('reject');
	});

	it('answers and hints a remapped approve key', async () => {
		applyShortcutPreferences('owlat', [{ id: 'teamCard.approve', keys: ['y'] }]);
		const wrapper = mountCard();
		expect(wrapper.text()).toContain('Y');
		press('a');
		await flushPromises();
		expect(done).not.toContain('approve');
		press('y');
		await flushPromises();
		expect(done).toContain('approve');
	});

	it("leaves the keyboard to the agent's questions while they hold the draft", async () => {
		entry = HELD;
		const wrapper = mountCard();
		press('a');
		press('x');
		press('Enter');
		await flushPromises();
		expect(done).toEqual([]);
		press('1');
		await flushPromises();
		expect(wrapper.get('[data-testid="ask-chip"][aria-pressed="true"]').text()).toContain('Yes');
	});
});
