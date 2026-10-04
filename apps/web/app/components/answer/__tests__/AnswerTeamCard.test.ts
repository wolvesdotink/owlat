// @vitest-environment happy-dom
/**
 * The Answer queue's team card, which only ever shows a team item with no
 * thread: one with a thread opens in Answer mode instead (#1226). So every
 * entry here has `thread: null`.
 *
 * Approve sends the draft the card shows (#1196).
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

const AGENT_ORIGINAL = 'Hi Jonas, I can add two seats to your plan.';
const AGENT_VARIANT = 'Hi Jonas, two more seats are no problem.';
const EDITED = 'Hi Jonas, I have added two seats, effective today. Best, Ada';

/** The stored message as the backend holds it, and what each approve sent. */
let stored: { draftResponse: string };
let sent: string[];
let entry: Record<string, unknown>;
/** The args of every `useConvexQuery` subscription made while mounting. */
let subscriptions: unknown[];

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
	subscriptions = [];
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
		subscriptions.push(args());
		return queryResult(args() === 'skip' ? [] : [entry]);
	});
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

	it('subscribes to the review queue and nothing else: there is no thread to watch', () => {
		mountCard();
		expect(subscriptions).toEqual([{ limit: 50 }]);
	});
});

/**
 * A draftless escalation: the agent wrote nothing, so the reviewer writes the
 * reply on the card. It goes out through `editDraft` then `approveDraft`.
 */
describe('AnswerTeamCard with a draftless escalation', () => {
	beforeEach(() => {
		vi.mocked(controls.complete).mockClear();
		vi.mocked(controls.openAnswer).mockClear();
		stored = { draftResponse: '' };
		entry = {
			message: {
				_id: 'im_3',
				from: 'Lea Brandt <lea@example.com>',
				subject: 'Contract change',
				textBody: 'Can we move to yearly billing?',
				processingStatus: 'draft_ready',
			},
			thread: null,
			contact: null,
		};
	});

	function mountReal() {
		return mount(AnswerTeamCard, {
			props: { entry: entry as never, controls },
			attachTo: document.body,
			global: {
				plugins: [createTestI18n()],
				stubs: {
					Icon: true,
					InboxTrustChip: true,
					InboxDecisionRationale: true,
					TaskContext: true,
					TaskAsk: true,
				},
			},
		});
	}

	it('offers a reply box with Send reply and Dismiss, and nothing that needs a thread', () => {
		const wrapper = mountReal();
		const buttons = wrapper.findAll('button').map((b) => b.text());
		expect(buttons).toEqual(['Send reply', 'Dismiss']);
		expect(wrapper.get('[data-testid="task-primary"]').attributes('disabled')).toBeDefined();
		expect(wrapper.find('[data-testid="task-held-reason"]').exists()).toBe(false);
	});

	it('sends the reply typed on the card and completes the item', async () => {
		const wrapper = mountReal();
		await wrapper.get('textarea').setValue('Hi Lea, yes, from the next cycle.');
		await wrapper.get('[data-testid="task-primary"]').trigger('click');
		await flushPromises();
		expect(stored.draftResponse).toBe('Hi Lea, yes, from the next cycle.');
		expect(sent).toEqual(['Hi Lea, yes, from the next cycle.']);
		expect(controls.complete).toHaveBeenCalledWith('sent', undefined);
		expect(controls.openAnswer).not.toHaveBeenCalled();
	});

	it('Dismiss rejects the item', async () => {
		const wrapper = mountReal();
		await wrapper.get('[data-testid="task-skip"]').trigger('click');
		await flushPromises();
		expect(controls.complete).toHaveBeenCalledWith('rejected');
		expect(sent).toEqual([]);
	});
});

/**
 * An agent draft with `[[...]]` gaps on the card (#1197). The server refuses
 * to approve a gap-guarded draft (DRAFT_HAS_GAPS), so the card marks the gaps,
 * holds Approve with the reason, and offers the way to fill them. Mounted with
 * the real action row, so held means disabled with the reason shown.
 */
