// @vitest-environment happy-dom
/**
 * The lost-race approval (adoption-gaps piece FU3).
 *
 * `inbox.mutations.approveDraft` no longer fabricates a success when the
 * lifecycle edge is refused — a double-click, or a teammate who approved or
 * declined the draft a moment earlier: it returns
 * `{ success: false, reason: 'not_found' }` and schedules NOTHING. Both review
 * surfaces used to read that as an approval and toast "Draft approved and
 * queued for sending" over a send that never existed. These mount the real
 * components and pin the honest behaviour:
 *
 *   - BROWSE: the neutral "already handled" toast, NO undo countdown armed, and
 *     the row stays hidden (it really did leave the queue).
 *   - FOCUS: the same toast, no undo entry, and the flow advances to the next
 *     card WITHOUT tallying an approve in the end-state summary.
 *
 * Both mount against the real English catalog, so the assertions are the
 * sentences a reviewer actually reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { approveUndoWindow, isApproveAlreadyHandled } from '~/composables/useReviewApproveUndo';
import { usePostboxOptimisticHide } from '~/composables/postbox/usePostboxOptimisticHide';
import { useReviewQueueKeyboard } from '~/composables/useReviewQueueKeyboard';
import { useReviewBulkSelect } from '~/composables/useReviewBulkSelect';

// Both components import `api` purely to name mutations/queries; the stubbed
// composables never touch Convex.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

// The focus flow imports the org directory explicitly (to name the teammate
// holding a thread), which reaches for the auth/Convex stack on import.
vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({ members: ref([]), fetchMembers: vi.fn() }),
}));

import ReviewBrowseList from '../ReviewBrowseList.vue';
import ReviewBrowseCard from '../ReviewBrowseCard.vue';
import ReviewFocusFlow from '../ReviewFocusFlow.vue';
import AgentTaskFlow from '../AgentTaskFlow.vue';

const ALREADY_HANDLED = 'Already handled — this draft was approved or declined by someone else';

/** A `draft_ready` queue entry carrying an agent draft (never draftless). */
function queueItem(id: string) {
	return {
		message: {
			_id: id,
			from: 'customer@example.com',
			subject: `Subject ${id}`,
			textBody: 'Where is my order?',
			draftResponse: 'It ships Friday.',
		},
		thread: { _id: `thread-${id}` },
	};
}

let toasts: Array<[string, string | undefined]>;
let arm: ReturnType<typeof vi.fn>;
let onApprove: ReturnType<typeof vi.fn>;
let stateBuckets: Map<string, ReturnType<typeof ref>>;

function stubQueueGlobals(items: ReturnType<typeof queueItem>[]) {
	stateBuckets = new Map();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useToast', () => ({
		showToast: (text: string, type?: string) => toasts.push([text, type]),
	}));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('navigateTo', vi.fn());
	// The narrowing helpers + hide/keyboard/selection composables are Nuxt
	// auto-imports in the app — wire the REAL ones so the surfaces under test run
	// their production logic.
	vi.stubGlobal('approveUndoWindow', approveUndoWindow);
	vi.stubGlobal('isApproveAlreadyHandled', isApproveAlreadyHandled);
	vi.stubGlobal('usePostboxOptimisticHide', usePostboxOptimisticHide);
	vi.stubGlobal('useReviewQueueKeyboard', useReviewQueueKeyboard);
	vi.stubGlobal('useReviewBulkSelect', useReviewBulkSelect);
	vi.stubGlobal('useReviewBulkActions', () => ({
		isBusy: ref(false),
		approveSelected: vi.fn(),
		rejectSelected: vi.fn(),
	}));
	vi.stubGlobal('useReviewApproveUndo', () => ({
		state: ref({ visible: false, inboundMessageId: null, sendAt: 0 }),
		arm,
		dismiss: vi.fn(),
	}));
	vi.stubGlobal('useReviewQueue', () => ({
		reviewItems: ref(items),
		isLoading: ref(false),
		needsReply: (message: { draftResponse?: string | null }) =>
			!message.draftResponse || message.draftResponse.trim().length === 0,
		onApprove,
		approveOption: vi.fn(),
		onReject: vi.fn().mockResolvedValue({ success: true }),
		undoApprove: vi.fn(),
		composeAndSend: vi.fn(),
		editDraft: vi.fn(),
	}));
}

beforeEach(() => {
	toasts = [];
	arm = vi.fn();
	onApprove = vi.fn();
});

// NOTE: no `vi.unstubAllGlobals()` teardown — it would also drop the Vue
// reactivity primitives app/__tests__/setup.ts stubs as Nuxt auto-imports.
// Every mount re-stubs its own composables through `stubQueueGlobals`.

const passthroughStubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<i />' },
	UiSpinner: { template: '<i />' },
	InboxTrustChip: { template: '<i />' },
	InboxDecisionRationale: { template: '<i />' },
	AiReviseBox: { template: '<i />' },
};

