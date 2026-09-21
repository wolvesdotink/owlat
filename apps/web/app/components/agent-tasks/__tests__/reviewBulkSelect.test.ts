import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import { createTestI18n } from '~/__tests__/i18n';

// The summary builders are pure, so they hand back key+params clauses; this is
// the same render boundary `useReviewBulkActions` applies, against the real
// catalog — so the assertions below stay the sentences a reviewer is toasted.
const i18n = createTestI18n();
const { t } = i18n.global;
const line = (clauses: Array<{ key: string; params?: Record<string, unknown> }>): string =>
	clauses.map((clause) => t(clause.key, clause.params ?? {})).join(', ');

/**
 * Multi-select + bulk approve on the Review Queue browse list (adoption-gaps
 * piece C2, decision D6):
 *   - the selection keyboard model (Space/x toggle, Shift+J/K range extend,
 *     `*` select-all-visible, capped at 50) layered over the existing review
 *     listbox — and inert on surfaces without a selection model,
 *   - the partial-result toast copy built from the per-id outcome arrays,
 *   - the bulk action flow: optimistic hide with per-id restore, one shared
 *     countdown-undo toast for the batch, and undo-all through undoAutoSends.
 */

// useState buckets (the Nuxt auto-import the selection Set lives in).
const stateBuckets = new Map<string, ReturnType<typeof ref>>();
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});

import {
	useReviewBulkSelect,
	REVIEW_BULK_ACTION_LIMIT,
} from '../../../composables/useReviewBulkSelect';
import { useReviewQueueKeyboard } from '../../../composables/useReviewQueueKeyboard';
import {
	summarizeBulkApprove,
	summarizeBulkReject,
	summarizeBulkUndo,
} from '../../../utils/reviewBulkSummary';

type Row = { _id: string };

function key(k: string, target?: EventTarget): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key: k, cancelable: true });
	if (target) Object.defineProperty(event, 'target', { value: target, configurable: true });
	return event;
}

/** The browse list's wiring: the keyboard layered over the selection Set. */
function selectionHarness(ids = ['a', 'b', 'c']) {
	const items = ref<Row[]>(ids.map((_id) => ({ _id })));
	const bulk = withSetup(() => useReviewBulkSelect(items)).result;
	const calls: Array<[string, string]> = [];
	const kb = withSetup(() =>
		useReviewQueueKeyboard<Row>({
			items,
			resetKey: ref('ready'),
			rowDomId: (r) => `review-row-${r._id}`,
			onOpen: (r) => calls.push(['open', r._id]),
			onApprove: (r) => calls.push(['approve', r._id]),
			onEdit: (r) => calls.push(['edit', r._id]),
			onReject: (r) => calls.push(['reject', r._id]),
			selection: {
				toggle: (r) => bulk.toggle(r._id),
				selectMany: (rows) => bulk.selectMany(rows.map((r) => r._id)),
				selectAllVisible: () => bulk.selectAllVisible(),
			},
		})
	).result;
	return { items, bulk, kb, calls };
}