describe('AnswerTeamCard with an agent draft that has gaps', () => {
	const GAPPED =
		'Hi Ana, your refund of [[refund amount]] went out on [[refund date]].\n> Can you check [[ticket 12]]?';
	const FILLED =
		'Hi Ana, your refund of 42 EUR went out on 2 October.\n> Can you check [[ticket 12]]?';

	function gappedEntry(message: Record<string, unknown> = {}) {
		stored = { draftResponse: GAPPED };
		entry = {
			message: {
				_id: 'im_2',
				from: 'Ana Silva <ana@example.com>',
				subject: 'Refund',
				textBody: 'Where is my refund?',
				processingStatus: 'draft_ready',
				draftResponse: GAPPED,
				isDraftGapGuarded: true,
				...message,
			},
			thread: null,
			contact: null,
		};
	}

	function mountReal() {
		return mount(AnswerTeamCard, {
			props: { entry: entry as never, controls },
			attachTo: document.body,
			global: {
				plugins: [createTestI18n()],
				stubs: {
					Icon: true,
					InboxTrustChip: true,
					InboxDecisionRationale: true,
					TaskContext: true,
					TaskAsk: true,
				},
			},
		});
	}

	const primary = (w: ReturnType<typeof mountReal>) => w.get('[data-testid="task-primary"]');
	const reason = (w: ReturnType<typeof mountReal>) => w.find('[data-testid="task-held-reason"]');

	beforeEach(() => {
		vi.mocked(controls.complete).mockClear();
		vi.mocked(controls.openAnswer).mockClear();
		vi.mocked(controls.undoSelf).mockClear();
	});

	it('marks the written gaps, not the quoted one, and holds Approve with the count', async () => {
		gappedEntry();
		const wrapper = mountReal();

		const gaps = wrapper.findAll('[data-testid="team-card-gap"]').map((m) => m.text());
		expect(gaps).toEqual(['[[refund amount]]', '[[refund date]]']);
		expect(wrapper.get('[data-testid="team-card-draft"]').text()).toContain('[[ticket 12]]');

		expect(primary(wrapper).attributes('disabled')).toBeDefined();
		expect(reason(wrapper).text()).toBe(
			'2 gaps left in this draft. Fill them in before you send it.'
		);

		await primary(wrapper).trigger('click');
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
		await flushPromises();
		expect(sent).toEqual([]);
		expect(controls.complete).not.toHaveBeenCalled();
	});

	it('lets a threadless draft be filled on the card and sent once no gap is left', async () => {
		gappedEntry();
		const wrapper = mountReal();

		await wrapper.get('[data-testid="team-card-fill-gaps"]').trigger('click');
		const field = wrapper.get<HTMLTextAreaElement>('[data-testid="team-card-fill"]');
		expect(field.element.value).toBe(GAPPED);
		expect(primary(wrapper).text()).toContain('Send reply');
		expect(primary(wrapper).attributes('disabled')).toBeDefined();
		expect(reason(wrapper).text()).toBe('2 gaps left');

		await field.setValue(FILLED);
		expect(primary(wrapper).attributes('disabled')).toBeUndefined();
		expect(reason(wrapper).exists()).toBe(false);

		await primary(wrapper).trigger('click');
		await flushPromises();
		expect(stored.draftResponse).toBe(FILLED);
		expect(sent).toEqual([FILLED]);
		expect(controls.complete).toHaveBeenCalledWith('sent', undefined);
	});

	it('releases Approve once the gaps are filled elsewhere', async () => {
		gappedEntry();
		const wrapper = mountReal();
		expect(primary(wrapper).attributes('disabled')).toBeDefined();

		const message = { ...(entry.message as object), draftResponse: FILLED, draftSavedAt: 2 };
		await wrapper.setProps({ entry: { ...entry, message } as never });
		expect(wrapper.findAll('[data-testid="team-card-gap"]')).toHaveLength(0);
		expect(primary(wrapper).attributes('disabled')).toBeUndefined();
		expect(reason(wrapper).exists()).toBe(false);
	});

	it('holds an unsaved draft from a backend that stores no guard', () => {
		gappedEntry({ isDraftGapGuarded: undefined });
		const wrapper = mountReal();
		expect(primary(wrapper).attributes('disabled')).toBeDefined();
	});

	it('marks but does not hold brackets a reviewer saved as their own text', () => {
		gappedEntry({ isDraftGapGuarded: undefined, draftSavedAt: 3 });
		const wrapper = mountReal();
		expect(wrapper.findAll('[data-testid="team-card-gap"]')).toHaveLength(2);
		expect(primary(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('leaves a clean draft as it was: nothing marked, Approve sends it', async () => {
		gappedEntry({ draftResponse: FILLED, isDraftGapGuarded: false });
		stored = { draftResponse: FILLED };
		const wrapper = mountReal();
		expect(wrapper.findAll('[data-testid="team-card-gap"]')).toHaveLength(0);
		expect(wrapper.get('[data-testid="team-card-draft"]').element.textContent).toBe(FILLED);
		expect(reason(wrapper).exists()).toBe(false);
		expect(wrapper.find('[data-testid="team-card-fill-gaps"]').exists()).toBe(false);

		await primary(wrapper).trigger('click');
		await flushPromises();
		expect(sent).toEqual([FILLED]);
		expect(controls.complete).toHaveBeenCalledWith('approved', undefined);
	});

	it('names the fill field and ties the gap count to it', async () => {
		gappedEntry();
		const wrapper = mountReal();
		await wrapper.get('[data-testid="team-card-fill-gaps"]').trigger('click');
		const field = wrapper.get<HTMLTextAreaElement>('[data-testid="team-card-fill"]');
		expect(field.attributes('aria-label')).toBe('Draft to fill in');
		const described = field.attributes('aria-describedby');
		expect(described).toBeTruthy();
		expect(wrapper.get(`[id="${described}"]`).text()).toBe('2 gaps left');

		await field.setValue(FILLED);
		expect(field.attributes('aria-describedby')).toBeUndefined();
	});

	it('arms the approve undo countdown for a reply filled on the card, and Undo cancels the send', async () => {
		gappedEntry();
		const sendAt = Date.now() + 15_000;
		const arm = vi.fn();
		vi.stubGlobal('useReviewApproveUndo', () => ({
			arm,
			state: ref({ inboundMessageId: null }),
			dismiss: vi.fn(),
		}));
		vi.stubGlobal('approveUndoWindow', (r: { undo?: { sendAt: number } }) => r.undo);
		const undoAutoSend = vi.fn(async () => ({ ok: true, result: { cancelled: true } }));
		let built = 0;
		vi.stubGlobal('useBackendOperation', () => {
			const index = built++;
			const run = vi.fn(async (args: { draftResponse?: string }) => {
				if (index === 2 && args.draftResponse !== undefined)
					stored.draftResponse = args.draftResponse;
				if (index === 3) return undoAutoSend(args);
				return {
					ok: true,
					result: { success: true, ...(index === 0 ? { undo: { sendAt } } : {}) },
				};
			});
			return { run, isLoading: ref(false) };
		});

		const wrapper = mountReal();
		await wrapper.get('[data-testid="team-card-fill-gaps"]').trigger('click');
		await wrapper.get('[data-testid="team-card-fill"]').setValue(FILLED);
		await primary(wrapper).trigger('click');
		await flushPromises();

		// The countdown toast is armed for this send, its Undo rewinds the queue...
		expect(arm).toHaveBeenCalledWith(expect.objectContaining({ inboundMessageId: 'im_2', sendAt }));
		arm.mock.calls[0]![0].onUndo();
		expect(controls.undoSelf).toHaveBeenCalled();
		// ...and the queue's undo is the true inverse: the held send is cancelled.
		const [outcome, inverse] = vi.mocked(controls.complete).mock.calls[0]!;
		expect(outcome).toBe('sent');
		await inverse!();
		expect(undoAutoSend).toHaveBeenCalledWith({ inboundMessageId: 'im_2' });
	});
});
