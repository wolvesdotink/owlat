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

	function gappedEntry(message: Record<string, unknown> = {}, thread: unknown = null) {
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
			thread,
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
		expect(controls.complete).toHaveBeenCalledWith('sent');
	});

	it('releases Approve once the gaps are filled elsewhere', async () => {
		gappedEntry({}, { _id: 'th_2' });
		const wrapper = mountReal();
		expect(primary(wrapper).attributes('disabled')).toBeDefined();

		const message = { ...(entry.message as object), draftResponse: FILLED, draftSavedAt: 2 };
		await wrapper.setProps({ entry: { ...entry, message } as never });
		expect(wrapper.findAll('[data-testid="team-card-gap"]')).toHaveLength(0);
		expect(primary(wrapper).attributes('disabled')).toBeUndefined();
		expect(reason(wrapper).exists()).toBe(false);
	});

	it('points a draft with a thread to Answer mode to fill the gaps', async () => {
		gappedEntry({}, { _id: 'th_2' });
		const wrapper = mountReal();
		expect(reason(wrapper).text()).toBe(
			'2 gaps left in this draft. Fill them in the thread before you send it.'
		);
		expect(wrapper.find('[data-testid="team-card-fill-gaps"]').exists()).toBe(false);

		const edit = wrapper.findAll('button').find((b) => b.text() === 'Edit in thread');
		await edit!.trigger('click');
		expect(controls.openAnswer).toHaveBeenCalled();
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
});