describe('selection keyboard model', () => {
	beforeEach(() => stateBuckets.clear());

	it('x toggles selection of the focused row instead of rejecting', () => {
		const { bulk, kb, calls } = selectionHarness();
		kb.onKeydown(key('j')); // focus 'a'
		kb.onKeydown(key('x'));
		expect(bulk.ids.value).toEqual(['a']);
		kb.onKeydown(key('x'));
		expect(bulk.ids.value).toEqual([]);
		expect(calls).toEqual([]); // never dispatched a reject
	});

	it('Space toggles too (and is consumed so the listbox never scrolls)', () => {
		const { bulk, kb } = selectionHarness();
		kb.onKeydown(key('j'));
		const space = key(' ');
		kb.onKeydown(space);
		expect(bulk.ids.value).toEqual(['a']);
		expect(space.defaultPrevented).toBe(true);
	});

	it('# still rejects the focused row while a selection model is active', () => {
		const { kb, calls } = selectionHarness();
		kb.onKeydown(key('j'));
		kb.onKeydown(key('#'));
		expect(calls).toEqual([['reject', 'a']]);
	});

	it('Shift+J extends the selection downward while moving focus', () => {
		const { bulk, kb } = selectionHarness();
		kb.onKeydown(key('j')); // focus 'a'
		kb.onKeydown(key('J')); // select a+b, focus 'b'
		expect(bulk.ids.value.sort()).toEqual(['a', 'b']);
		expect(kb.focusedIndex.value).toBe(1);
		kb.onKeydown(key('J')); // select c too, focus 'c'
		expect(bulk.ids.value.sort()).toEqual(['a', 'b', 'c']);
		expect(kb.focusedIndex.value).toBe(2);
		kb.onKeydown(key('J')); // clamped at the last row
		expect(kb.focusedIndex.value).toBe(2);
	});

	it('Shift+K extends the selection upward while moving focus', () => {
		const { bulk, kb } = selectionHarness();
		kb.onKeydown(key('j'));
		kb.onKeydown(key('j')); // focus 'b'
		kb.onKeydown(key('K')); // select b+a, focus 'a'
		expect(bulk.ids.value.sort()).toEqual(['a', 'b']);
		expect(kb.focusedIndex.value).toBe(0);
	});

	it('* selects everything visible, even with no row focused', () => {
		const { bulk, kb } = selectionHarness();
		kb.onKeydown(key('*'));
		expect(bulk.ids.value.sort()).toEqual(['a', 'b', 'c']);
	});

	it('selection keys stay inert while typing in the inline compose box', () => {
		const { bulk, kb } = selectionHarness();
		kb.onKeydown(key('j'));
		const input = document.createElement('input');
		kb.onKeydown(key('x', input));
		kb.onKeydown(key(' ', input));
		expect(bulk.ids.value).toEqual([]);
	});

	it('without a selection model, x keeps its original reject mapping', () => {
		const calls: Array<[string, string]> = [];
		const kb = withSetup(() =>
			useReviewQueueKeyboard<Row>({
				items: ref([{ _id: 'a' }]),
				resetKey: ref('ready'),
				rowDomId: (r) => r._id,
				onOpen: () => {},
				onApprove: () => {},
				onEdit: () => {},
				onReject: (r) => calls.push(['reject', r._id]),
			})
		).result;
		kb.onKeydown(key('j'));
		kb.onKeydown(key('x'));
		expect(calls).toEqual([['reject', 'a']]);
	});
});

describe('useReviewBulkSelect', () => {
	beforeEach(() => stateBuckets.clear());

	it('caps the selection at the 50-item batch limit', () => {
		const items = ref<Row[]>(Array.from({ length: 60 }, (_, i) => ({ _id: `m${i}` })));
		const bulk = withSetup(() => useReviewBulkSelect(items)).result;
		bulk.selectAllVisible();
		expect(bulk.count.value).toBe(REVIEW_BULK_ACTION_LIMIT);
		// Toggling one more ON past the cap is refused; toggling OFF still works.
		bulk.toggle('m59');
		expect(bulk.count.value).toBe(REVIEW_BULK_ACTION_LIMIT);
		bulk.toggle('m0');
		expect(bulk.count.value).toBe(REVIEW_BULK_ACTION_LIMIT - 1);
	});

	it('prunes ids whose rows left the visible list', async () => {
		const items = ref<Row[]>([{ _id: 'a' }, { _id: 'b' }]);
		const bulk = withSetup(() => useReviewBulkSelect(items)).result;
		bulk.selectMany(['a', 'b']);
		items.value = [{ _id: 'b' }]; // 'a' was approved elsewhere
		await nextTick();
		expect(bulk.ids.value).toEqual(['b']);
	});
});

