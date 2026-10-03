// @vitest-environment happy-dom
/**
 * Approve on the Answer queue's team card sends the draft the card shows (#1196).
 *
 * The agent may have offered variants (`draftOptions`) for its draft. The card
 * used to approve `draftOptions[0]` whenever there were two or more, writing it
 * over the draft first, so a reviewer's saved edit was replaced by the agent's
 * original right before it went out. The card offers no variant to pick, so it
 * shows no variant hint either.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import { useReviewQueue } from '~/composables/useReviewQueue';
import type { AnswerCardControls } from '~/utils/answerCard';
import AnswerTeamCard from '../AnswerTeamCard.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({ members: ref([]), fetchMembers: vi.fn() }),
}));

const AGENT_ORIGINAL = 'Hi Jonas, I can add two seats to your plan.';
const AGENT_VARIANT = 'Hi Jonas, two more seats are no problem.';
const EDITED = 'Hi Jonas, I have added two seats, effective today. Best, Ada';

/** The stored message as the backend holds it, and what each approve sent. */
let stored: { draftResponse: string };
let sent: string[];
let entry: Record<string, unknown>;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});
enableAutoUnmount(afterEach);

beforeEach(() => {
	stored = { draftResponse: EDITED };
	sent = [];
	entry = {
		message: {
			_id: 'im_1',
			from: 'Jonas Keller <jonas@example.com>',
			subject: 'Two more seats',
			textBody: 'Can we add two seats before Friday?',
			processingStatus: 'draft_ready',
			// The reviewer edited the agent's draft and saved it.
			draftResponse: EDITED,
			draftSavedAt: 1,
			draftOptions: [AGENT_ORIGINAL, AGENT_VARIANT],
		},
		thread: null,
		contact: null,
	};
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) =>
		queryResult(args() === 'skip' ? [] : [entry])
	);
	// A small backend. The queue builds its operations in a fixed order:
	// approveDraft, rejectDraft, editDraft, undoAutoSend.
	let built = 0;
	vi.stubGlobal('useBackendOperation', () => {
		const index = built++;
		const run = vi.fn(async (args: { draftResponse?: string }) => {
			if (index === 0) sent.push(stored.draftResponse);
			if (index === 2 && args.draftResponse !== undefined) {
				stored.draftResponse = args.draftResponse;
			}
			return { ok: true, result: { success: true } };
		});
		return { run, isLoading: ref(false) };
	});
	vi.stubGlobal('useReviewQueue', useReviewQueue);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'user-1' }) }));
	vi.stubGlobal('useReviewApproveUndo', () => ({
		arm: vi.fn(),
		state: ref({ inboundMessageId: null }),
		dismiss: vi.fn(),
	}));
	vi.stubGlobal('approveUndoWindow', () => undefined);
	vi.stubGlobal('isApproveAlreadyHandled', () => false);
	vi.stubGlobal('capitalize', (s: string) => s);
});

const controls: AnswerCardControls = {
	complete: vi.fn(),
	skip: vi.fn(),
	undoSelf: vi.fn(),
	back: vi.fn(),
	next: vi.fn(),
	openAnswer: vi.fn(),
};

const taskActionsStub = {
	name: 'TaskActions',
	emits: ['primary', 'skip'],
	template:
		'<div><button class="primary" @click="$emit(\'primary\')">approve</button><slot /></div>',
};

function mountCard() {
	return mount(AnswerTeamCard, {
		props: { entry: entry as never, controls },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				InboxTrustChip: true,
				InboxDecisionRationale: true,
				TaskContext: true,
				TaskAsk: true,
				TaskActions: taskActionsStub,
			},
		},
	});
}

describe('AnswerTeamCard approve, with agent variants stored', () => {
	it('sends the edited and saved draft the card shows', async () => {
		const wrapper = mountCard();
		expect(wrapper.text()).toContain(EDITED);

		await wrapper.get('button.primary').trigger('click');
		await flushPromises();

		expect(sent).toEqual([EDITED]);
		expect(stored.draftResponse).toBe(EDITED);
		expect(controls.complete).toHaveBeenCalledWith('approved', undefined);
	});

	it('shows no variant hint, since the card offers none to pick', () => {
		const wrapper = mountCard();
		expect(wrapper.text()).not.toMatch(/option/i);
	});
});