describe('browse list — a lost-race approve', () => {
	function mountBrowse(items = [queueItem('m1'), queueItem('m2')]) {
		stubQueueGlobals(items);
		return mount(ReviewBrowseList, {
			global: {
				plugins: [createTestI18n()],
				stubs: {
					...passthroughStubs,
					ReviewQueueHeader: true,
					ReviewBulkActionBar: true,
					TaskCardShell: { template: '<li><slot /></li>' },
					ReviewBrowseCard: true,
				},
			},
		});
	}

	/** Approve the first card exactly as its button does. */
	async function approveFirstCard(wrapper: VueWrapper) {
		await wrapper.findAllComponents(ReviewBrowseCard)[0]!.vm.$emit('approve');
		await flushPromises();
	}

	it('toasts honestly, arms no undo, and keeps the row hidden', async () => {
		onApprove.mockResolvedValue({ success: false, reason: 'not_found' });
		const wrapper = mountBrowse();
		expect(wrapper.findAllComponents(ReviewBrowseCard)).toHaveLength(2);

		await approveFirstCard(wrapper);

		expect(toasts).toEqual([[ALREADY_HANDLED, 'info']]);
		expect(arm).not.toHaveBeenCalled();
		// The draft really left the queue — the row does NOT come back.
		const remaining = wrapper.findAllComponents(ReviewBrowseCard);
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.props('row')).toMatchObject({ _id: 'm2' });
	});

	it('still arms the countdown undo for a real approval', async () => {
		onApprove.mockResolvedValue({ success: true, undo: { sendAt: 12_345 } });
		const wrapper = mountBrowse();

		await approveFirstCard(wrapper);

		expect(toasts).toEqual([]);
		expect(arm).toHaveBeenCalledTimes(1);
		expect(arm.mock.calls[0]![0]).toMatchObject({ inboundMessageId: 'm1', sendAt: 12_345 });
	});

	it('restores the row and names the teammate on a collision hold', async () => {
		onApprove.mockResolvedValue({
			success: false,
			reason: 'reply_in_progress',
			heldByName: 'Dana',
		});
		const wrapper = mountBrowse();

		await approveFirstCard(wrapper);

		expect(toasts).toEqual([['Dana just sent a reply — review the thread', 'error']]);
		expect(arm).not.toHaveBeenCalled();
		expect(wrapper.findAllComponents(ReviewBrowseCard)).toHaveLength(2); // restored
	});
});

describe('focus flow — a lost-race approve', () => {
	// The shell is stubbed so its props (position / complete / can-undo) and the
	// end-state summary slot are directly assertable.
	const flowStub = defineComponent({
		props: {
			position: { type: Number, default: 0 },
			total: { type: Number, default: 0 },
			currentKey: { type: String, default: null },
			complete: { type: Boolean, default: false },
			canUndo: { type: Boolean, default: false },
		},
		template: '<div><slot /><div class="done"><slot name="done" /></div></div>',
	});

	function mountFocus() {
		stubQueueGlobals([queueItem('m1'), queueItem('m2')]);
		vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'me' }) }));
		vi.stubGlobal('useOrganization', () => ({ members: ref([]), fetchMembers: vi.fn() }));
		vi.stubGlobal('useConvexQuery', () => ({ data: ref([]), isLoading: ref(false) }));
		return mount(ReviewFocusFlow, {
			attachTo: document.body,
			global: {
				plugins: [createTestI18n()],
				stubs: {
					...passthroughStubs,
					AgentTaskFlow: flowStub,
					TaskCardShell: { template: '<div><slot /></div>' },
					TaskContext: { template: '<div><slot /></div>' },
					TaskAsk: true,
					TaskActions: { template: '<div><slot /></div>' },
					TaskCardRenderer: true,
				},
			},
		});
	}

	/** The `a` shortcut on the focused card — the same path the button takes. */
	async function pressApprove() {
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', cancelable: true }));
		await flushPromises();
	}

	it('advances past the card without tallying an approve or an undo', async () => {
		onApprove
			.mockResolvedValueOnce({ success: false, reason: 'not_found' })
			.mockResolvedValueOnce({ success: true });
		const wrapper = mountFocus();
		await flushPromises();
		expect(wrapper.findComponent(flowStub).props('currentKey')).toBe('m1');

		await pressApprove();

		expect(toasts).toEqual([[ALREADY_HANDLED, 'info']]);
		expect(arm).not.toHaveBeenCalled();
		// The card is behind us — but it was never OUR approval, so no undo entry.
		const shell = wrapper.findComponent(flowStub);
		expect(shell.props('currentKey')).toBe('m2');
		expect(shell.props('position')).toBe(2);
		expect(shell.props('canUndo')).toBe(false);

		// The second card IS approved by us — the end-state counts exactly one.
		await pressApprove();
		expect(toasts[1]).toEqual(['Draft approved and queued for sending', undefined]);
		expect(wrapper.findComponent(flowStub).props('complete')).toBe(true);
		expect(wrapper.find('.done').text()).toContain('1 approved');
		expect(wrapper.find('.done').text()).not.toContain('2 approved');

		wrapper.unmount();
	});
});