describe('partial-result toast copy', () => {
	const o = (outcome: string, heldByName?: string, i = Math.random()) =>
		({ inboundMessageId: `m${i}`, outcome, heldByName }) as never;

	it('summarizes a mixed approve batch per id', () => {
		expect(
			line(
				summarizeBulkApprove([
					o('approved'),
					o('approved'),
					o('reply_in_progress', 'Dana'),
					o('reply_in_progress', 'Dana'),
					o('no_draft'),
					o('not_found'),
				])
			)
		).toBe('2 approved, 2 held — Dana is replying, 1 had no draft, 1 no longer in the queue');
	});

	it('keeps the held clause collective when several teammates hold', () => {
		expect(
			line(
				summarizeBulkApprove([
					o('approved'),
					o('reply_in_progress', 'Dana'),
					o('reply_in_progress', 'Kim'),
				])
			)
		).toBe('1 approved, 2 held — teammates are replying');
	});

	it('a clean batch is just the count', () => {
		expect(line(summarizeBulkApprove([o('approved'), o('approved')]))).toBe('2 approved');
	});

	it('summarizes bulk reject in the same shape', () => {
		expect(line(summarizeBulkReject([o('rejected'), o('rejected'), o('not_found')] as never))).toBe(
			'2 rejected, 1 no longer in the queue'
		);
	});

	it('summarizes undo-all: full, partial, and too-late', () => {
		const u = (cancelled: boolean, i = Math.random()) => ({
			inboundMessageId: `m${i}`,
			cancelled,
		});
		const undoLine = (outcomes: Array<{ inboundMessageId: string; cancelled: boolean }>) => {
			const summary = summarizeBulkUndo(outcomes);
			return { ...summary, text: t(summary.text.key, summary.text.params ?? {}) };
		};
		expect(undoLine([u(true), u(true)])).toMatchObject({
			text: 'Approvals undone — 2 drafts are back in the queue',
			allCancelled: true,
		});
		expect(undoLine([u(true), u(false)])).toMatchObject({
			text: '1 approval undone — 1 already sent',
			allCancelled: false,
		});
		expect(undoLine([u(false)])).toMatchObject({
			text: 'Too late to undo — the reply is already on its way',
			allCancelled: false,
		});
	});
});

describe('useReviewBulkActions', () => {
	// One mock run() per useBackendOperation call, in declaration order:
	// 0 = approveDrafts, 1 = rejectDrafts, 2 = undoAutoSends.
	let runs: Array<ReturnType<typeof vi.fn>>;
	let arm: ReturnType<typeof vi.fn>;
	let toasts: Array<[string, string | undefined]>;

	beforeEach(() => {
		stateBuckets.clear();
		runs = [];
		arm = vi.fn();
		toasts = [];
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useBackendOperation', () => {
			const run = vi.fn();
			runs.push(run);
			return { run };
		});
		vi.stubGlobal('useReviewApproveUndo', () => ({ arm }));
		vi.stubGlobal('useToast', () => ({
			showToast: (text: string, type?: string) => toasts.push([text, type]),
		}));
	});

	async function harness(ids: string[]) {
		const { useReviewBulkActions } = await import('../../../composables/useReviewBulkActions');
		const hidden: string[] = [];
		const restored: string[] = [];
		const clearSelection = vi.fn();
		const actions = useReviewBulkActions({
			ids: ref(ids),
			clearSelection,
			hideRow: (id) => hidden.push(id),
			unhideRow: (id) => restored.push(id),
		});
		return { actions, hidden, restored, clearSelection };
	}

	it('approve: hides optimistically, restores per id, arms ONE undo toast with the summary', async () => {
		const { actions, hidden, restored, clearSelection } = await harness(['a', 'b', 'c', 'd']);
		runs[0]!.mockResolvedValue({
			ok: true,
			result: {
				outcomes: [
					{ inboundMessageId: 'a', outcome: 'approved' },
					{ inboundMessageId: 'b', outcome: 'approved' },
					{ inboundMessageId: 'c', outcome: 'reply_in_progress', heldByName: 'Dana' },
					{ inboundMessageId: 'd', outcome: 'not_found' },
				],
				undo: { sendAt: 123_456 },
			},
		});

		await actions.approveSelected();

		expect(runs[0]).toHaveBeenCalledWith({ inboundMessageIds: ['a', 'b', 'c', 'd'] });
		expect(hidden).toEqual(['a', 'b', 'c', 'd']);
		// The held row comes back; the vanished row stays hidden (it left anyway).
		expect(restored).toEqual(['c']);
		expect(clearSelection).toHaveBeenCalled();

		// One shared toast for the batch, carrying the honest per-id summary.
		expect(arm).toHaveBeenCalledTimes(1);
		const armed = arm.mock.calls[0]![0];
		expect(armed.sendAt).toBe(123_456);
		expect(armed.label).toBe('2 approved, 1 held — Dana is replying, 1 no longer in the queue');
		expect(toasts).toEqual([]); // the countdown toast replaces the plain one
	});

	it('undo-all cancels the batch and restores only the rows that came back', async () => {
		const { actions, restored } = await harness(['a', 'b']);
		runs[0]!.mockResolvedValue({
			ok: true,
			result: {
				outcomes: [
					{ inboundMessageId: 'a', outcome: 'approved' },
					{ inboundMessageId: 'b', outcome: 'approved' },
				],
				undo: { sendAt: 999 },
			},
		});
		await actions.approveSelected();

		runs[2]!.mockResolvedValue({
			ok: true,
			result: {
				outcomes: [
					{ inboundMessageId: 'a', cancelled: true, reason: 'cancelled' },
					{ inboundMessageId: 'b', cancelled: false, reason: 'already_sent' },
				],
			},
		});
		await arm.mock.calls[0]![0].onUndo();

		expect(runs[2]).toHaveBeenCalledWith({ inboundMessageIds: ['a', 'b'] });
		expect(restored).toEqual(['a']); // 'b' fired — stays on its way
		expect(toasts).toEqual([['1 approval undone — 1 already sent', 'warning']]);
	});

	it('approve without an open window falls back to a plain summary toast', async () => {
		const { actions } = await harness(['a']);
		runs[0]!.mockResolvedValue({
			ok: true,
			result: {
				outcomes: [{ inboundMessageId: 'a', outcome: 'approved' }],
				// no `undo` — humanApproveUndoDelayMs is 0
			},
		});
		await actions.approveSelected();
		expect(arm).not.toHaveBeenCalled();
		expect(toasts).toEqual([['1 approved', 'success']]);
	});

	// Piece FU3: the bulk twin of the single-approve lost race — every id was
	// already approved or declined elsewhere, so nothing was scheduled.
	it('an all-lost-race batch keeps the rows hidden, arms no undo, and says so', async () => {
		const { actions, hidden, restored, clearSelection } = await harness(['a', 'b']);
		runs[0]!.mockResolvedValue({
			ok: true,
			result: {
				outcomes: [
					{ inboundMessageId: 'a', outcome: 'not_found' },
					{ inboundMessageId: 'b', outcome: 'not_found' },
				],
			},
		});

		await actions.approveSelected();

		expect(hidden).toEqual(['a', 'b']);
		expect(restored).toEqual([]); // they really left the queue
		expect(clearSelection).toHaveBeenCalled();
		expect(arm).not.toHaveBeenCalled();
		expect(toasts).toEqual([['0 approved, 2 no longer in the queue', 'warning']]);
	});

	it('a categorized failure restores every hidden row and keeps the selection', async () => {
		const { actions, restored, clearSelection } = await harness(['a', 'b']);
		runs[0]!.mockResolvedValue({ ok: false }); // useBackendOperation already toasted
		await actions.approveSelected();
		expect(restored).toEqual(['a', 'b']);
		expect(clearSelection).not.toHaveBeenCalled();
		expect(arm).not.toHaveBeenCalled();
	});

	it('reject: same batch shape, no undo, honest summary', async () => {
		const { actions, hidden, clearSelection } = await harness(['a', 'b']);
		runs[1]!.mockResolvedValue({
			ok: true,
			result: {
				outcomes: [
					{ inboundMessageId: 'a', outcome: 'rejected' },
					{ inboundMessageId: 'b', outcome: 'not_found' },
				],
			},
		});
		await actions.rejectSelected();
		expect(runs[1]).toHaveBeenCalledWith({ inboundMessageIds: ['a', 'b'] });
		expect(hidden).toEqual(['a', 'b']);
		expect(clearSelection).toHaveBeenCalled();
		expect(arm).not.toHaveBeenCalled();
		expect(toasts).toEqual([['1 rejected, 1 no longer in the queue', undefined]]);
	});
});
